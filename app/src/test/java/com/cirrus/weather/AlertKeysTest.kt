package com.cirrus.weather

import com.cirrus.weather.notify.AlertWorker
import com.cirrus.weather.notify.Notifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Alert dedupe keys and notification slots must be stable across polls and
 * distinct across alerts — a colliding key re-buzzes or silently drops
 * severe-weather warnings.
 */
class AlertKeysTest {

    @Test
    fun `alert key is deterministic for the same alert`() {
        assertEquals(
            AlertWorker.alertKey("Heat warning", "2026-09-03T04:00:00Z"),
            AlertWorker.alertKey("Heat warning", "2026-09-03T04:00:00Z"),
        )
    }

    @Test
    fun `different alerts never share a key`() {
        val a = AlertWorker.alertKey("Heat warning", "2026-09-03T04:00:00Z")
        val b = AlertWorker.alertKey("Storm warning", "2026-09-03T04:00:00Z")
        val c = AlertWorker.alertKey("Heat warning", "2026-09-04T04:00:00Z")
        assertNotEquals(a, b)
        assertNotEquals(a, c)
        assertNotEquals(b, c)
    }

    @Test
    fun `similar keys that collide under 32-bit hashCode stay distinct`() {
        // Two strings engineered to share Java's String.hashCode still
        // produce different SHA-256 based keys.
        val s1 = "Aa"
        val s2 = "BB"
        assertEquals(s1.hashCode(), s2.hashCode())
        assertNotEquals(AlertWorker.alertKey(s1, null), AlertWorker.alertKey(s2, null))
    }

    @Test
    fun `missing headline or time still yields a usable key`() {
        val key = AlertWorker.alertKey(null, null)
        assertTrue(key.isNotBlank())
    }

    @Test
    fun `notification slot is stable and stays inside the alert range`() {
        val key = AlertWorker.alertKey("Flood warning", "2026-09-03T00:00:00Z")
        val id = Notifier.alertNotificationId(key)
        assertEquals(id, Notifier.alertNotificationId(key)) // stable across polls
        assertTrue("id=$id", id in 2000 until 2000 + 0x1000_0000)
    }

    @Test
    fun `distinct alerts map to distinct notification slots (sampling)`() {
        val ids = (0 until 64)
            .map { AlertWorker.alertKey("Alert $it", "2026-09-03T0${it % 10}:00:00Z") }
            .map(Notifier::alertNotificationId)
            .toSet()
        // The 28-bit slot space must not collide on a healthy sample.
        assertEquals("colliding notification slots", 64, ids.size)
    }

    @Test
    fun `hashCode-colliding keys still get distinct slots`() {
        // "Aa" and "BB" share Java's String.hashCode; the SHA-256 derived
        // slot space must not inherit that collision.
        val s1 = AlertWorker.alertKey("Aa", null)
        val s2 = AlertWorker.alertKey("BB", null)
        assertNotEquals(Notifier.alertNotificationId(s1), Notifier.alertNotificationId(s2))
    }
}
