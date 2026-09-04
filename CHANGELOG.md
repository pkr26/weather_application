# Changelog

## 1.2.1 (unreleased) — audit hardening

Full-codebase audit fixes (see `AUDIT-2026-09-04.md` for the complete list).

### Backend
- Security: `X-Api-Token` redacted from logs; access logs no longer contain
  query strings (coordinates, city names, device ids).
- Correctness: truncated paginated forecasts now mark the bundle degraded;
  degraded bundles cache briefly (30 s) instead of never, so a persistent
  soft failure cannot amplify into 5 upstream calls per request.
- Resilience: retry backoff with jitter + Retry-After, per-endpoint circuit
  breaker, graceful-drain readiness (503 while draining).
- Performance: gzip for large JSON responses; core/alerts cache split (core
  weather shared across all 27 languages); LRU cache eviction; memoized
  Intl formatters in the briefing hot path.
- Devices: atomic first registration (no race), secret rotation endpoint,
  language normalized to a canonical pack code, prototype-safe writes.
- Validation: empty `?lat=`/`?lon=` rejected; localized fallback city in
  every language.

### Android
- Fixed: rain/snow particle effects now actually animate (the draw phase
  never invalidated before).
- Fixed: daily briefing no longer skipped when offline at fire time —
  workers require connectivity and a catch-up run posts when it returns.
- Offline: last-known weather per city is persisted and shown flagged
  stale on cold start without network.
- Battery: background polling pauses when the screen is off; Keystore I/O
  off the main thread.
- Correctness: re-locating refreshes the screen; DST-safe briefing delay;
  unit fields validated in mappers; clock-based "next hour"; alerts marked
  seen only when actually posted.
- State: sheet/scroll/expansion state survives recreation; honest empty
  home when the last city is deleted; onboarding dialog never flashes.
- UX/A11y: 48dp touch targets, vector icons instead of emoji, haptic
  feedback, spring physics, snackbar above the gesture bar, notification
  deep links, predictive back, notification-denial recovery path.
- Perf: spline paths cached in the draw phase; temperature gradient stops
  hoisted; OkHttp disk cache + call timeout.

### Infrastructure
- The project is under version control (this is the first commit series).
- CI hardened (concurrency, least-privilege permissions, wrapper validation,
  timeout, R8 release smoke build); tag-driven release workflow (signed AAB +
  Docker image); Dependabot; Gradle wrapper checksum-pinned; Apache-2.0
  LICENSE; release signing via env vars with debug fallback.
