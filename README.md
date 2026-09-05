# Cirrus 🌤️

A production-architected weather platform: a **dedicated backend** (Node.js +
TypeScript) that owns the Weather API key, caches upstream data and composes
localized notifications — and a native Android **frontend** with Apple
Weather–grade polish, powered end-to-end by the **Google Maps Platform
Weather API** (the same AI-blended data stream behind Google Search, Maps
and Gemini).

```
┌──────────────────────┐   HTTPS/HTTP    ┌──────────────────────────┐
│  Cirrus Android app  │ ───────────────▶│  Cirrus backend          │
│  (Compose frontend)  │   /api/v1/*     │  (Express + TypeScript)  │
│                      │                 │  · weather proxy+cache   │
│  · weather UI        │                 │  · geocoding proxy       │
│  · notifications     │◀── briefing ────│  · 27-language briefing  │
│    (WorkManager)     │   localized     │  · device registry       │
└──────────────────────┘                 │  · API key stays here 🔑 │
                                         └──────────┬───────────────┘
                                                    ▸ weather.googleapis.com
                                                    ▸ geocoding-api.open-meteo.com
```

## What's inside

### Frontend — `app/` (Android, Kotlin + Jetpack Compose)

- **Dynamic weather art** — condition-keyed gradients with ambient particle
  FX: slanted rain, drifting snow, twinkling stars, lightning flashes.
- **The signature hourly card** — 72-hour scrolling forecast with a smooth
  Catmull-Rom temperature spline, precipitation chances, sunset marker.
- **5-day forecast** — gradient temperature range bars, expandable rows.
- **Detail modules** — UV gauge, wind compass, sun arc, moon phase,
  precipitation, feels-like reasoning, humidity/dew point, visibility,
  pressure trend, cloud cover.
- **Saved cities** — live condition cards, worldwide search-as-you-type,
  device location, °C/°F toggle.
- **Notifications** ⭐
  - Daily *"here's what today brings"* briefing at a user-chosen time,
    **in any of 27 languages** (all major Indian + world languages),
    composed server-side and rendered on-device via WorkManager — survives
    reboots, re-schedules itself drift-free.
  - **Severe-weather alerts** polled every 2 h with dedupe, on a separate
    high-importance channel.
  - Settings screen (gear in the city list): toggle, delivery time picker,
    searchable language picker, and **"Send test notification"** to preview
    immediately in the chosen language.

### Backend — `backend/` (Node.js 22+, TypeScript, Express)

- Single API surface for the app (`/api/v1`) — the Google Weather API key
  lives only in `backend/.env`, never in the APK. Publicly-reachable
  deployments can set `API_TOKEN` to require a shared `X-Api-Token` on
  every route (the Android client sends it automatically when built with
  `API_TOKEN` in `local.properties`).
- Weather + geocoding proxying with a 10-minute shared cache (stampede-safe)
  so quota scales with users, not refresh taps; every response carries
  freshness headers (`X-Cache`, `X-Data-Age-Seconds`), large responses are
  gzipped, core weather is cached once per location (shared by all 27
  languages — only alerts are language-specific), and severe-weather alerts
  are served from a seconds-long microcache so warnings never go stale while
  a storm-time herd still shares one upstream call per place.
- Briefing engine: turns today's forecast into 2–5 lines of natural copy —
  condition, high/low, rain/snow timing with probability, UV, gusts, heat/
  cold advice, active alerts — localized into 27 languages, °C/°F aware,
  city-timezone-aware time formatting.
- Device registry (language, city, notification time) persisted atomically —
  the hook for server-side push (FCM-ready) later. Reads and deletes are
  protected by per-device secrets (stored as SHA-256 hashes, verified in
  constant time, with a uniform 401 that never reveals whether a device ID
  exists).
- Security hardening: zod validation on every input, helmet security headers,
  layered rate limits (global + tighter per-route budgets, keyed by forwarded
  client IP), CORS disabled unless explicitly allowlisted, credential
  redaction in logs, clean JSON error envelope, graceful shutdown, Dockerfile.
  See [SECURITY.md](SECURITY.md) for the full threat model and
  control-to-test matrix.
- **524 tests** (per-file coverage gated at 98%) plus **mutation testing
  (StrykerJS — the build breaks below 98% of scored mutants)** and a
  zero-finding `npm audit` — see [TESTING.md](TESTING.md).

## Run the whole system

1. **Backend** (do this first — the app needs it):

   ```bash
   cd backend
   cp .env.example .env        # set WEATHER_API_KEY (see "API key" below)
   npm install && npm run dev  # serves http://localhost:8080
   ```

2. **Android app**:

   ```bash
   ./gradlew assembleDebug
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```

   `local.properties` points the app at the backend:

   ```properties
   API_BASE_URL=http://10.0.2.2:8080/api/v1/   # emulator → host machine
   # physical device: http://<your-LAN-IP>:8080/api/v1/
   ```

   Release builds permit **no** cleartext HTTP at all (the network security
   config refuses it) — point `API_BASE_URL` at HTTPS for production. Debug
   builds allow cleartext to any host for physical-device testing; never
   ship a debug build.

3. **Notifications**: in the app, open the city list (top-left) → ⚙️ →
   enable the daily briefing, pick a language (try Telugu हिंदी العربية 中文…),
   set the time, and hit **Send test notification**.

## API key

`backend/.env` holds the credential (`local.properties` only points the app
at the backend URL). Create your own key in
[Google Cloud Console](https://console.cloud.google.com) (enable the Weather
API) and put it in `backend/.env` — the Android app needs no key at all.

## Testing & quality gates

```bash
# Backend (Node 22+)
cd backend
npm test            # 524 tests: API surface, security, upstream resilience,
                    # briefing engine (27 languages), cache, store, config,
                    # log content, graceful-shutdown integration
npm run typecheck
npm run test:coverage  # per-file 98% lines/branches/functions/statements gate
npm run mutation    # StrykerJS mutation testing — build breaks below 98%
npm run audit       # dependency audit — 0 findings

# Android
./gradlew :core:test              # pure domain logic (units, time, scheduling)
./gradlew :core:pitest            # PIT mutation testing — gate at 98%
./gradlew :app:testDebugUnitTest  # app logic (spline, themes, view model,
                                  # notification use cases, mappers, registrar,
                                  # alert dedupe keys)
./gradlew assembleDebug           # full APK
```

Details, including what mutation testing found and how accuracy is protected
(timezone math, single-source unit conversion, freshness headers):
[TESTING.md](TESTING.md). Threat model and the security-control-to-test
matrix: [SECURITY.md](SECURITY.md). CI runs all of the above on every push to
main and on every pull request (`.github/workflows/ci.yml`).

## Project layout

```
backend/                 Node.js + TypeScript service (see backend/README.md)
core/                    Pure Kotlin JVM module: unit conversions, domain
                         models, time formatting, briefing scheduling math —
                         mutation-tested with PIT (98% gate)
app/src/main/java/com/cirrus/weather/
  data/remote/           CirrusApi (backend client), DTOs, geocoding models
  data/local/            DataStore: cities, units + notification prefs
  data/repo/             WeatherRepository (one bundle round-trip)
  domain/                Mappers, condition themes (logic lives in :core)
  notify/                Notifier (channels), scheduler, briefing/alert workers,
                         device registrar
  ui/weather/            Home screen + ViewModel
  ui/citylist/           Saved cities, search
  ui/settings/           Notification settings + language picker
  ui/components/         Hero, hourly spline, daily bars, modules, glass cards
  ui/fx/                 Ambient background gradients + particles
```

## Notes

- **Release builds refuse to ship pointing at the emulator**: if
  `API_BASE_URL` is missing from `local.properties`, `assembleRelease`
  fails fast instead of producing an APK that can only talk to
  `10.0.2.2`. Debug builds keep the convenient loopback default, and
  debug network config allows cleartext to **any** host (not just LAN
  addresses) for physical-device testing — release config allows none.
- **On-screen condition text is English** even when notifications are in
  another language: core weather is cached once per location and shared by
  all 27 languages server-side (only alert text is fetched per language),
  so the hero/hourly descriptions arrive in English by design.
- Weather data is informational and is **not** an official severe-weather
  warning source — always defer to local authorities (alerts come from the
  API's `publicAlerts` endpoint, re-checked every 2 hours).
- Deployment: `backend/Dockerfile` (+ `/app/data` volume for the device
  registry); serve the APK via any standard Android distribution. Tag-driven
  releases additionally need the `RELEASE_API_BASE_URL` repo variable (the
  production backend URL) plus the four `CIRRUS_KEYSTORE_*` secrets.
