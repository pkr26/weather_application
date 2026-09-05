# Security Policy — Cirrus

This document describes the security controls, the threat model behind them,
and how each one is verified (every control has tests; see **Verification**).

## Architecture principle: the key never leaves the server

```
Android app ──HTTPS──▶ Cirrus backend ──API key header──▶ weather.googleapis.com
   (no secrets)         (owns the key, validates,        (and Open-Meteo geocoding)
                         caches, rate-limits)
```

The Google Weather API key exists only in `backend/.env` (git-ignored) and is
never compiled into the APK. The app cannot leak what it does not have.

## Controls

| # | Control | Where | Verification |
|---|---------|-------|--------------|
| 1 | **Upstream credential isolation** — API key lives only in the backend process, sent via `X-Goog-Api-Key` header to Google only | `src/upstream/googleWeather.ts`, `src/config.ts` | `upstream.test.ts` (header never appears in any client-facing surface) |
| 2 | **Input validation on every route** — zod schemas for coordinates (±90/±180), language codes, geocode queries, and a device-registration contract (types, lengths, integer hours/minutes, `deviceId` restricted to URL-safe identifier characters `[A-Za-z0-9._:-]` **plus an explicit denylist of the prototype-colliding names** — the charset alone admits `__proto__`, the denylist is the control that holds) | `src/routes.ts` | `api.test.ts`, `security.test.ts` (reserved IDs rejected), mutation-tested |
| 3 | **Device-secret authentication** — every mutation or read of an existing device record requires its per-device secret (issued once at registration; only the SHA-256 hash is stored; constant-time comparison; unknown device and wrong secret return the same 401 — no enumeration oracle). **Unauthenticated re-registration is refused with 401** — knowing a device ID can never rotate its secret or seize the record; the sanctioned recovery path is registering a fresh ID, which the Android client performs automatically on 401. **Rotation and authenticated updates write through a hash guard** — verify and write are one synchronous step, so a racing stale write can never resurrect a just-rotated-away secret | `src/security/deviceAuth.ts`, `src/routes.ts`, `src/store/deviceStore.ts` | `security.test.ts` (no-takeover, deny, no-enumeration), `api.test.ts`, `devicestore.test.ts` (rotation-race guard) |
| 4 | **Rate limiting, layered & unspoofable** — global per-IP budget (240/min) + tighter route budgets for weather reads (120/min), geocode (30/min) and device writes (20/min); standard `RateLimit` headers, legacy headers off; proxy trust is **off for direct clients by default** (`TRUST_PROXY` empty → loopback only, `1` → exactly one LB) so `X-Forwarded-For` cannot mint fresh rate-limit buckets | `src/app.ts`, `src/config.ts` | `ratelimit.test.ts` (global, per-route, cross-route isolation, per-client buckets, XFF-ignored when trust is off) |
| 5 | **CORS disabled by default** — the Android client needs no browser policy; origins can be allowlisted explicitly via `CORS_ORIGINS`; unknown origins never receive CORS headers, not even preflight answers | `src/app.ts` | `security.test.ts` (deny-by-default, allowlist reflection, multi-origin) |
| 6 | **Security headers** — helmet defaults on every response: CSP, HSTS (1y, includeSubDomains), `X-Content-Type-Options`, `X-Frame-Options`, Referrer-Policy, COOP/CORP; `X-Powered-By` removed | `src/app.ts` | `security.test.ts` (exact header values asserted) |
| 7 | **Body limits & parser errors** — JSON bodies capped at 64 KB; oversized bodies → 413 and malformed JSON → 400 with a generic message (never a 500/stack trace) | `src/app.ts`, `src/errors.ts` | `security.test.ts`, `errors.test.ts` |
| 8 | **Error hygiene** — clients receive a stable JSON error envelope (`{error, message}`); internal errors are logged server-side with full detail but surfaced as `{internal_error, "Something went wrong."}`; **all 5xx messages are sanitized** — upstream response bodies and internal diagnostics never reach clients | `src/errors.ts` | `errors.test.ts` (internal and upstream detail never leaks; log keeps it) |
| 9 | **Secret redaction in logs** — `Authorization`, `X-Goog-Api-Key`, `X-Device-Secret`, and `X-Api-Token` headers are redacted before anything is written; the request serializer logs method + route path only (no query strings — coordinates, city names and search terms never reach logs; device-registry paths are collapsed to `/devices/:id`), the response serializer logs the status code only (never response headers), and health checks are not logged at all | `src/app.ts`, `src/logger.ts` | `logging.test.ts` asserts log *content* and the actual middleware wiring: no token/secret/location/identifier ever appears in written output |
| 10 | **Atomic, validated, bounded persistence** — device registry written via tmp-file + fsync + rename with owner-only permissions (0600), serialized through a write queue; corrupted store files are quarantined and rebuilt rather than crashing; transient I/O errors fail the call instead of marking the registry loaded (a failed read can never wipe the file on the next write); a size cap (`MAX_DEVICES`, default 25 000) refuses new records when full (updates still pass); prototype-colliding keys (`__proto__`, `constructor`, `prototype`) are dropped when loading (verified even for entries with fresh timestamps); records older than `DEVICE_MAX_AGE_DAYS` (default 365) are pruned at load, so a flooded registry self-heals and uninstalled devices age out | `src/store/deviceStore.ts` | `devicestore.test.ts` (corruption, version, disk-failure survival, cap, permissions, key filtering, TTL pruning incl. exact boundary) |
| 11 | **Supply-chain hygiene** — `npm audit --audit-level=moderate` gates CI; dependency overrides pin the patched `qs`; Node ≥ 22 engines enforced | `package.json`, CI workflow | `npm run audit` (0 findings) |
| 12 | **Startup configuration validation** — all environment knobs validated once at boot (types, ranges, enum values); the process refuses to start misconfigured | `src/config.ts` | `config.test.ts` (11 acceptance/rejection cases), mutation-tested |
| 13 | **Freshness transparency** — every weather response carries `X-Cache: HIT\|MISS`, `X-Data-Age-Seconds`, and a `Cache-Control: max-age` aligned to the server TTL so no intermediary serves data older than the backend would; core weather is cached by coordinates only (it is language-independent) while localized alerts are cached per coordinates+language with a short microcache TTL — a request never serves another language's alerts, and multilingual cities share one upstream fetch | `src/routes.ts` | `api.test.ts` (core shared across languages, alerts isolated) |
| 14 | **Network security on the client** — Android `network_security_config`: release builds permit **no** cleartext HTTP anywhere; debug builds permit cleartext to any host (development only). Release builds ship R8-minified; backups are disabled (`allowBackup=false`) so the device identity never leaves the phone via adb/cloud backups | `app/src/main/res/xml/network_security_config.xml`, `app/src/debug/res/xml/network_security_config.xml`, `AndroidManifest.xml` | build config |
| 15 | **Client secret at rest in the Keystore** — the device-registry secret is stored in `EncryptedSharedPreferences` (AES-256-GCM under an Android Keystore master key), never in plaintext preferences; a legacy plaintext secret is migrated and scrubbed on first read | `app/src/main/java/com/cirrus/weather/data/local/SecretVault.kt` | device-registrar unit tests over the vault interface |
| 16 | **Optional shared API token** — with `API_TOKEN` set, every route except `GET /api/v1/health` requires `X-Api-Token` (constant-time, digest-compared), closing the open-proxy exposure of a publicly reachable deployment; the Android client sends it automatically via `BuildConfig.API_TOKEN` | `src/security/apiToken.ts`, `app/.../di/AppContainer.kt` | `security.test.ts` (open by default, gated when set, health exempt, writes gated) |
| 17 | **Rate limiting ahead of body parsing** — the global per-IP budget is counted before `express.json` runs, so junk-body floods cannot do parser work outside the rate budget | `src/app.ts` | middleware order, `ratelimit.test.ts` |
| 18 | **Bounded upstream fan-out** — paginated forecast endpoints (days/hours) follow `nextPageToken` with a hard page cap, stop at the requested item count, and degrade to partial data if a later page fails; every upstream call is time-boxed and retried at most `UPSTREAM_RETRIES` times with exponential backoff+jitter (429s and 5xxs retry, `Retry-After` honoured; other 4xx never do); the whole per-request fan-out runs under a wall-clock deadline and aborts when the client hangs up; a first page without its expected list key is treated as a contract change, not an answer; truncated pagination marks the bundle degraded (cached only for the short degraded TTL); a per-endpoint circuit breaker fails fast once an endpoint fails repeatedly (keyed per language on the alerts path) | `src/upstream/googleWeather.ts`, `src/upstream/http.ts` | `upstream.test.ts` (pagination merge, page cap, partial failure, truncation→degraded, contract guard, breaker open/half-open, backoff spacing, 429 retry, Retry-After parsing, request-scope abort), `errors.test.ts` (429/503→503 + Retry-After forwarded) |

## Threat model (STRIDE-lite)

| Threat | Vector | Mitigated by |
|--------|--------|--------------|
| API key theft | Decompiling the APK | Key is not in the app (control 1) |
| Spoofing another device's notifications | Guessing device IDs on `/devices/:id` **or re-registering an existing ID** | Per-device secret + hash storage + constant-time compare + takeover-proof re-registration (control 3) |
| Device enumeration | Distinct 404 vs 401 responses | Uniform 401 for unknown device and bad secret (control 3) |
| Rate-limit evasion | Spoofed `X-Forwarded-For` minting fresh buckets | Proxy trust defaults to loopback only (control 4) |
| Denial of wallet (quota exhaustion) | Flooding `/weather/*`, `/geocode` | Multi-layer rate limiting + stampede-safe cache + bounded upstream fan-out (controls 4, 15) |
| Registry flooding / disk fill | Unauthenticated `POST /devices` at scale | Device-write rate budget + registry size cap → 503 + max-age pruning so the cap self-heals (controls 4, 10) |
| Cross-language data bleed | Cached bundle for one lang served to another | Language is part of the cache key (control 13) |
| Upstream detail disclosure | 5xx errors quoting Google API responses | Sanitized client messages, full detail logged only (control 8) |
| Prototype pollution / key confusion | Hand-crafted `devices.json` with `__proto__` keys | Dangerous keys dropped at load; identifier charset enforced (controls 2, 10) |
| Cross-origin data theft | Malicious website reading API responses from a browser | CORS off unless allowlisted (control 5) |
| Injection / parser abuse | Malformed query params, giant or broken JSON bodies | zod validation + body caps (controls 2, 7) |
| Information disclosure | Verbose errors, stack traces, version banners | Error envelope + header hardening (controls 6, 8) |
| Secret leakage via logs | Request logging of credential headers | Redaction (control 9) |
| Secret leakage via device backups | adb / cloud backup of the app's DataStore | `allowBackup=false` on the client (control 14) |
| Tampering with registry data | Corrupt or partial writes on crash | Atomic persistence (control 10) |
| Stale-data decisions | Cached severe-weather alerts | Alerts are served from a seconds-long microcache and always `no-store` to clients — never meaningfully stale (control 13) |

## Data handling

- The registry stores only what notifications need: an opaque device ID,
  language, chosen city coordinates, delivery time, and a hashed secret.
  The unused `fcmToken` field was removed outright; old files carrying it
  are scrubbed at load.
- No passwords, contacts, location history, or advertising identifiers.
- Delete the file (`data/devices.json`) and the registry is gone — there is
  no secondary store.

## Reporting a vulnerability

Please use GitHub's **private security advisory** feature on this repository
(Report a vulnerability → Security tab) rather than filing a public issue.
Reports are acknowledged within 72 hours. Testing against an instance you
operate is welcome; please do not test against other people's deployments.
