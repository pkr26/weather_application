package com.cirrus.weather.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.WorkManager

/**
 * Re-anchors the daily briefing when the clock moves under us: a timezone
 * change (travel) or manual clock set leaves the pending worker delayed
 * against the *old* schedule. Manifest-registered for system-only
 * broadcasts, not exported; the actual rescheduling runs in
 * [RescheduleWorker] so no disk I/O happens on the main thread.
 */
class SchedulingReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_TIMEZONE_CHANGED || action == Intent.ACTION_TIME_CHANGED) {
            NotificationScheduler.requestReschedule(context)
        }
    }
}
