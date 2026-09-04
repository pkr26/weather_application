import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, resetConfigCache } from '../src/config.js'

beforeEach(() => resetConfigCache())

describe('loadConfig', () => {
  it('applies safe defaults for a minimal environment', () => {
    const config = loadConfig({ WEATHER_API_KEY: 'k' } as NodeJS.ProcessEnv)
    expect(config.PORT).toBe(8080)
    expect(config.HOST).toBe('0.0.0.0')
    expect(config.UPSTREAM_TIMEOUT_MS).toBe(8000)
    expect(config.UPSTREAM_RETRIES).toBe(2)
    expect(config.CACHE_TTL_MS).toBe(600_000)
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60_000)
    expect(config.RATE_LIMIT_MAX).toBe(240)
    expect(config.GEOCODE_RATE_LIMIT_MAX).toBe(30)
    expect(config.DEVICE_RATE_LIMIT_MAX).toBe(20)
    expect(config.UPSTREAM_RETRY_BACKOFF_MS).toBe(100)
    expect(config.DEGRADED_CACHE_TTL_MS).toBe(30_000)
    expect(config.ALERTS_CACHE_TTL_MS).toBe(15_000)
    expect(config.BREAKER_FAILURES).toBe(5)
    expect(config.BREAKER_COOLDOWN_MS).toBe(30_000)
    expect(config.CORS_ORIGINS).toBe('')
    expect(config.API_TOKEN).toBe('')
    expect(config.MAX_DEVICES).toBe(25_000)
    expect(config.DEVICE_MAX_AGE_DAYS).toBe(365)
    expect(config.NODE_ENV).toBe('development')
  })

  it('honours the legacy DEVICE_WRITE_RATE_LIMIT_MAX name when the new one is unset', () => {
    resetConfigCache()
    const config = loadConfig({
      WEATHER_API_KEY: 'k',
      DEVICE_WRITE_RATE_LIMIT_MAX: '42',
    } as NodeJS.ProcessEnv)
    expect(config.DEVICE_RATE_LIMIT_MAX).toBe(42)
  })

  it('reads the real environment when called with no argument', () => {
    const had = process.env.WEATHER_API_KEY
    delete process.env.WEATHER_API_KEY
    try {
      expect(() => loadConfig()).toThrow(/WEATHER_API_KEY/)
    } finally {
      if (had !== undefined) process.env.WEATHER_API_KEY = had
    }
  })

  it('refuses to start without an API key', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/WEATHER_API_KEY/)
  })

  it('refuses invalid ports and retry counts', () => {
    expect(() =>
      loadConfig({ WEATHER_API_KEY: 'k', PORT: 'nope' } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid configuration/)
    expect(() =>
      loadConfig({ WEATHER_API_KEY: 'k', UPSTREAM_RETRIES: '9' } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid configuration/)
  })

  it('coerces numeric environment strings', () => {
    const config = loadConfig({
      WEATHER_API_KEY: 'k',
      PORT: '9090',
      CACHE_TTL_MS: '30000',
    } as NodeJS.ProcessEnv)
    expect(config.PORT).toBe(9090)
    expect(config.CACHE_TTL_MS).toBe(30_000)
  })

  it('rejects out-of-range operational values', () => {
    const bad = [
      { PORT: '0' },
      { PORT: '-1' },
      { PORT: '1.5' },
      { UPSTREAM_RETRIES: '6' },
      { UPSTREAM_RETRIES: '-1' },
      { UPSTREAM_TIMEOUT_MS: '0' },
      { CACHE_TTL_MS: '-5' },
      { RATE_LIMIT_MAX: '0' },
      { GEOCODE_RATE_LIMIT_MAX: '-2' },
      { DEVICE_WRITE_RATE_LIMIT_MAX: '0' },
      { MAX_DEVICES: '0' },
      { DEVICE_MAX_AGE_DAYS: '0' },
      { DEVICE_MAX_AGE_DAYS: '-30' },
      { WEATHER_API_BASE: 'not-a-url' },
      { NODE_ENV: 'staging' },
      { LOG_LEVEL: 'loud' },
    ]
    for (const overrides of bad) {
      expect(() =>
        loadConfig({ WEATHER_API_KEY: 'k', ...overrides } as NodeJS.ProcessEnv),
      ).toThrow(/Invalid configuration/)
    }
  })

  it('keeps documented defaults for every operational knob', () => {
    const config = loadConfig({ WEATHER_API_KEY: 'k' } as NodeJS.ProcessEnv)
    expect(config.HOST).toBe('0.0.0.0')
    expect(config.WEATHER_API_BASE).toBe('https://weather.googleapis.com')
    expect(config.GEOCODING_API_BASE).toBe('https://geocoding-api.open-meteo.com')
    expect(config.DATA_DIR).toBe('data')
    expect(config.LOG_LEVEL).toBe('debug') // NODE_ENV=test is not production
  })

  it('accepts every documented NODE_ENV and LOG_LEVEL value', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      resetConfigCache()
      expect(
        loadConfig({ WEATHER_API_KEY: 'k', NODE_ENV: nodeEnv } as NodeJS.ProcessEnv).NODE_ENV,
      ).toBe(nodeEnv)
    }
    for (const level of ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
      resetConfigCache()
      expect(
        loadConfig({ WEATHER_API_KEY: 'k', LOG_LEVEL: level } as NodeJS.ProcessEnv).LOG_LEVEL,
      ).toBe(level)
    }
  })

  it('names the missing key and formats issues as a list', () => {
    try {
      loadConfig({} as NodeJS.ProcessEnv)
      expect.unreachable('must throw')
    } catch (err) {
      expect((err as Error).message).toContain('- WEATHER_API_KEY: Required')
    }
    try {
      loadConfig({ WEATHER_API_KEY: '' } as NodeJS.ProcessEnv)
      expect.unreachable('must throw')
    } catch (err) {
      expect((err as Error).message).toContain('WEATHER_API_KEY is required — put it in backend/.env')
    }
    try {
      loadConfig({ PORT: 'nope', CACHE_TTL_MS: '-1' } as NodeJS.ProcessEnv)
      expect.unreachable('must throw')
    } catch (err) {
      // Multiple issues are listed on separate lines.
      const lines = (err as Error).message.split('\n').filter((l) => l.trim().startsWith('- '))
      expect(lines.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('caches the parsed config until reset', () => {
    const first = loadConfig({ WEATHER_API_KEY: 'k' } as NodeJS.ProcessEnv)
    const second = loadConfig({ WEATHER_API_KEY: 'other' } as NodeJS.ProcessEnv)
    expect(second).toBe(first) // cached, env change ignored

    resetConfigCache()
    const third = loadConfig({ WEATHER_API_KEY: 'other' } as NodeJS.ProcessEnv)
    expect(third).not.toBe(first)
    expect(third.WEATHER_API_KEY).toBe('other')
  })
})
