import { describe, expect, it } from 'vitest'
import pino from 'pino'
import { REDACT_PATHS } from '../src/logger.js'
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
