package com.cirrus.weather

import com.cirrus.weather.data.remote.dto.CurrentConditionsResponse
import com.cirrus.weather.data.remote.dto.ForecastHourDto
import com.cirrus.weather.data.remote.dto.ForecastHoursResponse
import com.cirrus.weather.data.remote.dto.IntervalDto
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import com.cirrus.weather.data.remote.dto.QpfDto
import com.cirrus.weather.data.remote.dto.SpeedDto
import com.cirrus.weather.data.remote.dto.TemperatureDto
import com.cirrus.weather.data.remote.dto.VisibilityDto
import com.cirrus.weather.data.remote.dto.WeatherAlertDto
import com.cirrus.weather.data.remote.dto.WindDto
import com.cirrus.weather.domain.toAlertUis
import com.cirrus.weather.domain.toCurrentUi
import com.cirrus.weather.domain.toHourUi
import com.cirrus.weather.domain.toHourUis
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The DTO→domain boundary: the audit's biggest untested surface. Pins the
 * unit-field normalization (the upstream's per-value `unit` field is
 * trusted only after conversion), null tolerance, the hour-drop rule for
 * unparseable timestamps, and the alert headline fallback chain.
 */
class MappersTest {

    // ------------------------------------------------ unit normalization

    @Test
    fun `fahrenheit temperatures convert to celsius`() {
        val ui = CurrentConditionsResponse(
            temperature = TemperatureDto(degrees = 212.0, unit = "FAHRENHEIT"),
        ).toCurrentUi()
        assertEquals(100.0, ui.temperatureC!!, 1e-9)
    }

    @Test
    fun `celsius passes through unchanged`() {
        val ui = CurrentConditionsResponse(
            temperature = TemperatureDto(degrees = 25.5, unit = "CELSIUS"),
        ).toCurrentUi()
        assertEquals(25.5, ui.temperatureC!!, 1e-9)
    }

    @Test
    fun `a missing or unknown unit is treated as the documented metric default`() {
        val explicit = CurrentConditionsResponse(
            temperature = TemperatureDto(degrees = 20.0, unit = null),
        ).toCurrentUi()
        assertEquals(20.0, explicit.temperatureC!!, 1e-9)
    }

    @Test
    fun `mph wind converts to kph`() {
        val ui = CurrentConditionsResponse(
            wind = WindDto(speed = SpeedDto(value = 100.0, unit = "MILES_PER_HOUR")),
        ).toCurrentUi()
        assertEquals(160.9344, ui.windKph!!, 1e-4)
    }

    @Test
    fun `meters visibility converts to kilometers`() {
        val ui = CurrentConditionsResponse(
            visibility = VisibilityDto(distance = 5000.0, unit = "METERS"),
        ).toCurrentUi()
        assertEquals(5.0, ui.visibilityKm!!, 1e-9)
    }

    @Test
    fun `miles visibility converts to kilometers`() {
        val ui = CurrentConditionsResponse(
            visibility = VisibilityDto(distance = 10.0, unit = "MILES"),
        ).toCurrentUi()
        assertEquals(16.09344, ui.visibilityKm!!, 1e-4)
    }

    @Test
    fun `inches of precipitation convert to millimeters`() {
        val ui = CurrentConditionsResponse(
            temperature = TemperatureDto(degrees = 0.0),
            relativeHumidity = 50,
        ).toCurrentUi()
        assertEquals(0.0, ui.precipLast24hMm!!, 1e-9) // null history → 0, never NaN
        // 1 inch = 25.4 mm via the QPF normalization
        val withQpf = ForecastHourDto(
            interval = IntervalDto(startTime = "2026-09-04T10:00:00Z"),
            precipitation = com.cirrus.weather.data.remote.dto.PrecipitationDto(
                qpf = QpfDto(quantity = 1.0, unit = "INCHES"),
            ),
        ).toHourUi()!!
        assertEquals(25.4, withQpf.precipMm!!, 1e-9)
    }

    @Test
    fun `null measured values map to null, never to zero`() {
        val ui = CurrentConditionsResponse().toCurrentUi()
        assertNull(ui.temperatureC)
        assertNull(ui.feelsLikeC)
        assertNull(ui.windKph)
        assertNull(ui.visibilityKm)
    }

    // ------------------------------------------------------ hour mapping

    @Test
    fun `hours without a parseable start time are dropped`() {
        val hours = ForecastHoursResponse(
            forecastHours = listOf(
                ForecastHourDto(interval = IntervalDto(startTime = "2026-09-04T10:00:00Z")),
                ForecastHourDto(interval = IntervalDto(startTime = null)),
                ForecastHourDto(interval = null),
                ForecastHourDto(interval = IntervalDto(startTime = "garbage")),
            ),
        )
        val uis = hours.toHourUis()
        assertEquals(1, uis.size)
        assertEquals(java.time.Instant.parse("2026-09-04T10:00:00Z"), uis[0].startTime)
    }

    // ----------------------------------------------------- alert mapping

    @Test
    fun `alert headline fallback chain`() {
        val alerts = PublicAlertsResponse(
            weatherAlerts = listOf(
                WeatherAlertDto(headline = "Cyclone warning", alertType = "CYCLONE"),
                WeatherAlertDto(headline = null, alertType = "THUNDERSTORM"),
                WeatherAlertDto(headline = null, alertType = null),
            ),
        ).toAlertUis()

        assertEquals("Cyclone warning", alerts[0].headline)
        // Typed event with underscores-to-spaces stands in…
        assertEquals("THUNDERSTORM", alerts[1].headline)
        // …and fully-empty alerts map to blank — the banner localizes the
        // last resort instead of hardcoding English in the mapper.
        assertEquals("", alerts[2].headline)
    }

    @Test
    fun `condition text falls back to the typed condition, humanized`() {
        val ui = CurrentConditionsResponse(
            weatherCondition = com.cirrus.weather.data.remote.dto.WeatherConditionDto(
                type = "PARTLY_CLOUDY",
            ),
        ).toCurrentUi()
        assertEquals("Partly cloudy", ui.conditionText)
        assertTrue(ui.conditionText.isNotBlank())
    }
}
