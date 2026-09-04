import { gzipSync } from 'node:zlib'
import type { NextFunction, Request, Response } from 'express'

/**
 * Dependency-free gzip for JSON responses. Weather bundles are >100 KB of
 * verbose upstream JSON fetched dozens of times a day per user on a mobile
 * network; OkHttp sends `Accept-Encoding: gzip` by default, so compressing
 * is the single cheapest bandwidth/latency win available.
 *
 * Implemented against `res.json` (every route in this service responds via
 * `res.json`), bodies under 1 KB pass through untouched (compression overhead
 * exceeds the saving), and the sync gzip call costs ~1 ms for a 150 KB
 * payload — a fair trade for not pulling a middleware dependency into the
 * lockfile.
 */

const THRESHOLD_BYTES = 1024

export function gzipJsonMiddleware(req: Request, res: Response, next: NextFunction): void {
  const accept = String(req.headers['accept-encoding'] ?? '')
  if (!accept.includes('gzip')) {
    next()
    return
  }
  const originalJson = res.json.bind(res)
  res.json = function jsonGzip(body: unknown) {
    const payload = Buffer.from(JSON.stringify(body))
    if (payload.length < THRESHOLD_BYTES) {
      return originalJson(body)
    }
    const gz = gzipSync(payload, { level: 6 })
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Content-Length', String(gz.length))
    res.setHeader('Vary', 'Accept-Encoding')
    // No ETag on the compressed path — express would tag the uncompressed
    // body, and we bypassed its serialization entirely.
    res.removeHeader('ETag')
    res.end(gz)
    return res
  }
  next()
}
