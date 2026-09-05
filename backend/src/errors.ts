import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { logger } from './logger.js'

/** Operational error with an HTTP status; anything else is treated as a 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string) => new AppError(400, message, 'bad_request')
export const unauthorized = (message = 'Unauthorized') => new AppError(401, message, 'unauthorized')
export const notFound = (message = 'Not found') => new AppError(404, message, 'not_found')

/** Upstream (Google Weather / geocoding) failure surfaced as 502. */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    /** HTTP status the upstream actually returned, if it answered at all. */
    readonly upstreamStatus?: number,
    /** The upstream's Retry-After hint for OUR OWN retry sleep (capped at 5 s). */
    readonly retryAfterMs?: number,
    /** The hint to FORWARD to clients — the upstream's uncapped ask. */
    readonly forwardRetryAfterMs?: number,
    /**
     * Which side killed an aborted call. 'deadline' means OUR whole-request
     * budget fired — reported to clients as 504 Gateway Timeout (retrying
     * now would only hit the same deadline); 'client' means the caller hung
     * up, where nobody reads the status anyway.
     */
    readonly abortedBy?: 'deadline' | 'client',
  ) {
    super(502, message, 'upstream_error')
    this.name = 'UpstreamError'
  }
}

/** Device registry has hit its configured size cap (disk-fill protection). */
export class RegistryFullError extends AppError {
  constructor() {
    super(503, 'Device registry is full.', 'registry_full')
    this.name = 'RegistryFullError'
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  // Headers already flushed (streaming, partial write): a second status
  // write would throw — delegate to express's default handler, which closes
  // the connection instead.
  if (res.headersSent) {
    next(err)
    return
  }
  // Error bodies must never stick in an intermediary's cache.
  res.setHeader('Cache-Control', 'no-store')
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'bad_request',
      message: 'Invalid request parameters.',
      // Stryker disable StringLiteral: the join separator is pinned by the
      // exact-details assertion in errors.test.ts (hand-verified kill).
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      // Stryker restore StringLiteral
    })
    return
  }
  if (err instanceof AppError) {
    if (err.status >= 500) {
      // Full detail (which may quote upstream responses) stays in the log;
      // clients get a stable, non-revealing message.
      logger.error({ err }, err.message)
      if (err instanceof UpstreamError) {
        if (err.abortedBy === 'deadline') {
          // Our own whole-request budget fired (not the upstream, not the
          // client): 504 says exactly that, and no Retry-After is attached —
          // the deadline is not the upstream's backoff instruction, and an
          // immediate client retry with a fresh budget is legitimate.
          res.status(504).json({
            // UpstreamError always carries this code — no fallback branch.
            error: 'upstream_error',
            message: 'Upstream weather service did not answer in time. Try again shortly.',
          })
          return
        }
        // Throttling and maintenance are the two "come back later" answers:
        // say 503 (not 502) and pass the upstream's own Retry-After through
        // so well-behaved clients back off instead of hammering.
        const throttled = err.upstreamStatus === 429 || err.upstreamStatus === 503
        const hintMs = err.forwardRetryAfterMs ?? err.retryAfterMs
        // Stryker disable EqualityOperator,ConditionalExpression: the `hintMs &&` guard makes `> 0` ⟺ `>= 0` (a falsy hint short-circuits before the comparison); truth-table arms pinned by the four hint tests
        const retryAfterSec = throttled && hintMs && hintMs > 0
          ? Math.max(1, Math.ceil(hintMs / 1000))
          : undefined
        // Stryker restore EqualityOperator,ConditionalExpression
        if (retryAfterSec !== undefined) res.setHeader('Retry-After', String(retryAfterSec))
        res.status(throttled ? 503 : 502).json({
          // UpstreamError always carries this code — no fallback branch.
          error: 'upstream_error',
          message: throttled
            ? 'Upstream weather service is throttling. Try again shortly.'
            : 'Upstream weather service is unavailable. Try again shortly.',
        })
        return
      }
      const message = err instanceof RegistryFullError ? err.message : 'Something went wrong.'
      res.status(err.status).json({ error: err.code ?? 'error', message })
      return
    }
    res.status(err.status).json({ error: err.code ?? 'error', message: err.message })
    return
  }
  // body-parser errors (oversized body, malformed JSON) carry their own
  // 4xx status — honour it instead of masking it as a 500.
  const parserStatus = (err as { status?: unknown }).status
  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    const code = parserStatus === 413 ? 'payload_too_large' : 'bad_request'
    res.status(parserStatus).json({ error: code, message: 'Request body rejected.' })
    return
  }
  logger.error({ err }, 'Unhandled error')
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' })
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
