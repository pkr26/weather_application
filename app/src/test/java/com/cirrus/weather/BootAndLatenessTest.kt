package com.cirrus.weather

import com.cirrus.weather.notify.BriefingWorker
import com.cirrus.weather.notify.NotificationScheduler
import com.cirrus.weather.notify.NotificationScheduler.BootAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

/**
 * Pure decision matrices extracted from the workers so the boot-race and
 * max-lateness policies are pinned without WorkManager.
 */
class BootAndLatenessTest {

    // ---- bootAction: a REPLACE from Application.onCreate must never cancel
    // a worker WorkManager itself just started (or is about to run).

    @Test
    fun `a running worker is left alone - it reschedules itself`() {
        assertEquals(
            BootAction.RUNNER_ACTIVE,
            NotificationScheduler.bootAction(missedToday = true, anyRunning = true, anyEnqueued = false),
        )
        assertEquals(
            BootAction.RUNNER_ACTIVE,
            NotificationScheduler.bootAction(missedToday = false, anyRunning = true, anyEnqueued = true),
        )
    }

    @Test
    fun `an enqueued run already carries the schedule - replacing it can only delay`() {
        assertEquals(
            BootAction.PENDING_EXISTS,
            NotificationScheduler.bootAction(missedToday = true, anyRunning = false, anyEnqueued = true),
        )
        assertEquals(
            BootAction.PENDING_EXISTS,
            NotificationScheduler.bootAction(missedToday = false, anyRunning = false, anyEnqueued = true),
        )
    }

    @Test
    fun `nothing armed and today missed arms the catch-up and schedules`() {
        assertEquals(
            BootAction.ARM_CATCH_UP_AND_SCHEDULE,
            NotificationScheduler.bootAction(missedToday = true, anyRunning = false, anyEnqueued = false),
        )
    }

    @Test
    fun `nothing armed and today not missed just schedules`() {
        assertEquals(
            BootAction.SCHEDULE_ONLY,
            NotificationScheduler.bootAction(missedToday = false, anyRunning = false, anyEnqueued = false),
        )
    }

    // ---- isTooLateToPost: a briefing many hours after its target is noise.

    @Test
    fun `on time and moderately late briefings still post`() {
        val target08 = 8 * 60
        assertFalse(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 4, 7, 59), target08))
        assertFalse(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 4, 8, 0), target08))
        assertFalse(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 4, 13, 59), target08))
    }

    @Test
    fun `briefings later than the window are skipped`() {
        val target08 = 8 * 60
        assertTrue(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 4, 14, 1), target08))
        assertTrue(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 4, 22, 0), target08))
        // Early-morning target, morning run: 7.5 h late.
        assertTrue(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 4, 8, 0), 30))
    }

    @Test
    fun `a briefing just past midnight for a late-evening target still posts`() {
        // 23:30 target delayed into the next calendar day: today's target is
        // in the future again, so the age check must not misfire.
        assertFalse(BriefingWorker.isTooLateToPost(LocalDateTime.of(2026, 9, 5, 0, 15), 23 * 60 + 30))
    }
}
