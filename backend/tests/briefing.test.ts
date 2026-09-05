import { describe, expect, it } from 'vitest'
import type { WeatherBundle } from '../src/upstream/googleWeather.js'
import { generateBriefing } from '../src/briefing/generator.js'
import { resolvePack } from '../src/i18n/index.js'
import { en } from '../src/i18n/packs/en.js'
import { fmt } from '../src/i18n/types.js'

/** Synthetic Hyderabad-style bundle, METRIC units like the upstream API. */
function makeBundle(overrides: {
  conditionType?: string
  precipAt?: { hourUtc: number; percent: number }
  uvMax?: number
  gustKmh?: number
  highC?: number
  lowC?: number
  alerts?: Array<{ headline: string }>
  timeZone?: string
} = {}): WeatherBundle {
  const {
    conditionType = 'PARTLY_CLOUDY',
    precipAt = { hourUtc: 11, percent: 75 },
    uvMax = 9,
    gustKmh = 30,
    highC = 31,
    lowC = 24,
    alerts = [],
    timeZone = 'Asia/Kolkata',
  } = overrides

  const day = '2026-09-03'
  const hours = Array.from({ length: 24 }, (_, h) => ({
    interval: { startTime: `${day}T${String(h).padStart(2, '0')}:00:00Z` },
    weatherCondition: { type: conditionType },
    temperature: { unit: 'CELSIUS', degrees: 24 + h / 4 },
    precipitation: {
      probability: { type: 'RAIN', percent: h === precipAt.hourUtc ? precipAt.percent : 5 },
      qpf: { unit: 'MILLIMETERS', quantity: 0 },
      snowQpf: { unit: 'MILLIMETERS', quantity: 0 },
    },
    wind: {
      speed: { unit: 'KILOMETERS_PER_HOUR', value: 10 },
      gust: { unit: 'KILOMETERS_PER_HOUR', value: h === 14 ? gustKmh : 15 },
    },
    uvIndex: h === 12 ? uvMax : 1,
    isDaytime: h >= 6 && h <= 18,
  }))

  return {
    currentConditions: {
      timeZone: { id: timeZone },
      weatherCondition: { type: conditionType },
      temperature: { unit: 'CELSIUS', degrees: 27 },
      isDaytime: true,
    },
    forecastHours: { forecastHours: hours, timeZone: { id: timeZone } },
    forecastDays: {
      forecastDays: [
        {
          displayDate: { year: 2026, month: 9, day: 3 },
          maxTemperature: { unit: 'CELSIUS', degrees: highC },
          minTemperature: { unit: 'CELSIUS', degrees: lowC },
          daytimeForecast: { weatherCondition: { type: conditionType } },
        },
      ],
      timeZone: { id: timeZone },
    },
    historyHours: {},
    publicAlerts: { weatherAlerts: alerts },
  }
}

// 2026-09-03 is a real day; pin "now" inside it so day filtering is stable.
const NOW = new Date('2026-09-03T04:00:00Z')

describe('generateBriefing', () => {
  it('composes the standard English briefing', () => {
    const result = generateBriefing({
      bundle: makeBundle(),
      city: 'Hyderabad',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })

    expect(result.title).toBe('Today in Hyderabad')
    expect(result.body).toContain('Partly cloudy')
    expect(result.body).toContain('High 31° / Low 24°')
    expect(result.body).toMatch(/Rain likely around \d/)
    expect(result.body).toContain('Very high UV index (9)')
    expect(result.condition).toBe('Partly cloudy')
    expect(result.highC).toBe(31)
    expect(result.lowC).toBe(24)
  })

  it('converts to imperial units', () => {
    const result = generateBriefing({
      bundle: makeBundle({ highC: 40, lowC: 30, gustKmh: 60 }),
      city: 'Phoenix',
      pack: resolvePack('en'),
      units: 'imperial',
      now: NOW,
    })
    expect(result.body).toContain('High 104° / Low 86°')
    expect(result.body).toContain('mph')
    expect(result.body).toContain('Very hot today')
  })

  it('says no rain when probabilities are low', () => {
    const result = generateBriefing({
      bundle: makeBundle({ precipAt: { hourUtc: 12, percent: 5 } }),
      city: 'Cairo',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.body).toContain('No rain expected today')
  })

  it('uses the "possible" wording for middling probabilities', () => {
    const result = generateBriefing({
      bundle: makeBundle({ precipAt: { hourUtc: 15, percent: 35 } }),
      city: 'London',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.body).toMatch(/Rain possible around/)
  })

  it('includes localized alert lines', () => {
    const result = generateBriefing({
      bundle: makeBundle({ alerts: [{ headline: 'Heavy rain warning' }] }),
      city: 'Chennai',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.body).toContain('Weather alert: Heavy rain warning')
    expect(result.alertCount).toBe(1)
  })

  it('switches to snow copy for snow conditions', () => {
    const result = generateBriefing({
      bundle: makeBundle({ conditionType: 'SNOW', precipAt: { hourUtc: 9, percent: 70 } }),
      city: 'Shimla',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.condition).toBe('Snow')
    expect(result.body).toMatch(/Snow likely around/)
  })

  it('produces Telugu copy for the Telugu pack', () => {
    const result = generateBriefing({
      bundle: makeBundle(),
      city: 'Hyderabad',
      pack: resolvePack('te'),
      units: 'metric',
      now: NOW,
    })
    expect(result.title).toBe('ఈరోజు Hyderabadలో')
    expect(result.body).toContain('గరిష్ఠం 31° / కనిష్ఠం 24°')
    expect(result.body).toContain('వర్షం')
  })

  it('produces Hindi copy including the UV line', () => {
    const result = generateBriefing({
      bundle: makeBundle({ uvMax: 11 }),
      city: 'Delhi',
      pack: resolvePack('hi'),
      units: 'metric',
      now: NOW,
    })
    expect(result.title).toBe('आज Delhi में')
    expect(result.body).toContain('अत्यंत तेज़ UV किरणें (11)')
  })

  it('degrades gracefully with empty upstream data', () => {
    const result = generateBriefing({
      bundle: {
        currentConditions: {},
        forecastHours: {},
        forecastDays: {},
        historyHours: {},
        publicAlerts: {},
      },
      city: 'Nowhere',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.title).toBe('Today in Nowhere')
    expect(result.body).toContain('Cloudy')
    expect(result.highC).toBeNull()
  })

  it('renders the neutral unknown label for a future condition type', () => {
    // An unrecognized enum value must not claim "Cloudy" — that would assert
    // specific weather the upstream never reported.
    const result = generateBriefing({
      bundle: makeBundle({ conditionType: 'SOME_FUTURE_TYPE' }),
      city: 'Testville',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.condition).toBe(en.t.condUnknown)
    expect(result.condition).not.toBe(en.t.condCloudy)
  })

  it('does not throw for hours outside today (keeps first 16 as fallback)', () => {
    const bundle = makeBundle()
    // Shift all hours to tomorrow.
    const hours = (bundle.forecastHours as { forecastHours: Array<{ interval: { startTime: string } }> })
    for (const h of hours.forecastHours) {
      h.interval.startTime = h.interval.startTime.replace('2026-09-03', '2026-09-04')
    }
    const result = generateBriefing({
      bundle,
      city: 'Tokyo',
      pack: resolvePack('ja'),
      units: 'metric',
      now: NOW,
    })
    expect(result.title).toBe('今日のTokyo')
    expect(result.body).toBeTruthy()
  })
})

describe('generateBriefing boundaries', () => {
  const run = (overrides: Parameters<typeof makeBundle>[0] = {}) =>
    generateBriefing({
      bundle: makeBundle(overrides),
      city: 'Testville',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })

  it('produces the exact expected body for the default scenario', () => {
    const result = run()
    expect(result.body).toBe(
      [
        'Partly cloudy',
        'High 31° / Low 24°',
        'Rain likely around 4:30 PM (75%)',
        'Very high UV index (9) around midday',
      ].join('\n'),
    )
  })
  it('formats rain times in the city timezone when current conditions lack one', () => {
    const bundle = makeBundle({ precipAt: { hourUtc: 10, percent: 70 } })
    delete (bundle.currentConditions as { timeZone?: unknown }).timeZone
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toContain('Rain likely around 3:30 PM (70%)') // Asia/Kolkata = UTC+5:30
  })

  it('formats with padded hours for an invalid timezone', () => {
    const bundle = makeBundle({ precipAt: { hourUtc: 4, percent: 70 } })
    ;(bundle.currentConditions as { timeZone: { id: string } }).timeZone.id = 'Not/AZone'
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toContain('Rain likely around 04:00 (70%)')
  })

  it('degrades to defaults when whole payload sections are null', () => {
    const result = generateBriefing({
      bundle: { currentConditions: null, forecastHours: null, forecastDays: null, historyHours: null, publicAlerts: null },
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(result.condition).toBe('Cloudy')
    // Null hours = missing data, not an absence of rain: the definitive
    // no-rain claim must not be made on top of it.
    expect(result.body).not.toContain('No rain expected today')
    expect(result.alertCount).toBe(0)
  })

  it('ignores malformed hour fragments and alert entries without throwing', () => {
    const bundle = makeBundle({ precipAt: { hourUtc: 11, percent: 60 } })
    const hours = (bundle.forecastHours as {
      forecastHours: Array<Record<string, unknown>>
    }).forecastHours
    hours[0].interval = 5 // not an object
    hours[1].precipitation = null
    hours[2].wind = null
    hours[3].precipitation = { probability: null, snowQpf: null }
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toContain('Rain likely around 4:30 PM (60%)')
    expect(result.body).not.toContain('Snow')

    const alertBundle = makeBundle({ alerts: ['garbage-string', 42] as never })
    const withJunk = generateBriefing({
      bundle: alertBundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    expect(withJunk.alertCount).toBe(0)
  })

  it('keeps the first hour when equal precipitation probabilities tie', () => {
    const bundle = makeBundle({ precipAt: { hourUtc: 5, percent: 80 } })
    const hours = (bundle.forecastHours as {
      forecastHours: Array<{ interval: { startTime: string }; precipitation: { probability: { percent: number } } }>
    }).forecastHours
    hours[15].precipitation.probability.percent = 80
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toContain('10:30 AM') // hour 5 UTC in Kolkata
    expect(result.body).not.toContain('8:30 PM')
  })

  it('filters non-today hours even at low indices', () => {
    const bundle = makeBundle({ uvMax: 1, precipAt: { hourUtc: 11, percent: 5 } })
    const hours = (bundle.forecastHours as {
      forecastHours: Array<{ interval: { startTime: string }; uvIndex: number }>
    }).forecastHours
    hours[5].interval.startTime = '2026-09-04T23:00:00Z' // tomorrow, low index
    hours[5].uvIndex = 12
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).not.toContain('UV')
  })

  it('uses "rain likely" exactly at 50% and "possible" exactly at 25%', () => {
    expect(run({ precipAt: { hourUtc: 11, percent: 50 } }).body).toMatch(/Rain likely around/)
    expect(run({ precipAt: { hourUtc: 11, percent: 49 } }).body).toMatch(/Rain possible around/)
    expect(run({ precipAt: { hourUtc: 11, percent: 25 } }).body).toMatch(/Rain possible around/)
    expect(run({ precipAt: { hourUtc: 11, percent: 24 } }).body).toMatch(/No rain expected today/)
  })

  it('uses "snow" copy for hail regardless of snow quantities', () => {
    const result = run({ conditionType: 'HAIL', precipAt: { hourUtc: 11, percent: 70 } })
    expect(result.body).toMatch(/Snow likely around/)
  })

  it('treats snow quantities above 0.2mm as snow even under rain conditions', () => {
    const bundle = makeBundle({ precipAt: { hourUtc: 11, percent: 70 } })
    const hours = (bundle.forecastHours as { forecastHours: Array<{ precipitation: { snowQpf: { quantity: number } } }> })
      .forecastHours
    hours[3].precipitation.snowQpf.quantity = 0.21
    const justAbove = generateBriefing({ bundle, city: 'S', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(justAbove.body).toMatch(/Snow likely around/)

    const boundary = makeBundle({ precipAt: { hourUtc: 11, percent: 70 } })
    const bHours = (boundary.forecastHours as { forecastHours: Array<{ precipitation: { snowQpf: { quantity: number } } }> })
      .forecastHours
    bHours[3].precipitation.snowQpf.quantity = 0.2
    const atBoundary = generateBriefing({ bundle: boundary, city: 'S', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(atBoundary.body).toMatch(/Rain likely around/)
  })

  it('flags UV exactly at the 8 and 11 thresholds and rounds values', () => {
    expect(run({ uvMax: 8 }).body).toContain('Very high UV index (8)')
    expect(run({ uvMax: 7.9 }).body).not.toContain('UV')
    expect(run({ uvMax: 11 }).body).toContain('Extreme UV index (11)')
    expect(run({ uvMax: 11.5 }).body).toContain('Extreme UV index (12)') // rounds, not floors
    expect(run({ uvMax: 10.6 }).body).toContain('Very high UV index (11)') // 10.6 < 11
  })

  it('flags gusts exactly at 40 km/h', () => {
    expect(run({ gustKmh: 40 }).body).toContain('Gusty winds up to 40 km/h')
    expect(run({ gustKmh: 39.4 }).body).not.toContain('Gusty')
  })

  it('flags heat exactly at 40°C and cold exactly at 2°C', () => {
    expect(run({ highC: 40 }).body).toContain('Very hot today')
    expect(run({ highC: 39.6 }).body).not.toContain('Very hot')
    expect(run({ lowC: 2 }).body).toContain('Very cold today')
    expect(run({ lowC: 2.4, highC: 20 }).body).not.toContain('Very cold')
  })

  it('shows at most two alert headlines', () => {
    const result = run({
      alerts: [
        { headline: 'Alert one' },
        { headline: 'Alert two' },
        { headline: 'Alert three' },
        { headline: '' },
      ],
    })
    const alertLines = result.body.split('\n').filter((l) => l.startsWith('Weather alert:'))
    expect(alertLines).toEqual(['Weather alert: Alert one', 'Weather alert: Alert two'])
    // alertCount reports every displayable alert, not just the two in the body.
    expect(result.alertCount).toBe(3)
  })

  it('joins briefing lines with newlines', () => {
    expect(run().body.split('\n').length).toBeGreaterThanOrEqual(3)
  })

  it('converts with exact rounding in both unit systems', () => {
    expect(run({ highC: 31, lowC: 24 }).body).toContain('High 31° / Low 24°')
    const imperial = generateBriefing({
      bundle: makeBundle({ highC: 31, lowC: 24, gustKmh: 40 }),
      city: 'T',
      pack: resolvePack('en'),
      units: 'imperial',
      now: NOW,
    })
    expect(imperial.body).toContain('High 88° / Low 75°') // 87.8→88, 75.2→75
    expect(imperial.body).toContain('Gusty winds up to 25 mph') // 24.85→25
  })

  it('falls back to the current condition when the day entry has none', () => {
    const bundle = makeBundle({ conditionType: 'RAIN' })
    const day = (bundle.forecastDays as { forecastDays: Array<{ daytimeForecast: unknown }> }).forecastDays[0]
    delete day.daytimeForecast
    ;(bundle.currentConditions as { weatherCondition: { type: string } }).weatherCondition.type = 'WINDY'
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.condition).toBe('Windy')
  })

  it('omits the high/low line when temperatures are missing or non-numeric', () => {
    const bundle = makeBundle()
    delete (bundle.forecastDays as { forecastDays: Array<{ maxTemperature?: unknown }> }).forecastDays[0].maxTemperature
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.highC).toBeNull()
    expect(result.body).not.toContain('High')

    const nanBundle = makeBundle()
    ;(nanBundle.forecastDays as { forecastDays: Array<{ minTemperature: { degrees: number } }> })
      .forecastDays[0].minTemperature.degrees = Number.NaN
    const nanResult = generateBriefing({ bundle: nanBundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(nanResult.body).not.toContain('High')
  })

  it('falls back to UTC times for an invalid timezone', () => {
    const bundle = makeBundle({ precipAt: { hourUtc: 11, percent: 70 } })
    ;(bundle.currentConditions as { timeZone: { id: string } }).timeZone.id = 'Not/AZone'
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toMatch(/Rain likely around 11:00/)
  })

  it('uses the forecast timezone when current conditions lack one', () => {
    const bundle = makeBundle()
    delete (bundle.currentConditions as { timeZone?: unknown }).timeZone
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.title).toBe('Today in T') // composed without throwing
  })

  it('keeps only today hours, not tomorrow outliers', () => {
    const bundle = makeBundle({ uvMax: 1, precipAt: { hourUtc: 11, percent: 5 } })
    const hours = (bundle.forecastHours as {
      forecastHours: Array<{ interval: { startTime: string }; uvIndex: number }>
    }).forecastHours
    // Tomorrow-only extreme UV: must be ignored because it is not today.
    hours[20].interval.startTime = '2026-09-04T12:00:00Z'
    hours[20].uvIndex = 12
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).not.toContain('UV')
  })

  it('caps the all-hours fallback at 16 entries', () => {
    const bundle = makeBundle({ uvMax: 1, precipAt: { hourUtc: 11, percent: 5 } })
    const hours = (bundle.forecastHours as {
      forecastHours: Array<{ interval: { startTime: string }; uvIndex: number }>
    }).forecastHours
    for (const h of hours) h.interval.startTime = h.interval.startTime.replace('2026-09-03', '2026-09-04')
    // Index 16 is outside the 16-entry fallback window.
    hours[16].uvIndex = 12
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).not.toContain('UV')
  })

  it('ignores hour rows with a missing interval and non-array hour lists', () => {
    const bundle = makeBundle({ uvMax: 1, precipAt: { hourUtc: 11, percent: 5 } })
    const raw = bundle.forecastHours as { forecastHours: Array<{ interval?: unknown }> }
    delete raw.forecastHours[11].interval
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).toContain('No rain expected today')

    const notArray = makeBundle()
    ;(notArray.forecastHours as { forecastHours: unknown }).forecastHours = 'garbage'
    const degraded = generateBriefing({ bundle: notArray, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    // An unparseable hours list is missing data, not a dry forecast.
    expect(degraded.body).not.toContain('No rain expected today')
  })

  it('stays silent on rain when NO hour carries a precipitation probability', () => {
    // Absent precipitation data is not evidence of a dry day — hours
    // without any probability field must not produce the confident claim.
    const bundle = makeBundle()
    for (const h of (bundle.forecastHours as { forecastHours: Array<{ precipitation: { probability: unknown } }> }).forecastHours) {
      delete h.precipitation.probability
    }
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).not.toContain('No rain expected today')
    expect(result.body).not.toContain('rain likely')
    expect(result.body).not.toContain('rain possible')
  })
})

describe('generateBriefing — hostile timestamps', () => {
  it('renders an empty time when the timestamp and timezone are both invalid', () => {
    const bundle: WeatherBundle = {
      currentConditions: {
        timeZone: { id: 'Not/AZone' },
        weatherCondition: { type: 'RAIN' },
      },
      forecastHours: {
        forecastHours: [
          {
            interval: { startTime: 'not-a-timestamp' },
            precipitation: { probability: { type: 'RAIN', percent: 80 } },
          },
        ],
      },
      forecastDays: { forecastDays: [{}] },
      historyHours: {},
      publicAlerts: {},
    }

    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    // The rain line survives with an empty {time} — never a crash, never
    // "Invalid Date" noise in a localized notification.
    expect(result.body).toContain(fmt(en.t.rainLikely, { time: '', p: 80 }))
  })
})

describe('generateBriefing — malformed hour entries', () => {
  it('skips non-object entries instead of crashing', () => {
    const bundle = makeBundle()
    const raw = bundle.forecastHours as { forecastHours: unknown[] }
    raw.forecastHours[3] = 'garbage'
    raw.forecastHours[4] = null
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    // The intact hours still drive the briefing.
    expect(result.body).toContain(fmt(en.t.rainLikely, {
      time: new Intl.DateTimeFormat('en', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }).format(new Date('2026-09-03T11:00:00Z')),
      p: 75,
    }))
  })
})

describe('generateBriefing — snow wording in the possible band', () => {
  it('uses the snow phrasing for a 25-49% snow-family forecast', () => {
    const bundle = makeBundle({ conditionType: 'SNOW', precipAt: { hourUtc: 11, percent: 30 } })
    const result = generateBriefing({
      bundle,
      city: 'T',
      pack: resolvePack('en'),
      units: 'metric',
      now: NOW,
    })
    const expectedTime = new Intl.DateTimeFormat('en', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    }).format(new Date('2026-09-03T11:00:00Z'))
    expect(result.body).toContain(fmt(en.t.snowLikely, { time: expectedTime, p: 30 }))
    expect(result.body).not.toContain(en.t.rainPossible === undefined ? '\u0000' : fmt(en.t.rainPossible, { time: expectedTime, p: 30 }))
  })
})

describe('formatter memoization', () => {
  it('caps the per-locale|timezone formatter cache (upstream-controlled keys)', () => {
    // The timezone half of the cache key comes from upstream JSON; without
    // the cap a misbehaving upstream grows the map for the process lifetime.
    const zones = Intl.supportedValuesOf('timeZone').slice(0, 140)
    const bundleOf = (tz: string) =>
      makeBundle({ precipAt: { hourUtc: 11, percent: 40 }, timeZone: tz })
    for (const tz of zones) {
      const result = generateBriefing({
        bundle: bundleOf(tz),
        city: 'T',
        pack: resolvePack('en'),
        units: 'metric',
        now: NOW,
      })
      expect(result.body.length).toBeGreaterThan(0)
    }
    // A second pass over the same zones exercises the cache-HIT refresh
    // path (delete+re-insert), not just insertions.
    for (const tz of zones.slice(0, 20)) {
      generateBriefing({
        bundle: bundleOf(tz),
        city: 'T',
        pack: resolvePack('en'),
        units: 'metric',
        now: NOW,
      })
    }
  })
})

describe('degraded flag at the generator boundary', () => {
  it('a degraded bundle with perfectly normal hours still makes no rain claim', () => {
    // Normal hours, low precip, but the bundle is flagged degraded (e.g.
    // alerts-missing at the route layer): silence, not reassurance.
    const bundle = makeBundle({ precipAt: { hourUtc: 11, percent: 5 } }) as WeatherBundle & { degraded?: boolean }
    bundle.degraded = true
    const result = generateBriefing({ bundle, city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    expect(result.body).not.toContain('No rain expected today')
    // Same bundle without the flag DOES claim it — proving the flag is the pivot.
    const healthy = generateBriefing({
      bundle: makeBundle({ precipAt: { hourUtc: 11, percent: 5 } }),
      city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW,
    })
    expect(healthy.body).toContain('No rain expected today')
  })

  it('very-hot advice fires at exactly 40°C', () => {
    const at40 = generateBriefing({ bundle: makeBundle({ highC: 40, lowC: 24 }), city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    const at39 = generateBriefing({ bundle: makeBundle({ highC: 39, lowC: 24 }), city: 'T', pack: resolvePack('en'), units: 'metric', now: NOW })
    // The advice line is the ONLY difference between the two bodies.
    expect(at40.body).not.toBe(at39.body)
    expect(at40.body.length).toBeGreaterThan(at39.body.length)
  })
})
