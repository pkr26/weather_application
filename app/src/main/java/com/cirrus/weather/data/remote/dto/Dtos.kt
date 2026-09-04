package com.cirrus.weather.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * DTOs for weather.googleapis.com (Google Maps Platform Weather API).
 * All fields are nullable: the API may omit fields per location/condition,
 * and [kotlinx.serialization.Json] is configured with ignoreUnknownKeys.
 */

@Serializable
data class CurrentConditionsResponse(
    val timeZone: TimeZoneDto? = null,
    val weatherCondition: WeatherConditionDto? = null,
    val temperature: TemperatureDto? = null,
    val feelsLikeTemperature: TemperatureDto? = null,
    val dewPoint: TemperatureDto? = null,
    val heatIndex: TemperatureDto? = null,
    val windChill: TemperatureDto? = null,
    val precipitation: PrecipitationDto? = null,
    val airPressure: AirPressureDto? = null,
    val wind: WindDto? = null,
    val visibility: VisibilityDto? = null,
    val currentConditionsHistory: CurrentConditionsHistoryDto? = null,
    val currentTime: String? = null,
    val isDaytime: Boolean = false,
    val relativeHumidity: Int? = null,
    val uvIndex: Int? = null,
    val thunderstormProbability: Int? = null,
    val cloudCover: Int? = null,
)

@Serializable
data class ForecastHoursResponse(
    val forecastHours: List<ForecastHourDto> = emptyList(),
    val timeZone: TimeZoneDto? = null,
)

@Serializable
data class HistoryHoursResponse(
    val historyHours: List<ForecastHourDto> = emptyList(),
    val timeZone: TimeZoneDto? = null,
)

@Serializable
data class ForecastDaysResponse(
    val forecastDays: List<ForecastDayDto> = emptyList(),
    val timeZone: TimeZoneDto? = null,
)

@Serializable
data class PublicAlertsResponse(
    val weatherAlerts: List<WeatherAlertDto> = emptyList(),
    val regionCode: String? = null,
)

// --------------------------------------------- Cirrus backend API envelope

/** Full weather bundle for one location in a single round-trip. */
@Serializable
data class BundleResponse(
    val currentConditions: CurrentConditionsResponse = CurrentConditionsResponse(),
    val forecastHours: ForecastHoursResponse = ForecastHoursResponse(),
    val forecastDays: ForecastDaysResponse = ForecastDaysResponse(),
    val historyHours: HistoryHoursResponse = HistoryHoursResponse(),
    val publicAlerts: PublicAlertsResponse = PublicAlertsResponse(),
)

/** One entry of the backend's notification-language catalog. */
@Serializable
data class LanguageInfo(
    val code: String,
    val nativeName: String,
    val englishName: String,
    val rtl: Boolean = false,
)

@Serializable
data class LanguagesResponse(
    val languages: List<LanguageInfo> = emptyList(),
)

/** Localized "here's what happening today" notification content. */
@Serializable
data class BriefingResponse(
    val title: String = "",
    val body: String = "",
    val condition: String = "",
    val highC: Double? = null,
    val lowC: Double? = null,
    val alertCount: Int = 0,
    val language: String = "en",
)

@Serializable
data class DeviceRegistrationRequest(
    val deviceId: String,
    val language: String,
    val city: DeviceCityRequest,
    val notificationTime: NotificationTimeRequest,
    val units: String,
    val alertsEnabled: Boolean = true,
)

@Serializable
data class DeviceRegistrationResponse(
    val deviceId: String = "",
    val updatedAt: String = "",
    /** Present only when the server issued (or rotated) a fresh secret. */
    val deviceSecret: String? = null,
)

@Serializable
data class DeviceCityRequest(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val timeZone: String? = null,
)

@Serializable
data class NotificationTimeRequest(
    val hour: Int,
    val minute: Int,
)

@Serializable
data class ForecastHourDto(
    val interval: IntervalDto? = null,
    val displayDateTime: DisplayDateTimeDto? = null,
    val weatherCondition: WeatherConditionDto? = null,
    val temperature: TemperatureDto? = null,
    val feelsLikeTemperature: TemperatureDto? = null,
    val dewPoint: TemperatureDto? = null,
    val heatIndex: TemperatureDto? = null,
    val windChill: TemperatureDto? = null,
    val wetBulbTemperature: TemperatureDto? = null,
    val precipitation: PrecipitationDto? = null,
    val airPressure: AirPressureDto? = null,
    val wind: WindDto? = null,
    val visibility: VisibilityDto? = null,
    val iceThickness: IceThicknessDto? = null,
    val isDaytime: Boolean = false,
    val relativeHumidity: Int? = null,
    val uvIndex: Int? = null,
    val thunderstormProbability: Int? = null,
    val cloudCover: Int? = null,
)

@Serializable
data class ForecastDayDto(
    val interval: IntervalDto? = null,
    val displayDate: DateDto? = null,
    val daytimeForecast: ForecastDayPartDto? = null,
    val nighttimeForecast: ForecastDayPartDto? = null,
    val maxTemperature: TemperatureDto? = null,
    val minTemperature: TemperatureDto? = null,
    val feelsLikeMaxTemperature: TemperatureDto? = null,
    val feelsLikeMinTemperature: TemperatureDto? = null,
    val maxHeatIndex: TemperatureDto? = null,
    val sunEvents: SunEventsDto? = null,
    val moonEvents: MoonEventsDto? = null,
)

@Serializable
data class ForecastDayPartDto(
    val interval: IntervalDto? = null,
    val weatherCondition: WeatherConditionDto? = null,
    val precipitation: PrecipitationDto? = null,
    val wind: WindDto? = null,
    val iceThickness: IceThicknessDto? = null,
    val relativeHumidity: Int? = null,
    val uvIndex: Int? = null,
    val thunderstormProbability: Int? = null,
    val cloudCover: Int? = null,
)

@Serializable
data class WeatherAlertDto(
    val alertType: String? = null,
    val headline: String? = null,
    val description: LocalizedTextDto? = null,
    val severity: String? = null,
    val eventStartTime: String? = null,
    val eventEndTime: String? = null,
    val utcOffset: String? = null,
)

// ---- Shared value types ----

@Serializable
data class WeatherConditionDto(
    val iconBaseUri: String? = null,
    val description: LocalizedTextDto? = null,
    val type: String? = null,
)

@Serializable
data class LocalizedTextDto(
    val text: String? = null,
    val languageCode: String? = null,
)

@Serializable
data class TemperatureDto(
    val unit: String? = null,
    val degrees: Double? = null,
)

@Serializable
data class PrecipitationDto(
    val probability: PrecipProbabilityDto? = null,
    val qpf: QpfDto? = null,
    val snowQpf: QpfDto? = null,
)

@Serializable
data class PrecipProbabilityDto(
    val type: String? = null,
    val percent: Int? = null,
)

@Serializable
data class QpfDto(
    val unit: String? = null,
    val quantity: Double? = null,
)

@Serializable
data class AirPressureDto(
    val meanSeaLevelMillibars: Double? = null,
)

@Serializable
data class WindDto(
    val direction: WindDirectionDto? = null,
    val speed: SpeedDto? = null,
    val gust: SpeedDto? = null,
)

@Serializable
data class WindDirectionDto(
    val cardinal: String? = null,
    val degrees: Int? = null,
)

@Serializable
data class SpeedDto(
    val unit: String? = null,
    val value: Double? = null,
)

@Serializable
data class VisibilityDto(
    val unit: String? = null,
    val distance: Double? = null,
)

@Serializable
data class IceThicknessDto(
    val unit: String? = null,
    val thickness: Double? = null,
)

@Serializable
data class CurrentConditionsHistoryDto(
    val temperatureChange: TemperatureDto? = null,
    val maxTemperature: TemperatureDto? = null,
    val minTemperature: TemperatureDto? = null,
    val qpf: QpfDto? = null,
    val snowQpf: QpfDto? = null,
)

@Serializable
data class IntervalDto(
    val startTime: String? = null,
    val endTime: String? = null,
)

@Serializable
data class DisplayDateTimeDto(
    val year: Int? = null,
    val month: Int? = null,
    val day: Int? = null,
    val hours: Int? = null,
    val minutes: Int? = null,
    val seconds: Int? = null,
    val nanos: Int? = null,
    val utcOffset: String? = null,
)

@Serializable
data class DateDto(
    val year: Int? = null,
    val month: Int? = null,
    val day: Int? = null,
)

@Serializable
data class SunEventsDto(
    val sunriseTime: String? = null,
    val sunsetTime: String? = null,
)

@Serializable
data class MoonEventsDto(
    val moonPhase: String? = null,
    val moonriseTimes: List<String> = emptyList(),
    val moonsetTimes: List<String> = emptyList(),
)

@Serializable
data class TimeZoneDto(
    val id: String? = null,
    val version: String? = null,
)
