/**
 * Maps Google Weather API WeatherCondition types onto the same condition
 * families the Android app uses for theming, so notification copy matches
 * what the user sees on screen.
 */
export type ConditionKey =
  | 'condClear'
  | 'condPartly'
  | 'condCloudy'
  | 'condFog'
  | 'condWindy'
  | 'condDrizzle'
  | 'condRain'
  | 'condHeavyRain'
  | 'condThunder'
  | 'condSnow'
  | 'condHeavySnow'
  | 'condSleet'
  | 'condHail'

const MAP: Record<string, ConditionKey> = {
  CLEAR: 'condClear',
  MOSTLY_CLEAR: 'condClear',
  PARTLY_CLOUDY: 'condPartly',
  MOSTLY_CLOUDY: 'condPartly',
  CLOUDY: 'condCloudy',
  FOG: 'condFog',
  HAZE: 'condFog',
  MIST: 'condFog',
  WINDY: 'condWindy',
  LIGHT_RAIN_SHOWERS: 'condDrizzle',
  CHANCE_OF_SHOWERS: 'condDrizzle',
  SCATTERED_SHOWERS: 'condDrizzle',
  LIGHT_RAIN: 'condDrizzle',
  LIGHT_TO_MODERATE_RAIN: 'condDrizzle',
  RAIN_SHOWERS: 'condRain',
  RAIN: 'condRain',
  MODERATE_TO_HEAVY_RAIN: 'condRain',
  RAIN_PERIODICALLY_HEAVY: 'condRain',
  WIND_AND_RAIN: 'condRain',
  HEAVY_RAIN_SHOWERS: 'condHeavyRain',
  HEAVY_RAIN: 'condHeavyRain',
  LIGHT_SNOW_SHOWERS: 'condSnow',
  CHANCE_OF_SNOW_SHOWERS: 'condSnow',
  SCATTERED_SNOW_SHOWERS: 'condSnow',
  LIGHT_SNOW: 'condSnow',
  LIGHT_TO_MODERATE_SNOW: 'condSnow',
  SNOW_SHOWERS: 'condHeavySnow',
  SNOW: 'condHeavySnow',
  MODERATE_TO_HEAVY_SNOW: 'condHeavySnow',
  SNOW_PERIODICALLY_HEAVY: 'condHeavySnow',
  SNOWSTORM: 'condHeavySnow',
  HEAVY_SNOW_SHOWERS: 'condHeavySnow',
  HEAVY_SNOW: 'condHeavySnow',
  HEAVY_SNOW_STORM: 'condHeavySnow',
  BLOWING_SNOW: 'condHeavySnow',
  RAIN_AND_SNOW: 'condSleet',
  HAIL: 'condHail',
  HAIL_SHOWERS: 'condHail',
  THUNDERSTORM: 'condThunder',
  THUNDERSHOWER: 'condThunder',
  LIGHT_THUNDERSTORM_RAIN: 'condThunder',
  SCATTERED_THUNDERSTORMS: 'condThunder',
  HEAVY_THUNDERSTORM: 'condThunder',
}

const SNOW_FAMILIES = new Set<ConditionKey>(['condSnow', 'condHeavySnow', 'condSleet'])

export function conditionKey(type: string | undefined | null): ConditionKey {
  if (!type) return 'condCloudy'
  return MAP[type.toUpperCase()] ?? 'condCloudy'
}

export function isSnowFamily(key: ConditionKey): boolean {
  return SNOW_FAMILIES.has(key)
}
