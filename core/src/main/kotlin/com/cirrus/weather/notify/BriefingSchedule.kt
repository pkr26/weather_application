package com.cirrus.weather.notify

import java.time.Duration
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Pure scheduling math for the daily briefing — kept free of Android types
 * so it lives in the mutation-tested core module.
 */
object BriefingSchedule {

    /**
     * Milliseconds from [now] until the next occurrence of hour:minute.
     * At/before the target today, schedules tomorrow.
     *
     * The delay is computed on zoned date-times: on DST-transition days the
     * elapsed-milliseconds answer differs from the wall-clock answer by the
     * offset change, and the user asked for a wall-clock time — a plain
     * LocalDateTime subtraction would fire the briefing an hour early/late
     * once a year.
     */
    fun computeDelayMillis(
        now: LocalDateTime,
        hour: Int,
        minute: Int,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Long {
        val zonedNow = now.atZone(zone)
        val today = zonedNow.toLocalDate()
            .atTime(hour.coerceIn(0, 23), minute.coerceIn(0, 59))
            .atZone(zone)
        val next = if (zonedNow.isBefore(today)) today else today.plusDays(1)
        return Duration.between(zonedNow, next).toMillis().coerceAtLeast(0)
    }
}
