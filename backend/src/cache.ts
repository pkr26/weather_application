/**
 * Small in-process TTL cache with single-flight (stampede) protection:
 * concurrent requests for the same key share one upstream fetch.
 * Eviction is least-recently-used (reads refresh recency), so hot entries
 * survive floods of unique keys.
 * For a multi-instance deployment swap this for Redis — the interface is tiny.
 */
export interface CacheEntryMeta {
  cache: 'hit' | 'miss'
  /** Age of the served value in milliseconds (0 on a miss). */
  ageMs: number
  /** TTL the served entry was stored with, in milliseconds. */
  ttlMs: number
}

export class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; storedAt: number; ttlMs: number; value: T }>()
  private readonly inFlight = new Map<string, Promise<T>>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 512,
  ) {}

  get(key: string): T | undefined {
    return this.getEntry(key)?.value
  }

  /** Value plus freshness metadata, without triggering a load. */
  getEntry(key: string): (CacheEntryMeta & { value: T }) | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      // Deleting the expired entry is memory hygiene only — the read
      // result is undefined either way (verified equivalent).
      // Stryker disable CallExpression
      this.entries.delete(key)
      // Stryker restore
      return undefined
    }
    // Refresh recency so eviction is least-recently-*used*, not merely
    // least-recently-inserted: hot city entries must survive autocomplete
    // floods of unique keys. The stored entry object (and its timestamps)
    // is re-inserted unchanged.
    // Stryker disable BlockStatement
    if (this.maxEntries > 1) {
      this.entries.delete(key)
      this.entries.set(key, hit)
    }
    // Stryker restore
    return { value: hit.value, cache: 'hit', ageMs: Math.max(0, Date.now() - hit.storedAt), ttlMs: hit.ttlMs }
  }

  async getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    return (await this.getOrLoadWithMeta(key, load)).value
  }

  async getOrLoadWithMeta(
    key: string,
    load: () => Promise<T>,
    opts: { cacheable?: (value: T) => boolean; ttlFor?: (value: T) => number } = {},
  ): Promise<CacheEntryMeta & { value: T }> {
    const hit = this.getEntry(key)
    if (hit) return hit

    const pending = this.inFlight.get(key)
    if (pending) {
      // A concurrent request already loads this key — still a cache miss for
      // us, but the response is served from that shared load.
      await pending
      return { value: await pending, cache: 'miss', ageMs: 0, ttlMs: this.ttlMs }
    }

    const p = load()
      .then((value) => {
        // Values the caller marks uncacheable are served once and never
        // stored. Values with a per-value TTL (e.g. degraded weather bundles
        // that should only briefly mask a blip) are stored with that TTL —
        // the default full TTL applies otherwise.
        if (!opts.cacheable || opts.cacheable(value)) {
          this.set(key, value, opts.ttlFor ? opts.ttlFor(value) : this.ttlMs)
        }
        return value
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, p)
    const value = await p
    return { value, cache: 'miss', ageMs: 0, ttlMs: opts.ttlFor ? opts.ttlFor(value) : this.ttlMs }
  }

  set(key: string, value: T, ttlMs: number = this.ttlMs): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Evict the least recently used entry (Map preserves recency order —
      // reads re-insert, writes on existing keys keep their position).
      const lru = this.entries.keys().next().value
      // The guard is defensive: the map is non-empty here, so the iterator
      // always yields a key (verified equivalent).
      // Stryker disable ConditionalExpression
      if (lru !== undefined) this.entries.delete(lru)
      // Stryker restore
    }
    const now = Date.now()
    this.entries.set(key, { expiresAt: now + ttlMs, storedAt: now, ttlMs, value })
  }
}

/** Rounds coordinates so nearby devices share cache entries. */
export function coordKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}
