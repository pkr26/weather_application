package com.cirrus.weather.ui.components

import com.cirrus.weather.R

/**
 * Maps an API condition type (+ day/night) onto one of our hand-drawn glyphs.
 *
 * The condition table lives in a Map (not a `when`) so its key set is
 * introspectable: [KNOWN_GLYPHS] is pinned against ConditionThemes'
 * KNOWN_CONDITIONS in ConditionThemesTest, so a condition added to one table
 * without the other fails the build instead of drifting silently (that is
 * exactly how FOG/HAZE/MIST ended up rendering as "partly cloudy" once).
 */
object WeatherIcons {

    /** Glyph families drawable today; conditions map onto these. */
    private enum class Glyph {
        CLEAR, PARTLY, CLOUDY, WIND,
        RAIN_LIGHT, RAIN, RAIN_HEAVY,
        SNOW_LIGHT, SNOW, SLEET, HAIL, THUNDER,
    }

    private val CONDITION_GLYPHS: Map<String, Glyph> = buildMap {
        fun glyph(vararg types: String, g: Glyph) {
            types.forEach { put(it, g) }
        }
        glyph("CLEAR", "MOSTLY_CLEAR", g = Glyph.CLEAR)
        glyph("PARTLY_CLOUDY", "MOSTLY_CLOUDY", g = Glyph.PARTLY)
        // No dedicated fog drawable exists; the fog family deliberately
        // reuses the cloudy glyph — the closest visual that implies no
        // precipitation and no sun, matching the muted fog archetype.
        glyph("CLOUDY", "FOG", "HAZE", "MIST", g = Glyph.CLOUDY)
        glyph("WINDY", g = Glyph.WIND)
        glyph("WIND_AND_RAIN", g = Glyph.RAIN)
        glyph(
            "LIGHT_RAIN_SHOWERS", "CHANCE_OF_SHOWERS", "SCATTERED_SHOWERS",
            "LIGHT_RAIN", "LIGHT_TO_MODERATE_RAIN", g = Glyph.RAIN_LIGHT,
        )
        glyph(
            "RAIN_SHOWERS", "RAIN", "MODERATE_TO_HEAVY_RAIN", "RAIN_PERIODICALLY_HEAVY",
            g = Glyph.RAIN,
        )
        glyph("HEAVY_RAIN_SHOWERS", "HEAVY_RAIN", g = Glyph.RAIN_HEAVY)
        glyph(
            "LIGHT_SNOW_SHOWERS", "CHANCE_OF_SNOW_SHOWERS", "SCATTERED_SNOW_SHOWERS",
            "LIGHT_SNOW", "LIGHT_TO_MODERATE_SNOW", g = Glyph.SNOW_LIGHT,
        )
        glyph(
            "SNOW_SHOWERS", "SNOW", "MODERATE_TO_HEAVY_SNOW", "SNOW_PERIODICALLY_HEAVY",
            "HEAVY_SNOW_SHOWERS", "HEAVY_SNOW", "HEAVY_SNOW_STORM", "SNOWSTORM", "BLOWING_SNOW",
            g = Glyph.SNOW,
        )
        glyph("RAIN_AND_SNOW", g = Glyph.SLEET)
        glyph("HAIL", "HAIL_SHOWERS", g = Glyph.HAIL)
        glyph(
            "THUNDERSTORM", "THUNDERSHOWER", "LIGHT_THUNDERSTORM_RAIN",
            "SCATTERED_THUNDERSTORMS", "HEAVY_THUNDERSTORM", g = Glyph.THUNDER,
        )
    }

    /** Every condition string with an explicit glyph branch — the parity
     *  contract with ConditionThemes.KNOWN_CONDITIONS (see test). */
    internal val KNOWN_GLYPHS: Set<String> = CONDITION_GLYPHS.keys

    fun forCondition(conditionType: String?, isDaytime: Boolean): Int {
        val day = isDaytime
        return when (CONDITION_GLYPHS[conditionType?.uppercase()]) {
            Glyph.CLEAR -> if (day) R.drawable.ic_w_clear_day else R.drawable.ic_w_clear_night
            Glyph.PARTLY -> if (day) R.drawable.ic_w_partly_day else R.drawable.ic_w_partly_night
            Glyph.CLOUDY -> R.drawable.ic_w_cloudy
            Glyph.WIND -> R.drawable.ic_w_wind
            Glyph.RAIN_LIGHT -> R.drawable.ic_w_rain_light
            Glyph.RAIN -> R.drawable.ic_w_rain
            Glyph.RAIN_HEAVY -> R.drawable.ic_w_rain_heavy
            Glyph.SNOW_LIGHT -> R.drawable.ic_w_snow_light
            Glyph.SNOW -> R.drawable.ic_w_snow
            Glyph.SLEET -> R.drawable.ic_w_sleet
            Glyph.HAIL -> R.drawable.ic_w_hail
            Glyph.THUNDER -> R.drawable.ic_w_thunder
            null -> if (day) R.drawable.ic_w_partly_day else R.drawable.ic_w_partly_night
        }
    }
}
