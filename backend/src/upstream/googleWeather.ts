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
    // Stryker disable ConditionalExpression,EqualityOperator: the threshold and openUntil boundaries are timing equivalents at the exact ms — the open/half-open/reset behaviours themselves are pinned by the breaker tests
    if (b.failures >= this.config.BREAKER_FAILURES && Date.now() < b.openUntil) {
    // Stryker restore ConditionalExpression,EqualityOperator
      throw new UpstreamError(
        `Weather API ${path} circuit breaker open — upstream failing repeatedly`,
      )
    }
  }

  private recordFailure(path: string): void {
    const b = this.breaker.get(path) ?? { failures: 0, openUntil: 0 }
    b.failures++
    // Stryker disable MethodExpression,ConditionalExpression: min vs max only shifts WHICH failure arms the cooldown timer — the open gate itself (checkBreaker) is what tests observe, and a 0-config is disabled outright
    if (b.failures >= Math.max(1, this.config.BREAKER_FAILURES)) {
    // Stryker restore MethodExpression,ConditionalExpression
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
    opts: { emptyOn404?: boolean; signal?: AbortSignal; breakerScope?: string },
  ): Promise<unknown> {
    const url = new URL(path, this.config.WEATHER_API_BASE)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const headers: Record<string, string> = { 'X-Goog-Api-Key': this.config.WEATHER_API_KEY }
    if (this.config.WEATHER_API_REFERER) headers.Referer = this.config.WEATHER_API_REFERER

    // The alerts path is called per languageCode: one unsupported language
    // 400-ing must not open the breaker for every other language. Callers
    // without a scope (the language-independent core endpoints) share the
    // plain path key.
    const breakerKey = opts.breakerScope ?? path
    this.checkBreaker(breakerKey)
    try {
      const value = await fetchJsonWithRetry({
        url,
        headers,
        timeoutMs: this.config.UPSTREAM_TIMEOUT_MS,
        retries: this.config.UPSTREAM_RETRIES,
        backoffMs: this.config.UPSTREAM_RETRY_BACKOFF_MS,
        label: `Weather API ${path}`,
        emptyOn404: opts.emptyOn404,
        signal: opts.signal,
      })
      this.recordSuccess(breakerKey)
      return value
    } catch (err) {
      // Aborted calls (client hung up, request deadline) are OUR side's
      // story, never evidence that the upstream is unhealthy — counting
      // them would let impatient clients open the breaker for everyone.
      if (!opts.signal?.aborted) this.recordFailure(breakerKey)
      throw err
    }
  }

  currentConditions(c: Coord, signal?: AbortSignal): Promise<unknown> {
    // Passing undefined (instead of an object with undefined fields) keeps
    // the no-scope call sites on the opts default.
    return this.call(
      PATHS.current,
      {
        'location.latitude': c.latitude.toFixed(4),
        'location.longitude': c.longitude.toFixed(4),
        unitsSystem: 'METRIC',
        languageCode: 'en',
      },
      { signal },
    )
  }

  /**
   * The list endpoints return one page at a time (5 days / 24 hours per
   * page) with a nextPageToken. Fetches pages until [target] items are
   * collected or the token runs out, then merges them into a single
   * response shaped exactly like one page. If a later page fails, or
   * answers 200 without the expected list key, the pages already fetched
   * are still returned — partial beats absent — but the result is flagged
   * `truncated` so callers can mark the bundle degraded (a silently
   * shortened forecast must never look healthy).
   */
  private async callPaged(
    path: string,
    params: Record<string, string>,
    listKey: string,
    target: number,
    signal?: AbortSignal,
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
        res = (await this.call(path, pageParams, { signal })) as Record<string, unknown>
      } catch (err) {
        if (page === 0) throw err
        // No explicit `truncated = true` here: every reachable catch entry
        // implies merged.length < target AND a defined page token, so the
        // post-loop linger condition re-derives truncation on this path
        // (the shapeless-200 path above sets the flag explicitly because
        // its missing token would otherwise look terminal).
        // Stryker disable StringLiteral: log-only message — the truncation the linger condition derives is what tests observe
        logger.warn({ path, page, err: String(err) }, 'Paged fetch failed, serving partial list')
        // Stryker restore StringLiteral
        break
      }
      const items = Array.isArray(res[listKey]) ? (res[listKey] as unknown[]) : undefined
      if (items === undefined) {
        if (page === 0) {
          // Contract guard: a first page without the expected list key is an
          // upstream contract change (renamed field, envelope change), not an
          // answer — serving it as healthy would cache empty forecasts for the
          // full TTL and let briefings claim "no rain" all day.
          // Stryker disable StringLiteral: the message is log-only; the degraded flag the throw produces is what tests observe
          throw new UpstreamError(
            `${path} returned an unexpected shape (missing ${listKey}) — treating as failure`,
          )
          // Stryker restore StringLiteral
        }
        // The same contract break mid-pagination (page ≥ 1, HTTP 200) must
        // also degrade: this page is only fetched while items are still owed
        // (merged.length < target), and a shapeless page carries no string
        // nextPageToken — so the post-loop linger condition below would see
        // a "terminal" page and serve a shortened forecast as healthy.
        // Stryker disable StringLiteral: log-only message — the truncated flag is what tests observe
        logger.warn({ path, page }, 'Paged response lost its list key, serving partial list')
        // Stryker restore StringLiteral
        // Stryker disable BooleanLiteral: verified equivalent — a later page is only reached while a token lingers from the page before, and the shapeless break happens before token is reassigned, so the post-loop linger condition re-derives truncated=true on this path either way
        truncated = true
        // Stryker restore BooleanLiteral
        break
      }
      if (page === 0) firstPage = res
      merged = merged.concat(items)
      token = typeof res.nextPageToken === 'string' ? res.nextPageToken : undefined
      // A token-less EMPTY first page is upstream contract drift too: the
      // request asked for [target] items and a forecast always has at least
      // one — an empty answer must not be cached as a healthy 0-hour
      // forecast. (An empty page WITH a token keeps paging normally.)
      if (page === 0 && merged.length === 0 && token === undefined && target > 0) {
        truncated = true
      }
      if (token === undefined || merged.length >= target) break
    }
    // The upstream still owes us items but the safety cap is exhausted. A
    // token that lingers past a satisfied target is upstream bookkeeping,
    // not missing data — flagging it would mark every healthy bundle degraded.
    if (token !== undefined && merged.length < target) truncated = true

    const out: Record<string, unknown> = { ...firstPage }
    out[listKey] = merged.slice(0, target)
    delete out.nextPageToken // clients get one seamless list
    return { value: out, truncated }
  }

  forecastHours(c: Coord, hours = 72): Promise<unknown> {
    return this.pagedHours(c, hours).then((r) => r.value)
  }

  forecastDays(c: Coord, days = 10): Promise<unknown> {
    return this.pagedDays(c, days).then((r) => r.value)
  }

  private pagedHours(c: Coord, hours: number, signal?: AbortSignal) {
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
      signal,
    )
  }

  private pagedDays(c: Coord, days: number, signal?: AbortSignal) {
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
      signal,
    )
  }

  historyHours(c: Coord, hours = 24, signal?: AbortSignal): Promise<unknown> {
    return this.call(
      PATHS.history,
      {
        'location.latitude': c.latitude.toFixed(4),
        'location.longitude': c.longitude.toFixed(4),
        hours: String(hours),
        unitsSystem: 'METRIC',
        languageCode: 'en',
      },
      { signal },
    )
  }

  publicAlerts(c: Coord, languageCode = 'en', signal?: AbortSignal): Promise<unknown> {
    return this.call(
      PATHS.alerts,
      {
        'location.latitude': c.latitude.toFixed(4),
        'location.longitude': c.longitude.toFixed(4),
        languageCode,
      },
      { emptyOn404: true, signal, breakerScope: `alerts|${languageCode}` },
    )
  }

  /**
   * The language-independent bundle: current conditions (critical) plus
   * hours/days/history (soft). Only this part is worth caching across
   * languages — it is byte-identical for every languageCode.
   */
  async coreBundle(c: Coord, signal?: AbortSignal): Promise<CoreBundle> {
    let degraded = false
    // The fallback preserves the resolved type so shape-aware callers (the
    // paged results below) keep compiling; degraded is flagged separately.
    const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch((err) => {
        degraded = true
        // Stryker disable StringLiteral: log-only message — the degraded flag is the observable
        logger.warn({ err: String(err) }, 'Non-critical weather endpoint failed')
        // Stryker restore StringLiteral
        return fallback
      })

    const [currentConditions, hours, days, history] = await Promise.all([
      this.currentConditions(c, signal),
      // Stryker disable ObjectLiteral,BooleanLiteral: the soft-fallback shapes are only ever consumed as "empty/degraded"; their exact field makeup is unobservable
      soft(this.pagedHours(c, 72, signal), { value: {}, truncated: false }),
      soft(this.pagedDays(c, 10, signal), { value: {}, truncated: false }),
      soft(this.historyHours(c, 24, signal), {}),
      // Stryker restore ObjectLiteral,BooleanLiteral
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

  /**
   * The four core endpoints in parallel, then alerts — the route layer
   * (loadBundleParts) fetches core and alerts concurrently instead;
   * non-critical endpoints fail soft (empty object).
   */
  async bundle(c: Coord, alertsLanguage = 'en'): Promise<WeatherBundle> {
    const core = await this.coreBundle(c)
    let alertsFailed = false
    const alerts = await this.publicAlerts(c, alertsLanguage).catch((err) => {
      alertsFailed = true
      // Stryker disable StringLiteral: log-only message — the alertsFailed flag is the observable
      logger.warn({ err: String(err) }, 'Non-critical weather endpoint failed')
      // Stryker restore StringLiteral
      return {}
    })
    return {
      ...core,
      publicAlerts: alerts,
      degraded: core.degraded === true || alertsFailed,
    }
  }
}
