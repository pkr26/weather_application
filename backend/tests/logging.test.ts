import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { REDACT_PATHS, logger } from '../src/logger.js'
import { serializeReqForLog } from '../src/app.js'

/**
 * Log-content tests: assert what pino actually WRITES, not just that a
 * method was called. Credentials (API token, device secret) and user
 * locations (query strings) are the two things this service must never put
 * on disk.
 */
function capture(lines: string[]): pino.Logger {
  return pino(
    { redact: { paths: [...REDACT_PATHS], censor: '[redacted]' } },
    { write: (s: string) => lines.push(s) },
  )
}

describe('credential redaction in log output', () => {
  it('never writes the shared API token', () => {
    const lines: string[] = []
    capture(lines).info(
      { req: { headers: { 'x-api-token': 'master-secret-token' } } },
      'request',
    )
    expect(lines.join('\n')).not.toContain('master-secret-token')
    expect(lines.join('\n')).toContain('[redacted]')
  })

  it('never writes device secrets or authorization headers', () => {
    const lines: string[] = []
    capture(lines).info({
      req: {
        headers: {
          'x-device-secret': 'deadbeef'.repeat(8),
          authorization: 'Bearer jwt-value',
          'x-goog-api-key': 'google-key-value',
        },
      },
    })
    const out = lines.join('\n')
    expect(out).not.toContain('deadbeef')
    expect(out).not.toContain('jwt-value')
    expect(out).not.toContain('google-key-value')
  })

  it('covers every credential header the service accepts', () => {
    expect(REDACT_PATHS).toContain('req.headers["x-api-token"]')
    expect(REDACT_PATHS).toContain('req.headers["x-device-secret"]')
    expect(REDACT_PATHS).toContain('req.headers.authorization')
    expect(REDACT_PATHS).toContain('req.headers["x-goog-api-key"]')
  })
})

describe('request serialization keeps locations out of access logs', () => {
  it('logs method and path but never the query string', () => {
    const out = serializeReqForLog({
      method: 'GET',
      url: '/api/v1/notifications/briefing?lat=17.385&lon=78.4867&city=Hyderabad&lang=te',
    })
    expect(out).toEqual({ method: 'GET', url: '/api/v1/notifications/briefing' })
    expect(JSON.stringify(out)).not.toContain('lat=')
    expect(JSON.stringify(out)).not.toContain('Hyderabad')
  })

  it('strips search terms from geocode lookups', () => {
    const out = serializeReqForLog({ method: 'GET', url: '/api/v1/geocode?name=Home+Address' })
    expect(JSON.stringify(out)).not.toContain('Home')
  })
})

describe('the real middleware wiring', () => {
  // The unit tests above pin the serializers in isolation; this one pins the
  // WIRING — the exact options object handed to pino-http. The wiring block
  // is Stryker-disabled (unobservable at LOG_LEVEL=silent), so without this
  // test a deleted `serializers:` line would be invisible to every gate.
  it('mounts the PII-free request serializer and the response serializer', async () => {
    const { pinoHttpOptions } = await import('../src/app.js')
    const opts = pinoHttpOptions()

    const reqSerializer = opts.serializers['req'] as unknown as (o: { method?: string; url?: string }) => Record<string, unknown>
    expect(reqSerializer({
      method: 'GET',
      url: '/api/v1/notifications/briefing?lat=17.385&city=Hyderabad',
    })).toEqual({ method: 'GET', url: '/api/v1/notifications/briefing' })

    const resSerializer = opts.serializers['res'] as unknown as (o: { statusCode?: number; headers?: Record<string, string> }) => Record<string, unknown>
    expect(resSerializer({ statusCode: 200, headers: { 'Set-Cookie': 'session=topsecret' } }))
      .toEqual({ statusCode: 200 }) // response headers never reach the log

    expect(opts.redact.paths).toEqual([...REDACT_PATHS])
    expect(opts.autoLogging.ignore({ url: '/api/v1/health' })).toBe(true)
    expect(opts.autoLogging.ignore({ url: '/api/v1/weather/bundle' })).toBe(false)
  })

  it('collapses device-registry paths so identifiers stay out of logs', () => {
    const out = serializeReqForLog({ method: 'GET', url: '/api/v1/devices/abc-123-xyz' })
    expect(out).toEqual({ method: 'GET', url: '/api/v1/devices/:id' })
    // Express routing is case-insensitive; the collapse must be too. The
    // matched prefix (path start through the id) is normalized wholesale.
    const mixed = serializeReqForLog({ method: 'GET', url: '/API/v1/DEVICES/SECRETID123?x=1' })
    expect(mixed).toEqual({ method: 'GET', url: '/api/v1/devices/:id' })
    expect(JSON.stringify(mixed)).not.toContain('SECRETID123')
  })
})

describe('request serialization edge inputs', () => {
  it('tolerates a missing url', () => {
    expect(serializeReqForLog({ method: 'GET' })).toEqual({ method: 'GET', url: '' })
  })
})

describe('autoLogging ignore predicate edges', () => {
  it('a missing url is not a health check', async () => {
    const { pinoHttpOptions } = await import('../src/app.js')
    const opts = pinoHttpOptions()
    expect(opts.autoLogging.ignore({})).toBe(false)
    expect(opts.autoLogging.ignore({ url: '/api/v1/health' })).toBe(true)
    expect(opts.autoLogging.ignore({ url: '/api/v1/health/' })).toBe(true)
    // Prefix match by design: anything under the health path is a probe.
    expect(opts.autoLogging.ignore({ url: '/api/v1/healthcheck' })).toBe(true)
  })
})

describe('pino-http redaction wiring values', () => {
  it('redacts with the standard censor string', async () => {
    const { pinoHttpOptions } = await import('../src/app.js')
    expect(pinoHttpOptions().redact.censor).toBe('[redacted]')
  })
})
