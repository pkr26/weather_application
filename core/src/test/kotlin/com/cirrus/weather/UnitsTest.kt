package com.cirrus.weather

import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.Units
import org.junit.Assert.assertEquals
import org.junit.Test

class UnitsTest {

    @Test
    fun `celsius to fahrenheit`() {
        assertEquals(32.0, Units.celsiusToFahrenheit(0.0), 0.01)
        assertEquals(212.0, Units.celsiusToFahrenheit(100.0), 0.01)
        assertEquals(98.6, Units.celsiusToFahrenheit(37.0), 0.01)
    }

    @Test
    fun `temperature display in metric`() {
        assertEquals("25°", Units.tempDisplay(24.7, UnitPref.METRIC))
        assertEquals("-3°", Units.tempDisplay(-3.2, UnitPref.METRIC))
    }

    @Test
    fun `temperature display in imperial`() {
        assertEquals("77°", Units.tempDisplay(25.0, UnitPref.IMPERIAL))
        assertEquals("32°", Units.tempDisplay(0.0, UnitPref.IMPERIAL))
    }

    @Test
    fun `wind conversions`() {
        assertEquals("10 km/h", Units.windDisplay(10.4, UnitPref.METRIC))
        assertEquals("6 mph", Units.windDisplay(10.0, UnitPref.IMPERIAL))
    }

    @Test
    fun `null values render placeholder`() {
        assertEquals("--", Units.tempDisplay(null, UnitPref.METRIC))
        assertEquals("--", Units.windDisplay(null, UnitPref.IMPERIAL))
    }

    @Test
    fun `unit pref round trip from key`() {
        assertEquals(UnitPref.IMPERIAL, UnitPref.fromKey("imperial"))
        assertEquals(UnitPref.METRIC, UnitPref.fromKey("metric"))
        assertEquals(UnitPref.METRIC, UnitPref.fromKey(null))
        assertEquals(UnitPref.METRIC, UnitPref.fromKey("garbage"))
        assertEquals("metric", UnitPref.METRIC.key)
        assertEquals("imperial", UnitPref.IMPERIAL.key)
    }

    @Test
    fun `raw conversion factors are exact`() {
        assertEquals(0.621371, Units.kmhToMph(1.0), 0.0001)
        assertEquals(6.21371, Units.kmToMiles(10.0), 0.0001)
        assertEquals(1.0, Units.mmToInches(25.4), 0.0001)
        assertEquals(1.0, Units.mbToInHg(33.8639), 0.0001)
        assertEquals(-40.0, Units.celsiusToFahrenheit(-40.0), 0.01)
    }

    @Test
    fun `number variants omit units`() {
        assertEquals("25", Units.tempNumber(24.7, UnitPref.METRIC))
        assertEquals("77", Units.tempNumber(25.0, UnitPref.IMPERIAL))
        assertEquals("6", Units.windNumber(10.0, UnitPref.IMPERIAL))
        assertEquals("10", Units.windNumber(10.4, UnitPref.METRIC)) // metric passes through unconverted
        assertEquals("--", Units.tempNumber(null, UnitPref.METRIC))
        assertEquals("--", Units.windNumber(null, UnitPref.IMPERIAL))
        assertEquals("km/h", Units.windUnit(UnitPref.METRIC))
        assertEquals("mph", Units.windUnit(UnitPref.IMPERIAL))
    }

    @Test
    fun `visibility keeps one decimal below ten`() {
        assertEquals("9.5 km", Units.visibilityDisplay(9.46, UnitPref.METRIC))
        assertEquals("9.9 km", Units.visibilityDisplay(9.9, UnitPref.METRIC)) // boundary: one decimal below 10
        assertEquals("10 km", Units.visibilityDisplay(10.0, UnitPref.METRIC)) // boundary: integer at exactly 10
        assertEquals("10 km", Units.visibilityDisplay(10.2, UnitPref.METRIC))
        assertEquals("9.3 mi", Units.visibilityDisplay(15.0, UnitPref.IMPERIAL)) // 15 km = 9.32 mi
        assertEquals("--", Units.visibilityDisplay(null, UnitPref.METRIC))
    }

    @Test
    fun `precipitation switches formatting by unit and magnitude`() {
        assertEquals("0.5 mm", Units.precipDisplay(0.46, UnitPref.METRIC))
        assertEquals("9.9 mm", Units.precipDisplay(9.9, UnitPref.METRIC)) // boundary: one decimal below 10
        assertEquals("10 mm", Units.precipDisplay(10.0, UnitPref.METRIC)) // boundary: integer at exactly 10
        assertEquals("12 mm", Units.precipDisplay(12.3, UnitPref.METRIC))
        assertEquals("\"0.50", Units.precipDisplay(12.7, UnitPref.IMPERIAL)) // 12.7mm = 0.5in
        assertEquals("--", Units.precipDisplay(null, UnitPref.METRIC))
    }

    @Test
    fun `pressure renders per preference`() {
        assertEquals("1013 mb", Units.pressureDisplay(1013.2, UnitPref.METRIC))
        assertEquals("29.92 inHg", Units.pressureDisplay(1013.2, UnitPref.IMPERIAL))
        assertEquals("--", Units.pressureDisplay(null, UnitPref.IMPERIAL))
    }

    @Test
    fun `decimal formatting ignores the device locale`() {
        val original = java.util.Locale.getDefault()
        try {
            // German writes 9,5 — the app must still show 9.5 km.
            java.util.Locale.setDefault(java.util.Locale.GERMANY)
            assertEquals("9.5 km", Units.visibilityDisplay(9.46, UnitPref.METRIC))
            assertEquals("0.5 mm", Units.precipDisplay(0.46, UnitPref.METRIC))
            assertEquals("29.92 inHg", Units.pressureDisplay(1013.2, UnitPref.IMPERIAL))
        } finally {
            java.util.Locale.setDefault(original)
        }
    }
}
