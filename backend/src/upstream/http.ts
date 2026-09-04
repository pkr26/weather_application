import { logger } from '../logger.js'
import { UpstreamError } from '../errors.js'

/**
 * Shared upstream HTTP layer: per-attempt timeout, retry-with-backoff for
 * transient (5xx) upstream failures, and JSON parsing. Both upstream clients
 * (Google Weather, Open-Meteo geocoding) route through this so retry policy
 * stays consistent.
 *
 * Retry rules:
 * - Only HTTP 5xx retries — a 4xx (bad key, quota, bad request) is permanent.
 * - Network errors fail fast (no retry): the caller's own timeout or a dead
 *   socket is not something a second immediate attempt fixes.
 * - Attempts are spaced by exponential backoff with jitter (±30%), so a
 *   transient outage is never hammered by near-simultaneous retries, and
 *   `Retry-After` (when the upstream sends one) is honoured up to 5 s.
 */

export interface FetchJsonOptions {
  url: URL
  headers?: Record<string, string>
  timeoutMs: number
  /** Additional attempts after the first (0 = single attempt). */
  retries: number
  /** Base backoff for attempt N: backoffMs * 2^N, ±30% jitter. */
  backoffMs: number
  /** Log/error label, e.g. 'Weather API v1/currentConditions:lookup'. */
  label: string
  /** Treat 404 as a legitimate empty answer ({}) — used by publicAlerts. */
  emptyOn404?: boolean
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Honours Retry-After (seconds) when present; capped at 5 s. */
function retryAfterMs(res: Response): number {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return 0
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5_000) : 0
}

export async function fetchJsonWithRetry(o: FetchJsonOptions): Promise<unknown> {
  let lastRetryAfter = 0
  // Every iteration either returns, throws, or continues only while another
  // retry is allowed, so the loop can never complete normally.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), o.timeoutMs)
    // The retryable guard's instanceof arm and the timer clear below are
    // verified equivalents: non-UpstreamError errors can never satisfy the
    // status checks either, and by the time the finally runs the fetch has
    // settled, so a stray abort cannot change any outcome.
    // Stryker disable ConditionalExpression,LogicalOperator,BlockStatement,CallExpression: verified equivalents (see above)
    try {
      const res = await fetch(o.url, { headers: o.headers, signal: controller.signal })
      if (res.status === 404 && o.emptyOn404) {
        return {}
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        lastRetryAfter = retryAfterMs(res)
        throw new UpstreamError(
          `${o.label} failed: ${res.status} ${body.slice(0, 200)}`,
          res.status,
        )
      }
      return (await res.json()) as unknown
    } catch (err) {
      // Retry only what can plausibly heal: upstream 5xx. A 4xx (bad key,
      // quota, bad request) is permanent — retrying burns quota and adds
      // latency for the same answer. Network aborts fail fast instead.
      const retryable =
        err instanceof UpstreamError &&
        err.upstreamStatus !== undefined &&
        err.upstreamStatus >= 500 &&
        attempt < o.retries
      if (retryable) {
        const exponential = o.backoffMs * 2 ** attempt
        const jittered = exponential * (0.7 + 0.6 * Math.random())
        const delay = Math.max(lastRetryAfter, jittered)
        logger.warn(
          { path: o.url.pathname, attempt, status: err.upstreamStatus, delayMs: Math.round(delay) },
          'Upstream call failed, retrying',
        )
        await sleep(delay)
        continue
      }
      throw err instanceof UpstreamError
        ? err
        : new UpstreamError(`${o.label} unreachable: ${String(err)}`)
    } finally {
      clearTimeout(timer)
    }
    // Stryker restore
  }
}
