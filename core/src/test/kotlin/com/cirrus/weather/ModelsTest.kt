package com.cirrus.weather

import com.cirrus.weather.domain.AlertUi
import com.cirrus.weather.domain.CurrentUi
import com.cirrus.weather.domain.DayUi
import com.cirrus.weather.domain.HourUi
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.domain.WeatherBundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ModelsTest {

    private fun current() = CurrentUi(
        conditionType = "CLEAR",
        conditionText = "Clear",
        isDaytime = true,
        temperatureC = 29.0,
        feelsLikeC = 31.0,
        dewPointC = 22.0,
        humidity = 60,
        uvIndex = 7,
        windKph = 12.0,
        windGustKph = 25.0,
        windDegrees = 220,
        windCardinal = "SW",
        visibilityKm = 9.0,
        pressureMb = 1010.0,
        cloudCover = 10,
        thunderstormProbability = 0,
        precipProbability = 5,
        precipLast24hMm = 0.0,
        tempChangeC = 1.5,
        past24hMaxC = 30.0,
        past24hMinC = 21.0,
    )

    @Test
    fun `saved city falls back to Unknown for a blank name`() {
        assertEquals("Hyderabad", SavedCity(id = "1", name = "Hyderabad", latitude = 1.0, longitude = 2.0).displayName)
        assertEquals("Unknown", SavedCity(id = "1", name = "", latitude = 1.0, longitude = 2.0).displayName)
        assertEquals("Unknown", SavedCity(id = "1", name = "  ", latitude = 1.0, longitude = 2.0).displayName)
    }

    @Test
    fun `saved city defaults are device-less and UTC`() {
        val city = SavedCity(id = "1", name = "X", latitude = 1.0, longitude = 2.0)
        assertEquals("UTC", city.timeZone)
        assertFalse(city.isDeviceLocation)
        assertEquals("", city.region)
        assertEquals("", city.country)
    }

    @Test
    fun `bundle exposes its parts and equality works`() {
        val now = Instant.parse("2026-09-03T00:00:00Z")
        val a = WeatherBundle(
            timeZoneId = "Asia/Kolkata",
            current = current(),
            hours = listOf(
                HourUi(now, 28.0, "CLEAR", "Clear", true, 5, 0.0, 6, 10, 0, 1008.0),
            ),
            days = listOf(
                DayUi(20638, "RAIN", "Rain", null, "Clear", 30.0, 22.0, 31.0, 21.0,
                    Instant.parse("2026-09-03T00:00:00Z"), Instant.parse("2026-09-03T12:30:00Z"),
                    "FULL_MOON", 40, 8, 10),
            ),
            history = emptyList(),
            alerts = listOf(AlertUi("Rain alert", "Heavy rain", "MODERATE", now, now.plusSeconds(3600))),
            fetchedAt = now,
        )
        val b = a.copy()
        assertEquals(a, b)
        assertEquals(29.0, a.current.temperatureC!!, 0.0)
        assertTrue(a.alerts.first().severity == "MODERATE")
        assertEquals("FULL_MOON", a.days.first().moonPhase)
    }
}
