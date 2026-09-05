# Cirrus Backend

The dedicated server behind the Cirrus weather app. The Android client talks
**only** to this backend — the Google Maps Platform Weather API key never
ships inside the APK — and all localized notification content is composed
here.

## What it does

| Area | Endpoints | Notes |
|---|---|---|
| Weather data | `GET /api/v1/weather/bundle`, `GET /api/v1/weather/current` | Proxies the Google Weather API (key in `.env`), 10-minute shared cache with stampede protection |
| City search | `GET /api/v1/geocode?name=…` | Proxies Open-Meteo geocoding |
| Notifications | `GET /api/v1/notifications/briefing`, `GET /api/v1/notifications/alerts` | Generates the daily briefing ("Today in Hyderabad — cloudy, high 29°/low 24°, rain possible around 3 PM…") in **27 languages** |
| Languages | `GET /api/v1/languages` | Catalog for the app's language picker |
| Device registry | `POST /api/v1/devices`, `GET/DELETE /api/v1/devices/:id`, `POST /api/v1/devices/:id/secret` | Which devices want notifications, in which language, for which city, at what time — the dispatch list for server-side push; the `/secret` route rotates a leaked device secret |
| Health | `GET /api/v1/health` | Liveness probe |

Supported languages: English, Hindi, Telugu, Tamil, Bengali, Marathi,
Gujarati, Kannada, Malayalam, Punjabi, Urdu, Spanish, French, German,
Italian, Portuguese, Dutch, Russian, Turkish, Arabic, Indonesian, Thai,
Vietnamese, Japanese, Korean, Chinese (Simplified), Chinese (Traditional).
Unknown codes fall back to English; `zh-HK`-style tags resolve by primary
subtag.

## Run it

```bash
cd backend
cp .env.example .env       # put your Weather API key in WEATHER_API_KEY
npm install
npm run dev                # http://localhost:8080
```

Production:

```bash
npm run build && npm start          # or:
docker build -t cirrus-backend . && docker run -p 8080:8080 -e WEATHER_API_KEY=… cirrus-backend
```

Tests, type-check, mutation testing, audit:

```bash
npm test           # vitest: 524 tests — API, security, upstream, cache,
                   # briefing engine, i18n ×27, config, store
npm run typecheck  # tsc --noEmit
npm run mutation   # StrykerJS mutation testing (gate: 98% of scored mutants;
                   #   20.8% of mutants — 335 of 1609 — are documented
                   #   equivalent-mutant ignores; figures recomputed from
                   #   reports/mutation/mutation.json, which predates the
                   #   2026-09-04 fix round)
npm run audit      # dependency audit — 0 findings
```

## Try the briefing

```bash
curl "http://localhost:8080/api/v1/notifications/briefing?lat=17.385&lon=78.4867&city=Hyderabad&lang=te"
```

```json
{
  "title": "ఈరోజు Hyderabadలో",
  "body": "మేఘావృతం\nగరిష్ఠం 29° / కనిష్ఠం 24°\n3:00 PM సమయంలో వర్షం రావచ్చు (30%)\nమధ్యాహ్నం చాలా ఎక్కువ UV కిరణాలు (9)",
  "language": "te", "highC": 28.8, "lowC": 23.8, "alertCount": 0
}
```

`units=imperial` converts temperatures/wind to °F/mph. Times are rendered in
the city's timezone with locale-appropriate formatting via `Intl`.

## Layout

```
src/
  index.ts            entry: server bootstrap, graceful shutdown
  env.ts              loads .env before anything reads process.env
  app.ts              express assembly (helmet, CORS, rate limit, pino-http)
  routes.ts           /api/v1 endpoints (zod-validated)
  config.ts           env schema, validated at boot
  cache.ts            TTL cache + single-flight
  upstream/           googleWeather.ts (5 endpoints), openMeteo.ts
  briefing/           generator.ts (forecast → localized copy), conditions.ts
  i18n/               types + packs/{en,indian,european,apac}.ts
  store/              deviceStore.ts (atomic JSON persistence)
tests/                api, security, ratelimit, upstream, cache, briefing,
                      conditions, i18n, config, devicestore, errors
```

## Production notes

- Swap the in-memory cache for Redis and `DeviceStore` for a database when
  you run more than one instance (both are behind tiny interfaces).
- The device registry is FCM-ready: add `fcmToken` when the client obtains
  one, and run a scheduler over `devices` to push briefings server-side.
  Today the app pulls the same content on its own schedule (WorkManager),
  which works with zero external dependencies.
- Restrict the Weather API key to your server's IPs in Google Cloud Console.
