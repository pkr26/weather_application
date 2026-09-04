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
      // Stryker restore
    })
    return
  }
  if (err instanceof AppError) {
    if (err.status >= 500) {
      // Full detail (which may quote upstream responses) stays in the log;
      // clients get a stable, non-revealing message.
      logger.error({ err }, err.message)
      const message =
        err instanceof UpstreamError
          ? 'Upstream weather service is unavailable. Try again shortly.'
          : err instanceof RegistryFullError
            ? err.message
            : 'Something went wrong.'
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
