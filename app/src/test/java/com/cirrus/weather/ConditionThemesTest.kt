package com.cirrus.weather

import com.cirrus.weather.domain.ConditionThemes
import com.cirrus.weather.domain.Fx
import com.cirrus.weather.domain.ConditionThemes.KNOWN_CONDITIONS
import com.cirrus.weather.ui.components.WeatherIcons
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ConditionThemesTest {

    @Test
    fun `clear night gets stars`() {
        val archetype = ConditionThemes.archetypeFor("CLEAR", isDaytime = false)
        assertEquals(Fx.STARS, archetype.fx)
    }

    @Test
    fun `clear day has no particles`() {
        val archetype = ConditionThemes.archetypeFor("CLEAR", isDaytime = true)
        assertEquals(Fx.NONE, archetype.fx)
    }

    @Test
    fun `thunderstorm gets storm fx both day and night`() {
        assertEquals(
            Fx.STORM,
            ConditionThemes.archetypeFor("THUNDERSTORM", isDaytime = true).fx
        )
        assertEquals(
            Fx.STORM,
            ConditionThemes.archetypeFor("HEAVY_THUNDERSTORM", isDaytime = false).fx
        )
    }

    @Test
    fun `snow conditions map to snow fx`() {
        assertEquals(
            Fx.HEAVY_SNOW,
            ConditionThemes.archetypeFor("SNOW", isDaytime = true).fx
        )
        assertEquals(
            Fx.SNOW,
            ConditionThemes.archetypeFor("LIGHT_SNOW", isDaytime = false).fx
        )
    }

    @Test
    fun `rain severity is preserved`() {
        assertEquals(
            Fx.RAIN,
            ConditionThemes.archetypeFor("RAIN", isDaytime = true).fx
        )
        assertEquals(
            Fx.HEAVY_RAIN,
            ConditionThemes.archetypeFor("HEAVY_RAIN", isDaytime = true).fx
        )
    }

    @Test
    fun `unknown condition falls back to cloudy`() {
        val archetype = ConditionThemes.archetypeFor("SOMETHING_NEW", isDaytime = true)
        assertEquals(ConditionThemes.FALLBACK_DAY, archetype)
    }

    @Test
    fun `day and night variants differ for clear`() {
        val day = ConditionThemes.archetypeFor("CLEAR", isDaytime = true)
        val night = ConditionThemes.archetypeFor("CLEAR", isDaytime = false)
        assertEquals(day, ConditionThemes.CLEAR_DAY)
        assertEquals(night, ConditionThemes.CLEAR_NIGHT)
    }

    @Test
    fun `fog haze and mist map to the dedicated fog archetype`() {
        listOf("FOG", "HAZE", "MIST").forEach { type ->
            assertEquals(ConditionThemes.FOG_DAY, ConditionThemes.archetypeFor(type, isDaytime = true))
            assertEquals(ConditionThemes.FOG_NIGHT, ConditionThemes.archetypeFor(type, isDaytime = false))
        }
    }

    @Test
    fun `fog family is distinct from the fallback`() {
        // FOG previously fell through to the fallback (rendering as generic
        // cloudy); the dedicated archetype must actually differ from it.
        assertNotEquals(
            ConditionThemes.FALLBACK_DAY,
            ConditionThemes.archetypeFor("FOG", isDaytime = true),
        )
        assertNotEquals(
            ConditionThemes.FALLBACK_NIGHT,
            ConditionThemes.archetypeFor("MIST", isDaytime = false),
        )
    }

    @Test
    fun `fog family renders no particles`() {
        listOf("FOG", "HAZE", "MIST").forEach { type ->
            assertEquals(Fx.NONE, ConditionThemes.archetypeFor(type, isDaytime = true).fx)
            assertEquals(Fx.NONE, ConditionThemes.archetypeFor(type, isDaytime = false).fx)
        }
    }

    @Test
    fun `fog family reuses the cloudy glyph - no dedicated fog drawable exists`() {
        listOf("FOG", "HAZE", "MIST").forEach { type ->
            assertEquals(
                WeatherIcons.forCondition("CLOUDY", isDaytime = true),
                WeatherIcons.forCondition(type, isDaytime = true),
            )
        }
    }

    @Test
    fun `every backend condition string has a deliberate archetype`() {
        // Mirror of the backend's condition table
        // (backend/src/briefing/conditions.ts). A string appearing there but
        // missing here silently renders as the fallback archetype — this pin
        // forces whoever adds a backend condition to give it an app mapping.
        val backendConditions = setOf(
            "CLEAR", "MOSTLY_CLEAR", "PARTLY_CLOUDY", "MOSTLY_CLOUDY", "CLOUDY",
            "FOG", "HAZE", "MIST", "WINDY",
            "LIGHT_RAIN_SHOWERS", "CHANCE_OF_SHOWERS", "SCATTERED_SHOWERS",
            "LIGHT_RAIN", "LIGHT_TO_MODERATE_RAIN",
            "RAIN_SHOWERS", "RAIN", "MODERATE_TO_HEAVY_RAIN", "RAIN_PERIODICALLY_HEAVY",
            "WIND_AND_RAIN", "HEAVY_RAIN_SHOWERS", "HEAVY_RAIN",
            "LIGHT_SNOW_SHOWERS", "CHANCE_OF_SNOW_SHOWERS", "SCATTERED_SNOW_SHOWERS",
            "LIGHT_SNOW", "LIGHT_TO_MODERATE_SNOW",
            "SNOW_SHOWERS", "SNOW", "MODERATE_TO_HEAVY_SNOW", "SNOW_PERIODICALLY_HEAVY",
            "SNOWSTORM", "HEAVY_SNOW_SHOWERS", "HEAVY_SNOW", "HEAVY_SNOW_STORM", "BLOWING_SNOW",
            "RAIN_AND_SNOW", "HAIL", "HAIL_SHOWERS",
            "THUNDERSTORM", "THUNDERSHOWER", "LIGHT_THUNDERSTORM_RAIN",
            "SCATTERED_THUNDERSTORMS", "HEAVY_THUNDERSTORM",
        )
        assertEquals(backendConditions, KNOWN_CONDITIONS)
    }

    @Test
    fun `icon table covers exactly the conditions the theme table covers`() {
        // The archetype and glyph tables are maintained side by side; this
        // parity pin is what keeps a new condition from being themed but not
        // drawn (or vice versa) — the exact drift that hid FOG before.
        assertEquals(KNOWN_CONDITIONS, WeatherIcons.KNOWN_GLYPHS)
    }
}
