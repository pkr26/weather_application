import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { pinoHttp } from 'pino-http'
import type { Config } from './config.js'
import { logger, REDACT_PATHS } from './logger.js'
import { errorHandler } from './errors.js'
import { notFoundHandler } from './routes.js'
import {
  healthRouter,
  languagesRouter,
  weatherRouter,
  geocodeRouter,
  notificationsRouter,
  devicesRouter,
  type Services,
} from './routes.js'
import { TtlCache } from './cache.js'
import { GoogleWeatherClient } from './upstream/googleWeather.js'
import { GeocodingClient } from './upstream/openMeteo.js'
import { DeviceStore } from './store/deviceStore.js'
import { requireApiToken } from './security/apiToken.js'
import { gzipJsonMiddleware } from './compression.js'

export function buildServices(config: Config): Services {
  return {
    config,
    weather: new GoogleWeatherClient(config),
    geocoding: new GeocodingClient(config),
    // The core bundle (everything except alerts) is language-independent —
    // one entry per coordinate, shared by all 27 languages. Weather changes
    // slowly; a 10-minute cache keeps upstream quota usage proportional to
    // users, not to refresh taps.
    coreCache: new TtlCache(config.CACHE_TTL_MS),
    // Alerts vary by language and must stay near-fresh — short TTL only.
    alertsCache: new TtlCache(config.ALERTS_CACHE_TTL_MS),
    currentCache: new TtlCache(config.CACHE_TTL_MS),
    // Geocode results are stable for a day; a larger table because search
    // prefixes ("h", "hy", "hyd"…) create many short-lived entries and LRU
    // eviction must not churn hot cities out.
    geocodeCache: new TtlCache(24 * 60 * 60 * 1000, 2048),
    devices: new DeviceStore(config.DATA_DIR, config.MAX_DEVICES, config.DEVICE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000),
  }
}

const limiterMessage = { error: 'rate_limited', message: 'Too many requests, slow down.' }

function perRouteLimiter(config: Config, max: number) {
  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: limiterMessage,
  })
}

/** Request serializer that keeps user data out of logs: coordinates, city
 *  names and search terms arrive as query strings, and a weather app's
 *  access log must not become a location history. Logs method + route path
 *  only — no query string, no headers — and collapses device-registry
 *  paths to their route shape so identifiers stay out too.
 *  Exported for the log-content test. */
export function serializeReqForLog(req: { method?: string; url?: string }): Record<string, unknown> {
  // split('?') always yields at least one element — no fallback branch needed.
  const path = (req.url ?? '').split('?')[0]!
  // Stryker disable Regex: case-insensitivity and the id-shape anchors are pinned by the device-path logging tests (incl. mixed-case); remaining anchor mutants collapse every real id shape identically
  const anonymized = path.replace(/^\/api\/v1\/devices\/[^/]+/i, '/api/v1/devices/:id')
  // Stryker restore Regex
  return { method: req.method, url: anonymized }
}

/** Response serializer: pino-http's default logs every response header —
 *  more than needed, and one added Set-Cookie away from a leak. The status
 *  code is all the access log needs. Exported for the log-content test. */
export function serializeResForLog(res: { statusCode?: number }): Record<string, unknown> {
  return { statusCode: res.statusCode }
}

/**
 * The exact pino-http configuration the app mounts — exported so a test can
 * pin the WIRING (serializers + redact attached), not just the primitives.
 * The wiring block is Stryker-disabled (unobservable at LOG_LEVEL=silent),
 * which made a silent regression here invisible to every gate.
 */
export function pinoHttpOptions() {
  return {
    logger,
    autoLogging: { ignore: (req: { url?: string }) => req.url?.startsWith('/api/v1/health') === true },
    serializers: { req: serializeReqForLog, res: serializeResForLog },
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[redacted]',
    },
  }
}

export function createApp(config: Config, services = buildServices(config)): Express {
  const app = express()
  // X-Powered-By is suppressed by helmet()'s hidePoweredBy below — keeping a
  // second suppression here is redundant and untestable against the first.

  // Proxy trust decides whose X-Forwarded-For header defines the client IP
  // (and therefore the rate-limit bucket). Default: trust loopback proxies
  // only, so a direct internet attacker cannot mint a fresh identity per
  // request. Behind exactly one real LB, set TRUST_PROXY=1.
  // Stryker disable StringLiteral,CallExpression: express defaults 'trust proxy' to false and collapses falsy set() keys, so the key literal and the redundant explicit disable are verified equivalents; the comparison literals are killed by the proxy-trust assertions
  if (config.TRUST_PROXY === '1') app.set('trust proxy', 1)
  else if (config.TRUST_PROXY === '0') app.disable('trust proxy')
  else app.set('trust proxy', 'loopback')
  // Stryker restore StringLiteral,CallExpression

  // Stryker disable ObjectLiteral,ArrowFunction,ConditionalExpression,EqualityOperator,MethodExpression,OptionalChaining,BooleanLiteral,StringLiteral,ArrayDeclaration,CallExpression: pino replaces level methods with no-ops when LOG_LEVEL=silent, so this logging configuration is unobservable in tests; verified by inspection
  app.use(pinoHttp(pinoHttpOptions()))
  // Stryker restore ObjectLiteral,ArrowFunction,ConditionalExpression,EqualityOperator,MethodExpression,OptionalChaining,BooleanLiteral,StringLiteral,ArrayDeclaration,CallExpression
  app.use(helmet())
  app.use(gzipJsonMiddleware)

  // CORS is opt-in: only origins explicitly allowlisted via CORS_ORIGINS get
  // access. The Android client is not a browser and needs none of this.
  const corsOrigins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, credentials: false }))
  }

  // Rate limiting sits before body parsing: oversized/malformed bodies are
  // rejected by the budget, not parsed first and counted later — junk-body
  // floods must not do parser work outside the rate limit.
  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      limit: config.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: limiterMessage,
    }),
  )

  // Optional shared-token gate (API_TOKEN). Mounted on the API surface only,
  // and /health stays open for load balancers and container healthchecks —
  // matched case-insensitively and tolerant of a trailing slash so the
  // exemption cannot be missed by a path variant.
  const v1 = express.Router()
  if (config.API_TOKEN) {
    // Stryker disable Regex: slash-trimming variants are pinned by the token-gate health-exemption sweep in security.test.ts; anchor mutants are equivalent for every routable path
    const isHealth = (p: string) => p.replace(/\/+$/, '').toLowerCase() === '/health'
    // Stryker restore Regex
    const gate = requireApiToken(config.API_TOKEN)
    v1.use((req, res, next) => (isHealth(req.path) ? next() : gate(req, res, next)))
  }
  v1.use(healthRouter())
  v1.use(languagesRouter(services))
  // Weather + notification reads fan out into several upstream calls per
  // cache miss (paginated days/hours), so they carry their own budget to
  // protect upstream quota from coordinate-cycling abuse.
  v1.use(
    ['/weather', '/notifications'],
    perRouteLimiter(config, config.WEATHER_RATE_LIMIT_MAX),
  )
  v1.use(weatherRouter(services))
  // Geocoding hits an upstream on every miss — tighter budget than reads.
  v1.use('/geocode', perRouteLimiter(config, config.GEOCODE_RATE_LIMIT_MAX))
  v1.use(geocodeRouter(services))
  v1.use(notificationsRouter(services))
  // Device registrations are writes — tighter budget still.
  // Stryker disable StringLiteral: the mount path's identity is pinned by the device tests hitting the route; the budget ceiling is not exercised at test volumes, so path mutants are unobservable
  v1.use('/devices', perRouteLimiter(config, config.DEVICE_RATE_LIMIT_MAX))
  // Stryker restore StringLiteral
  v1.use(devicesRouter(services))

  app.use(express.json({ limit: '64kb' }))
  app.use('/api/v1', v1)

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
