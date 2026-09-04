/**
 * Notification copy packs. The English pack is the reference: every other
 * pack must expose the same keys with the same {placeholders} (enforced by
 * unit test). Weather condition names map to the same archetypes the app
 * uses for its visual themes.
 */
export interface WeatherStrings {
  /** Notification title. {city} = display name of the location. */
  todayIn: string
  condClear: string
  condPartly: string
  condCloudy: string
  condFog: string
  condWindy: string
  condDrizzle: string
  condRain: string
  condHeavyRain: string
  condThunder: string
  condSnow: string
  condHeavySnow: string
  condSleet: string
  condHail: string
  /** {high} and {low} are pre-formatted, unit-suffixed temperatures. */
  highLow: string
  /** {time} is a localized wall-clock time, {p} a 0–100 integer. */
  rainLikely: string
  rainPossible: string
  snowLikely: string
  noRain: string
  uvVeryHigh: string
  uvExtreme: string
  /** {speed} includes the localized unit, e.g. "40 km/h". */
  gusts: string
  veryHot: string
  veryCold: string
  /** Prefix for an upstream severe-weather alert headline. */
  alertActive: string
  windUnitMetric: string
  windUnitImperial: string
}

export interface LanguagePack {
  /** BCP-47-ish code, also the value clients send as ?lang=. */
  code: string
  /** Name of the language in itself, shown in the picker. */
  nativeName: string
  englishName: string
  rtl: boolean
  /**
   * Localized stand-in for a missing city name ("your location") — must
   * read naturally inside todayIn's template for its language. Wording is
   * area/position phrasing chosen to fit each template's grammar; native
   * review welcome (it only shows when a client omits ?city=).
   */
  fallbackCity: string
  t: WeatherStrings
}

/** Replaces {placeholders} in a pack string. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in vars ? String(vars[key]) : m,
  )
}
