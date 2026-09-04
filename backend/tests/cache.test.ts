import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TtlCache, coordKey } from '../src/cache.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('TtlCache', () => {
  it('returns undefined for unknown keys', () => {
    const cache = new TtlCache<number>(1000)
    expect(cache.get('nope')).toBeUndefined()
    expect(cache.getEntry('nope')).toBeUndefined()
  })

  it('stores and expires entries after the TTL', () => {
    const cache = new TtlCache<string>(1000)
    cache.set('k', 'v')
    expect(cache.get('k')).toBe('v')

    vi.advanceTimersByTime(999)
    expect(cache.get('k')).toBe('v')
    vi.advanceTimersByTime(2)
    expect(cache.get('k')).toBeUndefined()
    // Expired entry is really gone, not just reported expired.
    expect(cache.getEntry('k')).toBeUndefined()
  })

  it('treats an entry exactly at the TTL boundary as expired', () => {
    const cache = new TtlCache<string>(1000)
    cache.set('k', 'v')
    vi.advanceTimersByTime(1000)
    expect(cache.get('k')).toBeUndefined()
  })

  it('serves values the cacheable predicate rejects, but never stores them', async () => {
    const cache = new TtlCache<string>(1000)
    const first = await cache.getOrLoadWithMeta(
      'k',
      async () => 'degraded',
      { cacheable: (v) => v !== 'degraded' },
    )
    expect(first.value).toBe('degraded')
    expect(first.cache).toBe('miss')
    expect(cache.get('k')).toBeUndefined() // not stored

    const second = await cache.getOrLoadWithMeta(
      'k',
      async () => 'healthy',
      { cacheable: (v) => v !== 'degraded' },
    )
    expect(second.value).toBe('healthy') // loader ran again
    expect(cache.get('k')).toBe('healthy') // and this time it stuck
  })

  it('reports hit metadata with the age of the entry', () => {
    const cache = new TtlCache<string>(100_000)
    cache.set('k', 'v')
    vi.advanceTimersByTime(2500)
    expect(cache.getEntry('k')).toEqual({ value: 'v', cache: 'hit', ageMs: 2500, ttlMs: 100_000 })
  })

  it('evicts the oldest entry beyond maxEntries', () => {
    const cache = new TtlCache<number>(100_000, 2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('refreshes recency on reads — hot keys survive unique-key floods (LRU)', () => {
    const cache = new TtlCache<number>(100_000, 2)
    cache.set('hot', 1)
    cache.set('b', 2)
    expect(cache.get('hot')).toBe(1) // read refreshes recency
    cache.set('c', 3) // evicts 'b' (least recently used), not 'hot'
    expect(cache.get('hot')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe(3)
  })

  it('stores values with a per-value TTL when ttlFor is provided', async () => {
    vi.useFakeTimers()
    try {
      const cache = new TtlCache<string>(100_000)
      let loads = 0
      const entry = await cache.getOrLoadWithMeta('k', async () => {
        loads++
        return 'degraded'
      }, { cacheable: () => false, ttlFor: () => 50 })
      expect(entry.ttlMs).toBe(50)
      expect(cache.get('k')).toBeUndefined() // uncacheable was not stored
      const cached = await cache.getOrLoadWithMeta('k2', async () => 'soft', {
        ttlFor: () => 50,
      })
      expect(cached.ttlMs).toBe(50)
      expect(cache.get('k2')).toBe('soft') // cacheable default true -> stored short
      vi.advanceTimersByTime(80)
      expect(cache.get('k2')).toBeUndefined() // short TTL elapsed
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshing an existing key does not change eviction order', () => {
    const cache = new TtlCache<number>(100_000, 2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)
    cache.set('c', 3) // evicts 'a' (oldest insertion), not 'b'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('getOrLoad caches the loaded value', async () => {
    const cache = new TtlCache<number>(100_000)
    let loads = 0
    const load = async () => {
      loads++
      return 42
    }
    expect(await cache.getOrLoad('k', load)).toBe(42)
    expect(await cache.getOrLoad('k', load)).toBe(42)
    expect(loads).toBe(1)
  })

  it('collapses concurrent loads of the same key into one (stampede safety)', async () => {
    const cache = new TtlCache<number>(100_000)
    let loads = 0
    let release!: (v: number) => void
    const gate = new Promise<number>((r) => (release = r))
    const load = async () => {
      loads++
      return gate
    }

    const first = cache.getOrLoad('k', load)
    const second = cache.getOrLoad('k', load)
    release(7)
    expect(await first).toBe(7)
    expect(await second).toBe(7)
    expect(loads).toBe(1)
  })

  it('a failed load is not cached and frees the in-flight slot', async () => {
    const cache = new TtlCache<number>(100_000)
    let attempts = 0
    const load = async () => {
      attempts++
      if (attempts === 1) throw new Error('boom')
      return 5
    }
    await expect(cache.getOrLoad('k', load)).rejects.toThrow('boom')
    // Retry must actually load again and now succeed.
    expect(await cache.getOrLoad('k', load)).toBe(5)
    expect(attempts).toBe(2)
  })

  it('getOrLoadWithMeta marks hits and misses', async () => {
    const cache = new TtlCache<number>(100_000)
    const miss = await cache.getOrLoadWithMeta('k', async () => 1)
    expect(miss).toEqual({ value: 1, cache: 'miss', ageMs: 0 })
    const hit = await cache.getOrLoadWithMeta('k', async () => 2)
    expect(hit.cache).toBe('hit')
    expect(hit.value).toBe(1)
    expect(hit.ageMs).toBeGreaterThanOrEqual(0)
  })
})

describe('zero-cap caches', () => {
  it('stores entries even when maxEntries is 0 — no eviction guard', () => {
    // A cap of 0 disables the size guard entirely (documented quirk: there
    // is no oldest entry to evict yet, so the first set always lands).
    const cache = new TtlCache<number>(100_000, 0)
    cache.set('k', 7)
    expect(cache.get('k')).toBe(7)
  })
})

describe('single-flight metadata', () => {
  it('reports a miss for every request that shares an in-flight load', async () => {
    const cache = new TtlCache<number>(100_000)
    let release!: (v: number) => void
    const loaded = new Promise<number>((r) => (release = r))
    const first = cache.getOrLoadWithMeta('k', () => loaded)
    const second = cache.getOrLoadWithMeta('k', () => Promise.resolve(99))
    release(7)
    const [a, b] = await Promise.all([first, second])
    expect(a.value).toBe(7)
    expect(b.value).toBe(7) // shared load, not the second loader
    expect(a.cache).toBe('miss')
    expect(b.cache).toBe('miss') // still a miss — served from the flight, not the cache
  })
})

describe('coordKey', () => {
  it('rounds coordinates to two decimals so nearby devices share entries', () => {
    expect(coordKey(10.111, 20.222)).toBe('10.11,20.22')
    expect(coordKey(10.113, 20.224)).toBe(coordKey(10.111, 20.222))
  })
})
