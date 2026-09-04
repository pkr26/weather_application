import type { Config } from '../config.js'
import { logger } from '../logger.js'
import { UpstreamError } from '../errors.js'
import { fetchJsonWithRetry } from './http.js'

/**
 * Thin client for weather.googleapis.com. The API key lives in this process
 * only — the Android app never sees it.
 *
 * Responses are returned as parsed-but-untyped JSON: the /weather/bundle
 * endpoint passes them through verbatim (the app's DTOs already model the
 * shapes), while the briefing generator reads them through [WeatherViews].
 */

export interface Coord {
  latitude: number
  longitude: number
}

/**
 * The language-independent part of a weather bundle (everything except
 * publicAlerts). `degraded` is true when a non-critical endpoint failed soft
 * or a paginated list came back truncated.
 */
export interface CoreBundle {
  currentConditions: unknown
  forecastHours: unknown
  forecastDays: unknown
  historyHours: unknown
  degraded?: boolean
}

export interface WeatherBundle extends CoreBundle {
  publicAlerts: unknown
  /**
   * True when a non-critical endpoint failed soft and part of the bundle is
   * empty. Degraded bundles are served but only cached briefly (short TTL) —
   * a transient upstream blip must not poison the next 10 minutes of data,
   * and a persistent one must not turn every request into 5 upstream calls.
   */
  degraded?: boolean
}

const PATHS = {
  current: 'v1/currentConditions:lookup',
  hours: 'v1/forecast/hours:lookup',
  days: 'v1/forecast/days:lookup',
  history: 'v1/history/hours:lookup',
  alerts: 'v1/publicAlerts:lookup',
} as const

interface BreakerState {
  /** Consecutive failed calls for this endpoint path. */
  failures: number
  /** Until this epoch ms, fail fast instead of calling a known-dead path. */
  openUntil: number
}

export class GoogleWeatherClient {
  private readonly breaker = new Map<string, BreakerState>()

  constructor(private readonly config: Config) {}

  /** Fail fast while an endpoint is known-dead (consecutive failures ≥ N). */
  private checkBreaker(path: string): void {
    if (this.config.BREAKER_FAILURES <= 0) return
    const b = this.breaker.get(path)
    if (!b) return
    if (b.failures >= this.config.BREAKER_FAILURES && Date.now() < b.openUntil) {
      throw new UpstreamError(
        `Weather API ${path} circuit breaker open — upstream failing repeatedly`,
      )
    }
  }

  private recordFailure(path: string): void {
    const b = this.breaker.get(path) ?? { failures: 0, openUntil: 0 }
    b.failures++
    if (b.failures >= Math.max(1, this.config.BREAKER_FAILURES)) {
      b.openUntil = Date.now() + this.config.BREAKER_COOLDOWN_MS
    }
    this.breaker.set(path, b)
  }

  private recordSuccess(path: string): void {
    this.breaker.delete(path)
  }

  private async call(
    path: string,
    params: Record<string, string>,
    opts: { emptyOn404?: boolean } = {},
  ): Promise<unknown> {
    const url = new URL(path, this.config.WEATHER_API_BASE)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const headers: Record<string, string> = { 'X-Goog-Api-Key': this.config.WEATHER_API_KEY }
    if (this.config.WEATHER_API_REFERER) headers.Referer = this.config.WEATHER_API_REFERER

    this.checkBreaker(path)
    try {
      const value = await fetchJsonWithRetry({
        url,
        headers,
        timeoutMs: this.config.UPSTREAM_TIMEOUT_MS,
        retries: this.config.UPSTREAM_RETRIES,
        backoffMs: this.config.UPSTREAM_RETRY_BACKOFF_MS,
        label: `Weather API ${path}`,
        emptyOn404: opts.emptyOn404,
      })
      this.recordSuccess(path)
      return value
    } catch (err) {
      this.recordFailure(path)
      throw err
    }
  }

  currentConditions(c: Coord): Promise<unknown> {
    return this.call(PATHS.current, {
      'location.latitude': c.latitude.toFixed(4),
      'location.longitude': c.longitude.toFixed(4),
      unitsSystem: 'METRIC',
      languageCode: 'en',
    })
  }

  /**
   * The list endpoints return one page at a time (5 days / 24 hours per
   * page) with a nextPageToken. Fetches pages until [target] items are
   * collected or the token runs out, then merges them into a single
   * response shaped exactly like one page. If a later page fails, the
   * pages already fetched are still returned — partial beats absent — but
   * the result is flagged `truncated` so callers can mark the bundle
   * degraded (a silently shortened forecast must never look healthy).
   */
  private async callPaged(
    path: string,
    params: Record<string, string>,
    listKey: string,
    target: number,
  ): Promise<{ value: Record<string, unknown>; truncated: boolean }> {
    const MAX_PAGES = 6 // 10 days = 2 pages, 72 hours = 3 — slack for safety
    let merged: unknown[] = []
    let firstPage: Record<string, unknown> = {}
    let token: string | undefined
    let truncated = false

    for (let page = 0; page < MAX_PAGES; page++) {
      const pageParams: Record<string, string> = { ...params }
      if (token !== undefined) pageParams.pageToken = token
      let res: Record<string, unknown>
      try {
        res = (await this.call(path, pageParams)) as Record<string, unknown>
      } catch (err) {
        if (page === 0) throw err
        truncated = true
        logger.warn({ path, page, err: String(err) }, 'Paged fetch failed, serving partial list')
        break
      }
      if (page === 0) firstPage = res
      const items = Array.isArray(res[listKey]) ? (res[listKey] as unknown[]) : []
      merged = merged.concat(items)
      token = typeof res.nextPageToken === 'string' ? res.nextPageToken : undefined
      if (token === undefined || merged.length >= target) break
    }
    // The upstream still owes us items but the safety cap is exhausted.
    if (token !== undefined) truncated = true

    const out: Record<string, unknown> = { ...firstPage }
    // A response that isn't a list payload (or an empty first page) passes
    // through untouched — callers see exactly what the upstream sent.
    if (merged.length > 0 || Array.isArray(firstPage[listKey])) {
      out[listKey] = merged.slice(0, target)
      delete out.nextPageToken // clients get one seamless list
    }
    return { value: out, truncated }
  }

  forecastHours(c: Coord, hours = 72): Promise<unknown> {
    return this.pagedHours(c, hours).then((r) => r.value)
  }

  forecastDays(c: Coord, days = 10): Promise<unknown> {
    return this.pagedDays(c, days).then((r) => r.value)
  }

  private pagedHours(c: Coord, hours: number) {
    return this.callPaged(
      PATHS.hours,
      {
        'location.latitude': c.latitude.toFixed(4),
        'location.longitude': c.longitude.toFixed(4),
        hours: String(hours),
        unitsSystem: 'METRIC',
        languageCode: 'en',
      },
      'forecastHours',
      hours,
    )
  }

  private pagedDays(c: Coord, days: number) {
    return this.callPaged(
      PATHS.days,
      {
        'location.latitude': c.latitude.toFixed(4),
        'location.longitude': c.longitude.toFixed(4),
        days: String(days),
        unitsSystem: 'METRIC',
        languageCode: 'en',
      },
      'forecastDays',
      days,
    )
  }

  historyHours(c: Coord, hours = 24): Promise<unknown> {
    return this.call(PATHS.history, {
      'location.latitude': c.latitude.toFixed(4),
      'location.longitude': c.longitude.toFixed(4),
      hours: String(hours),
      unitsSystem: 'METRIC',
      languageCode: 'en',
    })
  }

  publicAlerts(c: Coord, languageCode = 'en'): Promise<unknown> {
    return this.call(
      PATHS.alerts,
      {
        'location.latitude': c.latitude.toFixed(4),
        'location.longitude': c.longitude.toFixed(4),
        languageCode,
      },
      { emptyOn404: true },
    )
  }

  /**
   * The language-independent bundle: current conditions (critical) plus
   * hours/days/history (soft). Only this part is worth caching across
   * languages — it is byte-identical for every languageCode.
   */
  async coreBundle(c: Coord): Promise<CoreBundle> {
    let degraded = false
    // The fallback preserves the resolved type so shape-aware callers (the
    // paged results below) keep compiling; degraded is flagged separately.
    const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch((err) => {
        degraded = true
        logger.warn({ err: String(err) }, 'Non-critical weather endpoint failed')
        return fallback
      })

    const [currentConditions, hours, days, history] = await Promise.all([
      this.currentConditions(c),
      soft(this.pagedHours(c, 72), { value: {}, truncated: false }),
      soft(this.pagedDays(c, 10), { value: {}, truncated: false }),
      soft(this.historyHours(c), {}),
    ])

    // A paginated list that ended early (page failure or page cap) is
    // degraded data even though the promise resolved.
    if (hours.truncated || days.truncated) degraded = true

    return {
      currentConditions,
      forecastHours: hours.value,
      forecastDays: days.value,
      historyHours: history,
      degraded,
    }
  }

  /** All five endpoints in parallel; non-critical ones fail soft (empty object). */
  async bundle(c: Coord, alertsLanguage = 'en'): Promise<WeatherBundle> {
    const core = await this.coreBundle(c)
    let alertsFailed = false
    const alerts = await this.publicAlerts(c, alertsLanguage).catch((err) => {
      alertsFailed = true
      logger.warn({ err: String(err) }, 'Non-critical weather endpoint failed')
      return {}
    })
    return {
      ...core,
      publicAlerts: alerts,
      degraded: core.degraded === true || alertsFailed,
    }
  }
}
