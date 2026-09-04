package com.cirrus.weather.util

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

object TimeFormats {

    private val hourAmPm: DateTimeFormatter =
        DateTimeFormatter.ofPattern("h a", Locale.ENGLISH)
    private val hourMinute: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)
    private val hourMinuteAmPm: DateTimeFormatter =
        DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    private val dayOfWeek: DateTimeFormatter =
        DateTimeFormatter.ofPattern("EEE", Locale.ENGLISH)
    private val dayMonth: DateTimeFormatter =
        DateTimeFormatter.ofPattern("MMM d", Locale.ENGLISH)

    /** Parses RFC 3339 UTC timestamps like 2026-09-03T17:30:00Z (with or without nanos). */
    fun parseUtc(raw: String?): Instant? = try {
        raw?.let { Instant.parse(raw) }
    } catch (_: DateTimeParseException) {
        null
    }

    /** Invalid/unparseable zone ids fall back to UTC — callers pass a
     *  non-null id (bundles and saved cities default theirs to "UTC"). */
    fun zoneOf(zoneId: String): ZoneId =
        runCatching { ZoneId.of(zoneId) }.getOrDefault(ZoneId.of("UTC"))

    fun hourAmPm(instant: Instant, zone: ZoneId): String =
        hourAmPm.format(instant.atZone(zone))

    fun hourMinute(instant: Instant, zone: ZoneId): String =
        hourMinute.format(instant.atZone(zone))

    /**
     * Hour-of-day label for forecast strips, following the user's clock
     * preference: "6 PM" on 12-hour devices, "18:00" on 24-hour ones.
     */
    fun hourLabel(instant: Instant, zone: ZoneId, clock24: Boolean): String =
        (if (clock24) hourMinute else hourAmPm).format(instant.atZone(zone))

    /** Wall-clock time following the user's 12/24-hour preference. */
    fun hourMinute(instant: Instant, zone: ZoneId, clock24: Boolean): String =
        (if (clock24) hourMinute else hourMinuteAmPm).format(instant.atZone(zone))

    fun dayOfWeek(instant: Instant, zone: ZoneId): String =
        dayOfWeek.format(instant.atZone(zone))

    fun dayMonth(instant: Instant, zone: ZoneId): String =
        dayMonth.format(instant.atZone(zone))

    fun localDate(instant: Instant, zone: ZoneId): LocalDate =
        instant.atZone(zone).toLocalDate()

    fun toEpochDay(year: Int?, month: Int?, day: Int?): Long =
        runCatching { LocalDate.of(year ?: 1970, month ?: 1, day ?: 1).toEpochDay() }
            .getOrDefault(0L)
}
