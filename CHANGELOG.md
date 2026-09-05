# Changelog

## 1.2.2 (2026-09-04) — red re-audit fixes

Fixes for every finding of the third adversarial audit round
(`AUDIT-3-2026-09-04.md`): 3 P1s, 9 P2s and the safe P3 tail. All suites
re-verified locally on fresh runtimes (Node 22.23.2, Temurin JDK 17):
backend 524/524 tests + typecheck + per-file coverage gate + `npm audit`
(0 findings) + Stryker 100% (1386/1386); Android `:core:test`, `:app:testDebugUnitTest`
(109 tests total), `:app:compileDebugKotlin`, `assembleDebug`, and PIT
126/126 killed (100%).

### Backend
- Correctness: the pagination contract guard now covers EVERY page — a
  shapeless later page (HTTP 200 without the list key) or a token-less
  empty first page marks the bundle degraded instead of ending pagination
  "healthy" and caching a truncated forecast for the full TTL.
- Correctness: the app↔backend 401s are distinguishable — the API-token
  gate answers `invalid_api_token`, device-secret failures `unauthorized`.
- Resilience: geocode routes run under the per-request upstream deadline
  with client-disconnect abort (like the weather routes); the independent
  core+alerts fan-out now runs in parallel; an unparseable 200 body is
  classified retryable like a 5xx; a deadline expiry maps to 504 (client
  hang-ups stay 502); upstream bodies are read under an 8 MiB streaming
  cap so a compromised upstream cannot OOM the process.
- Registry: prune-on-write — a create at the cap first evicts expired
  records, so a flooded registry self-heals without a restart; a
  wrong-version store file is quarantined like a corrupt one instead of
  being silently overwritten.
- Posture: freshness headers are `private` whenever the token gate is on
  (shared caches can no longer serve gated data tokenless); gzip runs off
  the event loop; explicit server header/request timeouts; `API_TOKEN`
  shorter than 16 chars fails config validation; `/health` no longer leaks
  uptime; unknown future condition types render a neutral label in all 27
  languages instead of a false "Cloudy"; `LOG_LEVEL` from `.env` is now
  actually honored.

### Android
- Notifications: the boot-time reschedule consults WorkManager before
  replacing anything — a briefing worker that cold-started the process can
  no longer be cancelled mid-run into a dead chain (the round-3 P1); all
  three workers keep their preferences reads inside the exception armor
  and the DataStore has a corruption handler, so a corrupt file degrades
  one run instead of killing the chain forever; a revoked notification
  permission or a hard 401/403 stops the 7-fetches-per-day retry burn; a
  briefing later than 6 h past its target is skipped as noise.
- Device registrar: serialized (mutex) — a first-launch settings toggle can
  no longer interleave two registrations into a mismatched identity; a
  secret the vault failed to persist blocks identity resets (no more ghost
  records per app open); a gate 401 (`invalid_api_token`) never resets.
- Offline data: degraded bundles are never persisted as "last known good";
  the last-known store writes atomically on every path.
- UI: opening/closing the city sheet no longer wipes scroll position, row
  expansions and entrance state (shared `SaveableStateHolder`); the
  entrance choreography replays on a real city switch as documented; rain
  drift follows wind updates (the frame loop no longer stale-captures its
  first callback); flat forecast series render centered instead of pinned
  to the floor; FOG/HAZE/MIST map to a dedicated muted archetype agreed
  across theme/icon/fx tables (parity-pinned by tests); duplicate geocoder
  results can no longer crash the search list; hot-path allocations
  (per-draw Paths, per-tick colors, per-row formatters) hoisted.
- City list: mini-card refreshes are gated on the sheet being visible —
  a 2-hourly seen-alert write during a storm no longer triggers per-city
  fetches with the screen off.
- The degraded flag is now surfaced end-to-end: the app shows a "Limited
  forecast data" banner when the backend served partial data.
- Core: `Instant.parse` gains an offset-aware fallback (API 26-29 devices
  no longer drop the hourly strip if upstream ever emits `+05:30`-style
  timestamps); schedule/time naming and doc corrections.

## 1.2.1 (2026-09-04) — audit hardening

Full-codebase audit fixes (see `AUDIT-2026-09-04.md` and the re-audit
`AUDIT-2-2026-09-04.md`). This entry covers both the original hardening pass
and the fixes from the re-audit of it — the release was never shipped in
between, so there is one consolidated 1.2.1.

### Backend
- Security: `X-Api-Token` redacted from logs; access logs carry no query
  strings (coordinates, city names, search terms), no response headers, and
  device-registry paths are collapsed to `/devices/:id`.
- Correctness: truncated paginated forecasts mark the bundle degraded;
  degraded bundles cache briefly (30 s default) so a persistent soft failure
  cannot amplify into 5 upstream calls per request (the re-audit found this
  shipped as dead code — `DEGRADED_CACHE_TTL_MS` was unreachable; now real
  and pinned by tests). A lingering `nextPageToken` on a satisfied target no
  longer flags healthy bundles degraded.
- Briefings never claim "no rain expected" on an empty or degraded hours
  list — missing data stays silent instead of promising a dry afternoon.
- Resilience: retry backoff with jitter; `Retry-After` honoured for
  delay-seconds and HTTP-date forms and 429s retried; upstream 429/503 map
  to client 503 with `Retry-After` forwarded; per-endpoint circuit breaker
  (alerts keyed per language so one bad language can't open it for all);
  graceful-drain readiness (503 while draining, pinned by a real
  spawn-and-SIGTERM integration test); per-request upstream deadline plus
  client-disconnect abort so a hung-up client's five upstream calls stop.
- Performance: gzip for large JSON responses with correct RFC 9110
  negotiation (`gzip;q=0` respected, `*` honoured) and — the re-audit's
  catch — `Content-Type` preserved on the compressed path; core/alerts
  cache split (core weather shared across all 27 languages); LRU cache
  eviction; memoized Intl formatters in the briefing hot path, capped so an
  upstream-controlled timezone can't grow the cache forever.
- Devices: atomic first registration (no race), secret rotation endpoint
  with hash-guarded writes (a racing stale write can no longer resurrect a
  rotated-away secret), language normalized to a canonical pack code
  (Traditional-Chinese locales resolve to zh-TW), prototype-safe writes,
  transient I/O errors fail the call instead of wiping the registry, and
  corrupt files are quarantined instead of silently replaced.
- Validation: empty `?lat=`/`?lon=` rejected; localized fallback city in
  every language.

### Android
- Fixed: rain/snow particle effects now actually animate (the draw phase
  never invalidated before).
- Fixed: the app compiles again — the previous pass shipped ~80 Kotlin
  errors (half-finished DTO package move, missing imports, a mangled
  alert-banner click handler, an easing function that didn't exist in the
  pinned Compose version).
- Fixed: the off-screen polling pause was inverted and killed foreground
  auto-refresh entirely; it is now lifecycle-state driven with a
  deadline-based timer that visibility flaps cannot postpone forever.
- Fixed: the offline catch-up run no longer APPENDs a second worker to the
  daily chain — after one offline morning, every future morning no longer
  gets two briefings.
- Fixed: severe-weather alert banners are expandable again (the tap handler
  was dead code); alerts without any headline no longer occupy the per-poll
  flood cap forever; the notification uses the alert's typed event as a
  headline stand-in.
- Fixed: deleting a city no longer leaves its cached weather snapshots on
  disk; the delete dialog no longer saves an unstorable object (crash);
  a single-hour forecast no longer crashes the spline.
- Briefings survive offline mornings (CONNECTED constraints + catch-up run);
  opening the app offline no longer cancels today's pending briefing
  (missed-today detection with a persisted last-posted day); timezone/clock
  changes re-anchor the schedule.
- Offline: last-known weather per city persisted per coordinates and shown
  flagged stale on cold start; switching cities offline never shows the
  previous city's numbers under the new city's name.
- Battery: background polling pauses when the screen is off; Keystore I/O
  off the main thread; the vault self-heals after keystore corruption
  instead of silently killing registration forever.
- Correctness: re-locating refreshes the screen; DST-safe briefing delay;
  unit fields validated in mappers (now mutation-covered by tests); alerts
  marked seen only when actually posted; timestamped seen-alert eviction.
- Notifications never fire for a made-up default city when the user deleted
  every city; "Send test notification" reports failure honestly when the
  post is blocked.
- State: sheet/scroll/expansion state survives recreation; honest empty
  home; onboarding dialog never flashes and cannot be permanently skipped
  by process death.
- UX/A11y: 48dp touch targets (banner close, daily rows, hourly header),
  vector icons instead of emoji, haptic feedback, spring physics, localized
  weekday and AM/PM labels, alert banners announced via liveRegion,
  snackbar above the gesture bar, notification deep links, predictive back,
  notification-denial recovery path.
- Perf: spline paths cached in the draw phase (`drawWithCache` for the
  hourly curve and daily range bars); gradient stops and fade brushes
  hoisted; reduced-motion now disables the ambient cross-fade, loading
  pulse and sheet tweens; OkHttp disk cache + call timeout.

### Independent re-audit round (all four auditor findings fixed)
- Backend: single-flight loads now survive a hung-up leader (participant-
  scoped aborts — one client leaving cannot 502 the whole coordinate cell);
  aborted calls no longer count toward the circuit breaker; alerts-missing
  bundles clamp their advertised max-age and omit the alerts-age header;
  forwarded Retry-After carries the upstream's uncapped ask; the briefing's
  "no rain" claim additionally requires observed precipitation data; the
  device-path log collapse is case-insensitive; backoff sleeps are
  abort-aware; config cross-validates the upstream deadline.
- Android: the hourly strip's right-edge fade renders again (absolute
  gradient coordinates); the reschedule worker respects the notification
  toggle; unconsumed deep links survive recreation; the secret vault is
  synchronized and never destroys the last secret copy; notification
  fallback headlines are humanized; a 20-hour window stops timezone hops
  from double-posting; the no-city path keeps the chain armed; the refresh
  loop cannot spin.
- Testing: the malformed `Stryker restore` directives were fixed (they had
  silently widened every disable to end-of-file, excluding 534 mutants);
  the mutation gate is now met honestly at 99.1% of scored mutants, and
  every remaining disable documents a proven equivalence.
- Infra: release checkouts fetch full history (versionCode monotonicity),
  the Tink keep rule references the interface that actually exists, and
  `RELEASE_API_BASE_URL` is documented.

### Infrastructure
- compileSdk/targetSdk bumped to 36 (the 2026 Play requirement) on AGP
  8.10.1; the two theme attributes that SDK 36 deprecates (statusBarColor,
  navigationBarColor — no-ops under enforced edge-to-edge) were removed.
- The project is under version control.
- CI hardened (concurrency, per-job least-privilege permissions including
  the dependency-graph write, wrapper validation, timeout, R8 release smoke
  build); tag-driven release workflow that refuses to silently publish a
  debug-signed AAB, derives a monotonic versionCode, and fails loudly when
  registry credentials are missing; Dependabot covers gradle, npm,
  GitHub Actions and Docker; Gradle wrapper checksum-pinned; Apache-2.0
  LICENSE; release signing via env vars with debug fallback for local
  smoke builds.
- Dockerfile: the device-registry volume is created owned by the runtime
  user (registration previously failed EACCES on first write while health
  stayed green).
- Docs numbers regenerated from actual runs; R8 keep rules for Tink
  narrowed from a blanket keep.
