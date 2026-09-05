import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Response } from 'express'
import { z, ZodError } from 'zod'
import {
  AppError,
  RegistryFullError,
  UpstreamError,
  asyncHandler,
  badRequest,
  errorHandler,
  notFound,
  unauthorized,
} from '../src/errors.js'
import { logger } from '../src/logger.js'

process.env.LOG_LEVEL = 'silent'

function fakeRes() {
  const capture = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  }
  const res = {
    status(code: number) {
      capture.statusCode = code
      return res
    },
    json(body: unknown) {
      capture.body = body
      return res
    },
    setHeader(name: string, value: string) {
      capture.headers[name] = value
      return res
    },
  } as unknown as Response
  return { res, capture }
}

afterEach(() => vi.restoreAllMocks())

describe('error constructors', () => {
  it('badRequest maps to 400 bad_request', () => {
    const err = badRequest('nope')
    expect(err.status).toBe(400)
    expect(err.code).toBe('bad_request')
    expect(err.message).toBe('nope')
    expect(err.name).toBe('AppError')
  })

  it('unauthorized maps to 401', () => {
    const err = unauthorized()
    expect(err.status).toBe(401)
    expect(err.code).toBe('unauthorized')
    expect(err.message).toBe('Unauthorized')
    expect(unauthorized('Nope').message).toBe('Nope')
  })

  it('notFound maps to 404 with its default message', () => {
    const err = notFound()
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
    expect(err.message).toBe('Not found')
  })

  it('UpstreamError is a 502', () => {
    const err = new UpstreamError('Google down')
    expect(err.status).toBe(502)
    expect(err.code).toBe('upstream_error')
    expect(err).toBeInstanceOf(AppError)
  })
})

describe('errorHandler', () => {
  const parse = (schema: z.ZodTypeAny, input: unknown): ZodError => {
    try {
      schema.parse(input)
    } catch (e) {
      return e as ZodError
    }
    throw new Error('expected a ZodError')
  }

  it('translates ZodErrors into 400 with field details', () => {
    const zodErr = parse(z.object({ lat: z.coerce.number().min(-90).max(90) }), { lat: 999 })
    const { res, capture } = fakeRes()
    errorHandler(zodErr, {} as never, res, {} as never)
    expect(capture.statusCode).toBe(400)
    expect(capture.body).toMatchObject({
      error: 'bad_request',
      message: 'Invalid request parameters.',
    })
    const details = (capture.body as { details: Array<{ path: string; message: string }> }).details
    expect(details).toEqual([{ path: 'lat', message: expect.any(String) }])
  })

  it('passes through 4xx AppErrors with their status and code', () => {
    const { res, capture } = fakeRes()
    errorHandler(badRequest('nope'), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(400)
    expect(capture.body).toEqual({ error: 'bad_request', message: 'nope' })
  })

  it('sanitizes 5xx AppError messages — internals stay in the log', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { res, capture } = fakeRes()
    errorHandler(
      new UpstreamError('Weather API v1/x failed: 429 QUOTA_EXCEEDED secret-details'),
      {} as never,
      res,
      {} as never,
    )
    expect(capture.statusCode).toBe(502)
    expect(capture.body).toEqual({
      error: 'upstream_error',
      message: 'Upstream weather service is unavailable. Try again shortly.',
    })
    // The full detail went to the log, not the client.
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][1]).toContain('QUOTA_EXCEEDED')
    spy.mockRestore()
  })

  it('surfaces the registry-full message for the device cap', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { res, capture } = fakeRes()
    errorHandler(new RegistryFullError(), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.body).toEqual({ error: 'registry_full', message: 'Device registry is full.' })
  })

  it('labels upstream errors with their class name', () => {
    expect(new UpstreamError('x').name).toBe('UpstreamError')
    expect(new AppError(400, 'x').name).toBe('AppError')
  })

  it('logs exactly-status-500 AppErrors, with the error attached', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { res } = fakeRes()
    errorHandler(new AppError(500, 'boom'), {} as never, res, {} as never)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][0]).toHaveProperty('err')
    expect(spy.mock.calls[0][1]).toBe('boom')
  })

  it('honours body-parser 4xx statuses but never trusts 5xx or non-numeric ones', () => {
    const tooLarge = fakeRes()
    errorHandler({ status: 413 }, {} as never, tooLarge.res, {} as never)
    expect(tooLarge.capture.statusCode).toBe(413)
    expect(tooLarge.capture.body).toEqual({ error: 'payload_too_large', message: 'Request body rejected.' })

    const badJson = fakeRes()
    errorHandler({ status: 400 }, {} as never, badJson.res, {} as never)
    expect(badJson.capture.statusCode).toBe(400)
    expect(badJson.capture.body).toEqual({ error: 'bad_request', message: 'Request body rejected.' })

    const fiveHundred = fakeRes()
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    errorHandler({ status: 500 }, {} as never, fiveHundred.res, {} as never)
    expect(fiveHundred.capture.statusCode).toBe(500)

    const stringStatus = fakeRes()
    errorHandler({ status: '404' }, {} as never, stringStatus.res, {} as never)
    expect(stringStatus.capture.statusCode).toBe(500)
    expect(stringStatus.capture.body).toEqual({ error: 'internal_error', message: 'Something went wrong.' })
  })

  it('hides internals for unexpected errors and logs them', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { res, capture } = fakeRes()
    errorHandler(new Error('secret stack details'), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(500)
    expect(capture.body).toEqual({ error: 'internal_error', message: 'Something went wrong.' })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][1]).toBe('Unhandled error')
  })

  it('logs 5xx AppErrors but not 4xx', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const ok = fakeRes()
    errorHandler(badRequest('x'), {} as never, ok.res, {} as never)
    expect(spy).not.toHaveBeenCalled()

    const bad = fakeRes()
    errorHandler(new UpstreamError('x'), {} as never, bad.res, {} as never)
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('errorHandler — parser-status guard arms', () => {
  it('ignores 5xx and non-numeric statuses on body-parser errors', () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})
    for (const bad of [500, 302, '413', undefined]) {
      const { res, capture } = fakeRes()
      errorHandler(Object.assign(new Error('parser'), { status: bad }), {} as never, res, {} as never)
      // Only real 4xx parser statuses may honour err.status; everything
      // else is an internal error with the generic envelope.
      expect(capture.statusCode).toBe(500)
      expect(capture.body).toEqual({ error: 'internal_error', message: 'Something went wrong.' })
    }
    // The unhandled path attaches the error to the log payload.
    expect(err).toHaveBeenCalled()
    expect((err.mock.calls[0][0] as { err: unknown }).err).toBeTruthy()
    err.mockRestore()
  })

  it('sanitizes generic 5xx AppErrors through the same envelope', () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { res, capture } = fakeRes()
    errorHandler(new AppError(500, 'boom'), {} as never, res, {} as never)
    expect(capture.body).toEqual({ error: 'error', message: 'Something went wrong.' })
    err.mockRestore()
  })

  it('labels RegistryFullError with its class name', () => {
    expect(new RegistryFullError().name).toBe('RegistryFullError')
  })

  it('lists zod issue paths and messages in the details array', () => {
    const { res, capture } = fakeRes()
    const zodErr = z.object({ n: z.number() }).safeParse({ n: 'x' }).error
    errorHandler(zodErr as unknown as ZodError, {} as never, res, {} as never)
    expect(capture.body.details).toEqual([
      { path: 'n', message: 'Expected number, received string' },
    ])
  })
})

describe('errorHandler — exact client-facing copy', () => {
  it('sanitizes upstream 5xx to the stable public message', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('Weather API v1/... failed: 500 SECRET-DETAILS'), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(502)
    expect(capture.body).toEqual({
      error: 'upstream_error',
      message: 'Upstream weather service is unavailable. Try again shortly.',
    })
  })

  it('surfaces the registry-full message verbatim', () => {
    const { res, capture } = fakeRes()
    errorHandler(new RegistryFullError(), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.body).toEqual({
      error: 'registry_full',
      message: 'Device registry is full.',
    })
  })

  it('hides internals behind the generic 500 envelope', () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { res, capture } = fakeRes()
    errorHandler(new Error('db password is hunter2'), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(500)
    expect(capture.body).toEqual({ error: 'internal_error', message: 'Something went wrong.' })
    err.mockRestore()
  })

  it('labels parser rejections with the stable body message', () => {
    for (const status of [400, 413]) {
      const { res, capture } = fakeRes()
      errorHandler(Object.assign(new Error('body'), { status }), {} as never, res, {} as never)
      expect(capture.statusCode).toBe(status)
      expect(capture.body).toEqual({
        error: status === 413 ? 'payload_too_large' : 'bad_request',
        message: 'Request body rejected.',
      })
    }
  })
})

describe('errorHandler — generic fallbacks', () => {
  it('falls back to a generic error code when an AppError carries none', () => {
    const { res, capture } = fakeRes()
    errorHandler(new AppError(418, 'teapot'), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(418)
    expect(capture.body).toEqual({ error: 'error', message: 'teapot' })
  })
})

describe('asyncHandler', () => {
  it('routes rejections into next()', async () => {
    const next = vi.fn()
    const handler = asyncHandler(async () => {
      throw new Error('boom')
    })
    await handler({} as never, {} as never, next)
    expect(next).toHaveBeenCalledOnce()
    expect((next.mock.calls[0][0] as Error).message).toBe('boom')
  })
})

describe('errorHandler — upstream throttling', () => {
  it('maps upstream 429 to 503 and forwards Retry-After', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('upstream said no', 429, 2_000), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.headers['Retry-After']).toBe('2')
    expect((capture.body as { message: string }).message).toContain('throttling')
  })

  it('maps upstream 503-with-Retry-After the same way', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('maintenance', 503, 8_000), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.headers['Retry-After']).toBe('8')
  })

  it('a plain 5xx upstream answer stays a 502 without Retry-After', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('boom', 500), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(502)
    expect(capture.headers['Retry-After']).toBeUndefined()
  })

  it('an aborted request scope reports 502 without retry-after', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('call aborted: request scope closed'), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(502)
    expect(capture.headers['Retry-After']).toBeUndefined()
  })

  it('a deadline expiry maps to 504 Gateway Timeout without Retry-After', () => {
    const { res, capture } = fakeRes()
    errorHandler(
      new UpstreamError(
        'call aborted: request scope closed',
        undefined,
        undefined,
        undefined,
        'deadline',
      ),
      {} as never,
      res,
      {} as never,
    )
    expect(capture.statusCode).toBe(504)
    expect(capture.body).toEqual({
      error: 'upstream_error',
      message: 'Upstream weather service did not answer in time. Try again shortly.',
    })
    // The deadline is not the upstream's backoff instruction — no hint is
    // attached; a fresh request with a fresh budget is legitimate.
    expect(capture.headers['Retry-After']).toBeUndefined()
  })

  it('a client hang-up stays a 502 even when explicitly classified', () => {
    const { res, capture } = fakeRes()
    errorHandler(
      new UpstreamError('call aborted: request scope closed', undefined, undefined, undefined, 'client'),
      {} as never,
      res,
      {} as never,
    )
    expect(capture.statusCode).toBe(502)
  })
})

describe('errorHandler — throttling without Retry-After', () => {
  it('still maps 429 to 503, but adds no header when the upstream sent none', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('throttled', 429), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.headers['Retry-After']).toBeUndefined()
  })
})

describe('errorHandler — headers already sent', () => {
  it('delegates to express instead of writing a second status', () => {
    const { res, capture } = fakeRes()
    const sent = { ...res, headersSent: true } as unknown as Response
    const next = vi.fn()
    errorHandler(new Error('late'), {} as never, sent, next)
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
    // Nothing was written on the already-flushed response.
    expect(capture.statusCode).toBe(0)
  })
})

describe('errorHandler — parser status guard arms', () => {
  it('a parser error carrying a 5xx status is NOT honoured (only 4xx parser statuses are)', () => {
    const { res, capture } = fakeRes()
    const suspicious = Object.assign(new Error('parser claims 503'), { status: 503 })
    errorHandler(suspicious, {} as never, res, {} as never)
    // Non-AppError, non-4xx parser status → the generic 500 envelope.
    expect(capture.statusCode).toBe(500)
    expect(capture.body).toEqual({ error: 'internal_error', message: 'Something went wrong.' })
  })
})

describe('errorHandler — parser status guard, sub-400 arm', () => {
  it('a parser error carrying a 3xx status is not honoured either (only 4xx is)', () => {
    const { res, capture } = fakeRes()
    const odd = Object.assign(new Error('parser claims 302'), { status: 302 })
    errorHandler(odd, {} as never, res, {} as never)
    expect(capture.statusCode).toBe(500)
  })
})

describe('errorHandler — cache header and Retry-After edges', () => {
  it('every error body is marked no-store', () => {
    const { res, capture } = fakeRes()
    errorHandler(badRequest('nope'), {} as never, res, {} as never)
    expect(capture.headers['Cache-Control']).toBe('no-store')
    const { res: res2, capture: cap2 } = fakeRes()
    errorHandler(new Error('boom'), {} as never, res2, {} as never)
    expect(cap2.headers['Cache-Control']).toBe('no-store')
  })

  it('a zero Retry-After produces no header', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('t', 429, 0), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.headers['Retry-After']).toBeUndefined()
  })

  it('a non-throttled upstream error never emits Retry-After even with a hint', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('t', 500, 8_000), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(502)
    expect(capture.headers['Retry-After']).toBeUndefined()
  })
})

describe('errorHandler — throttling truth table completeness', () => {
  it('a throttled 503 with a hint emits the hint', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('m', 503, 500), {} as never, res, {} as never)
    expect(capture.headers['Retry-After']).toBe('1')
  })
})

describe('errorHandler — forwarded Retry-After is the upstream\'s uncapped ask', () => {
  it('a 120-second upstream hint is forwarded as 120, not our 5 s sleep budget', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('t', 429, 5_000, 120_000), {} as never, res, {} as never)
    expect(capture.statusCode).toBe(503)
    expect(capture.headers['Retry-After']).toBe('120')
  })

  it('falls back to the internal hint when no uncapped value exists', () => {
    const { res, capture } = fakeRes()
    errorHandler(new UpstreamError('t', 503, 8_000), {} as never, res, {} as never)
    expect(capture.headers['Retry-After']).toBe('8')
  })
})
