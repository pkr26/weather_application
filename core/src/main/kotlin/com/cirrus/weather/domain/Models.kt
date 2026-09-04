package com.cirrus.weather.domain

import kotlinx.serialization.Serializable
import java.time.Instant

/** A persisted user location. */
@Serializable
data class SavedCity(
    val id: String,
    val name: String,
    val region: String = "",
    val country: String = "",
    val latitude: Double,
    val longitude: Double,
    val timeZone: String = "UTC",
    val isDeviceLocation: Boolean = false,
) {
    val displayName: String
        get() = name.ifBlank { "Unknown" }
}

/** Aggregated weather for one location, ready for the UI. */
data class WeatherBundle(
    val timeZoneId: String,
    val current: CurrentUi,
    val hours: List<HourUi>,
    val days: List<DayUi>,
    val history: List<HourUi>,
    val alerts: List<AlertUi>,
    val fetchedAt: Instant = Instant.now(),
)

data class CurrentUi(
    val conditionType: String?,
    val conditionText: String,
    val isDaytime: Boolean,
    val temperatureC: Double?,
    val feelsLikeC: Double?,
    val dewPointC: Double?,
    val humidity: Int?,
    val uvIndex: Int?,
    val windKph: Double?,
    val windGustKph: Double?,
    val windDegrees: Int?,
    val windCardinal: String?,
    val visibilityKm: Double?,
    val pressureMb: Double?,
    val cloudCover: Int?,
    val thunderstormProbability: Int?,
    val precipProbability: Int?,
    val precipLast24hMm: Double?,
    val tempChangeC: Double?,
    val past24hMaxC: Double?,
    val past24hMinC: Double?,
)

data class HourUi(
    val startTime: Instant,
    val temperatureC: Double?,
    val conditionType: String?,
    val conditionText: String,
    val isDaytime: Boolean,
    val precipProbability: Int?,
    val precipMm: Double?,
    val uvIndex: Int?,
    val cloudCover: Int?,
    val thunderstormProbability: Int?,
    val pressureMb: Double?,
)

data class DayUi(
    val dateEpochDay: Long,
    val daytimeConditionType: String?,
    val daytimeConditionText: String,
    val nighttimeConditionType: String?,
    val nighttimeConditionText: String,
    val maxTempC: Double?,
    val minTempC: Double?,
    val feelsLikeMaxC: Double?,
    val feelsLikeMinC: Double?,
    val sunrise: Instant?,
    val sunset: Instant?,
    val moonPhase: String?,
    val precipProbability: Int?,
    val uvIndex: Int?,
    val thunderstormProbability: Int?,
)

data class AlertUi(
    val headline: String,
    val description: String,
    val severity: String,
    val startsAt: Instant?,
    val endsAt: Instant?,
)
