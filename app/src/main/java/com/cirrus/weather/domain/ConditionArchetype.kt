package com.cirrus.weather.domain

import androidx.compose.ui.graphics.Color

/**
 * Ambient particle effect driven by the current weather archetype.
 */
enum class Fx { NONE, RAIN, HEAVY_RAIN, SNOW, HEAVY_SNOW, STARS, STORM }

/**
 * A visual archetype: a 3-stop vertical gradient plus a particle effect.
 * Every API condition type maps to exactly one archetype, adjusted for day/night.
 */
data class Archetype(
    val name: String,
    val top: Color,
    val middle: Color,
    val bottom: Color,
    val fx: Fx,
)

/**
 * Maps the ~43 WeatherCondition type strings returned by the Google Weather API
 * onto visual archetypes with day/night variants.
 */
object ConditionThemes {

    private fun day(top: Long, mid: Long, bot: Long, fx: Fx = Fx.NONE) =
        Archetype("day", Color(top), Color(mid), Color(bot), fx)

    private fun night(top: Long, mid: Long, bot: Long, fx: Fx = Fx.NONE) =
        Archetype("night", Color(top), Color(mid), Color(bot), fx)

    val CLEAR_DAY = day(0xFF2A6FC9, 0xFF4E97DE, 0xFF8FC3EF)
    val CLEAR_NIGHT = night(0xFF070C24, 0xFF101736, 0xFF1E2750, Fx.STARS)

    val PARTLY_DAY = day(0xFF3B77C2, 0xFF6FA3DC, 0xFFA9CBE9)
    val PARTLY_NIGHT = night(0xFF0C122E, 0xFF192145, 0xFF2A3563, Fx.STARS)

    val CLOUDY_DAY = day(0xFF5A6B7E, 0xFF75889B, 0xFF96A7B5)
    val CLOUDY_NIGHT = night(0xFF12161F, 0xFF1D2330, 0xFF2A3242)

    val WINDY_DAY = day(0xFF41708A, 0xFF5E8BA3, 0xFF87A9BC)
    val WINDY_NIGHT = night(0xFF101B25, 0xFF1B2936, 0xFF2A3B4A)

    val LIGHT_RAIN_DAY = day(0xFF4A5D74, 0xFF5F748C, 0xFF7E93A8, Fx.RAIN)
    val LIGHT_RAIN_NIGHT = night(0xFF131B2A, 0xFF1C2638, 0xFF2A3648, Fx.RAIN)

    val RAIN_DAY = day(0xFF39485C, 0xFF4C5F76, 0xFF67798E, Fx.RAIN)
    val RAIN_NIGHT = night(0xFF0F1624, 0xFF172031, 0xFF232E42, Fx.RAIN)

    val HEAVY_RAIN_DAY = day(0xFF25324A, 0xFF364460, 0xFF4C5C78, Fx.HEAVY_RAIN)
    val HEAVY_RAIN_NIGHT = night(0xFF0A101F, 0xFF121A2E, 0xFF1C2740, Fx.HEAVY_RAIN)

    val LIGHT_SNOW_DAY = day(0xFF6B7B8C, 0xFF8595A5, 0xFFA5B3BF, Fx.SNOW)
    val LIGHT_SNOW_NIGHT = night(0xFF1A2130, 0xFF26303F, 0xFF364253, Fx.SNOW)

    val SNOW_DAY = day(0xFF54647A, 0xFF6C7D92, 0xFF8B9BAC, Fx.HEAVY_SNOW)
    val SNOW_NIGHT = night(0xFF141C2C, 0xFF202B3D, 0xFF303E52, Fx.HEAVY_SNOW)

    val SLEET_DAY = day(0xFF4D5E72, 0xFF64788C, 0xFF8497A9, Fx.RAIN)
    val SLEET_NIGHT = night(0xFF121926, 0xFF1B2534, 0xFF293547, Fx.RAIN)

    val HAIL_DAY = day(0xFF333F55, 0xFF465471, 0xFF5E6C8A, Fx.HEAVY_RAIN)
    val HAIL_NIGHT = night(0xFF0D1322, 0xFF151D30, 0xFF202A42, Fx.HEAVY_RAIN)

    val THUNDER_DAY = day(0xFF1A1F3A, 0xFF272E52, 0xFF3A4270, Fx.STORM)
    val THUNDER_NIGHT = night(0xFF080B1D, 0xFF101430, 0xFF1B2245, Fx.STORM)

    // Fog family (FOG/HAZE/MIST): near-flat neutral greys with deliberately
    // low contrast between stops, and NO particles — fog reads as murk, not
    // as weather in motion. Muted relative to CLOUDY so it never reads as
    // rain-adjacent.
    val FOG_DAY = day(0xFF79838C, 0xFF8A939B, 0xFF9CA4AB)
    val FOG_NIGHT = night(0xFF1C2026, 0xFF242930, 0xFF2D333B)

    val FALLBACK_DAY = CLOUDY_DAY
    val FALLBACK_NIGHT = CLOUDY_NIGHT

    // The condition table lives in a Map (not a `when`) so its key set is
    // introspectable: KNOWN_CONDITIONS is the coverage contract that the icon
    // table is pinned against in ConditionThemesTest — the two tables drifted
    // before (FOG/HAZE/MIST arrived backend-side with no app branch).
    private val CONDITION_ARCHETYPES: Map<String, Pair<Archetype, Archetype>> = buildMap {
        fun archetypes(vararg types: String, day: Archetype, night: Archetype) {
            types.forEach { put(it, day to night) }
        }
        archetypes("CLEAR", "MOSTLY_CLEAR", day = CLEAR_DAY, night = CLEAR_NIGHT)
        archetypes("PARTLY_CLOUDY", day = PARTLY_DAY, night = PARTLY_NIGHT)
        archetypes("MOSTLY_CLOUDY", "CLOUDY", day = CLOUDY_DAY, night = CLOUDY_NIGHT)
        archetypes("FOG", "HAZE", "MIST", day = FOG_DAY, night = FOG_NIGHT)
        archetypes("WINDY", day = WINDY_DAY, night = WINDY_NIGHT)
        archetypes("WIND_AND_RAIN", day = RAIN_DAY, night = RAIN_NIGHT)
        archetypes(
            "LIGHT_RAIN_SHOWERS", "CHANCE_OF_SHOWERS", "SCATTERED_SHOWERS",
            "LIGHT_RAIN", "LIGHT_TO_MODERATE_RAIN",
            day = LIGHT_RAIN_DAY, night = LIGHT_RAIN_NIGHT,
        )
        archetypes(
            "RAIN_SHOWERS", "RAIN", "MODERATE_TO_HEAVY_RAIN", "RAIN_PERIODICALLY_HEAVY",
            day = RAIN_DAY, night = RAIN_NIGHT,
        )
        archetypes("HEAVY_RAIN_SHOWERS", "HEAVY_RAIN", day = HEAVY_RAIN_DAY, night = HEAVY_RAIN_NIGHT)
        archetypes(
            "LIGHT_SNOW_SHOWERS", "CHANCE_OF_SNOW_SHOWERS", "SCATTERED_SNOW_SHOWERS",
            "LIGHT_SNOW", "LIGHT_TO_MODERATE_SNOW",
            day = LIGHT_SNOW_DAY, night = LIGHT_SNOW_NIGHT,
        )
        archetypes(
            "SNOW_SHOWERS", "SNOW", "MODERATE_TO_HEAVY_SNOW", "SNOW_PERIODICALLY_HEAVY",
            "SNOWSTORM", "HEAVY_SNOW_SHOWERS", "HEAVY_SNOW", "HEAVY_SNOW_STORM", "BLOWING_SNOW",
            day = SNOW_DAY, night = SNOW_NIGHT,
        )
        archetypes("RAIN_AND_SNOW", day = SLEET_DAY, night = SLEET_NIGHT)
        archetypes("HAIL", "HAIL_SHOWERS", day = HAIL_DAY, night = HAIL_NIGHT)
        archetypes(
            "THUNDERSTORM", "THUNDERSHOWER", "LIGHT_THUNDERSTORM_RAIN",
            "SCATTERED_THUNDERSTORMS", "HEAVY_THUNDERSTORM",
            day = THUNDER_DAY, night = THUNDER_NIGHT,
        )
    }

    /**
     * Every condition string with an explicit archetype branch. Mirrors the
     * backend's condition table (backend/src/briefing/conditions.ts); a
     * string the backend can send that is missing here silently renders as
     * the fallback — ConditionThemesTest pins the two against each other.
     */
    val KNOWN_CONDITIONS: Set<String> = CONDITION_ARCHETYPES.keys

    fun archetypeFor(conditionType: String?, isDaytime: Boolean): Archetype {
        val (dayA, nightA) = CONDITION_ARCHETYPES[conditionType?.uppercase()]
            ?: (FALLBACK_DAY to FALLBACK_NIGHT)
        return if (isDaytime) dayA else nightA
    }
}
