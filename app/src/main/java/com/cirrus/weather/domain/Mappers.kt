package com.cirrus.weather.domain

import com.cirrus.weather.data.remote.dto.CurrentConditionsResponse
import com.cirrus.weather.data.remote.dto.ForecastDayDto
import com.cirrus.weather.data.remote.dto.ForecastDaysResponse
import com.cirrus.weather.data.remote.dto.ForecastHourDto
import com.cirrus.weather.data.remote.dto.ForecastHoursResponse
import com.cirrus.weather.data.remote.dto.HistoryHoursResponse
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import com.cirrus.weather.data.remote.dto.QpfDto
import com.cirrus.weather.data.remote.dto.SpeedDto
import com.cirrus.weather.data.remote.dto.TemperatureDto
import com.cirrus.weather.data.remote.dto.VisibilityDto
import com.cirrus.weather.util.TimeFormats

/**
 * Unit normalization: the backend asks upstream for METRIC, but the DTOs
 * carry a `unit` field on every measured value — trust the numbers only
 * after converting by that unit, so a future upstream default change can
 * never silently skew every displayed value.
 */
private const val MPH_PER_KPH = 1.609344

private fun TemperatureDto?.normalized(): Double? {
    val d = this?.degrees ?: return null
    return when (unit?.uppercase()) {
        "FAHRENHEIT" -> (d - 32) * 5 / 9
        else -> d // CELSIUS is the documented default; treat unknown/null as-is
    }
}

private fun SpeedDto?.normalizedKph(): Double? {
    val v = this?.value ?: return null
    return when (unit?.uppercase()) {
        "MILES_PER_HOUR", "MPH" -> v * MPH_PER_KPH
        else -> v // KILOMETERS_PER_HOUR is the documented default
    }
}

private fun VisibilityDto?.normalizedKm(): Double? {
    val v = this?.distance ?: return null
    return when (unit?.uppercase()) {
        "METERS" -> v / 1000
        "MILES" -> v * MPH_PER_KPH
        else -> v // KILOMETERS is the documented default
    }
}

private fun QpfDto?.normalizedMm(): Double? {
    val v = this?.quantity ?: return null
    return when (unit?.uppercase()) {
        "INCHES", "INCH" -> v * 25.4
        else -> v // MILLIMETERS is the documented default
    }
}

fun CurrentConditionsResponse.toCurrentUi(): CurrentUi = CurrentUi(
    conditionType = weatherCondition?.type,
    conditionText = weatherCondition?.description?.text
        ?: weatherCondition?.type?.replace('_', ' ')?.lowercase()?.replaceFirstChar { it.uppercase() }
        ?: "—",
    isDaytime = isDaytime,
    temperatureC = temperature.normalized(),
    feelsLikeC = (feelsLikeTemperature ?: heatIndex ?: windChill).normalized(),
    dewPointC = dewPoint.normalized(),
    humidity = relativeHumidity,
    uvIndex = uvIndex,
    windKph = wind?.speed.normalizedKph(),
    windGustKph = wind?.gust.normalizedKph(),
    windDegrees = wind?.direction?.degrees,
    windCardinal = wind?.direction?.cardinal?.replace('_', ' ')?.lowercase()
        ?.replaceFirstChar { it.uppercase() },
    visibilityKm = visibility.normalizedKm(),
    pressureMb = airPressure?.meanSeaLevelMillibars,
    cloudCover = cloudCover,
    thunderstormProbability = thunderstormProbability,
    precipProbability = precipitation?.probability?.percent,
    precipLast24hMm = (currentConditionsHistory?.qpf.normalizedMm() ?: 0.0) +
        (currentConditionsHistory?.snowQpf.normalizedMm() ?: 0.0),
    tempChangeC = currentConditionsHistory?.temperatureChange.normalized(),
    past24hMaxC = currentConditionsHistory?.maxTemperature.normalized(),
    past24hMinC = currentConditionsHistory?.minTemperature.normalized(),
)

/**
 * Null when the hour carries no parseable start time — an hour without a
 * timestamp would render as "5 AM 1970" and is dropped by the list mappers.
 */
fun ForecastHourDto.toHourUi(): HourUi? {
    val start = TimeFormats.parseUtc(interval?.startTime) ?: return null
    return HourUi(
        startTime = start,
        temperatureC = temperature.normalized(),
        conditionType = weatherCondition?.type,
        conditionText = weatherCondition?.description?.text ?: "",
        isDaytime = isDaytime,
        precipProbability = precipitation?.probability?.percent,
        precipMm = (precipitation?.qpf.normalizedMm() ?: 0.0) +
            (precipitation?.snowQpf.normalizedMm() ?: 0.0),
        uvIndex = uvIndex,
        cloudCover = cloudCover,
        thunderstormProbability = thunderstormProbability,
        pressureMb = airPressure?.meanSeaLevelMillibars,
    )
}

fun ForecastHoursResponse.toHourUis(): List<HourUi> =
    forecastHours.mapNotNull { it.toHourUi() }

fun HistoryHoursResponse.toHourUis(): List<HourUi> =
    historyHours.mapNotNull { it.toHourUi() }

fun ForecastDayDto.toDayUi(): DayUi = DayUi(
    dateEpochDay = TimeFormats.toEpochDay(displayDate?.year, displayDate?.month, displayDate?.day),
    daytimeConditionType = daytimeForecast?.weatherCondition?.type,
    daytimeConditionText = daytimeForecast?.weatherCondition?.description?.text ?: "",
    nighttimeConditionType = nighttimeForecast?.weatherCondition?.type,
    nighttimeConditionText = nighttimeForecast?.weatherCondition?.description?.text ?: "",
    maxTempC = maxTemperature.normalized(),
    minTempC = minTemperature.normalized(),
    feelsLikeMaxC = feelsLikeMaxTemperature.normalized(),
    feelsLikeMinC = feelsLikeMinTemperature.normalized(),
    sunrise = TimeFormats.parseUtc(sunEvents?.sunriseTime),
    sunset = TimeFormats.parseUtc(sunEvents?.sunsetTime),
    moonPhase = moonEvents?.moonPhase,
    precipProbability = (daytimeForecast?.precipitation?.probability?.percent ?: 0)
        .coerceAtLeast(nighttimeForecast?.precipitation?.probability?.percent ?: 0),
    uvIndex = daytimeForecast?.uvIndex,
    thunderstormProbability = (daytimeForecast?.thunderstormProbability ?: 0)
        .coerceAtLeast(nighttimeForecast?.thunderstormProbability ?: 0),
)

fun ForecastDaysResponse.toDayUis(): List<DayUi> =
    forecastDays.map { it.toDayUi() }

fun PublicAlertsResponse.toAlertUis(): List<AlertUi> =
    weatherAlerts.map { alert ->
        AlertUi(
            headline = alert.headline ?: alert.alertType?.replace('_', ' ') ?: "Weather Alert",
            description = alert.description?.text ?: "",
            severity = alert.severity ?: "",
            startsAt = TimeFormats.parseUtc(alert.eventStartTime),
            endsAt = TimeFormats.parseUtc(alert.eventEndTime),
        )
    }
