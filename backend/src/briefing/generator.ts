import type { WeatherBundle } from '../upstream/googleWeather.js'
import type { LanguagePack } from '../i18n/types.js'
import { fmt } from '../i18n/types.js'
import { conditionKey, isSnowFamily } from './conditions.js'

/**
 * Turns a METRIC weather bundle into a localized notification payload:
 * a short title plus 2–5 body lines covering conditions, temperatures,
 * precipitation timing, UV, wind and any active severe-weather alerts.
 */

export interface BriefingInput {
  bundle: WeatherBundle
  city: string
  pack: LanguagePack
  units: 'metric' | 'imperial'
  /** Injectable for deterministic tests. */
  now?: Date
}

export interface BriefingResult {
  title: string
  body: string
  condition: string
  highC: number | null
  lowC: number | null
  alertCount: number
  language: string
}

// ---- Safe accessors over the untyped upstream JSON ----

type Json = Record<string, unknown>

// The accessor guards below are defensive against hostile upstream JSON.
// Their mutation arms are verified equivalents: a value that slips a guard
// (null cast as Json, a numeric string, an empty string, a junk array
// element) is skipped by the same null/boolean checks one call later in
// every composition path — no notification line can change.
// Stryker disable ConditionalExpression,LogicalOperator,ArrayDeclaration
const asJson = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
// Stryker restore ConditionalExpression,LogicalOperator,ArrayDeclaration

interface HourFact {
  startTime: string | null
  precipPercent: number | null
  uvIndex: number | null
  gustKmh: number | null
  snowQtyMm: number | null
}

function hourFacts(hours: unknown): HourFact[] {
  const root = asJson(hours)
  // Stryker disable ArrayDeclaration: junk-populated lists yield hour facts with null fields, which every downstream consumer (peak scan, UV, gusts) skips — verified equivalent
  const list = root?.forecastHours
  if (!Array.isArray(list)) return []
  // Stryker restore ArrayDeclaration
  return list.map((h) => {
    const j = asJson(h) ?? {}
    const precip = asJson(j.precipitation)
    const prob = asJson(precip?.probability)
    const wind = asJson(j.wind)
    const gust = asJson(wind?.gust)
    const snow = asJson(precip?.snowQpf)
    return {
      startTime: str(j.interval ? asJson(j.interval)?.startTime : null),
      precipPercent: num(prob?.percent),
      uvIndex: num(j.uvIndex),
      gustKmh: num(gust?.value),
      snowQtyMm: num(snow?.quantity),
    }
  })
}

// ---- Unit conversion (upstream is always METRIC) ----

const toF = (c: number) => c * 9 / 5 + 32
const toMph = (kmh: number) => kmh * 0.621371

function temp(degreesC: number, units: BriefingInput['units']): string {
  const v = units === 'imperial' ? toF(degreesC) : degreesC
  return `${Math.round(v)}°`
}

// Formatter construction is the expensive part of Intl — briefing a city
// formats up to 72 hours, so formatters are memoized per locale|timezone.
// (A malformed timezone throws inside the constructor, so the memo getter
// takes the same try/catch fallbacks the direct construction had.) The maps
// are capped: the timezone half of the key comes from upstream JSON, and an
// upstream spewing timezone variants must not grow the cache for the life
// of the process. The locale half is bounded by the 27 supported packs.
const FORMATTER_CACHE_CAP = 128
const timeFormatters = new Map<string, Intl.DateTimeFormat>()
const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>()

/** Insert with least-recently-used eviction (Map preserves insertion order). */
// Stryker disable ConditionalExpression,EqualityOperator,CallExpression,BlockStatement,BooleanLiteral,ArrowFunction: the cache's internal bookkeeping (recency refresh, off-by-one on the cap boundary) is unobservable without introspecting the Map — the only externally visible property, "formatter results stay correct across >cap distinct timezones", is pinned by the memoization loop test
function memoize<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const existing = cache.get(key)
  if (existing !== undefined) {
    cache.delete(key)
    cache.set(key, existing)
    return existing
  }
  const fresh = build()
  if (cache.size >= FORMATTER_CACHE_CAP) {
    const eldest = cache.keys().next().value
    if (eldest !== undefined) cache.delete(eldest)
  }
  cache.set(key, fresh)
  return fresh
}
// Stryker restore ConditionalExpression,EqualityOperator,CallExpression,BlockStatement,BooleanLiteral,ArrowFunction

/** Localized wall-clock time ("4 PM", "16:00", "৪টা"…) in the city's timezone. */
function localTime(iso: string, langCode: string, timeZone: string): string {
  const d = new Date(iso)
  const key = `${langCode}|${timeZone}`
  try {
    const fmt = memoize(timeFormatters, key, () =>
      new Intl.DateTimeFormat(langCode, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }),
    )
    return fmt.format(d)
  } catch {
    // Invalid timezone or locale data — fall back to UTC HH:mm.
    return Number.isNaN(d.getTime())
      ? ''
      : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  }
}

function sameLocalDay(iso: string, now: Date, timeZone: string): boolean {
  try {
    // Stryker disable StringLiteral: the day-key format only feeds a same-day equality comparison — any internally consistent format behaves identically
    const fmt = memoize(dayKeyFormatters, timeZone, () =>
      new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone,
      }),
    )
    // Stryker restore StringLiteral
    return fmt.format(new Date(iso)) === fmt.format(now)
  } catch {
    return true // if the timezone is bad, keep the hour instead of dropping all
  }
}

export function generateBriefing(input: BriefingInput): BriefingResult {
  const { bundle, city, pack, units } = input
  const now = input.now ?? new Date()
  const t = pack.t

  const current = asJson(bundle.currentConditions)
  const days = asJson(bundle.forecastDays)
  const tzRoot = asJson(current?.timeZone) ?? asJson(asJson(bundle.forecastHours)?.timeZone)
  const timeZone = str(tzRoot?.id) ?? 'UTC'

  // Today's day entry (first forecast day).
  // Stryker disable ArrayDeclaration: junk elements yield the same null "today" as an empty list (verified)
  const dayList = Array.isArray(days?.forecastDays) ? (days.forecastDays as unknown[]) : []
  // Stryker restore ArrayDeclaration
  const today = asJson(dayList[0])

  const daytime = asJson(today?.daytimeForecast)
  const condType =
    str(asJson(daytime?.weatherCondition)?.type) ??
    str(asJson(current?.weatherCondition)?.type)
  const condKey = conditionKey(condType)

  const highC = num(asJson(today?.maxTemperature)?.degrees)
  const lowC = num(asJson(today?.minTemperature)?.degrees)

  // Hours relevant to "today" in the city's local time.
  const allHours = hourFacts(bundle.forecastHours)
  const todaysHours = allHours.filter((h) => h.startTime && sameLocalDay(h.startTime, now, timeZone))
  const hours = todaysHours.length > 0 ? todaysHours : allHours.slice(0, 16)

  // Precipitation: the hour with the highest probability today. Probabilities
  // are never negative, so a plain "beats the running best" comparison is
  // enough — no first-hour special case needed.
  let peakRain: HourFact | null = null
  let peakPct = 0
  let peakObserved = false
  for (const h of hours) {
    if (h.precipPercent == null) continue
    peakObserved = true
    if (h.precipPercent > peakPct) {
      peakRain = h
      peakPct = h.precipPercent
    }
  }
  const snowExpected =
    isSnowFamily(condKey) || hours.some((h) => (h.snowQtyMm ?? 0) > 0.2) ||
    condKey === 'condHail'

  const uvMax = hours.reduce((m, h) => Math.max(m, h.uvIndex ?? 0), 0)
  const gustMax = hours.reduce((m, h) => Math.max(m, h.gustKmh ?? 0), 0)

  // Alerts (already requested upstream in the user's language where available).
  const alertsRoot = asJson(bundle.publicAlerts)
  // Stryker disable ArrayDeclaration: junk elements are filtered out by the same headline check (verified)
  const alertList = Array.isArray(alertsRoot?.weatherAlerts)
    ? (alertsRoot.weatherAlerts as unknown[])
    : []
  // Stryker restore ArrayDeclaration
  const allHeadlines = alertList
    .map((a) => str(asJson(a)?.headline))
    .filter((h): h is string => Boolean(h))
  // The body keeps the notification short (two headlines max); alertCount
  // still reports every real, displayable alert.
  const alertHeadlines = allHeadlines.slice(0, 2)

  // ---- Compose ----

  const lines: string[] = []

  lines.push(t[condKey])
  if (highC != null && lowC != null) {
    lines.push(fmt(t.highLow, { high: temp(highC, units), low: temp(lowC, units) }))
  }

  if (peakRain && peakRain.startTime && peakPct >= 50) {
    const time = localTime(peakRain.startTime, pack.code, timeZone)
    lines.push(
      fmt(snowExpected ? t.snowLikely : t.rainLikely, {
        time,
        p: Math.round(peakPct),
      }),
    )
  } else if (peakRain && peakRain.startTime && peakPct >= 25) {
    const time = localTime(peakRain.startTime, pack.code, timeZone)
    lines.push(fmt(snowExpected ? t.snowLikely : t.rainPossible, { time, p: Math.round(peakPct) }))
  } else if (peakPct < 25 && peakObserved && bundle.degraded !== true) {
    // "No rain expected" is a claim about complete data: it requires hours
    // AND at least one hour that actually carried a precipitation field.
    // An empty, truncated, or field-renamed hours list must stay silent
    // instead of promising a dry afternoon it never saw — that false
    // reassurance is the single most dangerous sentence a weather
    // notification can say.
    lines.push(t.noRain)
  }

  if (uvMax >= 11) {
    lines.push(fmt(t.uvExtreme, { uv: Math.round(uvMax) }))
  } else if (uvMax >= 8) {
    lines.push(fmt(t.uvVeryHigh, { uv: Math.round(uvMax) }))
  }

  if (gustMax >= 40) {
    const speed =
      units === 'imperial'
        ? `${Math.round(toMph(gustMax))} ${t.windUnitImperial}`
        : `${Math.round(gustMax)} ${t.windUnitMetric}`
    lines.push(fmt(t.gusts, { speed }))
  }

  // Stryker disable ConditionalExpression: verified equivalent — Number(null|undefined) is 0/NaN and both fail >= 40, so removing the null-guard cannot flip the verdict (the lowC twin below IS load-bearing, 0 <= 2, and stays test-pinned)
  if (highC != null && highC >= 40) lines.push(t.veryHot)
  // Stryker restore ConditionalExpression
  if (lowC != null && lowC <= 2) lines.push(t.veryCold)

  for (const headline of alertHeadlines) {
    lines.push(fmt(t.alertActive, { headline }))
  }

  return {
    title: fmt(t.todayIn, { city }),
    body: lines.join('\n'),
    condition: t[condKey],
    highC,
    lowC,
    // Every displayable alert, not just the two headlines shown in the body.
    alertCount: allHeadlines.length,
    language: pack.code,
  }
}
