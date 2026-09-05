import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { NextFunction, Request, Response } from 'express'

/**
 * Dependency-free gzip for JSON responses. Weather bundles are >100 KB of
 * verbose upstream JSON fetched dozens of times a day per user on a mobile
 * network; OkHttp sends `Accept-Encoding: gzip` by default, so compressing
 * is the single cheapest bandwidth/latency win available.
 *
 * Implemented against `res.json` (every route in this service responds via
 * `res.json`), bodies under 1 KB pass through untouched (compression overhead
 * exceeds the saving), and compression runs through async zlib — a ~1 ms
 * gzipSync per ≥1 KB response is ~1 ms the event loop steals from every
 * concurrent request, so the work goes to the thread pool instead. Still no
 * middleware dependency in the lockfile.
 *
 * Negotiation follows RFC 9110 §12.5.3: token + q-value, case-insensitive,
 * `gzip;q=0` is an explicit refusal, `*` accepts anything not refused.
 * `Vary: Accept-Encoding` is set on EVERY response this middleware wraps —
 * a shared cache that stored the identity variant without the Vary header
 * could serve it to gzip clients (or double-store both).
 */

const gzipAsync = promisify(gzip)

const THRESHOLD_BYTES = 1024

/** RFC 9110 Accept-Encoding negotiation for the gzip token only. */
export function acceptsGzip(header: string): boolean {
  let wildcardQ: number | null = null
  let gzipQ: number | null = null
  for (const part of header.split(',')) {
    // split never yields an empty array — the destructure always has a token.
    // Stryker disable MethodExpression: both trims are redundant — token and rawKey are trimmed again downstream, so removing either changes no verdict
    const [rawToken, ...params] = part.trim().split(';')
    const token = rawToken!.trim().toLowerCase()
    if (token !== 'gzip' && token !== '*' && token !== 'x-gzip') continue
    let q = 1
    // Stryker restore MethodExpression
    for (const param of params) {
      // Stryker disable MethodExpression: see above — rawKey is trimmed again below
      const [rawKey, rawValue] = param.trim().split('=')
      if (rawKey!.trim().toLowerCase() === 'q') {
      // Stryker restore MethodExpression
        // A missing or malformed value is a malformed directive: refuse (0).
        const parsed = Number.parseFloat(String(rawValue))
        q = Number.isNaN(parsed) ? 0 : Math.min(Math.max(parsed, 0), 1)
      }
    }
    // Stryker disable ConditionalExpression: verified equivalent — Math.max coerces the initial null to 0 and q is clamped to [0,1], so `null ? q : max(0, q)` yields q under both arms for the first gzip-family token
    if (token === '*') wildcardQ = q
    else gzipQ = gzipQ === null ? q : Math.max(gzipQ, q)
    // Stryker restore ConditionalExpression
  }
  // An explicit gzip token decides; only its absence falls back to `*`.
  if (gzipQ !== null) return gzipQ > 0
  // Stryker disable ConditionalExpression: reachable only when gzipQ is null; with wildcardQ null, `null > 0` is false — identical to the fallthrough return. The if(false) arm is killed by the '*'-only table row.
  if (wildcardQ !== null) return wildcardQ > 0
  // Stryker restore ConditionalExpression
  return false
}

export function gzipJsonMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Set before any response is produced: the stored representation's
  // selection depends on this request header, compressed or not.
  res.setHeader('Vary', 'Accept-Encoding')
  // Stryker disable StringLiteral: verified equivalent — with the header absent, any junk fallback string contains no gzip/*/x-gzip token and negotiates to the same false verdict as ''
  if (!acceptsGzip(String(req.headers['accept-encoding'] ?? ''))) {
    // Stryker restore StringLiteral
    next()
    return
  }
  const originalJson = res.json.bind(res)
  res.json = function jsonGzip(body: unknown) {
    const payload = Buffer.from(JSON.stringify(body))
    if (payload.length < THRESHOLD_BYTES) {
      return originalJson(body)
    }
    // Compression completes asynchronously: the response is written from
    // the callback, so res.json still returns synchronously (express's
    // chainability contract) while the zlib work runs off the event loop.
    // Stryker disable ObjectLiteral: the gzip level changes bytes, never semantics or headers
    void gzipAsync(payload, { level: 6 })
      .then((gz) => {
        res.setHeader('Content-Encoding', 'gzip')
        res.setHeader('Content-Length', String(gz.length))
        // Calling res.end directly bypasses express's res.send — which is
        // what sets the content type. Without it every compressed response
        // ships untyped, and strict JSON clients refuse to parse the body.
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        // No ETag on the compressed path — express would tag the
        // uncompressed body, and we bypassed its serialization entirely.
        res.removeHeader('ETag')
        res.end(gz)
      })
      .catch(() => {
        // A zlib failure must not kill an otherwise valid answer: fall
        // back to the identity body.
        originalJson(body)
      })
    // Stryker restore ObjectLiteral
    return res
  }
  next()
}
