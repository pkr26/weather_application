import { describe, expect, it } from 'vitest'
import { conditionKey, isSnowFamily, type ConditionKey } from '../src/briefing/conditions.js'

/** The complete contract: every upstream condition type → briefing family. */
const EXPECTED: Array<[string, ConditionKey]> = [
  ['CLEAR', 'condClear'],
  ['MOSTLY_CLEAR', 'condClear'],
  ['PARTLY_CLOUDY', 'condPartly'],
  ['MOSTLY_CLOUDY', 'condPartly'],
  ['CLOUDY', 'condCloudy'],
  ['FOG', 'condFog'],
  ['HAZE', 'condFog'],
  ['MIST', 'condFog'],
  ['WINDY', 'condWindy'],
  ['LIGHT_RAIN_SHOWERS', 'condDrizzle'],
  ['CHANCE_OF_SHOWERS', 'condDrizzle'],
  ['SCATTERED_SHOWERS', 'condDrizzle'],
  ['LIGHT_RAIN', 'condDrizzle'],
  ['LIGHT_TO_MODERATE_RAIN', 'condDrizzle'],
  ['RAIN_SHOWERS', 'condRain'],
  ['RAIN', 'condRain'],
  ['MODERATE_TO_HEAVY_RAIN', 'condRain'],
  ['RAIN_PERIODICALLY_HEAVY', 'condRain'],
  ['WIND_AND_RAIN', 'condRain'],
  ['HEAVY_RAIN_SHOWERS', 'condHeavyRain'],
  ['HEAVY_RAIN', 'condHeavyRain'],
  ['LIGHT_SNOW_SHOWERS', 'condSnow'],
  ['CHANCE_OF_SNOW_SHOWERS', 'condSnow'],
  ['SCATTERED_SNOW_SHOWERS', 'condSnow'],
  ['LIGHT_SNOW', 'condSnow'],
  ['LIGHT_TO_MODERATE_SNOW', 'condSnow'],
  ['SNOW_SHOWERS', 'condHeavySnow'],
  ['SNOW', 'condHeavySnow'],
  ['MODERATE_TO_HEAVY_SNOW', 'condHeavySnow'],
  ['SNOW_PERIODICALLY_HEAVY', 'condHeavySnow'],
  ['SNOWSTORM', 'condHeavySnow'],
  ['HEAVY_SNOW_SHOWERS', 'condHeavySnow'],
  ['HEAVY_SNOW', 'condHeavySnow'],
  ['HEAVY_SNOW_STORM', 'condHeavySnow'],
  ['BLOWING_SNOW', 'condHeavySnow'],
  ['RAIN_AND_SNOW', 'condSleet'],
  ['HAIL', 'condHail'],
  ['HAIL_SHOWERS', 'condHail'],
  ['THUNDERSTORM', 'condThunder'],
  ['THUNDERSHOWER', 'condThunder'],
  ['LIGHT_THUNDERSTORM_RAIN', 'condThunder'],
  ['SCATTERED_THUNDERSTORMS', 'condThunder'],
  ['HEAVY_THUNDERSTORM', 'condThunder'],
]

describe('conditionKey', () => {
  it.each(EXPECTED)('maps %s correctly', (type, key) => {
    expect(conditionKey(type)).toBe(key)
  })

  it('matches case-insensitively', () => {
    expect(conditionKey('clear')).toBe('condClear')
    expect(conditionKey('Partly_Cloudy')).toBe('condPartly')
  })

  it('falls back to cloudy for unknown or missing types', () => {
    expect(conditionKey('NOT_A_THING')).toBe('condCloudy')
    expect(conditionKey(undefined)).toBe('condCloudy')
    expect(conditionKey(null)).toBe('condCloudy')
    expect(conditionKey('')).toBe('condCloudy')
  })
})

describe('isSnowFamily', () => {
  it('is true exactly for the snow families', () => {
    expect(isSnowFamily('condSnow')).toBe(true)
    expect(isSnowFamily('condHeavySnow')).toBe(true)
    expect(isSnowFamily('condSleet')).toBe(true)
    expect(isSnowFamily('condRain')).toBe(false)
    expect(isSnowFamily('condClear')).toBe(false)
    expect(isSnowFamily('condHail')).toBe(false)
  })
})
