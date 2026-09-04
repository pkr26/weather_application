package com.cirrus.weather

import com.cirrus.weather.util.TimeFormats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class TimeFormatsTest {

    private val kolkata = ZoneId.of("Asia/Kolkata")

    @Test
    fun `parses RFC 3339 UTC timestamps with and without nanos`() {
        assertEquals(
            Instant.parse("2026-09-03T17:30:00Z"),
            TimeFormats.parseUtc("2026-09-03T17:30:00Z"),
        )
        assertEquals(
            Instant.parse("2026-09-03T17:30:00.123456789Z"),
            TimeFormats.parseUtc("2026-09-03T17:30:00.123456789Z"),
        )
    }

    @Test
    fun `returns null for missing or malformed timestamps`() {
        assertNull(TimeFormats.parseUtc(null))
        assertNull(TimeFormats.parseUtc(""))
        assertNull(TimeFormats.parseUtc("   "))
        assertNull(TimeFormats.parseUtc("tomorrow"))
        assertNull(TimeFormats.parseUtc("2026-09-03 17:30"))
    }

    @Test
    fun `falls back to UTC for missing or invalid zones`() {
        assertEquals(ZoneId.of("UTC"), TimeFormats.zoneOf(null))
        assertEquals(ZoneId.of("UTC"), TimeFormats.zoneOf(""))
        assertEquals(ZoneId.of("UTC"), TimeFormats.zoneOf("Not/AZone"))
        assertEquals(kolkata, TimeFormats.zoneOf("Asia/Kolkata"))
    }

    @Test
    fun `formats wall-clock strings in the requested zone`() {
        val t = Instant.parse("2026-09-03T17:30:00Z") // 23:00 in Kolkata
        assertEquals("5 PM", TimeFormats.hourAmPm(t, ZoneId.of("UTC")))
        assertEquals("23:00", TimeFormats.hourMinute(t, kolkata))
        assertEquals("11 PM", TimeFormats.hourAmPm(t, kolkata))
    }

    @Test
    fun `formats weekday and date strings`() {
        val t = Instant.parse("2026-09-03T10:00:00Z") // Thursday
        assertEquals("Thu", TimeFormats.dayOfWeek(t, ZoneId.of("UTC")))
        assertEquals("Sep 3", TimeFormats.dayMonth(t, ZoneId.of("UTC")))
        assertEquals(LocalDate.of(2026, 9, 3), TimeFormats.localDate(t, ZoneId.of("UTC")))
        // Late-UTC instant is already the next day in Kolkata.
        assertEquals(LocalDate.of(2026, 9, 4), TimeFormats.localDate(Instant.parse("2026-09-03T20:00:00Z"), kolkata))
    }

    @Test
    fun `epoch day conversion handles defaults and invalid dates`() {
        assertEquals(LocalDate.of(2026, 9, 3).toEpochDay(), TimeFormats.toEpochDay(2026, 9, 3))
        assertEquals(LocalDate.of(1970, 1, 1).toEpochDay(), TimeFormats.toEpochDay(null, null, null))
        assertEquals(LocalDate.of(1970, 5, 5).toEpochDay(), TimeFormats.toEpochDay(null, 5, 5))
        assertEquals(LocalDate.of(2026, 9, 1).toEpochDay(), TimeFormats.toEpochDay(2026, 9, null))
        assertEquals(0L, TimeFormats.toEpochDay(2026, 13, 40)) // invalid month/day
        assertEquals(LocalDate.of(2026, 1, 1).toEpochDay(), TimeFormats.toEpochDay(2026, null, null))
    }
}
