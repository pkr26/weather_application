package com.cirrus.weather

import com.cirrus.weather.ui.components.Spline
import com.cirrus.weather.util.TimeFormats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class SplineTest {

    @Test
    fun `spline passes through control points`() {
        val xs = floatArrayOf(0f, 10f, 20f, 30f)
        val ys = floatArrayOf(5f, 15f, 10f, 20f)
        val spline = Spline(xs, ys)
        for (i in xs.indices) {
            assertEquals(ys[i], spline.yAt(xs[i]), 0.001f)
        }
    }

    @Test
    fun `clamps outside the domain`() {
        val spline = Spline(floatArrayOf(0f, 10f), floatArrayOf(3f, 7f))
        assertEquals(3f, spline.yAt(-5f), 0.001f)
        assertEquals(7f, spline.yAt(15f), 0.001f)
    }

    @Test
    fun `normalized spline flips y axis`() {
        val (xs, ys) = Spline.normalized(listOf(0.0, 10.0))
        assertEquals(0f, xs[0], 0.001f)
        assertEquals(1f, xs[1], 0.001f)
        assertEquals(1f, ys[0], 0.001f) // cold → bottom
        assertEquals(0f, ys[1], 0.001f) // hot → top
    }

    @Test
    fun `flat series does not divide by zero`() {
        val (_, ys) = Spline.normalized(listOf(5.0, 5.0, 5.0))
        assertEquals(ys[0], ys[1], 0.001f)
    }
}

class TimeFormatsTest {

    private val zone = ZoneId.of("Asia/Kolkata")

    @Test
    fun `parses utc timestamps with and without nanos`() {
        assertEquals(
            Instant.parse("2026-09-03T17:30:00Z"),
            TimeFormats.parseUtc("2026-09-03T17:30:00Z")
        )
        assertEquals(
            Instant.parse("2026-09-03T00:32:27.916974360Z"),
            TimeFormats.parseUtc("2026-09-03T00:32:27.916974360Z")
        )
        assertNull(TimeFormats.parseUtc(null))
        assertNull(TimeFormats.parseUtc("not-a-date"))
    }

    @Test
    fun `formats in the location timezone`() {
        val instant = Instant.parse("2026-09-03T17:30:00Z")
        assertEquals("11 PM", TimeFormats.hourAmPm(instant, zone))
        assertEquals("23:00", TimeFormats.hourMinute(instant, zone))
    }
}
