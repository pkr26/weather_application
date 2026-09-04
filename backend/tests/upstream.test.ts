import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, resetConfigCache } from '../src/config.js'
import { GoogleWeatherClient } from '../src/upstream/googleWeather.js'
import { GeocodingClient } from '../src/upstream/openMeteo.js'
import { UpstreamError } from '../src/errors.js'

process.env.LOG_LEVEL = 'silent'

function makeConfig(overrides: Record<string, string> = {}) {
  resetConfigCache()
  return loadConfig({
    WEATHER_API_KEY: 'test-key',
    UPSTREAM_TIMEOUT_MS: '50',
    UPSTREAM_RETRY_BACKOFF_MS: '1',
    ...overrides,
  } as NodeJS.ProcessEnv)
}

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response

const coord = { latitude: 17.38, longitude: 78.48 }

afterEach(() => vi.unstubAllGlobals())

describe('GoogleWeatherClient', () => {
  it('sends the API key in the dedicated header and returns parsed JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ hello: 'world' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const result = await client.currentConditions(coord)

    expect(result).toEqual({ hello: 'world' })
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toContain('location.latitude=17.38')
    expect(url.toString()).toContain('unitsSystem=METRIC')
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key')
  })

  it('treats a 404 from publicAlerts as "no coverage" and returns an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 404)))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    expect(await client.publicAlerts(coord)).toEqual({})
  })

  it('fails loudly on a 404 from any endpoint other than publicAlerts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 404)))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
  })

  it('does not retry permanent 4xx answers even when retries are available', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: 'quota' }, 429))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '3' }))
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries transient upstream failures and succeeds on a later attempt', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls < 3) return jsonResponse({ error: 'internal' }, 500)
      return jsonResponse({ ok: true })
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '2' }))

    const result = await client.forecastHours(coord)
    expect(result).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('gives up after the configured number of retries', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'internal' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '2' }))

    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 + 2 retries
  })

  it('wraps network failures as UpstreamError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(client.currentConditions(coord)).rejects.toThrow(/unreachable/i)
  })

  it('aborts calls that exceed the upstream timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
      ),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', UPSTREAM_TIMEOUT_MS: '50' }))
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
  })

  it('bundle keeps the critical endpoint but fails soft on the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('currentConditions')) return jsonResponse({ temp: 30 })
        return jsonResponse({ error: 'down' }, 500)
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const bundle = await client.bundle(coord)
    expect(bundle.currentConditions).toEqual({ temp: 30 })
    expect(bundle.forecastHours).toEqual({})
    expect(bundle.forecastDays).toEqual({})
    expect(bundle.historyHours).toEqual({})
    expect(bundle.publicAlerts).toEqual({})
  })

  it('bundle fails loudly when the critical endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'down' }, 500)))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(client.bundle(coord)).rejects.toBeInstanceOf(UpstreamError)
  })

  it('marks a soft-failed bundle as degraded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('currentConditions')) return jsonResponse({ temp: 30 })
        return jsonResponse({ error: 'down' }, 500)
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(true)
    expect(bundle.currentConditions).toEqual({ temp: 30 })
  })

  it('marks a fully successful bundle as not degraded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(false)
  })

  it('marks the core bundle degraded when pagination truncated a list', async () => {
    let hoursCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('currentConditions')) return jsonResponse({ temp: 30 })
        if (s.includes('hours')) {
          hoursCalls++
          if (hoursCalls === 1) return jsonResponse({ forecastHours: [{ iv: 1 }], nextPageToken: 'tok' })
          return jsonResponse({ error: 'down' }, 500) // page 2 of forecastHours dies
        }
        return jsonResponse({ ok: true }) // days + history healthy
      }),
    )
    const warn = vi.spyOn((await import('../src/logger.js')).logger, 'warn').mockImplementation(() => {})
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const core = await client.coreBundle(coord)
    expect(core.forecastHours).toEqual({ forecastHours: [{ iv: 1 }] }) // partial beats absent
    expect(core.degraded).toBe(true) // but it must never look healthy
    warn.mockRestore()
  })

  it('marks the core bundle degraded when the page cap is hit with a token pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ forecastDays: [{ d: 1 }], nextPageToken: 'x' })),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const core = await client.coreBundle(coord)
    expect((core.forecastDays as { forecastDays: unknown[] }).forecastDays).toHaveLength(6)
    expect(core.degraded).toBe(true)
  })
})

describe('GoogleWeatherClient circuit breaker', () => {
  it('fails fast once an endpoint has failed BREAKER_FAILURES times in a row', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'down' }, 500))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '2' }))

    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    // Breaker open: the third call never reaches the network.
    await expect(client.currentConditions(coord)).rejects.toThrow(/circuit breaker open/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resets after a successful call (half-open probe passes)', async () => {
    let fail = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (fail ? jsonResponse({}, 500) : jsonResponse({ ok: true }))),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '1', BREAKER_COOLDOWN_MS: '10' }))

    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    await expect(client.currentConditions(coord)).rejects.toThrow(/circuit breaker open/)
    await new Promise((r) => setTimeout(r, 30)) // cooldown elapses -> probe allowed
    fail = false
    expect(await client.currentConditions(coord)).toEqual({ ok: true })
  })

  it('can be disabled entirely with BREAKER_FAILURES=0', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'down' }, 500))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '0' }))
    for (let i = 0; i < 6; i++) {
      await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    }
    expect(fetchMock).toHaveBeenCalledTimes(6) // every call reached the network
  })
})

describe('retry backoff', () => {
  it('spaces retry attempts apart instead of retrying immediately', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++
          if (calls < 3) return jsonResponse({ error: 'internal' }, 500)
          return jsonResponse({ ok: true })
        }),
      )
      const client = new GoogleWeatherClient(
        makeConfig({ UPSTREAM_RETRIES: '2', UPSTREAM_RETRY_BACKOFF_MS: '100' }),
      )
      const pending = client.currentConditions(coord)
      // First retry must wait ~100ms: nothing happens until the timer moves.
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(await pending).toEqual({ ok: true })
      expect(calls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GoogleWeatherClient pagination', () => {
  const hourPage = (n: number, token?: string) => {
    const body: Record<string, unknown> = {
      timeZone: { id: 'Asia/Kolkata' },
      forecastHours: Array.from({ length: 24 }, (_, i) => ({ iv: `${n}-${i}` })),
    }
    if (token) body.nextPageToken = token
    return body
  }

  it('follows nextPageToken until the requested hours are collected', async () => {
    const pages = [hourPage(1, 'tok-2'), hourPage(2, 'tok-3'), hourPage(3)]
    const fetchMock = vi.fn(async (url: URL) => {
      const token = url.searchParams.get('pageToken')
      if (!token) return jsonResponse(pages[0])
      if (token === 'tok-2') return jsonResponse(pages[1])
      return jsonResponse(pages[2])
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const result = (await client.forecastHours(coord, 72)) as {
      forecastHours: Array<{ iv: string }>
      nextPageToken?: string
      timeZone: { id: string }
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.forecastHours).toHaveLength(72)
    expect(result.forecastHours[0].iv).toBe('1-0')
    expect(result.forecastHours[49].iv).toBe('3-1') // third page begins at index 48
    expect(result.nextPageToken).toBeUndefined() // clients get one seamless list
    expect(result.timeZone.id).toBe('Asia/Kolkata') // first page's metadata kept
  })

  it('stops paging once the target count is reached', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ forecastDays: Array.from({ length: 5 }, (_, i) => ({ d: i })) }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    // A page WITHOUT a token must not trigger another fetch.
    const result = (await client.forecastDays(coord, 5)) as { forecastDays: unknown[] }
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.forecastDays).toHaveLength(5)
  })

  it('serves partial data when a later page fails', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) return jsonResponse(hourPage(1, 'tok-2'))
        return jsonResponse({ error: 'down' }, 500)
      }),
    )
    const warn = vi.spyOn((await import('../src/logger.js')).logger, 'warn').mockImplementation(() => {})
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const result = (await client.forecastHours(coord, 72)) as { forecastHours: unknown[] }
    expect(result.forecastHours).toHaveLength(24) // first page survives
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('propagates a first-page failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'down' }, 500)))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(client.forecastDays(coord)).rejects.toBeInstanceOf(UpstreamError)
  })

  it('never pages more than the safety cap regardless of tokens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ forecastDays: [{ d: 1 }], nextPageToken: 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const result = (await client.forecastDays(coord, 10)) as { forecastDays: unknown[] }
    expect(fetchMock).toHaveBeenCalledTimes(6) // MAX_PAGES guard
    expect(result.forecastDays).toHaveLength(6)
  })

  it('slices the merged list to the requested target', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      const token = url.searchParams.get('pageToken')
      const list = Array.from({ length: 24 }, (_, i) => ({ iv: token ? `b${i}` : `a${i}` }))
      return token
        ? jsonResponse({ forecastHours: list })
        : jsonResponse({ forecastHours: list, nextPageToken: 't' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const result = (await client.forecastHours(coord, 30)) as { forecastHours: unknown[] }
    expect(result.forecastHours).toHaveLength(30) // 48 merged, sliced to 30
  })
})

describe('GeocodingClient', () => {
  it('searches with the query and count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ id: 1 }] }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GeocodingClient(makeConfig())

    const result = await client.search('Hyderabad', 5)
    expect(result).toEqual({ results: [{ id: 1 }] })
    const url = fetchMock.mock.calls[0][0] as URL
    expect(url.pathname).toContain('/v1/search')
    expect(url.searchParams.get('name')).toBe('Hyderabad')
    expect(url.searchParams.get('count')).toBe('5')
    expect(url.searchParams.get('language')).toBe('en')
    expect(url.searchParams.get('format')).toBe('json')
  })

  it('surfaces upstream HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    const client = new GeocodingClient(makeConfig())
    const err = await client.search('X').catch((e: Error) => e)
    expect(err.message).toContain('Geocoding API failed: 500') // rethrown verbatim, not re-wrapped
  })

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const client = new GeocodingClient(makeConfig())
    await expect(client.search('X')).rejects.toThrow(/Geocoding API unreachable/i)
  })

  it('aborts searches that exceed the upstream timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
      ),
    )
    const client = new GeocodingClient(makeConfig({ UPSTREAM_TIMEOUT_MS: '50' }))
    await expect(client.search('SlowCity')).rejects.toBeInstanceOf(UpstreamError)
  })
  it('reverse geocodes coordinates and maps the name chain', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        city: 'Mountain View',
        locality: 'Old Mountain View',
        principalSubdivision: 'California',
        countryName: 'United States',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new GeocodingClient(makeConfig())

    const result = (await client.reverse(37.42, -122.08)) as {
      name: string | null
      admin1: string | null
      country: string | null
    }
    expect(result).toEqual({
      name: 'Mountain View',
      admin1: 'California',
      country: 'United States',
    })
    const url = fetchMock.mock.calls[0][0] as URL
    expect(url.pathname).toContain('/data/reverse-geocode-client')
    expect(url.searchParams.get('latitude')).toBe('37.42')
    expect(url.searchParams.get('longitude')).toBe('-122.08')
  })

  it('falls back to locality then subdivision when city is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ locality: 'Old Mountain View', principalSubdivision: 'California' }),
      ),
    )
    const client = new GeocodingClient(makeConfig())
    expect(((await client.reverse(1, 2)) as { name: string | null }).name).toBe('Old Mountain View')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ principalSubdivision: 'California' })),
    )
    expect(((await client.reverse(1, 2)) as { name: string | null }).name).toBe('California')

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ city: '   ' })))
    expect(((await client.reverse(1, 2)) as { name: string | null }).name).toBeNull()
  })

  it('wraps reverse-geocoding failures as UpstreamError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 503)))
    const client = new GeocodingClient(makeConfig())
    const err = await client.reverse(1, 2).catch((e: Error) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('Reverse geocoding failed: 503')
  })

})

describe('GoogleWeatherClient request shapes', () => {
  const paramCase = async (
    run: (client: GoogleWeatherClient) => Promise<unknown>,
    expect: (url: URL) => void,
  ) => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await run(client)
    expect(fetchMock.mock.calls[0][0] as URL)
  }

  it('currentConditions requests METRIC data in English at 4-decimal precision', async () => {
    await paramCase(
      (c) => c.currentConditions({ latitude: 17.385678, longitude: -0.123456 }),
      (url) => {
        expect(url.pathname).toContain('currentConditions:lookup')
        expect(url.searchParams.get('location.latitude')).toBe('17.3857')
        expect(url.searchParams.get('location.longitude')).toBe('-0.1235')
        expect(url.searchParams.get('unitsSystem')).toBe('METRIC')
        expect(url.searchParams.get('languageCode')).toBe('en')
      },
    )
  })

  it('forecastHours asks for 72 hours at 4-decimal coordinates', async () => {
    await paramCase(
      (c) => c.forecastHours({ latitude: 17.385678, longitude: -0.123456 }),
      (url) => {
        expect(url.pathname).toContain('forecast/hours:lookup')
        expect(url.searchParams.get('hours')).toBe('72')
        expect(url.searchParams.get('location.latitude')).toBe('17.3857')
        expect(url.searchParams.get('location.longitude')).toBe('-0.1235')
        expect(url.searchParams.get('unitsSystem')).toBe('METRIC')
      },
    )
  })

  it('forecastDays asks for 10 days', async () => {
    await paramCase(
      (c) => c.forecastDays({ latitude: 1.23456, longitude: 2.34567 }),
      (url) => {
        expect(url.pathname).toContain('forecast/days:lookup')
        expect(url.searchParams.get('days')).toBe('10')
        expect(url.searchParams.get('location.latitude')).toBe('1.2346')
        expect(url.searchParams.get('location.longitude')).toBe('2.3457')
      },
    )
  })

  it('historyHours asks for the last 24 hours', async () => {
    await paramCase(
      (c) => c.historyHours({ latitude: 1.23456, longitude: 2.34567 }),
      (url) => {
        expect(url.pathname).toContain('history/hours:lookup')
        expect(url.searchParams.get('hours')).toBe('24')
        expect(url.searchParams.get('location.latitude')).toBe('1.2346')
      },
    )
  })

  it('publicAlerts passes the requested language and defaults to English in bundle', async () => {
    await paramCase(
      (c) => c.publicAlerts({ latitude: 1.23456, longitude: 2 }, 'te'),
      (url) => {
        expect(url.pathname).toContain('publicAlerts:lookup')
        expect(url.searchParams.get('languageCode')).toBe('te')
        expect(url.searchParams.get('location.latitude')).toBe('1.2346')
      },
    )
    // The bundle's fifth call is publicAlerts, in English by default.
    const fetchMock = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await client.bundle({ latitude: 1.23456, longitude: 2 })
    const alertUrl = fetchMock.mock.calls[4][0] as URL
    expect(alertUrl.pathname).toContain('publicAlerts:lookup')
    expect(alertUrl.searchParams.get('languageCode')).toBe('en')
  })

  it('logs a warning between retry attempts', async () => {
    const { logger } = await import('../src/logger.js')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return calls === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true })
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '1' }))
    await client.currentConditions(coord)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][1]).toBe('Upstream call failed, retrying')
    warn.mockRestore()
  })

  it('includes the beginning of the upstream error body in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'QUOTA_EXCEEDED' + 'x'.repeat(400) }, 429)),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const err = await client.currentConditions(coord).catch((e: Error) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('QUOTA_EXCEEDED')
  })

  it('sends the configured Referer only when set', async () => {
    const withReferer = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', withReferer)
    const client = new GoogleWeatherClient(
      makeConfig({ UPSTREAM_RETRIES: '0', WEATHER_API_REFERER: 'https://app.example.com' }),
    )
    await client.currentConditions(coord)
    expect((withReferer.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Referer: 'https://app.example.com',
      'X-Goog-Api-Key': 'test-key',
    })

    const withoutReferer = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', withoutReferer)
    const bare = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await bare.currentConditions(coord)
    expect((withoutReferer.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Referer')
  })

  it('does not retry network errors — only HTTP-level failures retry', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      throw new TypeError('socket hang up')
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '3' }))
    await expect(client.currentConditions(coord)).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('survives a response whose body cannot be read on the error path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error('unreadable')
          },
          json: async () => ({}),
        }) as Response,
      ),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(client.currentConditions(coord)).rejects.toThrow(/failed: 500/)
  })

  it('reports the upstream status and truncated body in the error', async () => {
    const bigBody = 'x'.repeat(500)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: bigBody }, 429)))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const err = await client.currentConditions(coord).catch((e: Error) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('429')
    expect(err.message.length).toBeLessThan(300)
  })
})
