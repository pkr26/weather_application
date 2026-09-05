# Testing Strategy — Cirrus

Three layers, each answering a different question:

| Layer | Question it answers | Tool | Status |
|-------|--------------------|------|--------|
| **Unit & integration tests** | Does the code do what it should? | Vitest (backend, **524 tests**), JUnit4 (Android `core` + app, **109 tests**) | all green |
| **Per-file coverage gate** | Did the suite forget a file? | Vitest + istanbul, **98% lines/branches/functions/statements per file** | enforced in CI (`npm run test:coverage`) |
| **Mutation testing** | Do the tests actually *catch* bugs — would they fail if the logic were broken? | StrykerJS (backend, **last full run: 100% — 1386/1386 scored mutants killed, 2026-09-04, break below 98**), PIT (Kotlin core, **last full run: 100% — 126/126 killed, 2026-09-04, thresholds at 98**) | enforced in CI |
| **Dependency audit** | Do we ship known-vulnerable code? | `npm audit` (gate in CI) | 0 findings |

> Mutation testing is the honest meter of test quality: it flips operators,
> boundaries, and constants in the production code (`>=` → `>`, `50` → `51`,
> `&&` → `||`, `return x` → `return null`, …) and counts how many of those
> deliberately broken builds make a test fail. A suite that passes every
> test but only catches 60% of mutants is a suite that lies. Both sides gate
> at 98% — the survivors that remain are individually analysed:
> each is either a provably equivalent mutant (documented with a
> `// Stryker disable` reason at the site) or a kill verified by hand where
> the sandbox's crash detection miscounts.

## Backend (`backend/`, TypeScript + Express)

```bash
cd backend
npm test            # 524 tests
npm run test:coverage  # same tests + per-file 98% coverage gate
npm run typecheck   # tsc --noEmit
npm run mutation    # Stryker — breaks below 98
npm run audit       # npm audit, fails on moderate+
```

What is covered:

- **HTTP surface** (`api.test.ts`) — every route, happy path + validation
  rejections, cache HIT/MISS behaviour, freshness headers, geocode
  case-insensitive cache keys, briefing localization fallbacks.
- **Security** (`security.test.ts`, `ratelimit.test.ts`) — device-secret
  issue/rotate/deny, no-enumeration, CORS default-deny and allowlist,
  exact security headers, body-size 413, malformed JSON, rate-limit buckets
  (global, per-route, per forwarded client IP).
- **Upstream resilience** (`upstream.test.ts`) — stubbed `fetch`: retry then
  recover, retries exhausted, network errors not retried, timeouts via
  AbortController, 404-as-empty for alerts, exact request shapes (headers,
  coordinates at 4-decimal precision, language pass-through).
- **Briefing engine** (`briefing.test.ts`) — every threshold at its exact
  boundary (50% / 25% rain, UV 8 / 11, gusts 40 km/h, heat 40° / cold 2°),
  unit conversion rounding, timezone formatting incl. invalid-zone fallback,
  degradation on missing/null/malformed payload fragments, exact composed
  body, all 27 language packs (key + placeholder completeness).
- **Cache** (`cache.test.ts`) — TTL expiry (incl. exact boundary), LRU-ish
  eviction order, stampede collapse (one load for concurrent requests),
  failed loads not cached, single-flight waiters receive the leader's
  per-value TTL (degraded entries never advertise a full-TTL max-age).
- **Device store** (`devicestore.test.ts`) — disk round-trip, corrupted-file
  quarantine, wrong-version rejection, disk-write failure survival, transient
  I/O errors failing instead of wiping the registry, hash-guarded updates
  (rotation-race protection), secrets persisted but never exposed through
  `publicDevice`.
- **Config & errors** (`config.test.ts`, `errors.test.ts`) — every enum and
  range, issue formatting, error envelope mapping incl. body-parser 4xx,
  upstream 429/503 → 503 with `Retry-After` forwarded.
- **Logging** (`logging.test.ts`) — redaction paths, the PII-free request
  serializer AND the actual pino-http wiring (serializers attached, response
  headers never logged, device ids collapsed out of paths).
- **Graceful shutdown** (`shutdown.test.ts`) — boots the real `index.ts`
  process, asserts SIGTERM drains and exits 0.

Stryker configuration: `backend/stryker.config.json` — mutates all `src/**`
except `index.ts` (bootstrap), `logger.ts` (pino configuration only) and the
translation packs (data, not logic). Reports: `backend/reports/mutation/`.

## Android (`core/` + `app/`, Kotlin)

```bash
./gradlew :core:test            # 30 tests over the pure domain module
./gradlew :core:pitest          # PIT — 98% mutation threshold enforced
./gradlew :app:testDebugUnitTest  # 61 tests over app logic (spline, themes,
                                  # view model + lifecycle, notification use
                                  # cases, mappers, registrar, alert keys)
./gradlew assembleDebug         # full APK build
```

The pure domain logic — unit conversions, domain models, timezone-aware time
formatting, notification scheduling math — lives in a dedicated Kotlin JVM
module (`core/`) precisely so it can be mutation-tested with PIT
(`DEFAULTS` + `STRONGER` mutators). Kotlin-generated data-class boilerplate
(`equals`/`copy`/`toString`) is excluded from mutation — it is not
hand-written logic. Reports: `core/build/reports/pitest/`.

Finding worth mentioning: the first PIT run showed **51 uncovered mutants in
`Units.kt`** — half of the unit-conversion helpers (visibility, precipitation,
pressure formatting) had never been directly tested. That gap is now closed
with boundary tests (sub-10 formatting, rounding, nulls, both unit systems).

## Accuracy: how the numbers stay right

- Single source of truth for conversions: upstream is always METRIC; every
  °F/mph/mi/inHg figure is derived in **one** place (`Units.kt`) — covered by
  mutation-tested exact-value tests (e.g. `-40 °C = -40 °F`, `25.4 mm = 1 in`).
- Timezone correctness: all wall-clock strings are formatted in the city's
  IANA zone (`TimeFormats`, boundary-tested across date lines), with UTC
  fallback for invalid zone data.
- Freshness: weather responses carry `X-Data-Age-Seconds` + `Cache-Control`
  aligned to the server TTL; severe-weather alerts are **never** cached
  (near-fresh microcache server-side, always `no-store` to clients).
- The briefing day-window ("today") is computed in the *city's* local day,
  not the server's — mutation-tested against tomorrow-outlier hours.
