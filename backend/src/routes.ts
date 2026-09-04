import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { Config } from './config.js'
import { TtlCache, coordKey } from './cache.js'
import { GoogleWeatherClient, type Coord, type CoreBundle } from './upstream/googleWeather.js'
import { GeocodingClient } from './upstream/openMeteo.js'
import { DeviceStore, publicDevice, type DeviceRecord } from './store/deviceStore.js'
import { generateBriefing } from './briefing/generator.js'
import { languageCatalog, resolvePack } from './i18n/index.js'
import { draining } from './readiness.js'
import { asyncHandler, badRequest, unauthorized } from './errors.js'
import {
  DEVICE_SECRET_HEADER,
  generateDeviceSecret,
  hashDeviceSecret,
  requireDeviceSecret,
  verifyDeviceSecret,
} from './security/deviceAuth.js'

export interface Services {
  config: Config
  weather: GoogleWeatherClient
  geocoding: GeocodingClient
  /** Language-independent core weather, keyed by rounded coordinates. */
  coreCache: TtlCache<CoreBundle>
  /** Localized severe-weather alerts, keyed by coordinates + language. */
  alertsCache: TtlCache<unknown>
  currentCache: TtlCache<unknown>
  geocodeCache: TtlCache<unknown>
  devices: DeviceStore
}

/** Query params arrive as strings: '' must be rejected, not coerced to 0. */
const numberParam = (opts: { min: number; max: number }) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().min(opts.min).max(opts.max),
  )

const latLon = z.object({
  lat: numberParam({ min: -90, max: 90 }),
  lon: numberParam({ min: -180, max: 180 }),
})

const langQuery = z.object({ lang: z.string().min(2).max(10).optional() })

function query<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  return schema.parse(req.query)
}

const coord = (q: { lat: number; lon: number }): Coord => ({ latitude: q.lat, longitude: q.lon })

/** Freshness transparency: tells clients how old the served data is. */
function freshnessHeaders(
  res: Response,
  cache: 'hit' | 'miss',
  ageMs: number,
  ttlMs: number,
  scope: 'public' | 'private' = 'public',
): void {
  res.setHeader('X-Cache', cache)
  res.setHeader('X-Data-Age-Seconds', String(Math.floor(ageMs / 1000)))
  // Shared caches may keep the payload only for the TTL we have left, never
  // a fresh full TTL on an already-aged hit (that would double staleness).
  const remainingSec = Math.max(1, Math.ceil((ttlMs - ageMs) / 1000))
  res.setHeader('Cache-Control', `${scope}, max-age=${remainingSec}`)
}

/**
 * Core weather is cached at the full TTL when healthy, and at the short
 * degraded TTL when a soft endpoint failed or pagination truncated: a blip
 * must not freeze for 10 minutes, and a persistent failure must not turn
 * every request into 5 upstream calls. (Both variants ARE cached — a
 * `cacheable: (b) => !b.degraded` predicate here would make the degraded
 * branch below unreachable dead code and resurrect the quota-burn bug.)
 */
function coreCacheOpts(svc: Services) {
  return {
    ttlFor: (b: CoreBundle) => (b.degraded ? svc.config.DEGRADED_CACHE_TTL_MS : svc.config.CACHE_TTL_MS),
  }
}

/**
 * Per-request upstream scope: a wall-clock deadline over the whole fan-out
 * and an abort when the client hangs up mid-flight. Without the link, a
 * disappeared client's five upstream calls run to completion for an answer
 * nobody will read — pure quota burn during brownouts.
 */
function upstreamScope(svc: Services, req: Request, res: Response): AbortSignal {
  const clientGone = new AbortController()
  // Stryker disable ConditionalExpression,ArrowFunction,ObjectLiteral: the abort-on-disconnect arm is pinned by the client-abort test; the listener registration itself is socket-lifecycle bookkeeping
  res.on('close', () => {
    if (!res.writableEnded) clientGone.abort()
  })
  // Stryker restore ConditionalExpression,ArrowFunction,ObjectLiteral
  return AbortSignal.any([
    clientGone.signal,
    AbortSignal.timeout(svc.config.UPSTREAM_DEADLINE_MS),
  ])
}

/**
 * Loads core + localized alerts and merges them into a bundle response.
 * Each request contributes its own scope (deadline + disconnect) to the
 * shared flight via the cache's participant set; the load aborts only when
 * every participant is gone.
 */
async function loadBundleParts(svc: Services, c: Coord, lang: string, signal?: AbortSignal) {
  const core = await svc.coreCache.getOrLoadWithMeta(
    coordKey(c.latitude, c.longitude),
    (flight) => svc.weather.coreBundle(c, flight),
    { ...coreCacheOpts(svc), signal },
  )
  // Alerts fail soft: the rest of the bundle is still useful without them.
  let alertsFailed = false
  const alerts = await svc.alertsCache
    .getOrLoadWithMeta(
      `${coordKey(c.latitude, c.longitude)}|${lang}`,
      (flight) => svc.weather.publicAlerts(c, lang, flight),
      // Stryker disable ObjectLiteral,ArrowFunction: the opts shape is unobservable — alerts metadata comes from the served entry, and this TTL never reaches a client-visible header
      { ttlFor: () => svc.config.ALERTS_CACHE_TTL_MS, signal },
      // Stryker restore ObjectLiteral,ArrowFunction
    )
    .catch(() => {
      alertsFailed = true
      // Stryker disable ObjectLiteral,ArrowFunction: the fallback object's exact shape is unobservable — the degraded flag it produces is what the response asserts
      return { value: {} as unknown, cache: 'miss' as const, ageMs: 0, ttlMs: svc.config.ALERTS_CACHE_TTL_MS }
      // Stryker restore ObjectLiteral,ArrowFunction
    })
  return { core, alerts, alertsFailed }
}

// ---------------------------------------------------------------- health

export function healthRouter(): Router {
  return Router().get('/health', (_req, res) => {
    // A draining instance must stop receiving work: LBs and container
    // orchestrators poll this endpoint to decide where to route.
    if (draining.value) {
      res.status(503).json({ status: 'draining' })
      return
    }
    res.json({ status: 'ok', uptime: process.uptime() })
  })
}

// ------------------------------------------------------------- languages

export function languagesRouter(): Router {
  return Router().get('/languages', (_req, res) => {
    // The catalog only changes on deploy — let clients cache it for a day.
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.json({ languages: languageCatalog() })
  })
}

// --------------------------------------------------------------- weather

export function weatherRouter(svc: Services): Router {
  return Router().get(
    '/weather/bundle',
    asyncHandler(async (req, res) => {
      const q = query(req, latLon.merge(langQuery))
      // Resolve to a canonical pack first: "EN", "en-US" and "en" must share
      // one cache entry and one upstream languageCode. Core weather is
      // language-independent (alerts are the only localized part).
      const pack = resolvePack(q.lang)
      const scope = upstreamScope(svc, req, res)
      const { core, alerts, alertsFailed } = await loadBundleParts(svc, coord(q), pack.code, scope)

      // Alerts missing = a degraded bundle: shared caches may keep it only
      // briefly, never the full core TTL.
      const servedTtl = alertsFailed
        ? Math.min(core.ttlMs, svc.config.ALERTS_CACHE_TTL_MS)
        : core.ttlMs
      freshnessHeaders(res, core.cache, core.ageMs, servedTtl)
      if (!alertsFailed) {
        res.setHeader('X-Alerts-Age-Seconds', String(Math.floor(alerts.ageMs / 1000)))
      }
      res.json({
        ...core.value,
        publicAlerts: alerts.value,
        degraded: core.value.degraded === true || alertsFailed,
      })
    }),
  ).get(
    '/weather/current',
    asyncHandler(async (req, res) => {
      const q = query(req, latLon)
      const scope = upstreamScope(svc, req, res)
      const entry = await svc.currentCache.getOrLoadWithMeta(
        coordKey(q.lat, q.lon),
        (flight) => svc.weather.currentConditions(coord(q), flight),
        { signal: scope },
      )
      freshnessHeaders(res, entry.cache, entry.ageMs, entry.ttlMs)
      res.json(entry.value)
    }),
  )
}

// -------------------------------------------------------------- geocode

export function geocodeRouter(svc: Services): Router {
  return Router().get(
    '/geocode',
    asyncHandler(async (req, res) => {
      const q = query(
        req,
        z.object({
          name: z.string().trim().min(2).max(100),
          count: z.coerce.number().int().min(1).max(25).default(12),
        }),
      )
      // Any case fold direction is unobservable: the key is internal, and
      // both directions share entries across letter case identically.
      // Stryker disable MethodExpression: verified equivalent case-fold direction
      const key = `${q.name.toLowerCase()}|${q.count}`
      // Stryker restore MethodExpression
      const entry = await svc.geocodeCache.getOrLoadWithMeta(key, () =>
        svc.geocoding.search(q.name, q.count),
      )
      res.setHeader('X-Cache', entry.cache)
      // City identities are stable; let the app's autocomplete cache too.
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.json(entry.value)
    }),
  ).get(
    '/geocode/reverse',
    asyncHandler(async (req, res) => {
      const q = query(req, latLon)
      const entry = await svc.geocodeCache.getOrLoadWithMeta(
        `rev|${coordKey(q.lat, q.lon)}`,
        () => svc.geocoding.reverse(q.lat, q.lon),
      )
      res.setHeader('X-Cache', entry.cache)
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.json(entry.value)
    }),
  )
}

// --------------------------------------------------------- notifications

export function notificationsRouter(svc: Services): Router {
  return Router()
    .get(
      '/notifications/briefing',
      asyncHandler(async (req, res) => {
        const q = query(
          req,
          latLon.merge(langQuery).merge(z.object({
            city: z.string().trim().min(1).max(100).optional(),
            // The default '' would flow through the generator as "not
            // imperial" — observably identical to 'metric' (verified).
            // Stryker disable StringLiteral
            units: z.enum(['metric', 'imperial']).default('metric'),
            // Stryker restore StringLiteral
          })),
        )
        const pack = resolvePack(q.lang)
        const scope = upstreamScope(svc, req, res)
        const { core, alerts, alertsFailed } = await loadBundleParts(svc, coord(q), pack.code, scope)
        const briefing = generateBriefing({
          bundle: {
            ...core.value,
            publicAlerts: alerts.value,
            degraded: core.value.degraded === true || alertsFailed,
          },
          // The built-in fallback is localized per pack — an English
          // "your location" must not leak into a Telugu title.
          city: q.city ?? pack.fallbackCity,
          pack,
          units: q.units,
        })
        // Briefings embed the user's city name — keep them out of shared
        // caches; and an alerts-missing briefing is degraded, so even the
        // private max-age is clamped to the short window.
        freshnessHeaders(
          res,
          core.cache,
          core.ageMs,
          alertsFailed ? Math.min(core.ttlMs, svc.config.ALERTS_CACHE_TTL_MS) : core.ttlMs,
          'private',
        )
        res.json(briefing)
      }),
    )
    .get(
      '/notifications/alerts',
      asyncHandler(async (req, res) => {
        const q = query(req, latLon.merge(langQuery))
        const pack = resolvePack(q.lang)
        // Alerts are served near-fresh from a microcache (seconds, not the
        // full weather TTL): warnings are never meaningfully stale, yet a
        // storm-time herd of devices shares one upstream call per place.
        const scope = upstreamScope(svc, req, res)
        const entry = await svc.alertsCache.getOrLoadWithMeta(
          `${coordKey(q.lat, q.lon)}|${pack.code}`,
          (flight) => svc.weather.publicAlerts(coord(q), pack.code, flight),
          { ttlFor: () => svc.config.ALERTS_CACHE_TTL_MS, signal: scope },
        )
        res.setHeader('X-Cache', entry.cache)
        res.setHeader('X-Data-Age-Seconds', String(Math.floor(entry.ageMs / 1000)))
        res.setHeader('Cache-Control', 'no-store')
        res.json(entry.value)
      }),
    )
}

// --------------------------------------------------------------- devices

/** Identifiers that collide with Object.prototype machinery — never stored. */
const RESERVED_DEVICE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

const deviceBody = z.object({
  // Conservative charset: plain identifier material only, plus an explicit
  // denylist for the prototype-colliding names — the charset alone admits
  // "__proto__" (underscore is legal), so the denylist is what actually
  // keeps hostile keys out of the persistent store.
  deviceId: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, 'must contain only letters, digits, . _ : -')
    .refine((id) => !RESERVED_DEVICE_IDS.has(id), 'reserved identifier'),
  // Stored as a canonical pack code: resolvePack maps locale variants
  // ("te-IN") and unknown codes onto a supported language.
  language: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .transform((l) => resolvePack(l).code),
  city: z.object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(100),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timeZone: z.string().trim().max(64).optional(),
  }),
  notificationTime: z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  units: z.enum(['metric', 'imperial']).default('metric'),
  alertsEnabled: z.boolean().default(true),
})

export function devicesRouter(svc: Services): Router {
  return Router()
    .post(
      '/devices',
      asyncHandler(async (req, res) => {
        const parsed = deviceBody.safeParse(req.body)
        if (!parsed.success) {
          // safeParse failures always carry at least one issue (zod contract).
          const first = parsed.error.issues[0]!.message
          throw badRequest(`Invalid device registration: ${first}`)
        }
        // Atomic create: the existence check and the insertion happen in one
        // synchronous step, so two concurrent first registrations (or an
        // attacker racing a victim's first POST) can never both mint secrets
        // for the same deviceId — exactly one 201 exists per identity.
        const deviceSecret = generateDeviceSecret()
        const { created, record } = await svc.devices.createIfAbsent({
          ...parsed.data,
          secretHash: hashDeviceSecret(deviceSecret),
        })
        if (!created) {
          // An existing record can only be updated by whoever presents its
          // current secret. An unauthenticated or wrong-secret POST gets the
          // same 401 as reads/deletes — it must never rotate the secret and
          // seize the registration (device-takeover audit finding). Devices
          // that lose their secret recover by registering a fresh ID, which
          // the Android client does automatically.
          const authenticated = verifyDeviceSecret(req.header(DEVICE_SECRET_HEADER), record.secretHash)
          if (!authenticated) {
            throw unauthorized('Missing or invalid device secret.')
          }
          // Guarded write: if a concurrent rotation changed the secret
          // between the middleware's read and this write, the guard rejects
          // instead of resurrecting the just-retired hash.
          const saved = await svc.devices.updateIfSecretMatches(
            record.deviceId,
            record.secretHash,
            parsed.data,
          )
          if (!saved) {
            throw unauthorized('Device record changed; re-authenticate.')
          }
          res.setHeader('Cache-Control', 'no-store')
          res.json({ deviceId: saved.deviceId, updatedAt: saved.updatedAt })
          return
        }

        // We won the create — the stored hash is this secret's; hand the
        // secret out exactly once.
        res.status(201)
        res.setHeader('Cache-Control', 'no-store')
        res.json({
          deviceId: record.deviceId,
          updatedAt: record.updatedAt,
          deviceSecret,
        })
      }),
    )
    .post(
      '/devices/:deviceId/secret',
      requireDeviceSecret(svc.devices),
      asyncHandler(async (req, res) => {
        // Secret rotation: a leaked secret is replaced (verify old, issue
        // new) without abandoning the device identity. The write is guarded
        // on the hash the middleware verified — a concurrent rotation or
        // authenticated update cannot be silently clobbered by this one.
        const current = res.locals.device as DeviceRecord
        const deviceSecret = generateDeviceSecret()
        const rotated = await svc.devices.updateIfSecretMatches(
          current.deviceId,
          current.secretHash,
          { ...current, secretHash: hashDeviceSecret(deviceSecret) },
        )
        if (!rotated) {
          throw unauthorized('Device record changed; re-authenticate.')
        }
        res.setHeader('Cache-Control', 'no-store')
        res.json({ deviceId: current.deviceId, deviceSecret })
      }),
    )
    .get(
      '/devices/:deviceId',
      requireDeviceSecret(svc.devices),
      asyncHandler(async (req, res) => {
        // Auth middleware has verified the secret and put the record here.
        res.setHeader('Cache-Control', 'no-store')
        res.json(publicDevice(res.locals.device))
      }),
    )
    .delete(
      '/devices/:deviceId',
      requireDeviceSecret(svc.devices),
      asyncHandler(async (req, res) => {
        await svc.devices.delete(res.locals.device.deviceId)
        res.status(204).end()
      }),
    )
}

// --------------------------------------------------------- 404 fallback

export function notFoundHandler(_req: Request, res: Response): void {
  // 404s are request-dependent; a shared cache must never memorize them.
  res.setHeader('Cache-Control', 'no-store')
  res.status(404).json({ error: 'not_found', message: 'No such endpoint.' })
}
