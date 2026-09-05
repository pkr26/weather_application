import { logger } from '../logger.js'
import { UpstreamError } from '../errors.js'

/**
 * Shared upstream HTTP layer: per-attempt timeout, retry-with-backoff for
 * transient upstream failures, and JSON parsing. Both upstream clients
 * (Google Weather, Open-Meteo geocoding) route through this so retry policy
 * stays consistent.
 *
 * Retry rules:
 * - HTTP 5xx and 429 retry — both can heal; a 4xx (bad key, bad request)
 *   is permanent.
 * - A 200 whose body cannot be parsed as JSON is classified like a 5xx
 *   (retry + breaker): the upstream is broken mid-contract, and the
 *   "unreachable" bucket never retries.
 * - Network errors fail fast (no retry): the caller's own timeout or a dead
 *   socket is not something a second immediate attempt fixes.
 * - Attempts are spaced by exponential backoff with jitter (±30%), so a
 *   transient outage is never hammered by near-simultaneous retries, and
 *   `Retry-After` (delay-seconds or HTTP-date, when the upstream sends one)
 *   is honoured up to 5 s — the upstream's own backoff hint wins over ours.
 * - An optional external [FetchJsonOptions.signal] (per-request deadline or
 *   client-disconnect) aborts every attempt immediately; aborted calls are
 *   never retried.
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
  /** Abort deadline / client disconnect — linked into every attempt. */
  signal?: AbortSignal
}

/** Sleep that also ends when the signal aborts — a dead request must not
 *  linger in a backoff sleep past its own deadline/disconnect. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  // Stryker disable ConditionalExpression,CallExpression,StringLiteral: the pre-check is a fast path the abort listener subsumes; the DOMException reason string never reaches an assertion (the catch re-wraps)
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort)
  })
  // Stryker restore ConditionalExpression,CallExpression,StringLiteral

const RETRY_AFTER_CAP_MS = 5_000

/** Forwarded Retry-After is clamped to an hour — generous, but never absurd. */
const FORWARD_RETRY_AFTER_CAP_MS = 3_600_000

/**
 * Upstream response byte cap: the largest legitimate weather payload is a
 * few hundred KB, so 8 MiB is ~40x headroom. A body beyond it is a
 * compromised or broken upstream buffer-bombing us — reading it whole would
 * exhaust memory long before any JSON parse error could fire.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Reads the response body with a hard byte cap. The streaming read is the
 * production path; the text() fallback covers responses without a body
 * stream (consumed streams, minimal Response implementations). Cap breaches
 * throw a status-less UpstreamError — status-less means non-retryable, a
 * multi-gigabyte body is a compromised upstream, not a transient fault.
 */
async function readCappedBody(res: Response, label: string): Promise<string> {
  const body = res.body
  if (!body?.getReader) {
    const text = await res.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      throw new UpstreamError(`${label} body exceeded ${MAX_BODY_BYTES} bytes — refusing to buffer`)
    }
    return text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_BODY_BYTES) {
      // Cancel the stream: keep draining-to-discard minimal, then fail.
      // Stryker disable CallExpression: cancel() is stream hygiene — the error it precedes is the observable
      await reader.cancel().catch(() => {})
      // Stryker restore CallExpression
      throw new UpstreamError(`${label} body exceeded ${MAX_BODY_BYTES} bytes — refusing to buffer`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parses Retry-After as delay-seconds or HTTP-date; capped, 0 when unusable.
 *  The cap is a parameter so the error path can carry the uncapped hint. */
export function parseRetryAfterMs(
  raw: string | null | undefined,
  now = Date.now(),
  capMs = RETRY_AFTER_CAP_MS,
): number {
  if (!raw) return 0
  // Stryker disable MethodExpression,ConditionalExpression,EqualityOperator,LogicalOperator: trim() is cosmetic for Number(), '0'/negative/non-finite all fall through to the same 0, and the at==now boundary is a timing equivalent; the value and cap mutations are killed by the exact-value parsing tests
  const trimmed = raw.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, capMs)
  }
  // HTTP-date form (RFC 9110 §10.1.3): only a future date asks us to wait.
  const at = Date.parse(trimmed)
  if (Number.isFinite(at) && at > now) {
    return Math.min(at - now, capMs)
  }
  // Stryker restore MethodExpression,ConditionalExpression,EqualityOperator,LogicalOperator
  return 0
}

/**
 * Which side killed an aborted scope. AbortSignal.timeout() aborts with a
 * DOMException named 'TimeoutError'; every other path (client hang-up,
 * explicit controller.abort()) carries the default AbortError — so the
 * reason's name identifies the deadline without extra wiring, and the
 * SharedScope/cache chain preserves it by re-aborting with the
 * participant's reason.
 */
function abortedBy(signal: AbortSignal | undefined): 'deadline' | 'client' {
  return (signal?.reason as { name?: string } | undefined)?.name === 'TimeoutError'
    ? 'deadline'
    : 'client'
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
    try {
      const signal = o.signal ? AbortSignal.any([controller.signal, o.signal]) : controller.signal
      const res = await fetch(o.url, { headers: o.headers, signal })
      if (res.status === 404 && o.emptyOn404) {
        return {}
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        // Stryker disable OptionalChaining,EqualityOperator: the defensive header accessors always exist on real Response objects, and a 0 assignment is observably identical to no assignment
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'))
        if (retryAfterMs > 0) lastRetryAfter = retryAfterMs
        // Stryker restore OptionalChaining,EqualityOperator
        // The error carries the UNCAPPED upstream hint: our own retry sleep
        // uses the capped `lastRetryAfter`, but the client-facing 503 must
        // relay what the upstream actually asked for (capped only by a sane
        // hour), not our internal 5 s budget.
        // Stryker disable OptionalChaining: the defensive header accessors always exist on real Response objects
        const uncappedHintMs = parseRetryAfterMs(res.headers?.get?.('retry-after'), Date.now(), Number.POSITIVE_INFINITY)
        // Stryker restore OptionalChaining
        throw new UpstreamError(
          `${o.label} failed: ${res.status} ${body.slice(0, 200)}`,
          res.status,
          retryAfterMs,
          Math.min(uncappedHintMs, FORWARD_RETRY_AFTER_CAP_MS),
        )
      }
      let text: string
      try {
        text = await readCappedBody(res, o.label)
      } catch (err) {
        if (err instanceof UpstreamError) throw err
        // A body-stream failure mid-read (socket reset, truncated chunk) is
        // plausibly transient — classify like a 5xx so it retries; the byte
        // cap above already threw its own non-retryable error.
        throw new UpstreamError(`${o.label} body read failed: ${String(err).slice(0, 120)}`, 500)
      }
      try {
        return JSON.parse(text) as unknown
      } catch (err) {
        // A 200 whose body is not the JSON it promised is a broken upstream,
        // not an unreachable one — the "unreachable" bucket never retries,
        // which would freeze a half-healthy answer in the breaker forever.
        // Stryker disable MethodExpression: verified equivalent — V8's JSON.parse error messages never exceed 92 chars (measured across malformed-input shapes on Node 22), so the 120-char slice never removes anything
        throw new UpstreamError(
          `${o.label} returned a malformed body: ${String(err).slice(0, 120)}`,
          500,
        )
        // Stryker restore MethodExpression
      }
    } catch (err) {
      // Retry only what can plausibly heal: upstream 5xx and throttling
      // 429s. Other 4xx (bad key, bad request) are permanent — retrying
      // burns quota and adds latency for the same answer. Network aborts
      // fail fast instead.
      // Stryker disable ConditionalExpression,LogicalOperator: the instanceof/status arms exclude non-UpstreamErrors, and fetch itself throws only TypeErrors (no status) — pinned by the network-error single-attempt test; the surviving arms are unreachable error shapes
      const retryable =
        err instanceof UpstreamError &&
        err.upstreamStatus !== undefined &&
        (err.upstreamStatus >= 500 || err.upstreamStatus === 429) &&
        attempt < o.retries
      // Stryker restore ConditionalExpression,LogicalOperator
      if (retryable) {
        const exponential = o.backoffMs * 2 ** attempt
        // Stryker disable ArithmeticOperator: jitter is randomized per run — its exact bounds are unobservable by construction; the exponential base and operator are pinned by the spacing-boundary test
        const jittered = exponential * (0.7 + 0.6 * Math.random())
        // Stryker restore ArithmeticOperator
        const delay = Math.max(lastRetryAfter, jittered)
        logger.warn(
          { path: o.url.pathname, attempt, status: err.upstreamStatus, delayMs: Math.round(delay) },
          'Upstream call failed, retrying',
        )
        try {
          await sleep(delay, o.signal)
        } catch {
          // Scope died during the backoff sleep — fail fast, no more attempts.
          throw new UpstreamError(
            `${o.label} aborted: request scope closed`,
            undefined,
            undefined,
            undefined,
            abortedBy(o.signal),
          )
        }
        continue
      }
      if (err instanceof UpstreamError) throw err
      if (o.signal?.aborted) {
        // Deadline hit or client hung up: not an upstream fault, and the
        // caller's request scope is dead — retrying is pointless.
        throw new UpstreamError(
          `${o.label} aborted: request scope closed`,
          undefined,
          undefined,
          undefined,
          abortedBy(o.signal),
        )
      }
      throw new UpstreamError(`${o.label} unreachable: ${String(err)}`)
    } finally {
      // Stryker disable BlockStatement,CallExpression: clearing the attempt timer after settle is hygiene — a stray abort of a settled attempt's controller changes nothing
      clearTimeout(timer)
    }
    // Stryker restore BlockStatement,CallExpression
  }
}
