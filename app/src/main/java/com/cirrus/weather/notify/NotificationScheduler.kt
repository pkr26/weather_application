package com.cirrus.weather.notify

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

/**
 * Owns all notification scheduling:
 *  - the daily briefing runs as a self-rescheduling one-time chain that
 *    targets the user's chosen wall-clock time. WorkManager is inexact by
 *    design — Doze/batching can shift a fire by minutes — but because every
 *    run reschedules from `now`, the error never accumulates across days.
 *    Both work requests additionally require connectivity: their entire
 *    job is a network fetch, so running them offline only burns retries;
 *  - severe-alert polling is a plain periodic job (WorkManager keeps both
 *    across reboots and process death).
 */
object NotificationScheduler {

    const val BRIEFING_CHAIN = "daily_briefing_chain"
    const val BRIEFING_CATCHUP = "daily_briefing_catchup"
    const val ALERT_POLLING = "severe_alert_polling"

    /** Marks a run as the connectivity catch-up (exhausted-retries) variant. */
    const val KEY_CATCHUP = "catchup"

    /** Decision matrix for the boot-time reschedule (see [bootAction]). */
    enum class BootAction {
        /** A briefing worker is running right now — leave it alone; it
         *  reschedules itself when it finishes. */
        RUNNER_ACTIVE,

        /** A run is already enqueued — it carries today's/tomorrow's
         *  schedule; replacing it could only delay the next briefing. */
        PENDING_EXISTS,

        /** Nothing armed and today's target already passed unposted — arm
         *  the connectivity catch-up and schedule the next occurrence. */
        ARM_CATCH_UP_AND_SCHEDULE,

        /** Nothing armed, today not missed — just schedule the next run. */
        SCHEDULE_ONLY,
    }

    /** Connectivity is the one thing every notification run needs. */
    private val online = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * Milliseconds from [now] until the next occurrence of hour:minute.
     * Delegates to the pure, mutation-tested implementation in the core module.
     */
    fun computeDelayMillis(now: LocalDateTime, hour: Int, minute: Int): Long =
        BriefingSchedule.computeDelayMillis(now, hour, minute)

    /**
     * (Re)schedules the daily briefing at the given minutes-from-midnight.
     * Default policy is REPLACE (settings changed the time — any pending run
     * for the old time must go); the worker self-reschedules with
     * APPEND_OR_REPLACE so it never cancels itself mid-run.
     */
    fun scheduleDailyBriefing(
        context: Context,
        timeMinutes: Int,
        policy: ExistingWorkPolicy = ExistingWorkPolicy.REPLACE,
    ) {
        val now = LocalDateTime.now()
        val delay = computeDelayMillis(now, timeMinutes / 60, timeMinutes % 60)
        val request = OneTimeWorkRequestBuilder<BriefingWorker>()
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(BRIEFING_CHAIN, policy, request)
    }

    fun cancelDailyBriefing(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(BRIEFING_CHAIN)
    }

    /**
     * Boot / timezone-change reschedule. A plain REPLACE would silently kill
     * today's still-pending briefing (its CONNECTED constraint unmet while the
     * device was offline) and jump straight to tomorrow — so when the target
     * time has already passed today and nothing was posted yet, a catch-up
     * run is armed to fire the moment connectivity returns.
     *
     * The chain's own state is consulted first: WorkManager often
     * cold-starts the process *for* the briefing worker itself, and an
     * unconditional schedule from Application.onCreate would then REPLACE
     * that very worker mid-run — cancelling today's briefing and leaving a
     * dead chain that nothing ever revives. A RUNNING worker reschedules
     * itself; a pending ENQUEUED run already carries today's (or tomorrow's)
     * schedule, and replacing it could only push the next briefing out.
     */
    fun bootReschedule(context: Context, timeMinutes: Int, lastPostedAtMs: Long) {
        val now = LocalDateTime.now()
        val target = now.toLocalDate().atTime(timeMinutes / 60, timeMinutes % 60)
        // "Recently" is a 20-hour wall-clock window, not a calendar day: a
        // westward flight that jumps local time across midnight must not
        // count as "a whole day missed" hours after the real briefing.
        val postedRecently =
            lastPostedAtMs > 0 &&
                System.currentTimeMillis() - lastPostedAtMs < RECENT_BRIEFING_WINDOW_MS
        val missedToday = now.isAfter(target) && !postedRecently
        val states = chainStates(context)
        when (bootAction(missedToday, states.contains(WorkInfo.State.RUNNING), states.contains(WorkInfo.State.ENQUEUED))) {
            BootAction.RUNNER_ACTIVE -> return
            BootAction.PENDING_EXISTS -> return
            BootAction.ARM_CATCH_UP_AND_SCHEDULE -> {
                scheduleBriefingCatchUp(context)
                scheduleDailyBriefing(context, timeMinutes, ExistingWorkPolicy.KEEP)
            }
            BootAction.SCHEDULE_ONLY ->
                scheduleDailyBriefing(context, timeMinutes, ExistingWorkPolicy.KEEP)
        }
    }

    /** What a boot-time reschedule should do given the chain's live state.
     *  Pure so the decision matrix is unit-testable without WorkManager. */
    fun bootAction(missedToday: Boolean, anyRunning: Boolean, anyEnqueued: Boolean): BootAction =
        when {
            anyRunning -> BootAction.RUNNER_ACTIVE
            anyEnqueued -> BootAction.PENDING_EXISTS
            missedToday -> BootAction.ARM_CATCH_UP_AND_SCHEDULE
            else -> BootAction.SCHEDULE_ONLY
        }

    /** Current states of the briefing chain; empty when WorkManager cannot
     *  answer (treated as "nothing scheduled" by the caller). Blocking by
     *  design — every call site is already on a background dispatcher. */
    private fun chainStates(context: Context): Set<WorkInfo.State> =
        runCatching {
            WorkManager.getInstance(context)
                .getWorkInfosForUniqueWork(BRIEFING_CHAIN)
                .get()
                .mapNotNull { it?.state }
                .toSet()
        }.getOrDefault(emptySet())

    /**
     * Fires the briefing as soon as connectivity returns — used when the
     * scheduled run exhausted its retries (e.g. a long tunnel commute), so
     * the day's briefing is late rather than skipped. The tomorrow chain is
     * unaffected: catch-up runs under its own unique name and replaces only
     * itself.
     */
    fun scheduleBriefingCatchUp(context: Context) {
        val request = OneTimeWorkRequestBuilder<BriefingWorker>()
            .setConstraints(online)
            .setInputData(workDataOf(KEY_CATCHUP to true))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(BRIEFING_CATCHUP, ExistingWorkPolicy.REPLACE, request)
    }

    /** Every 2 hours: checks for new severe-weather alerts at the active city.
     *  Severe-weather warnings are time-critical — a 4-hour worst-case delay
     *  is too late for a storm; 2h balances urgency against battery. */
    fun scheduleAlertPolling(context: Context) {
        val request = PeriodicWorkRequestBuilder<AlertWorker>(2, TimeUnit.HOURS)
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(ALERT_POLLING, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancelAlertPolling(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(ALERT_POLLING)
    }

    /**
     * Re-anchors the briefing schedule after a clock or timezone change.
     * Broadcast receivers must not do DataStore I/O on the main thread, so
     * the work is handed to a one-shot worker under a stable unique name
     * (flapping broadcasts coalesce).
     */
    fun requestReschedule(context: Context) {
        val request = OneTimeWorkRequestBuilder<RescheduleWorker>()
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(RESCHEDULE, ExistingWorkPolicy.REPLACE, request)
    }

    private const val RESCHEDULE = "briefing_reschedule_after_clock_change"

        /** A briefing posted within this window counts as "not missed". */
        private const val RECENT_BRIEFING_WINDOW_MS = 20L * 60 * 60 * 1000
}
