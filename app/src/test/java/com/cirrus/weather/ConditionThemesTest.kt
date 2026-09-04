package com.cirrus.weather

import com.cirrus.weather.domain.ConditionThemes
import com.cirrus.weather.domain.Fx
import org.junit.Assert.assertEquals
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
}
