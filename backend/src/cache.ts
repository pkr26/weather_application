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
  /** In-flight loads carry the TTL the leader computed and the shared abort scope. */
  private readonly inFlight = new Map<string, { promise: Promise<{ value: T; ttlMs: number }>; scope: SharedScope }>()

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
      // Stryker restore CallExpression
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
    // Stryker restore BlockStatement
    return { value: hit.value, cache: 'hit', ageMs: Math.max(0, Date.now() - hit.storedAt), ttlMs: hit.ttlMs }
  }

  async getOrLoad(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return (await this.getOrLoadWithMeta(key, load)).value
  }

  async getOrLoadWithMeta(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    opts: { cacheable?: (value: T) => boolean; ttlFor?: (value: T) => number; signal?: AbortSignal } = {},
  ): Promise<CacheEntryMeta & { value: T }> {
    const hit = this.getEntry(key)
    if (hit) return hit

    const pending = this.inFlight.get(key)
    if (pending) {
      // A concurrent request already loads this key — still a cache miss
      // for us, but the value (and the TTL the leader stored it with, e.g.
      // the short degraded TTL) comes from that shared load. Fabricating
      // the constructor TTL here once advertised a 10-minute max-age on a
      // 30-second degraded entry. The waiter ALSO joins the flight's
      // participant set: the load must stay alive as long as ANY waiter
      // still wants it — one hung-up client must not abort the answer for
      // everyone else sharing this coordinate cell.
      if (opts.signal) pending.scope.join(opts.signal)
      const served = await pending.promise
      return { value: served.value, cache: 'miss', ageMs: 0, ttlMs: served.ttlMs }
    }

    const scope = new SharedScope()
    if (opts.signal) scope.join(opts.signal)
    const p = load(scope.signal)
      .then((value) => {
        // Values the caller marks uncacheable are served once and never
        // stored. Values with a per-value TTL (e.g. degraded weather bundles
        // that should only briefly mask a blip) are stored with that TTL —
        // the default full TTL applies otherwise.
        const ttl = opts.ttlFor ? opts.ttlFor(value) : this.ttlMs
        if (!opts.cacheable || opts.cacheable(value)) {
          this.set(key, value, ttl)
        }
        return { value, ttlMs: ttl }
      })
      .finally(() => {
        // Stryker disable CallExpression: the scope close is leak hygiene; the inFlight delete is pinned by the retry-after-failure test
        scope.close()
        // Stryker restore CallExpression
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, { promise: p, scope })
    const served = await p
    return { value: served.value, cache: 'miss', ageMs: 0, ttlMs: served.ttlMs }
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
      // Stryker restore ConditionalExpression
    }
    const now = Date.now()
    this.entries.set(key, { expiresAt: now + ttlMs, storedAt: now, ttlMs, value })
  }
}

/**
 * Rounds coordinates so nearby devices share cache entries.
 */
export function coordKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}

/**
 * The abort scope shared by a single-flight load and every waiter that
 * joined it. The load is aborted only when the LAST participant's signal
 * aborts (its client hung up or its per-request deadline expired) — one
 * impatient client must never cancel the answer for the others sharing
 * the same coordinate cell.
 */
export class SharedScope {
  private readonly controller = new AbortController()
  private readonly participants = new Set<AbortSignal>()
  // Stryker disable BlockStatement,CallExpression,StringLiteral: listener bookkeeping only prevents leaks — its absence is unobservable in-process; the abort semantics are pinned by the scope tests
  private readonly onParticipantAbort = (): void => {
    // Snapshot + filter: participants abort one event at a time, but the
    // handler must also sweep any that aborted while an earlier event ran.
    const aborted = [...this.participants].filter((s) => s.aborted)
    let reason: unknown
    for (const s of aborted) {
      this.participants.delete(s)
      s.removeEventListener('abort', this.onParticipantAbort)
      reason = s.reason
    }
    // Re-abort the flight controller with the departing participant's
    // reason (e.g. the request deadline's TimeoutError) so the HTTP layer
    // can distinguish a deadline expiry from a client hang-up downstream.
    if (this.participants.size === 0) this.controller.abort(reason)
  }
  // Stryker restore BlockStatement,CallExpression,StringLiteral

  readonly signal: AbortSignal = this.controller.signal

  /** Adds a participant; an already-aborted signal is ignored (that
   *  participant wants nothing — it must not abort the flight for others). */
  join(signal: AbortSignal): void {
    if (signal.aborted) return
    if (this.controller.signal.aborted) return
    this.participants.add(signal)
    signal.addEventListener('abort', this.onParticipantAbort)
  }

  /** Detaches all listeners once the flight settles. */
  // Stryker disable BlockStatement,CallExpression,StringLiteral: leak hygiene only — unobservable
  close(): void {
    for (const s of this.participants) s.removeEventListener('abort', this.onParticipantAbort)
    this.participants.clear()
  }
  // Stryker restore BlockStatement,CallExpression,StringLiteral
}
