import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServices, createApp } from '../src/app.js'
import { loadConfig, resetConfigCache } from '../src/config.js'
import { TtlCache } from '../src/cache.js'
import { GoogleWeatherClient } from '../src/upstream/googleWeather.js'
import { GeocodingClient } from '../src/upstream/openMeteo.js'
import { DeviceStore } from '../src/store/deviceStore.js'

process.env.LOG_LEVEL = 'silent'

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cirrus-svc-'))
afterAll(() => rmSync(tmpDataDir, { recursive: true, force: true }))

describe('buildServices', () => {
  beforeEach(() => resetConfigCache())

  it('createApp builds its own services when none are injected', () => {
    const config = loadConfig({
      WEATHER_API_KEY: 'k',
      DATA_DIR: tmpDataDir,
    } as NodeJS.ProcessEnv)
    const app = createApp(config) // default parameter path
    expect(app).toBeTruthy()
    expect(typeof app.listen).toBe('function')
  })

  it('wires the full service graph from a validated config', () => {
    const config = loadConfig({
      WEATHER_API_KEY: 'k',
      DATA_DIR: tmpDataDir,
    } as NodeJS.ProcessEnv)
    const services = buildServices(config)

    expect(services.config).toBe(config)
    expect(services.weather).toBeInstanceOf(GoogleWeatherClient)
    expect(services.geocoding).toBeInstanceOf(GeocodingClient)
    expect(services.coreCache).toBeInstanceOf(TtlCache)
    expect(services.alertsCache).toBeInstanceOf(TtlCache)
    expect(services.currentCache).toBeInstanceOf(TtlCache)
    expect(services.geocodeCache).toBeInstanceOf(TtlCache)
    expect(services.devices).toBeInstanceOf(DeviceStore)
  })
})

describe('module-level logging defaults', () => {
  it('picks LOG_LEVEL info in production and debug otherwise', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalLogLevel = process.env.LOG_LEVEL
    try {
      for (const [nodeEnv, expected] of [
        ['production', 'info'],
        ['development', 'debug'],
      ] as const) {
        vi.resetModules()
        delete process.env.LOG_LEVEL
        process.env.NODE_ENV = nodeEnv
        const { logger } = await import('../src/logger.js')
        expect(logger.level).toBe(expected)

        // The config schema must agree with the logger it feeds.
        const { loadConfig: freshLoad } = await import('../src/config.js')
        expect(
          freshLoad({ WEATHER_API_KEY: 'k' } as NodeJS.ProcessEnv).LOG_LEVEL,
        ).toBe(expected)
      }
    } finally {
      process.env.NODE_ENV = originalNodeEnv
      process.env.LOG_LEVEL = originalLogLevel
      vi.resetModules()
    }
  })
})
