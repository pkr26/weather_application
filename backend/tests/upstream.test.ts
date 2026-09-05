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

/** OK response whose raw body is arbitrary text (not necessarily JSON). */
const jsonResponseText = (text: string, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  }) as Response

const coord = { latitude: 17.38, longitude: 78.48 }

afterEach(() => vi.unstubAllGlobals())

describe('parseRetryAfterMs', () => {
  it('parses delay-seconds and applies the cap', async () => {
    const { parseRetryAfterMs } = await import('../src/upstream/http.js')
    expect(parseRetryAfterMs('2')).toBe(2_000)
    expect(parseRetryAfterMs('120')).toBe(5_000) // capped
    expect(parseRetryAfterMs('0')).toBe(0)
    expect(parseRetryAfterMs(null)).toBe(0)
  })

  it('parses HTTP-date form relative to now', async () => {
    const { parseRetryAfterMs } = await import('../src/upstream/http.js')
    const now = Date.now()
    const in3s = new Date(now + 3_000).toUTCString()
    // toUTCString truncates to whole seconds — accept the truncation window.
    const parsed = parseRetryAfterMs(in3s, now)
    expect(parsed).toBeGreaterThanOrEqual(2_000)
    expect(parsed).toBeLessThanOrEqual(3_000)
    const past = new Date(now - 60_000).toUTCString()
    expect(parseRetryAfterMs(past, now)).toBe(0) // a past date asks for no wait
  })

  it('returns 0 for garbage values', async () => {
    const { parseRetryAfterMs } = await import('../src/upstream/http.js')
    expect(parseRetryAfterMs('soon', Date.now())).toBe(0)
  })
})

describe('GoogleWeatherClient per-language alerts breaker', () => {
  it('opens the breaker for one language without failing fast for another', async () => {
    const calls: Array<string | null> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        const lang = s.match(/languageCode=([a-z-]+)/)?.[1] ?? null
        calls.push(lang)
        if (s.includes('publicAlerts')) {
          if (lang === 'xx') return jsonResponse({ detail: 'unsupported' }, 400)
          return jsonResponse({ weatherAlerts: [] })
        }
        return jsonResponse({ ok: true })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '2' }))
    // Two consecutive 400s for the unsupported language…
    await expect(client.publicAlerts(coord, 'xx')).rejects.toBeInstanceOf(UpstreamError)
    await expect(client.publicAlerts(coord, 'xx')).rejects.toBeInstanceOf(UpstreamError)
    // …open that language's breaker only…
    await expect(client.publicAlerts(coord, 'xx')).rejects.toThrow(/breaker open/)
    // …while every other language still reaches the upstream.
    expect(await client.publicAlerts(coord, 'te')).toEqual({ weatherAlerts: [] })
    expect(await client.publicAlerts(coord, 'en')).toEqual({ weatherAlerts: [] })
    expect(calls.filter((l) => l === 'xx').length).toBe(2)
    expect(calls.filter((l) => l === 'te').length).toBe(1)
  })
})

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
    const fetchMock = vi.fn(async () => jsonResponse({ detail: 'forbidden' }, 403))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '3' }))
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries 429 throttling answers — they can heal', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls < 2) return jsonResponse({ detail: 'slow down' }, 429)
      return jsonResponse({ ok: true })
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '2' }))
    expect(await client.currentConditions(coord)).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('retries transient upstream failures and succeeds on a later attempt', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls < 3) return jsonResponse({ error: 'internal' }, 500)
      return jsonResponse({ forecastHours: [{ interval: { startTime: '2026-09-04T00:00:00Z' } }] })
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '2' }))

    const result = (await client.forecastHours(coord)) as { forecastHours: unknown[] }
    expect(result.forecastHours).toHaveLength(1)
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('hours:lookup')) return jsonResponse({ forecastHours: [{ h: 1 }] })
        if (s.includes('days:lookup')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ ok: true })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(false)
  })

  it('treats a first page without its list key as a soft failure, not an answer', async () => {
    // Upstream contract change (renamed field): previously the empty pass-
    // through was served and cached as healthy.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('currentConditions')) return jsonResponse({ temp: 30 })
        if (s.includes('hours:lookup')) return jsonResponse({ renamedHours: [{}] })
        if (s.includes('days:lookup')) return jsonResponse({ forecastDays: [{}] })
        return jsonResponse({ ok: true })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(true)
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
    const fetchMock = vi.fn(async () => jsonResponse({ forecastHours: [], forecastDays: [] }))
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
    const fetchMock = vi.fn(async () => jsonResponse({ forecastHours: [], forecastDays: [] }))
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

describe('fetchJsonWithRetry external request scope', () => {
  const base = {
    url: new URL('https://upstream.test/x'),
    timeoutMs: 5_000,
    retries: 2,
    backoffMs: 1,
    label: 'test',
  }

  it('an already-aborted scope fails fast without fetching', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchJsonWithRetry({ ...base, signal: controller.signal }),
    ).rejects.toThrow(/aborted: request scope closed/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // one attempt, zero retries
  })

  it('a scope aborted mid-flight cancels the in-progress fetch', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
            setTimeout(() => controller.abort(), 10)
          }),
      ),
    )
    await expect(
      fetchJsonWithRetry({ ...base, signal: controller.signal }),
    ).rejects.toThrow(/aborted: request scope closed/)
  })
})

describe('fetchJsonWithRetry error-body handling', () => {
  it('tolerates an unreadable error body', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => {
          throw new Error('body stream broken')
        },
      }) as Response),
    )
    await expect(
      fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 0,
        backoffMs: 1,
        label: 'test',
      }),
    ).rejects.toThrow(/failed: 500/)
  })
})

describe('abort classification for status mapping', () => {
  // AbortSignal.timeout() aborts with a DOMException named 'TimeoutError';
  // the manual abort mirrors that reason for determinism.
  const deadlineReason = () => new DOMException('signal timed out', 'TimeoutError')

  it('marks a TimeoutError abort as deadline (maps to 504 downstream)', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const controller = new AbortController()
    controller.abort(deadlineReason())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('This operation was aborted', 'AbortError')
      }),
    )
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 0,
      backoffMs: 1,
      label: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.abortedBy).toBe('deadline')
  })

  it('marks a plain abort as client (stays 502 downstream)', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const controller = new AbortController()
    controller.abort() // client hang-up: the default AbortError reason
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('This operation was aborted', 'AbortError')
      }),
    )
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 0,
      backoffMs: 1,
      label: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.abortedBy).toBe('client')
  })
})

describe('fetchJsonWithRetry malformed 200 bodies', () => {
  it('retries a 200 whose body is not parseable JSON — like a 5xx', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({}),
            text: async () => '<html>maintenance interstitial</html>',
          } as Response
        }
        return jsonResponse({ recovered: true })
      }),
    )
    const result = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 2,
      backoffMs: 1,
      label: 'test',
    })
    expect(result).toEqual({ recovered: true })
    expect(calls).toBe(2)
  })

  it('gives up after retries with the malformed-body message', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const fetchMock = vi.fn(async () => jsonResponseText('not json at all'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 1,
        backoffMs: 1,
        label: 'test',
      }),
    ).rejects.toThrow(/malformed body/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('fetchJsonWithRetry body byte cap', () => {
  it('refuses to buffer a body beyond the cap — non-retryable', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    // 8 MiB + 1: the cap is a compromised-upstream guard, and a multi-GB
    // body is not a transient fault — one attempt, no retry.
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1)
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => huge,
      }) as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 3,
      backoffMs: 1,
      label: 'test',
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('refusing to buffer')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads a streamed body under the cap normally', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"streamed":'))
        controller.enqueue(encoder.encode('true}'))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: true, status: 200, headers: { get: () => null }, body }) as unknown as Response,
      ),
    )
    const result = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 0,
      backoffMs: 1,
      label: 'test',
    })
    expect(result).toEqual({ streamed: true })
  })

  it('caps the streaming path too — cancels the stream and fails non-retryably', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const chunk = new Uint8Array(5 * 1024 * 1024) // two of these bust the 8 MiB cap
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        // Deliberately NOT closed: a giant response is still mid-stream when
        // the cap trips, and per the streams spec cancel() on an already-
        // closed stream resolves without notifying the source — the mock
        // must stay open for the cancel to be observable.
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, headers: { get: () => null }, body }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 3,
      backoffMs: 1,
      label: 'test',
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('refusing to buffer')
    expect(cancelled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('swallows a failing cancel() — the cap error is still surfaced', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const chunk = new Uint8Array(5 * 1024 * 1024) // two of these bust the 8 MiB cap
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
      },
      cancel() {
        throw new Error('cancel refused')
      },
    })
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, headers: { get: () => null }, body }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 3,
      backoffMs: 1,
      label: 'test',
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('refusing to buffer')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies a mid-read stream failure as transient and retries it like a 5xx', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const makeBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'))
          controller.error(new Error('socket reset'))
        },
      })
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody() }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 1,
      backoffMs: 1,
      label: 'test',
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('body read failed')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 500-class: retried once, then gave up
  })
})

describe('fetchJsonWithRetry honours Retry-After headers', () => {
  it('uses the upstream delay hint for the retry spacing', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (h: string) => (h === 'retry-after' ? '1' : null) },
            json: async () => ({}),
            text: async () => 'slow down',
          } as Response
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ recovered: true }),
          text: async () => JSON.stringify({ recovered: true }),
        } as Response
      }),
    )
    const result = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 2,
      backoffMs: 1,
      label: 'test',
    })
    expect(result).toEqual({ recovered: true })
    expect(calls).toBe(2)
  })
})

describe('paged fetch terminal page', () => {
  it('stops when the last page carries no nextPageToken', async () => {
    const pages = [
      { forecastHours: [{ i: 1 }], nextPageToken: 't2' },
      { forecastHours: [{ i: 2 }] }, // terminal: token absent, not a string
    ]
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(pages[Math.min(call++, pages.length - 1)])),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const out = (await client.forecastHours(coord)) as { forecastHours: unknown[] }
    expect(out.forecastHours).toHaveLength(2)
    expect(out.nextPageToken).toBeUndefined()
  })
})

describe('paged fetch with a shapeless later page', () => {
  it('serves the partial list but marks the bundle degraded', async () => {
    // Page 1 is healthy with a token; page 2 answers 200 without the list
    // key — the contract broke mid-pagination. The pages already fetched
    // are still served (partial beats absent), never as a healthy forecast.
    const warn = vi.spyOn((await import('../src/logger.js')).logger, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('currentConditions')) return jsonResponse({ temp: 30 })
        if (s.includes('forecast/hours') && !s.includes('pageToken')) {
          return jsonResponse({ forecastHours: [{ i: 1 }], nextPageToken: 't2' })
        }
        if (s.includes('forecast/hours')) return jsonResponse({ unrelated: true })
        if (s.includes('forecast/days')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ h: 1 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const core = await client.coreBundle(coord)
    expect((core.forecastHours as { forecastHours: unknown[] }).forecastHours).toEqual([{ i: 1 }])
    expect(core.degraded).toBe(true)
    warn.mockRestore()
  })
})

describe('paged fetch with a token-less empty first page', () => {
  it('marks the bundle degraded — an empty answer is not a healthy forecast', async () => {
    // The request asked for 72 hours and the upstream "answered" with an
    // empty list and no continuation: contract drift, not zero weather.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('currentConditions')) return jsonResponse({ temp: 30 })
        if (s.includes('forecast/hours')) return jsonResponse({ forecastHours: [] })
        if (s.includes('forecast/days')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ h: 1 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const core = await client.coreBundle(coord)
    expect((core.forecastHours as { forecastHours: unknown[] }).forecastHours).toEqual([])
    expect(core.degraded).toBe(true)
  })
})

describe('circuit breaker bookkeeping', () => {
  it('does NOT open after a single failure when BREAKER_FAILURES=2', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return calls === 1 ? jsonResponse({ error: 'x' }, 500) : jsonResponse({ ok: true })
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '2' }))
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError) // failure 1
    // Breaker still closed: the very next call reaches the upstream.
    expect(await client.currentConditions(coord)).toEqual({ ok: true })
  })

  it('resets the failure count after a success', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      // fail (1) → success (2, resets) → fail (3) → success (4)
      return calls === 1 || calls === 3 ? jsonResponse({ error: 'x' }, 500) : jsonResponse({ ok: true })
    }))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '2' }))
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError) // failure 1
    expect(await client.currentConditions(coord)).toEqual({ ok: true })                // success resets
    await expect(client.currentConditions(coord)).rejects.toBeInstanceOf(UpstreamError) // failure 1 again
    // One failure after a reset must NOT trip a 2-failure breaker.
    expect(await client.currentConditions(coord)).toEqual({ ok: true })
  })
})

describe('pagination break conditions', () => {
  it('stops after a page that already satisfies the target', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ forecastHours: Array.from({ length: 72 }, (_, i) => ({ i })), nextPageToken: 'more' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const out = (await client.forecastHours(coord)) as { forecastHours: unknown[] }
    expect(out.forecastHours).toHaveLength(72)
    expect(fetchMock).toHaveBeenCalledTimes(1) // target met — no second page
  })

  it('marks the bundle degraded when a LATER page fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const sUrl = String(url)
        if (sUrl.includes('currentConditions')) return jsonResponse({ temp: 30 })
        // Hours page 1 healthy with a token; page 2 dies mid-pagination.
        if (sUrl.includes('hours:lookup') && !sUrl.includes('pageToken')) {
          return jsonResponse({ forecastHours: [{ i: 1 }], nextPageToken: 't2' })
        }
        if (sUrl.includes('hours:lookup')) return jsonResponse({ error: 'down' }, 500)
        if (sUrl.includes('days:lookup')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ h: 1 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.coreBundle(coord)
    expect(bundle.degraded).toBe(true)
    expect((bundle.forecastHours as { forecastHours: unknown[] }).forecastHours).toHaveLength(1)
  })

  it('marks the bundle degraded when only the DAYS pagination truncates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const sUrl = String(url)
        if (sUrl.includes('currentConditions')) return jsonResponse({ temp: 30 })
        if (sUrl.includes('hours:lookup')) return jsonResponse({ forecastHours: [{ i: 1 }] })
        if (sUrl.includes('days:lookup') && !sUrl.includes('pageToken')) {
          return jsonResponse({ forecastDays: [{ d: 1 }], nextPageToken: 't2' })
        }
        if (sUrl.includes('days:lookup')) return jsonResponse({ error: 'down' }, 500)
        return jsonResponse({ h: 1 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.coreBundle(coord)
    expect(bundle.degraded).toBe(true)
  })

  it('bundle is degraded when ONLY the alerts endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const sUrl = String(url)
        if (sUrl.includes('hours:lookup')) return jsonResponse({ forecastHours: [{ i: 1 }] })
        if (sUrl.includes('days:lookup')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        if (sUrl.includes('publicAlerts')) return jsonResponse({ error: 'gone' }, 500)
        return jsonResponse({ temp: 30 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(true)
    // Everything else stayed healthy.
    expect(bundle.currentConditions).toEqual({ temp: 30 })
  })
})

describe('retry spacing bounds are deterministic', () => {
  it('attempt 2 waits the full jittered backoff window (>=70ms with base 100)', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls === 1) return jsonResponse({ error: 'x' }, 500)
        return jsonResponse({ ok: true })
      }))
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      const pending = fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 2,
        backoffMs: 100,
        label: 'test',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      // Jitter window for attempt 0 is [70, 130] ms: 69 ms must NOT be enough.
      await vi.advanceTimersByTimeAsync(69)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(70)
      expect(calls).toBe(2)
      await expect(pending).resolves.toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Retry-After wins over the jittered backoff', () => {
  it('waits the upstream hint, not the smaller backoff', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (h: string) => (h === 'retry-after' ? '1' : null) },
            json: async () => ({}),
            text: async () => 'slow down',
          } as Response
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: 1 }), text: async () => JSON.stringify({ ok: 1 }) } as Response
      }))
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      const pending = fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 2,
        backoffMs: 100,
        label: 't',
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(calls).toBe(1) // Retry-After says 1s — the 100ms backoff must NOT win
      await vi.advanceTimersByTimeAsync(600)
      expect(calls).toBe(2)
      await expect(pending).resolves.toEqual({ ok: 1 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GeocodingClient request shapes', () => {
  it('reverse geocoding passes exact coordinates', async () => {
    const { GeocodingClient } = await import('../src/upstream/openMeteo.js')
    const fetchMock = vi.fn(async () => jsonResponse({ city: 'Testville' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GeocodingClient(makeConfig())
    const out = (await client.reverse(17.385678, -0.123456)) as { name: string | null }
    expect(out.name).toBe('Testville')
    const url = fetchMock.mock.calls[0][0] as URL
    expect(url.searchParams.get('latitude')).toBe('17.385678')
    expect(url.searchParams.get('longitude')).toBe('-0.123456')
    expect(url.searchParams.get('localityLanguage')).toBe('en')
  })
})

describe('per-endpoint signal threading', () => {
  it('currentConditions aborts through its pass-through options', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
            setTimeout(() => controller.abort(), 10)
          }),
      ),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(
      client.currentConditions(coord, controller.signal),
    ).rejects.toThrow(/aborted: request scope closed/)
  })

  it('historyHours aborts through its pass-through options', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
            setTimeout(() => controller.abort(), 10)
          }),
      ),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(
      client.historyHours(coord, 24, controller.signal),
    ).rejects.toThrow(/aborted: request scope closed/)
  })

  it('aborted calls do not count toward the circuit breaker', async () => {
    // ONE client (one breaker) across five aborted calls: with a
    // 2-failure breaker, counting aborts would open it and the final
    // success would fail fast.
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0', BREAKER_FAILURES: '2' }))
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController()
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: URL, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              )
              setTimeout(() => controller.abort(), 5)
            }),
        ),
      )
      await expect(
        client.currentConditions(coord, controller.signal),
      ).rejects.toThrow(/aborted: request scope closed/)
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    expect(await client.currentConditions(coord)).toEqual({ ok: true })
  })
})

describe('attempt-1 retry spacing and uncapped hint carry', () => {
  it('attempt 1 waits the doubled backoff window (>=140ms with base 100)', async () => {
    vi.useFakeTimers()
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0) // jitter = 0.7x exactly
    try {
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls <= 2) return jsonResponse({ error: 'x' }, 500)
        return jsonResponse({ forecastHours: [{ i: 1 }] })
      }))
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      const pending = fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 2,
        backoffMs: 100,
        label: 't',
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(140) // first retry happened, second not yet
      expect(calls).toBe(2)
      // Worst case for attempt 1: attempt 0 fired at t≈130, its delay is
      // 200×[0.7,1.3] ≤ 260 → attempt 1 fires by t≈390.
      await vi.advanceTimersByTimeAsync(400)
      expect(calls).toBe(3)
      await expect(pending).resolves.toBeDefined()
    } finally {
      rand.mockRestore()
      vi.useRealTimers()
    }
  })

  it('the error carries the UNCAPPED upstream hint for forwarding', async () => {
    const { fetchJsonWithRetry, UpstreamError } = await import('../src/upstream/http.js')
    const { UpstreamError: UE } = await import('../src/errors.js')
    void UpstreamError
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: { get: (h: string) => (h === 'retry-after' ? '120' : null) },
        json: async () => ({}),
        text: async () => 'slow down',
      }) as Response),
    )
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 0,
      backoffMs: 1,
      label: 't',
    }).catch((e: unknown) => e as InstanceType<typeof UE>)
    expect(err).toBeInstanceOf(UE)
    expect((err as InstanceType<typeof UE>).retryAfterMs).toBe(5_000) // our sleep: capped
    expect((err as InstanceType<typeof UE>).forwardRetryAfterMs).toBe(120_000) // client: uncapped
  })
})

describe('non-UpstreamError failures are never retried', () => {
  it('a network error with retries available still makes exactly one attempt', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    await expect(
      fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 2,
        backoffMs: 1,
        label: 't',
      }),
    ).rejects.toThrow(/unreachable/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('lingering-token truncation derivation', () => {
  it('a satisfied target with a lingering nextPageToken is NOT truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const sUrl = String(url)
        if (sUrl.includes('hours:lookup')) {
          return jsonResponse({ forecastHours: Array.from({ length: 72 }, (_, i) => ({ i })), nextPageToken: 'more' })
        }
        if (sUrl.includes('days:lookup')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ ok: true })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.coreBundle(coord)
    expect(bundle.degraded).toBe(false)
  })
})

describe('exponential backoff arithmetic (deterministic jitter)', () => {
  it('the attempt-1 delay is 2x the attempt-0 delay (200 vs 100 base)', async () => {
    vi.useFakeTimers()
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls <= 2) return jsonResponse({ error: 'x' }, 500)
        return jsonResponse({ forecastHours: [{ i: 1 }] })
      }))
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      const pending = fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 2,
        backoffMs: 100,
        label: 't',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(69)
      expect(calls).toBe(1) // attempt-0 sleep is exactly 70
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2) // …and fires at exactly 70
      await vi.advanceTimersByTimeAsync(139)
      expect(calls).toBe(2) // attempt-1 sleep is exactly 140 (200*0.7)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(3) // …firing at exactly +140
      await expect(pending).resolves.toBeDefined()
    } finally {
      rand.mockRestore()
      vi.useRealTimers()
    }
  })

  it('a scope aborted during the backoff sleep fails fast without retrying', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const controller = new AbortController()
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        return jsonResponse({ error: 'x' }, 500)
      }))
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      const pending = fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 3,
        backoffMs: 1_000,
        label: 't',
        signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      controller.abort() // client hangs up during the backoff sleep
      await expect(pending).rejects.toThrow(/aborted: request scope closed/)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls).toBe(1) // the aborted sleep must not fire another attempt
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('abort-aware sleep', () => {
  it('rejects immediately when the scope is already dead', async () => {
    const { sleep } = await import('../src/upstream/http.js')
    const dead = new AbortController()
    dead.abort()
    await expect(sleep(1_000, dead.signal)).rejects.toThrow()
    // An un-signalled sleep resolves normally.
    await expect(sleep(0)).resolves.toBeUndefined()
  })
})

describe('paged fetch first-page contract guard', () => {
  it('a shapeless FIRST page rejects outright — it is a contract break, not an answer', async () => {
    // A first page without the list key is an upstream contract change. It
    // must throw (fail the endpoint) — never fall through to the "serve the
    // partial list, flag truncated" path reserved for LATER pages: the
    // throw keeps the failure out of the cache entirely.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ renamedHours: [{}] })))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await expect(client.forecastHours(coord, 72)).rejects.toBeInstanceOf(UpstreamError)
    await expect(client.forecastDays(coord, 10)).rejects.toBeInstanceOf(UpstreamError)
  })
})

describe('paged fetch envelope metadata', () => {
  it('the merged response keeps the FIRST page’s envelope fields only', async () => {
    // Envelope metadata (timezone…) comes from the first page; a later page
    // is only a list continuation and must neither overwrite nor leak fields.
    const fetchMock = vi.fn(async (url: URL) => {
      const token = url.searchParams.get('pageToken')
      if (!token) {
        return jsonResponse({
          timeZone: { id: 'Asia/Kolkata' },
          forecastHours: Array.from({ length: 24 }, (_, i) => ({ iv: `a${i}` })),
          nextPageToken: 't2',
        })
      }
      return jsonResponse({
        timeZone: { id: 'Europe/Paris' },
        secondPageOnly: true,
        forecastHours: Array.from({ length: 24 }, (_, i) => ({ iv: `b${i}` })),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))

    const result = (await client.forecastHours(coord, 30)) as {
      forecastHours: unknown[]
      timeZone?: { id: string }
      secondPageOnly?: boolean
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.forecastHours).toHaveLength(30)
    expect(result.timeZone?.id).toBe('Asia/Kolkata') // first page’s metadata
    expect(result).not.toHaveProperty('secondPageOnly') // no later-page leakage
  })
})

describe('paged fetch empty-page guards', () => {
  const healthyRest = (s: string) =>
    s.includes('currentConditions')
      ? jsonResponse({ temp: 30 })
      : s.includes('days:lookup')
        ? jsonResponse({ forecastDays: [{ d: 1 }] })
        : jsonResponse({ h: 1 })

  it('an empty first page WITH a token keeps paging normally — not degraded', async () => {
    // The empty-answer guard targets token-less pages (terminal emptiness).
    // An empty page that still carries a continuation token is mid-answer:
    // paging continues and the eventual data must stay healthy.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('hours:lookup')) {
          if (!s.includes('pageToken')) {
            return jsonResponse({ forecastHours: [], nextPageToken: 't2' })
          }
          return jsonResponse({
            forecastHours: Array.from({ length: 24 }, (_, i) => ({ iv: i })),
          })
        }
        return healthyRest(s)
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const core = await client.coreBundle(coord)
    expect((core.forecastHours as { forecastHours: unknown[] }).forecastHours).toHaveLength(24)
    expect(core.degraded).toBe(false)
  })

  it('an empty first page with a token followed by an empty terminal page stays healthy', async () => {
    // The token-less-empty-page guard is scoped to the FIRST page: once a
    // continuation existed, a later empty terminal page is judged by the
    // ordinary linger condition (no token pending → nothing owed → healthy).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('hours:lookup')) {
          if (!s.includes('pageToken')) {
            return jsonResponse({ forecastHours: [], nextPageToken: 't2' })
          }
          return jsonResponse({ forecastHours: [] })
        }
        return healthyRest(s)
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const core = await client.coreBundle(coord)
    expect((core.forecastHours as { forecastHours: unknown[] }).forecastHours).toEqual([])
    expect(core.degraded).toBe(false)
  })

  it('a target of zero asks for nothing — an empty answer to an empty ask stays healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ forecastHours: [] })))
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    // Private visibility is compile-time only; target=0 is unreachable
    // through the public surface (the bundle always asks for 72 hours / 10
    // days), so the boundary is pinned against the real method directly.
    const callPaged = (
      client as unknown as {
        callPaged: (
          path: string,
          params: Record<string, string>,
          listKey: string,
          target: number,
        ) => Promise<{ value: Record<string, unknown>; truncated: boolean }>
      }
    ).callPaged.bind(client)

    const out = await callPaged('v1/forecast/hours:lookup', {}, 'forecastHours', 0)
    expect(out.truncated).toBe(false)
    expect(out.value.forecastHours).toEqual([])
  })
})

describe('paged fetch shapeless later page diagnostics', () => {
  it('logs the path and page number of the contract break', async () => {
    const warn = vi.spyOn((await import('../src/logger.js')).logger, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('hours:lookup') && !s.includes('pageToken')) {
          return jsonResponse({ forecastHours: [{ i: 1 }], nextPageToken: 't2' })
        }
        if (s.includes('hours:lookup')) return jsonResponse({ unrelated: true })
        if (s.includes('days:lookup')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ h: 1 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    await client.coreBundle(coord)
    expect(warn).toHaveBeenCalledOnce()
    const ctx = warn.mock.calls[0][0] as { path: string; page: number }
    expect(ctx.path).toContain('forecast/hours:lookup')
    expect(ctx.page).toBe(1) // the page that lost its list key
    warn.mockRestore()
  })
})

describe('bundle alerts soft-failure diagnostics', () => {
  it('logs the non-critical alerts failure it degrades with', async () => {
    const warn = vi.spyOn((await import('../src/logger.js')).logger, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | Request) => {
        const s = String(url)
        if (s.includes('publicAlerts')) return jsonResponse({ error: 'gone' }, 500)
        if (s.includes('hours:lookup')) return jsonResponse({ forecastHours: [{ i: 1 }] })
        if (s.includes('days:lookup')) return jsonResponse({ forecastDays: [{ d: 1 }] })
        return jsonResponse({ temp: 30 })
      }),
    )
    const client = new GoogleWeatherClient(makeConfig({ UPSTREAM_RETRIES: '0' }))
    const bundle = await client.bundle(coord)
    expect(bundle.degraded).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('body byte cap boundary is inclusive', () => {
  it('accepts a text-path body of exactly MAX_BODY_BYTES (8 MiB)', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    // Exactly 8 MiB of valid JSON (number + trailing whitespace): a body AT
    // the cap is a legitimate answer — only strictly-beyond is refused.
    const exact = '1' + ' '.repeat(8 * 1024 * 1024 - 1)
    expect(Buffer.byteLength(exact)).toBe(8 * 1024 * 1024)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: true, status: 200, headers: { get: () => null }, text: async () => exact }) as Response,
      ),
    )
    const result = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 3,
      backoffMs: 1,
      label: 'test',
    })
    expect(result).toBe(1)
  })

  it('accepts a streamed body of exactly MAX_BODY_BYTES (8 MiB)', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const exact = '1' + ' '.repeat(8 * 1024 * 1024 - 1)
    const bytes = new TextEncoder().encode(exact)
    expect(bytes.byteLength).toBe(8 * 1024 * 1024)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: true, status: 200, headers: { get: () => null }, body }) as unknown as Response,
      ),
    )
    const result = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 3,
      backoffMs: 1,
      label: 'test',
    })
    expect(result).toBe(1)
  })
})

describe('abort classification without a reason', () => {
  it('a reason-less aborted scope classifies as client — it must not crash', async () => {
    // Not every abort source populates signal.reason the DOM way; reading
    // the name must stay optional so classification still returns 'client'.
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const signal = { aborted: true } as AbortSignal
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 0,
      backoffMs: 1,
      label: 'test',
      signal,
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.abortedBy).toBe('client')
  })
})

describe('Retry-After persists across attempts', () => {
  it('a later attempt without its own hint still honours the remembered one', async () => {
    vi.useFakeTimers()
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0) // deterministic jitter
    try {
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++
          if (calls === 1) {
            return {
              ok: false,
              status: 429,
              headers: { get: (h: string) => (h === 'retry-after' ? '1' : null) },
              json: async () => ({}),
              text: async () => 'slow down',
            } as Response
          }
          if (calls === 2) {
            // A 500 with no Retry-After of its own: the remembered 1 s hint
            // must keep spacing the retries, not be reset to nothing.
            return jsonResponse({ error: 'x' }, 500)
          }
          return jsonResponse({ ok: true })
        }),
      )
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      const pending = fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 2,
        backoffMs: 100,
        label: 't',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000) // first retry sleeps the 1 s hint
      expect(calls).toBe(2)
      // Attempt 1 fires at exactly 200*0.7 = 140 ms if the hint were
      // forgotten; the remembered hint must hold it until t = 2 s.
      await vi.advanceTimersByTimeAsync(140)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(860) // t = 2000: the hinted delay elapses
      expect(calls).toBe(3)
      await expect(pending).resolves.toEqual({ ok: true })
    } finally {
      rand.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('body-read failure diagnostics are bounded', () => {
  it('slices the underlying stream error to 120 characters', async () => {
    const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
    const makeBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'))
          controller.error(new Error('E'.repeat(300)))
        },
      })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody() }) as unknown as Response,
      ),
    )
    const err = await fetchJsonWithRetry({
      url: new URL('https://upstream.test/x'),
      timeoutMs: 5_000,
      retries: 0,
      backoffMs: 1,
      label: 'test',
    }).catch((e: unknown) => e as UpstreamError)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.message).toContain('body read failed')
    expect(err.message).toContain('Error: E') // the underlying error is named
    // 'test body read failed: ' (23) + at most 120 sliced chars.
    expect(err.message.length).toBeLessThan(145)
  })
})

describe('per-attempt deadline hygiene', () => {
  it('clears the attempt timer once the attempt settles — no stray aborts later', async () => {
    vi.useFakeTimers()
    try {
      let seen: AbortSignal | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: URL, init: RequestInit) => {
          seen = init.signal
          return jsonResponse({ ok: true })
        }),
      )
      const { fetchJsonWithRetry } = await import('../src/upstream/http.js')
      await fetchJsonWithRetry({
        url: new URL('https://upstream.test/x'),
        timeoutMs: 5_000,
        retries: 0,
        backoffMs: 1,
        label: 't',
      })
      // Past the attempt deadline: the settled attempt's abort signal must
      // never fire — an uncleared timer would abort the composite signal the
      // upstream fetch still holds.
      await vi.advanceTimersByTimeAsync(6_000)
      expect(seen?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
