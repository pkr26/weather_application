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
import {
  generateDeviceSecret,
  hashDeviceSecret,
  verifyDeviceSecret,
} from '../src/security/deviceAuth.js'

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cirrus-sec-'))
afterAll(() => rmSync(tmpDataDir, { recursive: true, force: true }))

process.env.LOG_LEVEL = 'silent'

function makeApp(overrides: Record<string, string> = {}) {
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

describe('device secret primitives', () => {
  it('issues 64-hex-char secrets that never repeat', () => {
    const a = generateDeviceSecret()
    const b = generateDeviceSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })

  it('produces the pinned SHA-256 digest for a known input', () => {
    // Cross-implementation compatibility pin: the stored hash format must
    // never drift (encoding, algorithm, or input handling).
    expect(hashDeviceSecret('cirrus')).toBe(
      'fded586871aa2ef47b1547e38751d20e1414ddb4ee4d64b3cc9d94865f6c41b0',
    )
  })

  it('verifies the matching secret', () => {
    const secret = generateDeviceSecret()
    expect(verifyDeviceSecret(secret, hashDeviceSecret(secret))).toBe(true)
  })

  it('rejects wrong, missing and malformed inputs', () => {
    const secret = generateDeviceSecret()
    const hash = hashDeviceSecret(secret)
    expect(verifyDeviceSecret('wrong', hash)).toBe(false)
    expect(verifyDeviceSecret(undefined, hash)).toBe(false)
    expect(verifyDeviceSecret(secret, undefined)).toBe(false)
    // Stored value that is not a SHA-256 length hash must not throw.
    expect(verifyDeviceSecret(secret, 'abcd')).toBe(false)
  })
})

describe('device registry authentication', () => {
  const app = makeApp()
  const device = {
    deviceId: 'sec-device-0001',
    language: 'en',
    city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
    notificationTime: { hour: 7, minute: 30 },
  }

  it('issues a secret on registration', async () => {
    const res = await request(app).post('/api/v1/devices').send(device)
    expect(res.status).toBe(201)
    expect(res.body.deviceSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(res.body.secretHash).toBeUndefined()
  })

  it('denies reads and deletes without or with a wrong secret', async () => {
    const noSecret = await request(app).get(`/api/v1/devices/${device.deviceId}`)
    expect(noSecret.status).toBe(401)
    expect(noSecret.body.error).toBe('unauthorized')

    const wrongSecret = await request(app)
      .get(`/api/v1/devices/${device.deviceId}`)
      .set('X-Device-Secret', 'deadbeef'.repeat(8))
    expect(wrongSecret.status).toBe(401)

    const wrongDelete = await request(app)
      .delete(`/api/v1/devices/${device.deviceId}`)
      .set('X-Device-Secret', 'deadbeef'.repeat(8))
    expect(wrongDelete.status).toBe(401)
  })

  it('gives the same 401 for an unknown device — no enumeration oracle', async () => {
    const res = await request(app)
      .get('/api/v1/devices/nonexistent-device')
      .set('X-Device-Secret', generateDeviceSecret())
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthorized')
  })

  it('rejects re-registration without the current secret — no takeover', async () => {
    const body = {
      deviceId: 'sec-device-take1',
      language: 'en',
      city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
      notificationTime: { hour: 9, minute: 15 },
    }
    const first = await request(app).post('/api/v1/devices').send(body)
    expect(first.status).toBe(201)

    // An attacker who knows (or guesses) the deviceId but not the secret
    // must not be able to rotate it and seize the record.
    const takeover = await request(app).post('/api/v1/devices').send({
      ...body,
      language: 'zh',
      alertsEnabled: false,
    })
    expect(takeover.status).toBe(401)
    expect(takeover.body.error).toBe('unauthorized')
    expect(takeover.body.message).toBe('Missing or invalid device secret.')
    expect(takeover.body.deviceSecret).toBeUndefined()

    // The rightful owner's secret still works and the record is untouched.
    const read = await request(app)
      .get(`/api/v1/devices/${body.deviceId}`)
      .set('X-Device-Secret', first.body.deviceSecret)
    expect(read.status).toBe(200)
    expect(read.body.language).toBe('en')
    expect(read.body.alertsEnabled).toBe(true)
  })

  it('keeps the secret when re-registration authenticates with it', async () => {
    const body = {
      deviceId: 'sec-device-keep1',
      language: 'en',
      city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    }
    const created = await request(app).post('/api/v1/devices').send(body)
    expect(created.status).toBe(201)

    // The device updates its own record presenting its stored secret.
    const updated = await request(app)
      .post('/api/v1/devices')
      .set('X-Device-Secret', created.body.deviceSecret)
      .send({ ...body, language: 'te' })
    expect(updated.status).toBe(200)
    expect(updated.headers['cache-control']).toBe('no-store')
    expect(updated.body.deviceSecret).toBeUndefined() // no rotation, no re-issue
    expect(updated.body.deviceId).toBe(body.deviceId)

    // The original secret still authenticates reads, and the update landed.
    const read = await request(app)
      .get(`/api/v1/devices/${body.deviceId}`)
      .set('X-Device-Secret', created.body.deviceSecret)
    expect(read.status).toBe(200)
    expect(read.body.language).toBe('te')

    // A wrong secret on an existing device is rejected — it must never
    // fall back to rotation semantics.
    const refused = await request(app)
      .post('/api/v1/devices')
      .set('X-Device-Secret', 'deadbeef'.repeat(8))
      .send(body)
    expect(refused.status).toBe(401)
    expect(refused.body.deviceSecret).toBeUndefined()
  })

  it('refuses the prototype-colliding identifiers by name', async () => {
    // The charset regex alone admits "__proto__" (underscore is legal), so
    // the explicit denylist is the control that must hold.
    for (const deviceId of ['__proto__', 'constructor', 'prototype']) {
      const res = await request(app).post('/api/v1/devices').send({
        deviceId,
        language: 'en',
        city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
        notificationTime: { hour: 8, minute: 0 },
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('bad_request')
      expect(res.body.message).toBe('Invalid device registration: reserved identifier')
    }

    // …and the charset message is the one clients see for bad characters.
    const charset = await request(app).post('/api/v1/devices').send({
      deviceId: 'has spaces!',
      language: 'en',
      city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    })
    expect(charset.body.message).toBe(
      'Invalid device registration: must contain only letters, digits, . _ : -',
    )
  })

  it('drops a submitted fcmToken instead of storing it', async () => {
    const deviceId = 'sec-device-nofcm'
    const created = await request(app).post('/api/v1/devices').send({
      deviceId,
      language: 'en',
      city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
      fcmToken: 'should-not-be-stored-1234',
    })
    expect(created.status).toBe(201)

    const read = await request(app)
      .get(`/api/v1/devices/${deviceId}`)
      .set('X-Device-Secret', created.body.deviceSecret)
    expect(read.status).toBe(200)
    expect(read.body).not.toHaveProperty('fcmToken')
    expect(read.body).not.toHaveProperty('secretHash')
  })
})

describe('API token gate', () => {
  it('leaves the API open when API_TOKEN is unset', async () => {
    const app = makeApp()
    const res = await request(app).get('/api/v1/languages')
    expect(res.status).toBe(200)
  })

  it('requires the token on every route except /health when set', async () => {
    const app = makeApp({ API_TOKEN: 'cirrus-shared-secret' })

    const bare = await request(app).get('/api/v1/languages')
    expect(bare.status).toBe(401)
    // The API-token 401 carries its own error code: the Android client
    // resets its device identity on "unauthorized", and no reset can fix a
    // missing API token — the two failure bodies must never be identical.
    expect(bare.body.error).toBe('invalid_api_token')
    expect(bare.body.message).toBe('Missing or invalid API token.')

    const wrong = await request(app).get('/api/v1/languages').set('X-Api-Token', 'nope')
    expect(wrong.status).toBe(401)

    const good = await request(app).get('/api/v1/languages').set('X-Api-Token', 'cirrus-shared-secret')
    expect(good.status).toBe(200)

    // Container/LB healthchecks must keep working without the token.
    const health = await request(app).get('/api/v1/health')
    expect(health.status).toBe(200)
    // Trailing-slash variants (LB normalisation) stay exempt too: the
    // exemption trims the slashes before matching.
    const healthSlash = await request(app).get('/api/v1/health/')
    expect(healthSlash.status).toBe(200)
    const healthSlashes = await request(app).get('/api/v1/health///')
    // Exempt from the gate — merely unrouted (404, never a gated 401).
    expect(healthSlashes.status).toBe(404)
  })

  it('guards writes with the token too', async () => {
    const app = makeApp({ API_TOKEN: 'cirrus-shared-secret' })
    const device = {
      deviceId: 'tok-device-0001',
      language: 'en',
      city: { id: 'c', name: 'Testville', latitude: 1, longitude: 1 },
      notificationTime: { hour: 8, minute: 0 },
    }
    const refused = await request(app).post('/api/v1/devices').send(device)
    expect(refused.status).toBe(401)

    const allowed = await request(app)
      .post('/api/v1/devices')
      .set('X-Api-Token', 'cirrus-shared-secret')
      .send(device)
    expect(allowed.status).toBe(201)
  })

  it('marks cacheable routes private while the token gate is on', async () => {
    // `public` would let a shared cache store token-gated payloads and serve
    // them to callers without the token — bypassing the gate entirely.
    const app = makeApp({ API_TOKEN: 'cirrus-shared-secret' })

    const langs = await request(app)
      .get('/api/v1/languages')
      .set('X-Api-Token', 'cirrus-shared-secret')
    expect(langs.status).toBe(200)
    expect(langs.headers['cache-control']).toBe('private, max-age=86400')

    const geo = await request(app)
      .get('/api/v1/geocode?name=Hyderabad')
      .set('X-Api-Token', 'cirrus-shared-secret')
    expect(geo.status).toBe(200)
    expect(geo.headers['cache-control']).toBe('private, max-age=300')
  })
})

describe('CORS', () => {
  it('sends no CORS headers when no origins are allowlisted', async () => {
    const app = makeApp()
    const res = await request(app)
      .get('/api/v1/languages')
      .set('Origin', 'https://evil.example')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('reflects only allowlisted origins', async () => {
    const app = makeApp({ CORS_ORIGINS: 'https://app.example.com' })
    const allowed = await request(app)
      .get('/api/v1/languages')
      .set('Origin', 'https://app.example.com')
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com')

    const denied = await request(app)
      .get('/api/v1/languages')
      .set('Origin', 'https://evil.example')
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('supports several allowlisted origins', async () => {
    const app = makeApp({ CORS_ORIGINS: 'https://a.example, https://b.example' })
    for (const origin of ['https://a.example', 'https://b.example']) {
      const res = await request(app).get('/api/v1/languages').set('Origin', origin)
      expect(res.headers['access-control-allow-origin']).toBe(origin)
    }
  })
})

describe('security headers', () => {
  const app = makeApp()

  it('ships the hardening header set on every response', async () => {
    const res = await request(app).get('/api/v1/languages')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(res.headers['x-permitted-cross-domain-policies']).toBe('none')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('never advertises the server implementation', async () => {
    const res = await request(app).get('/api/v1/nope')
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.headers)).not.toContain('Express')
    expect(res.body).toEqual({ error: 'not_found', message: 'No such endpoint.' })
  })

  it('rejects request bodies above the JSON size cap', async () => {
    const res = await request(app)
      .post('/api/v1/devices')
      .send({ deviceId: 'device-largebody', language: 'en', padding: 'x'.repeat(70_000) })
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('payload_too_large')
  })

  it('rejects malformed JSON bodies cleanly', async () => {
    const res = await request(app)
      .post('/api/v1/devices')
      .set('Content-Type', 'application/json')
      .send('{"deviceId": "device-json-bad", nope}')
    expect([400, 413]).toContain(res.status)
    expect(res.body.error).not.toBe('internal_error')
  })

  it('does not answer CORS preflights when no origins are allowlisted', async () => {
    const res = await request(app)
      .options('/api/v1/languages')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET')
    // Express' automatic OPTIONS response — no CORS headers attached.
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-methods']).toBeUndefined()
  })

  it('answers CORS preflights for allowlisted origins', async () => {
    const corsApp = makeApp({ CORS_ORIGINS: 'https://app.example.com' })
    const res = await request(corsApp)
      .options('/api/v1/languages')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET')
    expect(res.status).toBeLessThan(500)
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com')
  })

  it('uses standard rate-limit headers, not the legacy ones', async () => {
    const res = await request(app).get('/api/v1/languages')
    expect(res.headers['ratelimit-policy']).toBe('240;w=60')
    expect(res.headers['ratelimit']).toMatch(/^limit=240, remaining=\d+, reset=\d+$/)
    expect(res.headers['x-ratelimit-limit']).toBeUndefined()
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined()
  })
})
