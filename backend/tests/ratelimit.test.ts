import { afterAll, describe, expect, it } from 'vitest'
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

process.env.LOG_LEVEL = 'silent'

// Fresh dir per run: the registry must never carry state across test runs
// (a stale record would turn the 201s below into takeover-refusal 401s).
const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cirrus-rl-'))
afterAll(() => rmSync(tmpDataDir, { recursive: true, force: true }))

function makeApp(overrides: Record<string, string>) {
  resetConfigCache()
  const config = loadConfig({
    WEATHER_API_KEY: 'test-key',
    DATA_DIR: tmpDataDir,
    ...overrides,
  } as NodeJS.ProcessEnv)
  const services: Services = {
    config,
    weather: {} as unknown as GoogleWeatherClient,
    geocoding: { search: async () => ({ results: [] }) } as unknown as GeocodingClient,
    coreCache: new TtlCache(60_000),
    alertsCache: new TtlCache(15_000),
    currentCache: new TtlCache(60_000),
    geocodeCache: new TtlCache(60_000),
    devices: new DeviceStore(tmpDataDir),
  }
  return createApp(config, services)
}

const device = (deviceId: string) => ({
  deviceId,
  language: 'en',
  city: { id: 'c', name: 'T', latitude: 1, longitude: 1 },
  notificationTime: { hour: 8, minute: 0 },
})

describe('rate limiting', () => {
  it('enforces the global per-IP budget', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '3' })
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(app).get('/api/v1/languages')),
    )
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 429])
    expect(results[3].body).toEqual({
      error: 'rate_limited',
      message: 'Too many requests, slow down.',
    })
  })

  it('applies a tighter budget to geocode than the global limit', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '100', GEOCODE_RATE_LIMIT_MAX: '2' })
    const a = await request(app).get('/api/v1/geocode?name=Hyderabad')
    const b = await request(app).get('/api/v1/geocode?name=Hyderabad')
    const c = await request(app).get('/api/v1/geocode?name=Hyderabad')
    expect([a.status, b.status, c.status]).toEqual([200, 200, 429])
    // The global budget is untouched — other routes still work.
    const other = await request(app).get('/api/v1/languages')
    expect(other.status).toBe(200)
  })

  it('applies a tighter budget to device writes', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '100', DEVICE_WRITE_RATE_LIMIT_MAX: '2' })
    const a = await request(app).post('/api/v1/devices').send(device('device-aaaa1111'))
    const b = await request(app).post('/api/v1/devices').send(device('device-bbbb2222'))
    const c = await request(app).post('/api/v1/devices').send(device('device-cccc3333'))
    expect([a.status, b.status, c.status]).toEqual([201, 201, 429])
  })

  it('does not let the geocode budget block weather reads', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '100', GEOCODE_RATE_LIMIT_MAX: '1' })
    expect((await request(app).get('/api/v1/geocode?name=Hyderabad')).status).toBe(200)
    expect((await request(app).get('/api/v1/geocode?name=Secunderabad')).status).toBe(429)
    expect((await request(app).get('/api/v1/languages')).status).toBe(200)
  })

  it('buckets rate limits per client behind the proxy', async () => {
    // Default trust ('loopback'): X-Forwarded-For from a loopback client
    // identifies the client, so different forwarded IPs get separate budgets.
    const app = makeApp({ RATE_LIMIT_MAX: '1' })
    const ips = ['9.9.9.9', '8.8.8.8', '7.7.7.7']
    const results = await Promise.all(
      ips.map((ip) => request(app).get('/api/v1/languages').set('X-Forwarded-For', ip)),
    )
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])

    // A second request from an exhausted bucket is throttled…
    const repeat = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '9.9.9.9')
    expect(repeat.status).toBe(429)
    // …while a fresh IP still passes.
    const fresh = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '6.6.6.6')
    expect(fresh.status).toBe(200)
  })

  it('trusts exactly one proxy hop when TRUST_PROXY=1', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '1', TRUST_PROXY: '1' })
    const a = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '9.9.9.9')
    const b = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '8.8.8.8')
    // Different forwarded clients get separate budgets...
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // ...and the same forwarded client shares one budget.
    const c = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '9.9.9.9')
    expect(c.status).toBe(429)
  })

  it('TRUST_PROXY=0 ignores X-Forwarded-For — no bucket minting by header spoofing', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '1', TRUST_PROXY: '0' })
    const first = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '9.9.9.9')
    expect(first.status).toBe(200)
    // A spoofed "different client" shares the same real-IP bucket.
    const spoofed = await request(app).get('/api/v1/languages').set('X-Forwarded-For', '8.8.8.8')
    expect(spoofed.status).toBe(429)
  })

  it('applies a tighter per-route budget to weather reads than the global limit', async () => {
    resetConfigCache()
    const config = loadConfig({
      WEATHER_API_KEY: 'test-key',
      DATA_DIR: tmpDataDir,
      RATE_LIMIT_MAX: '100',
      WEATHER_RATE_LIMIT_MAX: '2',
    } as NodeJS.ProcessEnv)
    const services: Services = {
      config,
      weather: {
        currentConditions: async () => ({}),
      } as unknown as GoogleWeatherClient,
      geocoding: { search: async () => ({ results: [] }) } as unknown as GeocodingClient,
      coreCache: new TtlCache(60_000),
      alertsCache: new TtlCache(15_000),
      currentCache: new TtlCache(60_000),
      geocodeCache: new TtlCache(60_000),
      devices: new DeviceStore(tmpDataDir),
    }
    const app = createApp(config, services)
    const hit = (path: string) => request(app).get(path)
    expect((await hit('/api/v1/weather/current?lat=1&lon=1')).status).toBe(200)
    expect((await hit('/api/v1/weather/current?lat=1&lon=1')).status).toBe(200)
    expect((await hit('/api/v1/weather/current?lat=1&lon=1')).status).toBe(429)
    // The weather budget does not leak into other routes.
    expect((await hit('/api/v1/languages')).status).toBe(200)
  })
})
