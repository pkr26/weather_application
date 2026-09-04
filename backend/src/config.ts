import { z } from 'zod'

/**
 * Environment-driven configuration, validated once at startup.
 * The Google Weather API key never leaves this process — the Android
 * client talks only to this backend.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),

  WEATHER_API_KEY: z.string().min(1, 'WEATHER_API_KEY is required — put it in backend/.env'),
  WEATHER_API_REFERER: z.string().default(''),
  WEATHER_API_BASE: z.string().url().default('https://weather.googleapis.com'),

  GEOCODING_API_BASE: z.string().url().default('https://geocoding-api.open-meteo.com'),

  // Keyless reverse geocoding (coordinates → place name) for devices whose
  // platform Geocoder has no backend (common on emulators/AOSP builds).
  REVERSE_GEOCODING_API_BASE: z.string().url().default('https://api.bigdatacloud.net'),

  // Upstream fetch behaviour
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  UPSTREAM_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Base delay between retries: backoffMs * 2^attempt, ±30% jitter. */
  UPSTREAM_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(100),

  // Weather payloads are cached to keep upstream quota usage low.
  CACHE_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  /**
   * Degraded bundles (a soft endpoint failed) are cached only this long:
   * long enough that a persistent upstream outage cannot turn every request
   * into 5 upstream calls, short enough that a blip self-heals quickly.
   */
  DEGRADED_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Alerts are fetched near-fresh (never the full cache TTL) so warnings are
   * never meaningfully stale, while a storm-time herd of devices still
   * shares one upstream call per coordinate.
   */
  ALERTS_CACHE_TTL_MS: z.coerce.number().int().positive().default(15_000),

  // Circuit breaker: after BREAKER_FAILURES consecutive failed calls an
  // endpoint fails fast for BREAKER_COOLDOWN_MS before one probe is allowed.
  // 0 failures disables the breaker.
  BREAKER_FAILURES: z.coerce.number().int().min(0).default(5),
  BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),

  // Per-IP request budget (the Android app makes ~1 bundle call per refresh).
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(240),

  // Tighter budgets for the expensive/mutation-prone routes (same window).
  WEATHER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  GEOCODE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  DEVICE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /**
   * Proxy trust for client-IP resolution. Empty (default) trusts only
   * loopback proxies — a direct internet client cannot spoof its identity
   * (and thus its rate-limit bucket) with X-Forwarded-For. Set to "1" only
   * when deployed behind exactly one reverse proxy/LB, "0" to disable
   * proxy trust entirely.
   */
  TRUST_PROXY: z.enum(['', '0', '1']).default(''),

  // Browser CORS: comma-separated origin allowlist. Empty (default) disables
  // CORS entirely — the Android client is not a browser and sends no Origin.
  CORS_ORIGINS: z.string().default(''),

  /**
   * Optional shared bearer token for the whole API surface. Empty (default)
   * leaves the API open as before; when set, every request except
   * GET /health must present it as X-Api-Token. Meant for deployments where
   * the backend is publicly reachable and must not proxy the metered
   * weather API for strangers.
   */
  API_TOKEN: z.string().default(''),

  // Device registry persistence (swap for a real DB at scale).
  DATA_DIR: z.string().default('data'),

  // Registry size cap: unauthenticated registrations are capped so a flood
  // cannot fill the disk (or memory) with junk records.
  MAX_DEVICES: z.coerce.number().int().positive().default(25_000),

  // Records not updated within this many days are pruned when the store
  // loads — a flooded registry self-heals instead of 503-ing fresh installs
  // forever, and dead devices (uninstalled apps) age out naturally.
  DEVICE_MAX_AGE_DAYS: z.coerce.number().int().positive().default(365),

  LOG_LEVEL: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default(process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
})

export type Config = z.infer<typeof envSchema>

let cached: Config | null = null

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached
  // Back-compat: the devices-route budget was renamed (it throttles reads
  // too); the old env name keeps working if the new one is unset.
  const effective: NodeJS.ProcessEnv = {
    ...env,
    DEVICE_RATE_LIMIT_MAX: env.DEVICE_RATE_LIMIT_MAX ?? env.DEVICE_WRITE_RATE_LIMIT_MAX,
  }
  const parsed = envSchema.safeParse(effective)
  if (!parsed.success) {
    // Stryker disable StringLiteral: the dash prefix is pinned by the
    // 'names the missing key' assertion — hand-verified kill that the
    // sandbox miscounts (verified twice by hand-mutation).
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    // Stryker restore
      .join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  cached = parsed.data
  return cached
}

/** Test hook — forces a re-read of the environment. */
export function resetConfigCache(): void {
  cached = null
}
