/**
 * Mutation-hardening tests: each block pins a behaviour whose mutation
 * previously survived — exact messages, header values, TTL arithmetic,
 * request shapes and load-time edge cases. Kept in one file so the
 * "what did this lock down?" story is reviewable in a single pass.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { buildServices, createApp } from '../src/app.js'
import { loadConfig, resetConfigCache } from '../src/config.js'
import { DeviceStore } from '../src/store/deviceStore.js'
import { TtlCache } from '../src/cache.js'
import { GoogleWeatherClient } from '../src/upstream/googleWeather.js'
import { GeocodingClient } from '../src/upstream/openMeteo.js'
import { generateBriefing } from '../src/briefing/generator.js'
import { logger } from '../src/logger.js'
import { resolvePack } from '../src/i18n/index.js'
import type { Services } from '../src/routes.js'
import type { WeatherBundle } from '../src/upstream/googleWeather.js'

process.env.LOG_LEVEL = 'silent'

const root = mkdtempSync(path.join(tmpdir(), 'cirrus-hard-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const dir = (name: string) => path.join(root, name)

function makeConfig(overrides: Record<string, string> = {}) {
  resetConfigCache()
  return loadConfig({
    WEATHER_API_KEY: 'test-key',
    DATA_DIR: dir('app-data'),
    ...overrides,
  } as NodeJS.ProcessEnv)
}

function makeApp(overrides: Record<string, string> = {}) {
  const config = makeConfig(overrides)
  const services: Services = {
    config,
    weather: {
      currentConditions: async () => ({}),
      publicAlerts: async () => ({}),
    } as unknown as GoogleWeatherClient,
    geocoding: { search: async () => ({ results: [] }) } as unknown as GeocodingClient,
    coreCache: new TtlCache(60_000),
    alertsCache: new TtlCache(15_000),
    currentCache: new TtlCache(60_000),
    geocodeCache: new TtlCache(60_000),
    devices: new DeviceStore(dir('app-devices')),
  }
  return createApp(config, services)
}

describe('buildServices wiring', () => {
  it('gives the geocode cache exactly a 24-hour TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'))
    const services = buildServices(makeConfig())
    services.geocodeCache.set('hyderabad', { results: [] })

    vi.setSystemTime(new Date('2026-09-03T23:59:00Z'))
    expect(services.geocodeCache.get('hyderabad')).toBeTruthy()

    vi.setSystemTime(new Date('2026-09-04T00:01:00Z'))
    expect(services.geocodeCache.get('hyderabad')).toBeUndefined()
  })

  it('prunes device records past the configured max age, keeps fresher ones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const dataDir = dir('ttl-build')
    const services = buildServices(makeConfig({ DATA_DIR: dataDir, DEVICE_MAX_AGE_DAYS: '30' }))
    await services.devices.upsert({
      deviceId: 'device-ttlbuild1',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })

    // 29 days old: still here (asserted through buildServices so the
    // app-level DAY arithmetic is the code under test).
    vi.setSystemTime(new Date('2026-01-30T00:00:00Z'))
    const fresh = buildServices(makeConfig({ DATA_DIR: dataDir, DEVICE_MAX_AGE_DAYS: '30' }))
    expect(await fresh.devices.get('device-ttlbuild1')).toBeTruthy()

    // 31 days old: pruned at load.
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'))
    const aged = buildServices(makeConfig({ DATA_DIR: dataDir, DEVICE_MAX_AGE_DAYS: '30' }))
    expect(await aged.devices.get('device-ttlbuild1')).toBeNull()
  })

  it('default registry max age is 365 days', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const dataDir = dir('ttl-default')
    await new DeviceStore(dataDir).upsert({
      deviceId: 'device-ttlyear1',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })

    vi.setSystemTime(new Date('2026-12-30T00:00:00Z')) // ~363 days
    expect(await new DeviceStore(dataDir).get('device-ttlyear1')).toBeTruthy()

    vi.setSystemTime(new Date('2027-01-03T00:00:00Z')) // ~367 days
    expect(await new DeviceStore(dataDir).get('device-ttlyear1')).toBeNull()
  })
})

describe('proxy trust configuration', () => {
  it('maps TRUST_PROXY values onto the exact express settings', () => {
    expect(makeApp({ TRUST_PROXY: '1' }).get('trust proxy')).toBe(1)
    expect(makeApp({ TRUST_PROXY: '0' }).get('trust proxy')).toBe(false)
    expect(makeApp({ TRUST_PROXY: '' }).get('trust proxy')).toBe('loopback')
    expect(makeApp().get('trust proxy')).toBe('loopback')
  })
})

describe('CORS credentials', () => {
  it('never advertises credentialed CORS even for allowlisted origins', async () => {
    const app = makeApp({ CORS_ORIGINS: 'https://app.example.com' })
    const res = await request(app).get('/api/v1/languages').set('Origin', 'https://app.example.com')
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('request logging', () => {
  it('never reveals the implementation banner on success routes', async () => {
    const res = await request(makeApp()).get('/api/v1/languages')
    expect(res.status).toBe(200)
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
})

describe('global rate-limit headers on the 429 itself', () => {
  it('keeps the rejection modern and message stable', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '1' })
    await request(app).get('/api/v1/languages')
    const rejected = await request(app).get('/api/v1/languages')
    expect(rejected.status).toBe(429)
    expect(rejected.body).toEqual({
      error: 'rate_limited',
      message: 'Too many requests, slow down.',
    })
    expect(rejected.headers['ratelimit-policy']).toBe('1;w=60')
    expect(rejected.headers['x-ratelimit-limit']).toBeUndefined()
    expect(rejected.headers['x-ratelimit-remaining']).toBeUndefined()
  })
})

describe('per-route rate-limit headers', () => {
  it('weather and notification routes use draft-7 headers only', async () => {
    const app = makeApp({ WEATHER_RATE_LIMIT_MAX: '100' })
    const weather = await request(app).get('/api/v1/weather/current?lat=1&lon=1')
    expect(weather.headers['ratelimit']).toMatch(/^limit=100/)
    expect(weather.headers['x-ratelimit-limit']).toBeUndefined()

    const alerts = await request(app).get('/api/v1/notifications/alerts?lat=1&lon=1')
    expect(alerts.headers['ratelimit-policy']).toBe('100;w=60')
    expect(alerts.headers['x-ratelimit-remaining']).toBeUndefined()
  })

  it('does not let the weather budget leak into geocoding', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '100', WEATHER_RATE_LIMIT_MAX: '1' })
    expect((await request(app).get('/api/v1/weather/current?lat=1&lon=1')).status).toBe(200)
    // The weather budget is spent; geocode must still answer from its own
    // separate budget — a leaked mount would 429 here.
    expect((await request(app).get('/api/v1/geocode?name=Hyderabad')).status).toBe(200)
    // And the second geocode is still fine (30/min budget untouched).
    expect((await request(app).get('/api/v1/geocode?name=Secunderabad')).status).toBe(200)
  })

  it('shares the weather budget across weather and notification routes', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '100', WEATHER_RATE_LIMIT_MAX: '2' })
    expect((await request(app).get('/api/v1/weather/current?lat=1&lon=1')).status).toBe(200)
    expect((await request(app).get('/api/v1/notifications/alerts?lat=1&lon=1')).status).toBe(200)
    // Budget exhausted by the two calls above — notification reads are capped too.
    expect((await request(app).get('/api/v1/notifications/alerts?lat=1&lon=1')).status).toBe(429)
    // And the shared budget does not leak to unrelated routes.
    expect((await request(app).get('/api/v1/languages')).status).toBe(200)
  })
})

describe('DeviceStore load-time edges', () => {
  const record = (deviceId: string) => ({
    deviceId,
    language: 'en',
    city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
    notificationTime: { hour: 8, minute: 0 },
    units: 'metric' as const,
    alertsEnabled: true,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  })

  it('rejects a wrong-version file even when it holds a valid record', async () => {
    const dataDir = dir('v99-valid')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      path.join(dataDir, 'devices.json'),
      JSON.stringify({ version: 99, devices: { 'device-v99valid1': record('device-v99valid1') } }),
    )
    expect(await new DeviceStore(dataDir).get('device-v99valid1')).toBeNull()
  })

  it('silently ignores a null document — no unreadable-file warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const dataDir = dir('null-doc')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'devices.json'), 'null')
    expect(await new DeviceStore(dataDir).get('anything-000000')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a record aged exactly to the cutoff (boundary is exclusive)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'))
    const dataDir = dir('cutoff')
    mkdirSync(dataDir, { recursive: true })
    const maxAge = 60 * 60 * 1000
    const exactlyOld = new Date(Date.now() - maxAge).toISOString()
    writeFileSync(
      path.join(dataDir, 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: { 'device-cutoff01': { ...record('device-cutoff01'), updatedAt: exactlyOld } },
      }),
    )
    // One hour old with a one-hour max age: < cutoff is false → kept.
    // (Clock granularity makes a strictly-below assertion flaky, so the
    // boundary itself is the assertion: the record must survive.)
    const store = new DeviceStore(dataDir, 25_000, maxAge)
    expect(await store.get('device-cutoff01')).toBeTruthy()
  })

  it('attaches the underlying error object to the unreadable-file warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const dataDir = dir('warn-payload')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'devices.json'), '{broken')
    await new DeviceStore(dataDir).get('anything-000000')
    expect(warn).toHaveBeenCalledOnce()
    const firstArg = warn.mock.calls[0][0] as Record<string, unknown>
    expect(firstArg).toBeTruthy()
    expect(String(firstArg.err)).toContain('SyntaxError')
  })

  it('stores the registry under devices.json with a pretty 2-space layout', async () => {
    const dataDir = dir('layout')
    await new DeviceStore(dataDir).upsert({
      deviceId: 'device-layout001',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    const text = readFileSync(path.join(dataDir, 'devices.json'), 'utf8')
    expect(text).toContain('"version": 1')
    expect(text).toContain('\n  "devices"')
    expect(text).toContain('"device-layout001"')
  })
})

describe('GoogleWeatherClient request shapes', () => {
  const coord = { latitude: 17.38, longitude: 78.48 }

  function stubFetch(pages: unknown[]) {
    const calls: Array<[URL, RequestInit]> = []
    let i = 0
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push([url, init])
      const body = pages[Math.min(i, pages.length - 1)]
      i++
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls, fetchMock }
  }

  it('sends METRIC units, 4-decimal coordinates and page tokens on hours/days', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'))
    const { calls } = stubFetch([
      { forecastHours: [{ a: 1 }, { a: 2 }], nextPageToken: 'tok-1' },
      { forecastHours: [{ a: 3 }] },
    ])
    const client = new GoogleWeatherClient(makeConfig())
    await client.forecastHours(coord, 3)

    expect(calls.length).toBe(2)
    const first = calls[0][0]
    expect(first.pathname).toContain('/v1/forecast/hours:lookup')
    expect(first.searchParams.get('location.latitude')).toBe('17.3800')
    expect(first.searchParams.get('location.longitude')).toBe('78.4800')
    expect(first.searchParams.get('unitsSystem')).toBe('METRIC')
    expect(first.searchParams.get('languageCode')).toBe('en')
    expect(first.searchParams.get('hours')).toBe('3')
    expect(first.searchParams.get('pageToken')).toBeNull()
    expect(calls[1][0].searchParams.get('pageToken')).toBe('tok-1')
  })

  it('sends the language code through on alerts', async () => {
    const { calls } = stubFetch([{ weatherAlerts: [] }])
    const client = new GoogleWeatherClient(makeConfig())
    await client.publicAlerts(coord, 'te')
    expect(calls[0][0].searchParams.get('languageCode')).toBe('te')
  })

  it('stops paging as soon as the target count is reached', async () => {
    const { fetchMock } = stubFetch([
      { forecastDays: [{ d: 1 }, { d: 2 }, { d: 3 }, { d: 4 }, { d: 5 }] },
      { forecastDays: [{ d: 6 }] },
    ])
    const client = new GoogleWeatherClient(makeConfig())
    const merged = (await client.forecastDays(coord, 5)) as { forecastDays: unknown[] }
    // Exactly the target: no second page is fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(merged.forecastDays.length).toBe(5)
  })

  it('sends METRIC units and English copy on days and history lookups', async () => {
    const { calls } = stubFetch([{ forecastDays: [{ d: 1 }] }])
    const client = new GoogleWeatherClient(makeConfig())
    await client.forecastDays(coord, 10)
    expect(calls[0][0].searchParams.get('unitsSystem')).toBe('METRIC')
    expect(calls[0][0].searchParams.get('languageCode')).toBe('en')
    expect(calls[0][0].searchParams.get('days')).toBe('10')

    stubFetch([{ historyHours: [] }])
    await client.historyHours(coord, 24)
    expect(calls[0][0].searchParams.get('unitsSystem')).toBe('METRIC')
  })

  it('defaults the alerts language to English and passes the body through', async () => {
    const body = { weatherAlerts: [{ headline: 'H' }], regionCode: 'IN' }
    const { calls } = stubFetch([body])
    const client = new GoogleWeatherClient(makeConfig())
    const result = await client.publicAlerts(coord)
    expect(result).toEqual(body) // 200 responses are returned verbatim
    expect(calls[0][0].searchParams.get('languageCode')).toBe('en')
  })

  it('stops paging at the exact target even when a token is offered', async () => {
    const { fetchMock } = stubFetch([
      { forecastHours: [{ a: 1 }, { a: 2 }, { a: 3 }], nextPageToken: 'more' },
      { forecastHours: [{ a: 4 }] },
    ])
    const client = new GoogleWeatherClient(makeConfig())
    const merged = (await client.forecastHours(coord, 3)) as {
      forecastHours: unknown[]
      nextPageToken?: unknown
    }
    expect(fetchMock).toHaveBeenCalledTimes(1) // >= 3 means done
    expect(merged.forecastHours.length).toBe(3)
    expect(merged.nextPageToken).toBeUndefined() // clients get one seamless list
  })

  it('treats a non-string page token as "no more pages"', async () => {
    const { fetchMock } = stubFetch([{ forecastDays: [{ d: 1 }], nextPageToken: 42 }])
    const client = new GoogleWeatherClient(makeConfig())
    const merged = (await client.forecastDays(coord, 5)) as { forecastDays: unknown[] }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(merged.forecastDays.length).toBe(1)
  })

  it('keeps first-page metadata when a later page fails', async () => {
    const calls: Array<[URL, RequestInit]> = []
    let i = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push([url, init])
        i++
        if (i === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ timeZone: { id: 'Asia/Kolkata' }, forecastHours: [{ a: 1 }], nextPageToken: 't2' }),
          } as Response
        }
        throw new TypeError('page 2 down')
      }),
    )
    const client = new GoogleWeatherClient(makeConfig())
    const merged = (await client.forecastHours(coord, 3)) as Record<string, unknown>
    expect(merged.timeZone).toEqual({ id: 'Asia/Kolkata' })
    expect(merged.forecastHours).toEqual([{ a: 1 }])
  })

  it('trims a merged list to the requested target even across pages', async () => {
    stubFetch([
      { forecastHours: [{ a: 1 }, { a: 2 }], nextPageToken: 'p2' },
      { forecastHours: [{ a: 3 }, { a: 4 }, { a: 5 }] },
    ])
    const client = new GoogleWeatherClient(makeConfig())
    const merged = (await client.forecastHours(coord, 3)) as { forecastHours: unknown[] }
    expect(merged.forecastHours.length).toBe(3) // slice(0, target), not the raw 5
  })

  it('seamlessly handles an empty first page that still offers a token', async () => {
    stubFetch([{ forecastHours: [], nextPageToken: 'p2' }, { forecastHours: [{ a: 1 }] }])
    const client = new GoogleWeatherClient(makeConfig())
    const merged = (await client.forecastHours(coord, 3)) as { forecastHours: unknown[]; nextPageToken?: unknown }
    expect(merged.forecastHours).toEqual([{ a: 1 }])
    expect(merged.nextPageToken).toBeUndefined()
  })

  it('sends hours and language on history lookups', async () => {
    const { calls } = stubFetch([{ historyHours: [] }])
    const client = new GoogleWeatherClient(makeConfig())
    await client.historyHours(coord, 24)
    expect(calls[0][0].searchParams.get('hours')).toBe('24')
    expect(calls[0][0].searchParams.get('unitsSystem')).toBe('METRIC')
    expect(calls[0][0].searchParams.get('languageCode')).toBe('en')
  })

  it('quotes the exact upstream detail when the body is readable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: false, status: 429, json: async () => ({}), text: async () => 'quota exceeded' }) as Response,
      ),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const err = await client.currentConditions(coord).catch((e: Error) => e)
    expect(err.message).toBe('Weather API v1/currentConditions:lookup failed: 429 quota exceeded')
  })

  it('attaches the failing error to the soft-failure warning payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (String(url).includes('currentConditions')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
        }
        throw new TypeError('network down')
      }),
    )
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const client = new GoogleWeatherClient(makeConfig())
    await client.bundle(coord)
    const call = warn.mock.calls.find(c => c[1] === 'Non-critical weather endpoint failed')
    expect(call).toBeTruthy()
    expect(String((call![0] as Record<string, unknown>).err)).toContain('network down')
  })

  it('does not retry network errors or timeouts — one attempt each', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '3' }))
    await expect(client.currentConditions(coord)).rejects.toThrow(/unreachable/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry permanent 4xx answers — one attempt', async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: false, status: 429, json: async () => ({}), text: async () => 'quota' }) as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '3' }))
    await expect(client.currentConditions(coord)).rejects.toThrow('Weather API v1/currentConditions:lookup failed: 429')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('quotes the upstream body in the log-only detail, tolerating unreadable bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: false, status: 500, json: async () => ({}), text: async () => { throw new Error('unreadable') } }) as unknown as Response,
      ),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    // The empty body slice must not crash the error path — and the detail
    // stays exactly "status + empty body", not a fallback string.
    const err = await client.currentConditions(coord).catch((e: Error) => e)
    expect(err.message).toBe('Weather API v1/currentConditions:lookup failed: 500 ')
  })

  it('attaches structured context to the retry warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let i = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        i++
        return { ok: i === 1 ? false : true, status: i === 1 ? 503 : 200, json: async () => ({ ok: true }), text: async () => '' } as Response
      }),
    )
    const client = new GoogleWeatherClient(makeConfig())
    await client.currentConditions(coord)
    expect(warn).toHaveBeenCalledOnce()
    const payload = warn.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ attempt: 0, status: 503 })
    expect(warn.mock.calls[0][1]).toBe('Upstream call failed, retrying')
  })

  it('attaches structured context to the partial-page warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let i = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        i++
        if (i === 1) {
          return { ok: true, status: 200, json: async () => ({ forecastHours: [{ a: 1 }], nextPageToken: 't' }) } as Response
        }
        throw new TypeError('page 2 down')
      }),
    )
    const client = new GoogleWeatherClient(makeConfig())
    await client.forecastHours(coord, 3)
    expect(warn).toHaveBeenCalledOnce()
    const payload = warn.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ page: 1 })
    expect(warn.mock.calls[0][1]).toBe('Paged fetch failed, serving partial list')
  })

  it('marks the bundle degraded when a non-critical endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (String(url).includes('currentConditions')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
        }
        throw new TypeError('network down')
      }),
    )
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const client = new GoogleWeatherClient(makeConfig())
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(true)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some(c => c[1] === 'Non-critical weather endpoint failed')).toBe(true)
    expect(bundle.currentConditions).toEqual({ ok: true })
    expect(bundle.forecastHours).toEqual({})
    expect(bundle.publicAlerts).toEqual({})
  })
})

describe('briefing hostile-number edges', () => {
  const NOW = new Date('2026-09-03T04:00:00Z')

  it('ignores infinite precipitation probabilities instead of printing them', () => {
    const bundle: WeatherBundle = {
      currentConditions: { weatherCondition: { type: 'RAIN' } },
      forecastHours: {
        forecastHours: [
          { interval: { startTime: '2026-09-03T11:00:00Z' }, precipitation: { probability: { percent: Infinity } } },
        ],
      },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: {},
    }
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).not.toContain('Infinity')
    expect(result.body).toContain('No rain expected today')
  })

  it('keeps same-day hours when the timezone is invalid — late-day rain survives', () => {
    const hours = Array.from({ length: 24 }, (_, h) => ({
      interval: { startTime: `2026-09-03T${String(h).padStart(2, '0')}:00:00Z` },
      precipitation: { probability: { type: 'RAIN', percent: h === 20 ? 90 : 5 } },
    }))
    const bundle: WeatherBundle = {
      currentConditions: { timeZone: { id: 'Not/AZone' }, weatherCondition: { type: 'RAIN' } },
      forecastHours: { forecastHours: hours, timeZone: { id: 'Not/AZone' } },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: {},
    }
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    // Hour 20 (UTC) is 2026-09-03 — same local day under the UTC fallback —
    // so its 90% must win even though it sits beyond a naive first-16 slice.
    expect(result.body).toContain('90%')
    expect(result.body).not.toContain('No rain expected today')
  })

  it('adds no rain line at exactly 25 percent without a timestamp', () => {
    // Exactly-25 with unknowable timing falls through every arm: claiming
    // "no rain" at 25 percent would be a lie the <= mutant would tell.
    const bundle: WeatherBundle = {
      currentConditions: { weatherCondition: { type: 'RAIN' } },
      forecastHours: {
        forecastHours: [{ precipitation: { probability: { type: 'RAIN', percent: 25 } } }],
      },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: {},
    }
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: new Date('2026-09-03T04:00:00Z'),
    })
    expect(result.body).toBe(result.condition)
    expect(result.body).not.toContain('No rain expected today')
  })

  it('advises on heat well above the threshold, not only at it', () => {
    const bundle: WeatherBundle = {
      currentConditions: { weatherCondition: { type: 'CLEAR' } },
      forecastHours: { forecastHours: [] },
      forecastDays: { forecastDays: [{ maxTemperature: { degrees: 45 }, minTemperature: { degrees: 30 } }] },
      historyHours: {},
      publicAlerts: {},
    }
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toContain('Very hot today — stay hydrated')
  })
})

describe('briefing composition edges', () => {
  const NOW = new Date('2026-09-03T04:00:00Z')

  it('falls back to UTC when no timezone appears anywhere', () => {
    const bundle: WeatherBundle = {
      currentConditions: { weatherCondition: { type: 'RAIN' } },
      forecastHours: {
        forecastHours: [
          {
            interval: { startTime: '2026-09-03T11:00:00Z' },
            precipitation: { probability: { type: 'RAIN', percent: 80 } },
          },
        ],
      },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: {},
    }
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    // UTC formatting ("11:00 AM"), not a bare HH:mm crash-fallback.
    expect(result.body).toContain('11:00 AM')
  })

  it('skips the rain line when the peak hour has no timestamp', () => {
    const bundle: WeatherBundle = {
      currentConditions: { weatherCondition: { type: 'RAIN' } },
      forecastHours: {
        forecastHours: [
          { precipitation: { probability: { type: 'RAIN', percent: 85 } } },
        ],
      },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: {},
    }
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    // Neither the "likely" nor the "possible" wording may appear when the
    // timing is unknowable — and the "no rain" claim would be a lie.
    expect(result.body).not.toMatch(/likely|possible/i)
    expect(result.body).toBe(result.condition)
  })

  it('ignores non-object alert entries', () => {
    const bundle: WeatherBundle = {
      currentConditions: { weatherCondition: { type: 'CLEAR' } },
      forecastHours: { forecastHours: [] },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: { weatherAlerts: ['just a string', null, { headline: 'Real alert' }] },
    }
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.alertCount).toBe(1)
    expect(result.body).toContain('Real alert')
  })

  it('treats an array-typed bundle section as empty', () => {
    const bundle = {
      currentConditions: [],
      forecastHours: [],
      forecastDays: [],
      historyHours: [],
      publicAlerts: [],
    } as unknown as WeatherBundle
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    // No crash, defaults everywhere.
    expect(result.condition).toBeTruthy()
    expect(result.alertCount).toBe(0)
    expect(result.body).toContain('No rain expected today')
  })
})
