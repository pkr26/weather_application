import { afterAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../src/app.js'
import { loadConfig, resetConfigCache } from '../src/config.js'
import { DeviceStore } from '../src/store/deviceStore.js'
import type { Services } from '../src/routes.js'
import type { GoogleWeatherClient } from '../src/upstream/googleWeather.js'
import type { GeocodingClient } from '../src/upstream/openMeteo.js'
import { TtlCache } from '../src/cache.js'

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cirrus-test-'))
afterAll(() => rmSync(tmpDataDir, { recursive: true, force: true }))

process.env.WEATHER_API_KEY = 'test-key'
process.env.LOG_LEVEL = 'silent'
resetConfigCache()
const config = loadConfig({ ...process.env, WEATHER_API_KEY: 'test-key', DATA_DIR: tmpDataDir, DEVICE_WRITE_RATE_LIMIT_MAX: '100', CACHE_TTL_MS: '60000' })

const fixtureBundle = {
  currentConditions: {
    timeZone: { id: 'Asia/Kolkata' },
    weatherCondition: { type: 'CLEAR' },
    temperature: { unit: 'CELSIUS', degrees: 29 },
    isDaytime: true,
  },
  forecastHours: {
    forecastHours: [
      {
        interval: { startTime: '2026-09-03T04:00:00Z' },
        precipitation: { probability: { percent: 10 } },
        uvIndex: 3,
        wind: { gust: { unit: 'KILOMETERS_PER_HOUR', value: 12 } },
      },
      {
        interval: { startTime: '2026-09-03T10:00:00Z' },
        precipitation: { probability: { percent: 80 } },
        uvIndex: 10,
        wind: { gust: { unit: 'KILOMETERS_PER_HOUR', value: 50 } },
      },
    ],
  },
  forecastDays: {
    forecastDays: [
      {
        maxTemperature: { degrees: 33 },
        minTemperature: { degrees: 25 },
        daytimeForecast: { weatherCondition: { type: 'RAIN' } },
      },
    ],
  },
  historyHours: {},
  publicAlerts: {},
}

const sharedGeocodeSearches: Array<{ name: string; count: number }> = []

const services: Services = {
  config,
  weather: {
    coreBundle: async () => fixtureBundle,
    currentConditions: async () => fixtureBundle.currentConditions,
    publicAlerts: async () => ({ weatherAlerts: [] }),
  } as unknown as GoogleWeatherClient,
  geocoding: {
    search: async (name: string, count: number) => {
      sharedGeocodeSearches.push({ name, count })
      return { results: [] }
    },
    reverse: async () => ({ name: 'Somewhere', admin1: '', country: '' }),
  } as unknown as GeocodingClient,
  coreCache: new TtlCache(60_000),
  alertsCache: new TtlCache(15_000),
  currentCache: new TtlCache(60_000),
  geocodeCache: new TtlCache(60_000),
  devices: new DeviceStore(tmpDataDir),
}

const app = createApp(config, services)

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/v1/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})

describe('GET /api/v1/languages', () => {
  it('returns the full catalog', async () => {
    const res = await request(app).get('/api/v1/languages')
    expect(res.status).toBe(200)
    expect(res.body.languages.length).toBeGreaterThanOrEqual(20)
    const te = res.body.languages.find((l: { code: string }) => l.code === 'te')
    expect(te).toMatchObject({ nativeName: 'తెలుగు', englishName: 'Telugu' })
  })
})

describe('GET /api/v1/weather/bundle', () => {
  it('proxies the bundle pass-through with freshness headers', async () => {
    const res = await request(app).get('/api/v1/weather/bundle?lat=17.38&lon=78.48')
    expect(res.status).toBe(200)
    expect(res.body.currentConditions.weatherCondition.type).toBe('CLEAR')
    expect(res.headers['x-cache']).toBe('miss')
    expect(Number(res.headers['x-data-age-seconds'])).toBeGreaterThanOrEqual(0)
    expect(res.headers['cache-control']).toMatch(/^public, max-age=\d+$/)
  })

  it('reports a cache hit on the second call', async () => {
    const res = await request(app).get('/api/v1/weather/bundle?lat=17.38&lon=78.48')
    expect(res.headers['x-cache']).toBe('hit')
  })

  it('rejects out-of-range coordinates', async () => {
    const res = await request(app).get('/api/v1/weather/bundle?lat=999&lon=0')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('serves the second call from cache', async () => {
    let calls = 0
    const counting: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => {
          calls++
          return fixtureBundle
        },
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const cachedApp = createApp(config, counting)
    await request(cachedApp).get('/api/v1/weather/bundle?lat=10&lon=10')
    await request(cachedApp).get('/api/v1/weather/bundle?lat=10&lon=10')
    expect(calls).toBe(1)
  })

  it('passes exact coordinates upstream and requests alerts in the pack language', async () => {
    const seen: Array<{ coord?: { latitude: number; longitude: number }; lang?: string }> = []
    const counting: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async (coord) => {
          seen.push({ coord })
          return fixtureBundle
        },
        publicAlerts: async (_c: unknown, lang: string) => {
          seen.push({ lang })
          return {}
        },
      } as unknown as GoogleWeatherClient,
    }
    const coordApp = createApp(config, counting)
    await request(coordApp).get('/api/v1/weather/bundle?lat=17.385&lon=78.4867')
    expect(seen).toEqual([
      { coord: { latitude: 17.385, longitude: 78.4867 } },
      { lang: 'en' },
    ])

    const hit = await request(coordApp).get('/api/v1/weather/bundle?lat=17.385&lon=78.4867')
    expect(hit.headers['x-data-age-seconds']).toBe('0')
    expect(hit.headers['cache-control']).toBe('public, max-age=60') // the injected cache's TTL
  })

  it('shares core weather across languages — only alerts are fetched per language', async () => {
    let coreCalls = 0
    const alertLangs: string[] = []
    const counting: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => {
          coreCalls++
          return fixtureBundle
        },
        publicAlerts: async (_c: unknown, lang: string) => {
          alertLangs.push(lang)
          return { lang }
        },
      } as unknown as GoogleWeatherClient,
    }
    const langApp = createApp(config, counting)

    const en1 = await request(langApp).get('/api/v1/weather/bundle?lat=5&lon=5')
    const en2 = await request(langApp).get('/api/v1/weather/bundle?lat=5&lon=5') // same lang: cached
    const te = await request(langApp).get('/api/v1/weather/bundle?lat=5&lon=5&lang=te')

    // Core is language-independent: one fetch serves all three requests.
    expect(coreCalls).toBe(1)
    // Alerts differ per language: fetched for en once, then for te.
    expect(alertLangs).toEqual(['en', 'te'])
    expect(en2.headers['x-cache']).toBe('hit')
    expect(te.headers['x-cache']).toBe('hit') // the Telugu request reuses the English core
    expect(en1.body.publicAlerts.lang).toBe('en')
    expect(te.body.publicAlerts.lang).toBe('te') // but never the English alerts
  })

  it('normalizes language variants onto one cache entry', async () => {
    let coreCalls = 0
    const alertLangs: string[] = []
    const counting: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => {
          coreCalls++
          return fixtureBundle
        },
        publicAlerts: async (_c: unknown, lang: string) => {
          alertLangs.push(lang)
          return {}
        },
      } as unknown as GoogleWeatherClient,
    }
    const normApp = createApp(config, counting)

    await request(normApp).get('/api/v1/weather/bundle?lat=6&lon=6&lang=en')
    await request(normApp).get('/api/v1/weather/bundle?lat=6&lon=6&lang=EN')
    await request(normApp).get('/api/v1/weather/bundle?lat=6&lon=6&lang=en-US')

    // One core fetch and one alerts fetch, always with the canonical code.
    expect(coreCalls).toBe(1)
    expect(alertLangs).toEqual(['en'])
  })

  it('bounds a degraded bundle to the short TTL — a blip never freezes for 10 minutes', async () => {
    let calls = 0
    resetConfigCache()
    const shortTtlConfig = loadConfig({
      ...process.env,
      WEATHER_API_KEY: 'test-key',
      DATA_DIR: tmpDataDir,
      DEGRADED_CACHE_TTL_MS: '50',
      CACHE_TTL_MS: '60000',
      DEVICE_RATE_LIMIT_MAX: '100',
    } as NodeJS.ProcessEnv)
    const flaky: Services = {
      ...services,
      config: shortTtlConfig,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => {
          calls++
          return calls === 1
            ? { ...fixtureBundle, forecastHours: {}, degraded: true }
            : fixtureBundle
        },
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const degradedApp = createApp(shortTtlConfig, flaky)

    const first = await request(degradedApp).get('/api/v1/weather/bundle?lat=7&lon=7')
    expect(first.status).toBe(200)
    expect(first.body.degraded).toBe(true)
    expect(first.headers['x-cache']).toBe('miss')

    // Within the degraded TTL the blip is served (bounded staleness — a
    // persistent failure must not turn every request into 5 upstream calls).
    const second = await request(degradedApp).get('/api/v1/weather/bundle?lat=7&lon=7')
    expect(second.headers['x-cache']).toBe('hit')
    expect(calls).toBe(1)

    // After the short TTL the next caller gets a fresh, healthy retry.
    await new Promise((r) => setTimeout(r, 80))
    const third = await request(degradedApp).get('/api/v1/weather/bundle?lat=7&lon=7')
    expect(third.headers['x-cache']).toBe('miss')
    expect(third.body.degraded).toBe(false)
    expect(calls).toBe(2)
  })

  it('advertises only the remaining TTL on an aged cache hit', async () => {
    const counting: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const agedApp = createApp(config, counting)
    const miss = await request(agedApp).get('/api/v1/weather/bundle?lat=8&lon=8')
    expect(Number(miss.headers['cache-control'].match(/max-age=(\d+)/)?.[1])).toBe(60)

    await new Promise((r) => setTimeout(r, 1100))
    const hit = await request(agedApp).get('/api/v1/weather/bundle?lat=8&lon=8')
    const hitMaxAge = Number(hit.headers['cache-control'].match(/max-age=(\d+)/)?.[1])
    expect(hit.headers['x-cache']).toBe('hit')
    expect(hitMaxAge).toBeLessThan(60)
    expect(hitMaxAge).toBeGreaterThanOrEqual(55)
  })
})

describe('GET /api/v1/geocode (shared app)', () => {
  it('shares one upstream search across letter case and trims padding', async () => {
    const before = sharedGeocodeSearches.length
    const a = await request(app).get('/api/v1/geocode?name=Chennai')
    const b = await request(app).get('/api/v1/geocode?name=CHENNAI')
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // Same name in different case = one cache entry = one upstream call.
    expect(sharedGeocodeSearches.slice(before)).toEqual([{ name: 'Chennai', count: 12 }])
  })
})

describe('GET /api/v1/weather/current', () => {
  it('carries freshness transparency headers', async () => {
    const res = await request(app).get('/api/v1/weather/current?lat=17.38&lon=78.48')
    expect(res.status).toBe(200)
    expect(res.headers['x-cache']).toBe('miss')
    expect(res.headers['x-data-age-seconds']).toBe('0')
    expect(res.headers['cache-control']).toMatch(/^public, max-age=/)
  })
})

describe('GET /api/v1/notifications/briefing', () => {
  it('returns an English briefing by default', async () => {
    const res = await request(app).get(
      '/api/v1/notifications/briefing?lat=17.38&lon=78.48&city=Hyderabad',
    )
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Today in Hyderabad')
    expect(res.body.body).toContain('High 33° / Low 25°')
    expect(res.body.body).toContain('Rain likely around')
    expect(res.body.body).toContain('Very high UV index (10)')
    expect(res.body.body).toContain('Gusty winds up to 50 km/h')
  })

  it('marks briefings private — they embed the user\'s city name', async () => {
    const res = await request(app).get(
      '/api/v1/notifications/briefing?lat=17.38&lon=78.48&city=Hyderabad',
    )
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/)
  })

  it('caches per coordinates — one city never serves another', async () => {
    const coords = new Map<string, unknown>()
    const stubbed: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async (c: { latitude: number; longitude: number }) => {
          const key = `${c.latitude},${c.longitude}`
          if (!coords.has(key)) {
            const high = key.startsWith('17') ? 33 : 5
            coords.set(key, {
              ...fixtureBundle,
              forecastDays: {
                forecastDays: [
                  {
                    maxTemperature: { degrees: high },
                    minTemperature: { degrees: 25 },
                    daytimeForecast: { weatherCondition: { type: 'RAIN' } },
                  },
                ],
              },
            })
          }
          return coords.get(key)
        },
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const keyed = createApp(config, stubbed)
    const hyd = await request(keyed).get('/api/v1/notifications/briefing?lat=17.38&lon=78.48&city=A')
    const del = await request(keyed).get('/api/v1/notifications/briefing?lat=28.6&lon=77.2&city=B')
    expect(hyd.body.body).toContain('High 33°')
    expect(del.body.body).toContain('High 5°') // not Hyderabad's cached 30°
  })

  it('trims the city name before embedding it in the title', async () => {
    const res = await request(app).get(
      '/api/v1/notifications/briefing?lat=17.38&lon=78.48&city=%20%20Hyderabad%20%20',
    )
    expect(res.body.title).toBe('Today in Hyderabad')
  })

  it('serves a degraded core from the short-TTL cache instead of hammering upstream', async () => {
    let calls = 0
    const flaky: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => {
          calls++
          if (calls === 1) {
            return { ...fixtureBundle, forecastHours: {}, degraded: true }
          }
          return fixtureBundle
        },
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const flakyApp = createApp(config, flaky)
    const first = await request(flakyApp).get('/api/v1/notifications/briefing?lat=17.38&lon=78.48')
    expect(first.headers['x-cache']).toBe('miss')
    const second = await request(flakyApp).get('/api/v1/notifications/briefing?lat=17.38&lon=78.48')
    // Bounded staleness: the degraded blip is served for DEGRADED_CACHE_TTL_MS
    // (30 s default) — a HIT here is correct; a full-TTL freeze would not be.
    expect(second.headers['x-cache']).toBe('hit')
    expect(calls).toBe(1)
  })

  it('honours lang and falls back for unknown languages', async () => {
    const te = await request(app).get(
      '/api/v1/notifications/briefing?lat=17.38&lon=78.48&city=Hyderabad&lang=te',
    )
    expect(te.body.title).toBe('ఈరోజు Hyderabadలో')

    const xx = await request(app).get(
      '/api/v1/notifications/briefing?lat=17.38&lon=78.48&city=Hyderabad&lang=zz',
    )
    expect(xx.body.language).toBe('en')
  })
})

describe('GET /api/v1/notifications/alerts', () => {
  it('serves near-fresh alerts from the microcache, per language', async () => {
    const alertCalls: Array<{ coord?: { latitude: number; longitude: number }; lang: string }> = []
    const counting: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        publicAlerts: async (c: { latitude: number; longitude: number }, lang: string) => {
          alertCalls.push({ coord: c, lang })
          return { weatherAlerts: [] }
        },
      } as unknown as GoogleWeatherClient,
    }
    const alertsApp = createApp(config, counting)
    const first = await request(alertsApp).get('/api/v1/notifications/alerts?lat=1.5&lon=2.5')
    const repeat = await request(alertsApp).get('/api/v1/notifications/alerts?lat=1.5&lon=2.5')
    const te = await request(alertsApp).get('/api/v1/notifications/alerts?lat=1.5&lon=2.5&lang=te')
    expect(first.status).toBe(200)
    expect(repeat.status).toBe(200)
    expect(te.status).toBe(200)
    // Within the microcache TTL the herd shares one upstream call; a
    // different language (different alerts) is its own entry.
    expect(alertCalls).toEqual([
      { coord: { latitude: 1.5, longitude: 2.5 }, lang: 'en' },
      { coord: { latitude: 1.5, longitude: 2.5 }, lang: 'te' },
    ])
    expect(first.headers['x-cache']).toBe('miss')
    expect(repeat.headers['x-cache']).toBe('hit')
    expect(te.headers['x-cache']).toBe('miss')
    expect(te.headers['cache-control']).toBe('no-store')
  })
})

describe('GET /api/v1/notifications/briefing defaults', () => {
  it('defaults city, units and language', async () => {
    const res = await request(app).get('/api/v1/notifications/briefing?lat=17.38&lon=78.48')
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Today in your location')
    expect(res.body.body).toContain('°') // metric degrees rendered
    expect(res.body.language).toBe('en')
  })

  it('localizes the fallback city per pack — no English leaks into a Telugu title', async () => {
    const res = await request(app).get('/api/v1/notifications/briefing?lat=17.38&lon=78.48&lang=te')
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('ఈరోజు మీ ప్రాంతంలో')
  })

  it('rejects malformed lang, empty and bad coordinates on every weather route', async () => {
    expect((await request(app).get('/api/v1/notifications/briefing?lat=1&lon=2&lang=x')).status).toBe(400)
    expect((await request(app).get('/api/v1/weather/current?lat=91&lon=0')).status).toBe(400)
    expect((await request(app).get('/api/v1/weather/current?lat=0&lon=-181')).status).toBe(400)
    expect((await request(app).get('/api/v1/weather/bundle?lat=abc&lon=0')).status).toBe(400)
    // Empty strings must not coerce to 0 (that would serve weather for Null Island).
    expect((await request(app).get('/api/v1/weather/bundle?lat=&lon=0')).status).toBe(400)
    expect((await request(app).get('/api/v1/weather/current?lat=%20&lon=0')).status).toBe(400)
  })
})

describe('readiness / graceful drain', () => {
  it('health returns 503 while the process is draining', async () => {
    const { draining } = await import('../src/readiness.js')
    try {
      draining.value = true
      const res = await request(app).get('/api/v1/health')
      expect(res.status).toBe(503)
      expect(res.body.status).toBe('draining')
    } finally {
      draining.value = false
    }
    const ok = await request(app).get('/api/v1/health')
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('ok')
  })
})

describe('response compression', () => {
  // >1 KB so the compression threshold actually engages.
  const bigBundle = { ...fixtureBundle, padding: 'x'.repeat(8192) }
  const gzipServices: Services = {
    ...services,
    weather: {
      coreBundle: async () => bigBundle,
      currentConditions: async () => fixtureBundle.currentConditions,
      publicAlerts: async () => ({}),
    } as unknown as GoogleWeatherClient,
  }
  const gzipApp = createApp(config, gzipServices)

  it('gzips large JSON responses for clients that accept it', async () => {
    const res = await request(gzipApp)
      .get('/api/v1/weather/bundle?lat=41.38&lon=2.17')
      .set('Accept-Encoding', 'gzip')
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    // The compressed path must still declare its media type — strict JSON
    // clients refuse untyped bodies (this is exactly the bug the commit's
    // first version shipped).
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers.vary).toContain('Accept-Encoding')
    // supertest decompresses transparently — the payload must still parse.
    expect(res.body.currentConditions.weatherCondition.type).toBe('CLEAR')
  })

  it('honors an explicit gzip;q=0 refusal (RFC 9110 negotiation)', async () => {
    const res = await request(gzipApp)
      .get('/api/v1/weather/bundle?lat=41.38&lon=2.17')
      .set('Accept-Encoding', 'gzip;q=0')
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
  })

  it('accepts gzip via the * wildcard token', async () => {
    const res = await request(gzipApp)
      .get('/api/v1/weather/bundle?lat=41.38&lon=2.17')
      .set('Accept-Encoding', '*')
    expect(res.headers['content-encoding']).toBe('gzip')
  })

  it('sets Vary: Accept-Encoding even on the identity path', async () => {
    const res = await request(gzipApp)
      .get('/api/v1/weather/bundle?lat=41.38&lon=2.17')
      .set('Accept-Encoding', 'identity')
    expect(res.headers.vary).toContain('Accept-Encoding')
  })

  it('leaves small responses and non-gzip clients untouched', async () => {
    const plain = await request(app).get('/api/v1/health')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.status).toBe('ok')
  })
})

describe('GET /api/v1/geocode', () => {
  it('validates and defaults the count, and shares cache across letter case', async () => {
    let searches: Array<{ name: string; count: number }> = []
    const counting: Services = {
      ...services,
      geocodeCache: new TtlCache(60_000),
      geocoding: {
        search: async (name: string, count: number) => {
          searches.push({ name, count })
          return { results: [] }
        },
      } as unknown as GeocodingClient,
    }
    const geoApp = createApp(config, counting)

    await request(geoApp).get('/api/v1/geocode?name=%20%20Hyderabad%20%20')
    await request(geoApp).get('/api/v1/geocode?name=hyderabad')
    expect(searches).toEqual([{ name: 'Hyderabad', count: 12 }]) // trimmed once, case-shared

    // A different name is a different cache entry — it must hit upstream.
    await request(geoApp).get('/api/v1/geocode?name=Secunderabad')
    expect(searches).toEqual([
      { name: 'Hyderabad', count: 12 },
      { name: 'Secunderabad', count: 12 },
    ])

    expect((await request(geoApp).get('/api/v1/geocode?name=H')).status).toBe(400)
    expect((await request(geoApp).get('/api/v1/geocode')).status).toBe(400)
    expect((await request(geoApp).get('/api/v1/geocode?name=Hyderabad&count=26')).status).toBe(400)
    expect((await request(geoApp).get('/api/v1/geocode?name=Hyderabad&count=0')).status).toBe(400)
  })
})

describe('GET /api/v1/geocode/reverse', () => {
  it('resolves coordinates, validates input and caches by coordinate', async () => {
    let calls: Array<{ lat: number; lon: number }> = []
    const counting: Services = {
      ...services,
      geocodeCache: new TtlCache(60_000),
      geocoding: {
        search: async () => ({ results: [] }),
        reverse: async (lat: number, lon: number) => {
          calls.push({ lat, lon })
          return { name: 'Mountain View', admin1: 'California', country: 'United States' }
        },
      } as unknown as GeocodingClient,
    }
    const revApp = createApp(config, counting)

    const first = await request(revApp).get('/api/v1/geocode/reverse?lat=37.42&lon=-122.08')
    expect(first.status).toBe(200)
    expect(first.body).toEqual({
      name: 'Mountain View',
      admin1: 'California',
      country: 'United States',
    })

    // Same coordinates hit the cache, not the upstream.
    await request(revApp).get('/api/v1/geocode/reverse?lat=37.42&lon=-122.08')
    expect(calls).toEqual([{ lat: 37.42, lon: -122.08 }])

    expect((await request(revApp).get('/api/v1/geocode/reverse?lat=91&lon=0')).status).toBe(400)
    expect((await request(revApp).get('/api/v1/geocode/reverse?lat=0&lon=-181')).status).toBe(400)
    expect((await request(revApp).get('/api/v1/geocode/reverse')).status).toBe(400)
  })
})

describe('device registry', () => {
  const device = {
    deviceId: 'device-abc12345',
    language: 'te',
    city: {
      id: 'hyderabad',
      name: 'Hyderabad',
      latitude: 17.385,
      longitude: 78.4867,
      timeZone: 'Asia/Kolkata',
    },
    notificationTime: { hour: 8, minute: 0 },
    units: 'metric',
    alertsEnabled: true,
  }

  it('registers, reads and deletes a device using its issued secret', async () => {
    const created = await request(app).post('/api/v1/devices').send(device)
    expect(created.status).toBe(201)
    expect(created.body.deviceId).toBe(device.deviceId)
    expect(created.body.deviceSecret).toMatch(/^[0-9a-f]{64}$/)

    const read = await request(app)
      .get(`/api/v1/devices/${device.deviceId}`)
      .set('X-Device-Secret', created.body.deviceSecret)
    expect(read.status).toBe(200)
    expect(read.body.language).toBe('te')
    expect(read.body.city.name).toBe('Hyderabad')
    // Secrets (hash or plaintext) must never come back on reads.
    expect(read.body.secretHash).toBeUndefined()

    // A correct deviceId with a WRONG secret must never authenticate —
    // record existence alone is not authorization.
    const wrongSecret = await request(app)
      .get(`/api/v1/devices/${device.deviceId}`)
      .set('X-Device-Secret', 'deadbeef'.repeat(8))
    expect(wrongSecret.status).toBe(401)

    const removed = await request(app)
      .delete(`/api/v1/devices/${device.deviceId}`)
      .set('X-Device-Secret', created.body.deviceSecret)
    expect(removed.status).toBe(204)

    const gone = await request(app)
      .get(`/api/v1/devices/${device.deviceId}`)
      .set('X-Device-Secret', created.body.deviceSecret)
    expect(gone.status).toBe(401) // same answer as an unknown device — no enumeration
  })

  it('rejects malformed registrations', async () => {
    const res = await request(app).post('/api/v1/devices').send({ deviceId: 'x' })
    expect(res.status).toBe(400)
  })

  it('enforces every field bound', async () => {
    const base = {
      deviceId: 'device-bounds001',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    }
    const cases = [
      { ...base, deviceId: 'short' }, // < 8 chars
      { ...base, notificationTime: { hour: 24, minute: 0 } }, // hour max 23
      { ...base, notificationTime: { hour: 8, minute: -1 } }, // minute min 0
      { ...base, notificationTime: { hour: 8, minute: 60 } }, // minute max 59
      { ...base, notificationTime: { hour: 8.5, minute: 0 } }, // hours are integers
      { ...base, city: { ...base.city, latitude: 91 } },
      { ...base, city: { ...base.city, longitude: 181 } },
      { ...base, city: { ...base.city, timeZone: 'x'.repeat(65) } },
      { ...base, units: 'kelvin' },
      { ...base, language: 'e' },
    ]
    for (const body of cases) {
      const res = await request(app).post('/api/v1/devices').send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.message).toContain('Invalid device registration')
    }
  })

  it('accepts imperial units and trims identifiers on the way in', async () => {
    const reg = await request(app).post('/api/v1/devices').send({
      deviceId: '  device-trimmed1  ',
      language: ' te ',
      city: { id: ' c ', name: ' Shimla ', latitude: 1, longitude: 1, timeZone: ' Asia/Kolkata ' },
      notificationTime: { hour: 8, minute: 0 },
      units: 'imperial',
    })
    expect(reg.status).toBe(201)
    expect(reg.headers['cache-control']).toBe('no-store')
    expect(reg.body.deviceId).toBe('device-trimmed1')

    const read = await request(app)
      .get('/api/v1/devices/device-trimmed1')
      .set('X-Device-Secret', reg.body.deviceSecret)
    expect(read.status).toBe(200)
    expect(read.body.language).toBe('te')
    expect(read.body.units).toBe('imperial')
    expect(read.body.city.name).toBe('Shimla')
    expect(read.body.city.id).toBe('c')
    expect(read.body.city.timeZone).toBe('Asia/Kolkata')
  })

  it('requires notificationTime and applies schema defaults', async () => {
    const missing = await request(app).post('/api/v1/devices').send({
      deviceId: 'device-defaults1',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
    })
    expect(missing.status).toBe(400)

    const reg = await request(app).post('/api/v1/devices').send({
      deviceId: 'device-defaults2',
      language: 'en',
      city: { id: 'c', name: '  Testville  ', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(reg.status).toBe(201)
    expect(new Date(reg.body.updatedAt).toISOString()).toBe(reg.body.updatedAt)

    const read = await request(app)
      .get('/api/v1/devices/device-defaults2')
      .set('X-Device-Secret', reg.body.deviceSecret)
    expect(read.status).toBe(200)
    expect(read.body.units).toBe('metric')
    expect(read.body.alertsEnabled).toBe(true)
    expect(read.body.city.name).toBe('Testville') // trimmed
    expect(read.headers['cache-control']).toBe('no-store')
  })
  it('normalizes device language onto a supported pack code', async () => {
    const reg = await request(app).post('/api/v1/devices').send({
      deviceId: 'device-langnorm1',
      language: 'te-IN',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(reg.status).toBe(201)
    const read = await request(app)
      .get('/api/v1/devices/device-langnorm1')
      .set('X-Device-Secret', reg.body.deviceSecret)
    expect(read.body.language).toBe('te')

    const fallback = await request(app).post('/api/v1/devices').send({
      deviceId: 'device-langnorm2',
      language: 'zz',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(fallback.status).toBe(201)
    const read2 = await request(app)
      .get('/api/v1/devices/device-langnorm2')
      .set('X-Device-Secret', fallback.body.deviceSecret)
    expect(read2.body.language).toBe('en') // unknown codes store as English, never junk
  })

  it('exactly one 201 wins a concurrent first registration for the same id', async () => {
    const body = {
      deviceId: 'device-race00001',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    }
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/devices').send(body),
      request(app).post('/api/v1/devices').send(body),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 401]) // the loser cannot seize the record
    const winner = a.status === 201 ? a : b
    // The winner's secret actually works on the record that exists.
    const read = await request(app)
      .get('/api/v1/devices/device-race00001')
      .set('X-Device-Secret', winner.body.deviceSecret)
    expect(read.status).toBe(200)
  })

  it('rotates a device secret: old stops working, new works', async () => {
    const reg = await request(app).post('/api/v1/devices').send({
      deviceId: 'device-rotate001',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(reg.status).toBe(201)

    const rotated = await request(app)
      .post('/api/v1/devices/device-rotate001/secret')
      .set('X-Device-Secret', reg.body.deviceSecret)
    expect(rotated.status).toBe(200)
    expect(rotated.body.deviceSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(rotated.body.deviceSecret).not.toBe(reg.body.deviceSecret)

    expect(
      (await request(app).get('/api/v1/devices/device-rotate001').set('X-Device-Secret', reg.body.deviceSecret)).status,
    ).toBe(401) // the leaked/old secret is dead
    expect(
      (await request(app).get('/api/v1/devices/device-rotate001').set('X-Device-Secret', rotated.body.deviceSecret)).status,
    ).toBe(200)
  })

  it('rejects unauthenticated secret rotation', async () => {
    const reg = await request(app).post('/api/v1/devices').send({
      deviceId: 'device-rotate002',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(reg.status).toBe(201)
    expect(
      (await request(app).post('/api/v1/devices/device-rotate002/secret')).status,
    ).toBe(401)
  })
})

describe('device registry charset anchoring', () => {
  it('rejects identifiers with leading junk before a valid suffix', async () => {
    const res = await request(app).post('/api/v1/devices').send({
      deviceId: '!@#abcdefgh',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toBe(
      'Invalid device registration: must contain only letters, digits, . _ : -',
    )
  })

  it('rejects identifiers with trailing junk after a valid prefix', async () => {
    const res = await request(app).post('/api/v1/devices').send({
      deviceId: 'abcdefgh!@#',
      language: 'en',
      city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toBe(
      'Invalid device registration: must contain only letters, digits, . _ : -',
    )
  })
})

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const res = await request(app).get('/api/v1/nope')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})

describe('resolvePack — Chinese script/region handling', () => {
  // Behind the /languages + device-language path: the primary-subtag scan
  // alone would hand every zh* locale Simplified Chinese by pack order.
  it('maps Traditional-script and HK/MO/TW locales to zh-TW', async () => {
    const { resolvePack } = await import('../src/i18n/index.js')
    for (const code of ['zh-HK', 'zh-Hant', 'zh-Hant-TW', 'zh-TW', 'zh_MO', 'zh_tw', 'zh-Latn-TW', 'zh-419-HK']) {
      expect(resolvePack(code).code).toBe('zh-TW')
    }
    expect(resolvePack('zh').code).toBe('zh-CN')
    expect(resolvePack('zh-SG').code).toBe('zh-CN')
  })
})

describe('acceptsGzip negotiation (RFC 9110)', () => {
  it('decides every token/q-value combination correctly', async () => {
    const { acceptsGzip } = await import('../src/compression.js')
    expect(acceptsGzip('gzip')).toBe(true)
    expect(acceptsGzip('GZIP')).toBe(true)
    expect(acceptsGzip('x-gzip')).toBe(true)
    expect(acceptsGzip('deflate, gzip;q=1.0')).toBe(true)
    expect(acceptsGzip('gzip;q=0.5, br')).toBe(true)
    expect(acceptsGzip('*')).toBe(true)
    expect(acceptsGzip('*;q=0.3')).toBe(true)
    expect(acceptsGzip('*;q=0')).toBe(false) // wildcard refusal
    expect(acceptsGzip('gzip;q=1.0, gzip;q=0')).toBe(true) // most permissive token wins
    expect(acceptsGzip('gzip;q=0')).toBe(false) // explicit refusal
    expect(acceptsGzip('gzip;q=0.0')).toBe(false)
    expect(acceptsGzip('*, gzip;q=0')).toBe(false) // explicit beats wildcard
    expect(acceptsGzip('gzip;q=abc')).toBe(false) // unusable q → 0
    expect(acceptsGzip('br, deflate')).toBe(false)
    expect(acceptsGzip('')).toBe(false)
    expect(acceptsGzip('gzip,')).toBe(true) // empty trailing token
    expect(acceptsGzip('gzip;v=1')).toBe(true) // non-q directives ignored
    expect(acceptsGzip('gzip;q')).toBe(false) // malformed q directive = refusal
  })
})

describe('guarded device writes reject when the hash moved on', () => {
  // The middleware verified the secret, but a concurrent rotation changed
  // the record before the write: both guarded routes must answer 401
  // instead of silently clobbering the newer state.
  it('re-registration and rotation both fail closed', async () => {
    const guardedDevices = Object.assign(Object.create(Object.getPrototypeOf(services.devices)), services.devices, {
      updateIfSecretMatches: async () => null,
    })
    const guardedApp = createApp(config, { ...services, devices: guardedDevices })

    // Register a device through the real store, capture its secret.
    const reg = await request(app)
      .post('/api/v1/devices')
      .send(deviceBody())
    expect(reg.status).toBe(201)
    const secret: string = reg.body.deviceSecret

    // Re-registration (update path) → guard rejects → 401.
    const update = await request(guardedApp)
      .post('/api/v1/devices')
      .set('X-Device-Secret', secret)
      .send(deviceBody())
    expect(update.status).toBe(401)

    // Rotation → guard rejects → 401, and no secret is handed out.
    const rotate = await request(guardedApp)
      .post(`/api/v1/devices/${reg.body.deviceId}/secret`)
      .set('X-Device-Secret', secret)
    expect(rotate.status).toBe(401)
    expect(rotate.body.deviceSecret).toBeUndefined()
  })
})

function deviceBody() {
  return {
    deviceId: 'guard-race-0001',
    language: 'en',
    city: { id: 'c', name: 'T', latitude: 1, longitude: 2 },
    notificationTime: { hour: 8, minute: 0 },
    units: 'metric',
    alertsEnabled: true,
  }
}

describe('alerts fail soft inside the bundle', () => {
  it('a failing alerts endpoint degrades the bundle but still serves the core', async () => {
    const alertsDown: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => {
          throw new Error('alerts endpoint down')
        },
      } as unknown as GoogleWeatherClient,
    }
    const app2 = createApp(config, alertsDown)
    const res = await request(app2).get('/api/v1/weather/bundle?lat=12.34&lon=56.78')
    expect(res.status).toBe(200)
    expect(res.body.degraded).toBe(true)
    expect(res.body.currentConditions.weatherCondition.type).toBe('CLEAR')
  })
})

describe('client disconnects abort the upstream fan-out', () => {
  it('a hung-up client cancels the in-flight upstream load', async () => {
    const http = await import('node:http')
    let observed: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async (_c: unknown, signal?: AbortSignal) => {
          observed = signal
          await gate
          return fixtureBundle
        },
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const server = http.createServer(createApp(config, slow))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    // A dedicated, non-keep-alive agent: destroying this socket must never
    // disturb the process-global agent that supertest shares with the other
    // concurrently running test files.
    const agent = new http.Agent({ keepAlive: false })
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/weather/bundle?lat=44.44&lon=55.55',
        agent,
      },
      () => {},
    )
    req.on('error', () => {}) // the destroy below surfaces as ECONNRESET here
    req.end()
    // Wait until the upstream loader holds the request-scoped signal, then
    // hang up the socket out from under it.
    await vi.waitFor(() => {
      if (observed === undefined) throw new Error('upstream not reached yet')
    })
    req.destroy()
    await vi.waitFor(() => {
      if (!observed!.aborted) throw new Error('scope not aborted yet')
    })
    release!()
    await new Promise<void>((r) => server.close(() => r()))
  }, 10_000)
})

describe('compression threshold boundary', () => {
  it('compresses exactly at THRESHOLD_BYTES and not one byte below', async () => {
    const express = (await import('express')).default
    const { gzipJsonMiddleware } = await import('../src/compression.js')
    const bodyAt = (n: number) => {
      // {"padding":"…"} — tune the pad so the serialized JSON is exactly n bytes.
      const overhead = JSON.stringify({ padding: '' }).length - 2 // quotes of ''
      return { padding: 'X'.repeat(n - overhead - JSON.stringify({ padding: '' }).length + 0) }
    }
    const sizedBody = (n: number): Record<string, string> => {
      const base = JSON.stringify({ padding: '' }).length // length with empty pad
      return { padding: 'X'.repeat(n - base) }
    }
    const appFor = (n: number) => {
      const app = express()
      app.use(gzipJsonMiddleware)
      app.get('/x', (_req, res) => res.json(sizedBody(n)))
      return app
    }
    expect(Buffer.byteLength(JSON.stringify(sizedBody(1024)))).toBe(1024)
    expect(Buffer.byteLength(JSON.stringify(sizedBody(1023)))).toBe(1023)

    const at = await request(appFor(1024)).get('/x').set('Accept-Encoding', 'gzip')
    expect(at.headers['content-encoding']).toBe('gzip')
    const below = await request(appFor(1023)).get('/x').set('Accept-Encoding', 'gzip')
    expect(below.headers['content-encoding']).toBeUndefined()
  })

  it('parses tokens and directives with generous whitespace', async () => {
    const { acceptsGzip } = await import('../src/compression.js')
    expect(acceptsGzip('  gzip  ')).toBe(true)
    expect(acceptsGzip('gzip ; q=0.5 , br')).toBe(true)
    expect(acceptsGzip('GZip;Q=0')).toBe(false)
  })
})

describe('exact cacheability header values', () => {
  it('static routes advertise their exact TTLs and ages', async () => {
    const langs = await request(app).get('/api/v1/languages')
    expect(langs.headers['cache-control']).toBe('public, max-age=86400')

    const bundle = await request(app).get('/api/v1/weather/bundle?lat=60.60&lon=60.60')
    expect(bundle.headers['x-alerts-age-seconds']).toBe('0')
    expect(bundle.headers['x-data-age-seconds']).toBe('0')

    const geo = await request(app).get('/api/v1/geocode?name=Hyderabad')
    expect(geo.headers['cache-control']).toBe('public, max-age=300')

    const rev = await request(app).get('/api/v1/geocode/reverse?lat=17.38&lon=78.48')
    expect(rev.headers['cache-control']).toBe('public, max-age=300')

    const alerts = await request(app).get('/api/v1/notifications/alerts?lat=61.61&lon=61.61')
    expect(alerts.headers['cache-control']).toBe('no-store')
    expect(alerts.headers['x-data-age-seconds']).toBe('0')

    const missing = await request(app).get('/api/v1/nope')
    expect(missing.headers['cache-control']).toBe('no-store')
  })

  it('secret rotation responses are no-store', async () => {
    const body = { ...deviceBody(), deviceId: 'rot-store-00001' }
    const reg = await request(app).post('/api/v1/devices').send(body)
    const secret = reg.body.deviceSecret as string
    const rotate = await request(app)
      .post(`/api/v1/devices/${reg.body.deviceId}/secret`)
      .set('X-Device-Secret', secret)
    expect(rotate.status).toBe(200)
    expect(rotate.headers['cache-control']).toBe('no-store')
  })
})

describe('acceptsGzip q-clamping', () => {
  it('clamps out-of-range q values to the valid range', async () => {
    const { acceptsGzip } = await import('../src/compression.js')
    expect(acceptsGzip('gzip;q=1.5')).toBe(true) // clamped to 1
    expect(acceptsGzip('gzip;q=-1')).toBe(false) // clamped to 0
    expect(acceptsGzip('gzip ; q=0')).toBe(false) // untrimmed directive must still parse
    expect(acceptsGzip('gzip;q =0')).toBe(false) // untrimmed KEY must still parse
    expect(acceptsGzip('gzip;level=0')).toBe(true) // non-q directives ignored
    expect(acceptsGzip('deflate ; x=1, gzip ; q=1')).toBe(true)
  })
})

describe('degraded plumbing at the route boundary', () => {
  it('a briefing built on an alerts-missing bundle makes no rain claim', async () => {
    // Low precip everywhere: a healthy bundle would say "No rain expected
    // today" — the degraded (alerts-missing) flag must suppress that claim.
    const dryBundle = {
      ...fixtureBundle,
      forecastHours: {
        forecastHours: fixtureBundle.forecastHours.forecastHours.map((h: { precipitation?: { probability?: { percent?: number } } }) => ({
          ...h,
          precipitation: { probability: { percent: 5 } },
        })),
      },
    }
    const alertsDown: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => dryBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => {
          throw new Error('alerts endpoint down')
        },
      } as unknown as GoogleWeatherClient,
    }
    const app3 = createApp(config, alertsDown)
    const res = await request(app3).get(
      '/api/v1/notifications/briefing?lat=13.13&lon=13.13&city=T',
    )
    expect(res.status).toBe(200)
    expect(res.body.body).not.toContain('No rain expected today')
    // The same dry bundle WITH alerts does claim it — proving the route's
    // degraded plumbing (not the generator alone) is the pivot.
    const healthyApp = createApp(config, {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => dryBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    })
    const healthy = await request(healthyApp).get(
      '/api/v1/notifications/briefing?lat=13.13&lon=13.13&city=T',
    )
    expect(healthy.body.body).toContain('No rain expected today')
  })

  it('an alerts-missing bundle clamps its advertised max-age to the short window', async () => {
    const alertsDown: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => {
          throw new Error('down')
        },
      } as unknown as GoogleWeatherClient,
    }
    const app4 = createApp(config, alertsDown)
    const res = await request(app4).get('/api/v1/weather/bundle?lat=14.14&lon=14.14')
    const maxAge = Number(res.headers['cache-control'].match(/max-age=(\d+)/)?.[1])
    expect(maxAge).toBeLessThanOrEqual(30)
  })
})

describe('cache-key namespaces and aged headers', () => {
  it('reverse geocode results are keyed apart from search results', async () => {
    // Same coordinate cell, same underlying cache instance: a search for
    // "rev-ish" text and a reverse lookup must never share an entry.
    const geoCalls: string[] = []
    const geo: Services = {
      ...services,
      geocodeCache: new TtlCache(60_000),
      geocoding: {
        search: async (name: string) => {
          geoCalls.push(`search:${name}`)
          return { results: [{ id: 1, name, latitude: 1, longitude: 2 }] }
        },
        reverse: async () => {
          geoCalls.push('reverse')
          return { name: 'Reverseville', admin1: '', country: '' }
        },
      } as unknown as GeocodingClient,
    }
    const geoApp = createApp(config, geo)
    const rev = await request(geoApp).get('/api/v1/geocode/reverse?lat=1.00&lon=2.00')
    expect(rev.body.name).toBe('Reverseville') // a search entry would echo `name` of the query
    const search = await request(geoApp).get('/api/v1/geocode?name=rev%7C1.00,2.00')
    expect(search.body.results[0].name).toBe('rev|1.00,2.00')
    expect(geoCalls).toEqual(['reverse', 'search:rev|1.00,2.00']) // two upstream calls, no cross-hit
  })

  it('aged hits advertise a nonzero data age and a reduced max-age', async () => {
    const aged: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const agedApp2 = createApp(config, aged)
    await request(agedApp2).get('/api/v1/weather/bundle?lat=15.15&lon=15.15')
    await new Promise((r) => setTimeout(r, 1_100))
    const hit = await request(agedApp2).get('/api/v1/weather/bundle?lat=15.15&lon=15.15')
    expect(hit.headers['x-cache']).toBe('hit')
    expect(Number(hit.headers['x-data-age-seconds'])).toBeGreaterThanOrEqual(1)
    const maxAge = Number(hit.headers['cache-control'].match(/max-age=(\d+)/)?.[1])
    expect(maxAge).toBeLessThan(60)
  })
})

describe('survivor-kill batch (mutation triage)', () => {
  it('a degraded briefing also clamps its private max-age', async () => {
    const alertsDown: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => {
          throw new Error('down')
        },
      } as unknown as GoogleWeatherClient,
    }
    const app5 = createApp(config, alertsDown)
    const res = await request(app5).get('/api/v1/notifications/briefing?lat=16.16&lon=16.16&city=T')
    expect(res.status).toBe(200)
    const maxAge = Number(res.headers['cache-control'].match(/max-age=(\d+)/)?.[1])
    expect(maxAge).toBeLessThanOrEqual(30)
  })

  it('the alerts-failed bundle omits the alerts age header entirely', async () => {
    const alertsDown: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => {
          throw new Error('down')
        },
      } as unknown as GoogleWeatherClient,
    }
    const app6 = createApp(config, alertsDown)
    const res = await request(app6).get('/api/v1/weather/bundle?lat=17.17&lon=17.17')
    expect(res.body.degraded).toBe(true)
    expect(res.headers['x-alerts-age-seconds']).toBeUndefined()
  })

  it('distinct reverse-geocode coordinates never share a cache entry', async () => {
    const revCalls: number[] = []
    const geo: Services = {
      ...services,
      geocodeCache: new TtlCache(60_000),
      geocoding: {
        search: async () => ({ results: [] }),
        reverse: async (lat: number) => {
          revCalls.push(lat)
          return { name: `P${lat}`, admin1: '', country: '' }
        },
      } as unknown as GeocodingClient,
    }
    const app7 = createApp(config, geo)
    const a = await request(app7).get('/api/v1/geocode/reverse?lat=10.10&lon=1.00')
    const b = await request(app7).get('/api/v1/geocode/reverse?lat=20.20&lon=2.00')
    expect(a.body.name).toBe('P10.1')
    expect(b.body.name).toBe('P20.2')
    expect(revCalls).toEqual([10.1, 20.2]) // a shared '' key would collapse these to one call
  })

  it('the alerts route advertises a nonzero age on an aged hit', async () => {
    const alertApp = createApp(config, {
      ...services,
      alertsCache: new TtlCache(60_000),
      coreCache: new TtlCache(60_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({ weatherAlerts: [] }),
      } as unknown as GoogleWeatherClient,
    })
    await request(alertApp).get('/api/v1/notifications/alerts?lat=18.18&lon=18.18')
    await new Promise((r) => setTimeout(r, 1_100))
    const hit = await request(alertApp).get('/api/v1/notifications/alerts?lat=18.18&lon=18.18')
    expect(hit.headers['x-cache']).toBe('hit')
    const age = Number(hit.headers['x-data-age-seconds'])
    expect(age).toBeGreaterThanOrEqual(1)
    expect(age).toBeLessThan(10)
  })

  it('device registration normalizes the stored language code', async () => {
    const reg = await request(app)
      .post('/api/v1/devices')
      .send({ ...deviceBody(), deviceId: 'lang-norm-0001', language: 'EN-us' })
    expect(reg.status).toBe(201)
    const secret = reg.body.deviceSecret as string
    const me = await request(app)
      .get(`/api/v1/devices/lang-norm-0001`)
      .set('X-Device-Secret', secret)
    expect(me.body.language).toBe('en')
  })

  it('identity responses quote the exact 401 copy', async () => {
    const missing = await request(app).get('/api/v1/devices/nobody-12345678')
    expect(missing.status).toBe(401)
    expect(missing.body.message).toBe('Missing or invalid device secret.')
  })

  it('a request with no Accept-Encoding header at all is served identity', async () => {
    const res = await request(app)
      .get('/api/v1/weather/bundle?lat=19.19&lon=19.19')
      // supertest sends no Accept-Encoding by default unless set.
      .unset('Accept-Encoding')
    expect(res.status).toBe(200)
    expect(res.body.currentConditions.weatherCondition.type).toBe('CLEAR')
  })

  it('the compressed path carries no ETag', async () => {
    const bigBundle = { ...fixtureBundle, padding: 'y'.repeat(4096) }
    const etagApp = createApp(config, {
      ...services,
      coreCache: new TtlCache(60_000),
      weather: {
        coreBundle: async () => bigBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    })
    const res = await request(etagApp)
      .get('/api/v1/weather/bundle?lat=43.43&lon=4.44')
      .set('Accept-Encoding', 'gzip')
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers.etag).toBeUndefined()
  })

  it('most permissive duplicate token wins (max, not first)', async () => {
    const { acceptsGzip } = await import('../src/compression.js')
    expect(acceptsGzip('gzip;q=0, gzip;q=1')).toBe(true)
  })
})

describe('healthy briefing plumbing', () => {
  it('a fully healthy core produces the rain line through the route', async () => {
    const res = await request(app).get(
      '/api/v1/notifications/briefing?lat=20.20&lon=20.20&city=Healthy',
    )
    expect(res.status).toBe(200)
    expect(res.body.body).toContain('Rain likely')
  })

  it('an aged bundle hit advertises a nonzero alerts age too', async () => {
    const aged: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => fixtureBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const agedApp3 = createApp(config, aged)
    await request(agedApp3).get('/api/v1/weather/bundle?lat=21.21&lon=21.21')
    await new Promise((r) => setTimeout(r, 1_100))
    const hit = await request(agedApp3).get('/api/v1/weather/bundle?lat=21.21&lon=21.21')
    expect(hit.headers['x-cache']).toBe('hit')
    // Exact-ish: a ÷1000→×1000 mutant yields 1100, far outside the window.
    const alertsAge = Number(hit.headers['x-alerts-age-seconds'])
    const dataAge = Number(hit.headers['x-data-age-seconds'])
    expect(alertsAge).toBeGreaterThanOrEqual(1)
    expect(alertsAge).toBeLessThan(10)
    expect(dataAge).toBeGreaterThanOrEqual(1)
    expect(dataAge).toBeLessThan(10)
  })
})

describe('core-degraded briefing plumbing', () => {
  it('a CORE-degraded dry bundle also stays silent on rain', async () => {
    const dryBundle = {
      ...fixtureBundle,
      degraded: true,
      forecastHours: {
        forecastHours: fixtureBundle.forecastHours.forecastHours.map((h: { precipitation?: { probability?: { percent?: number } } }) => ({
          ...h,
          precipitation: { probability: { percent: 5 } },
        })),
      },
    }
    const coreDown: Services = {
      ...services,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      weather: {
        coreBundle: async () => dryBundle,
        currentConditions: async () => fixtureBundle.currentConditions,
        publicAlerts: async () => ({}),
      } as unknown as GoogleWeatherClient,
    }
    const app8 = createApp(config, coreDown)
    const res = await request(app8).get('/api/v1/notifications/briefing?lat=22.22&lon=22.22&city=T')
    expect(res.status).toBe(200)
    expect(res.body.body).not.toContain('No rain expected today')
  })
})
