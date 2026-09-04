package com.cirrus.weather

import com.cirrus.weather.notify.BriefingSchedule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

/**
 * The daily briefing chain relies on this delay computation landing exactly
 * on the next occurrence of the user's chosen time.
 */
class BriefingScheduleTest {

    private fun delayFrom(now: LocalDateTime, hour: Int, minute: Int): Long =
        BriefingSchedule.computeDelayMillis(now, hour, minute)

    @Test
    fun `later today when target is ahead`() {
        val now = LocalDateTime.of(2026, 9, 3, 6, 30)
        assertEquals(90 * 60 * 1000L, delayFrom(now, 8, 0))
    }

    @Test
    fun `tomorrow when target already passed`() {
        val now = LocalDateTime.of(2026, 9, 3, 9, 0)
        assertEquals(23L * 60 * 60 * 1000, delayFrom(now, 8, 0))
    }

    @Test
    fun `tomorrow delay is 23 hours after firing at target`() {
        val now = LocalDateTime.of(2026, 9, 3, 8, 0)
        assertEquals(23L * 60 * 60 * 1000, delayFrom(now, 7, 0))
    }

    @Test
    fun `exactly at target schedules a full day ahead`() {
        val now = LocalDateTime.of(2026, 9, 3, 8, 0)
        assertEquals(24L * 60 * 60 * 1000, delayFrom(now, 8, 0))
    }

    @Test
    fun `delay is never negative`() {
        val now = LocalDateTime.of(2026, 12, 31, 23, 59)
        assertTrue(delayFrom(now, 0, 0) > 0)
    }

    @Test
    fun `out of range hour and minute are clamped`() {
        val now = LocalDateTime.of(2026, 9, 3, 0, 0)
        assertEquals((23L * 60 + 59) * 60 * 1000, delayFrom(now, 25, 130))
    }

    @Test
    fun `spring-forward DST keeps the wall-clock target`() {
        // Europe/Berlin jumps 02:00 -> 03:00 on 2026-03-29. Scheduling at
        // 07:00 the day before must land on 07:00 local (a zoned computation),
        // not 07:00 by naive elapsed-time arithmetic.
        val zone = java.time.ZoneId.of("Europe/Berlin")
        val now = LocalDateTime.of(2026, 3, 28, 7, 0)
        val delay = BriefingSchedule.computeDelayMillis(now, 7, 0, zone)
        val arrival = now.atZone(zone).toInstant().plusMillis(delay)
        val localArrival = arrival.atZone(zone).toLocalDateTime()
        assertEquals(LocalDateTime.of(2026, 3, 29, 7, 0), localArrival)
    }

    @Test
    fun `fall-back DST keeps the wall-clock target`() {
        // Berlin falls back 03:00 -> 02:00 on 2026-10-25: that day is 25 h
        // long, and the delay must account for the extra hour.
        val zone = java.time.ZoneId.of("Europe/Berlin")
        val now = LocalDateTime.of(2026, 10, 24, 7, 0)
        val delay = BriefingSchedule.computeDelayMillis(now, 7, 0, zone)
        val arrival = now.atZone(zone).toInstant().plusMillis(delay)
        assertEquals(LocalDateTime.of(2026, 10, 25, 7, 0), arrival.atZone(zone).toLocalDateTime())
        assertEquals(25L * 60 * 60 * 1000, delay)
    }
}
