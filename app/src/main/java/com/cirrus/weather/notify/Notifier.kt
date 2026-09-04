package com.cirrus.weather.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.cirrus.weather.MainActivity
import com.cirrus.weather.R

/**
 * Posts the daily briefing and severe-weather alert notifications.
 * All copy arrives pre-localized from the backend, in the language the
 * user picked in Settings. Post functions return whether the notification
 * actually went out — callers use that to decide what to mark as seen.
 */
object Notifier {

    const val CHANNEL_BRIEFING = "daily_briefing"
    const val CHANNEL_ALERTS = "severe_alerts"

    /** Launch extra: the saved-city id the notification is about. */
    const val EXTRA_CITY_ID = "com.cirrus.weather.extra.CITY_ID"

    private const val ID_BRIEFING = 1001
    private const val ID_ALERT_BASE = 2000

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val briefing = NotificationChannel(
            CHANNEL_BRIEFING,
            context.getString(R.string.channel_briefing_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = context.getString(R.string.channel_briefing_desc) }

        val alerts = NotificationChannel(
            CHANNEL_ALERTS,
            context.getString(R.string.channel_alerts_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = context.getString(R.string.channel_alerts_desc) }

        manager.createNotificationChannels(listOf(briefing, alerts))
    }

    /** Opens the app on the city the notification is about (when known). */
    private fun contentIntent(context: Context, requestCode: Int, cityId: String?): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                if (!cityId.isNullOrBlank()) putExtra(EXTRA_CITY_ID, cityId)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** @return true when the briefing was posted. */
    fun showBriefing(context: Context, title: String, body: String, cityId: String? = null): Boolean {
        ensureChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_BRIEFING)
            // Status-bar small icons must be monochrome alpha masks — the
            // multicolor weather glyphs flattened into blobs up there.
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body.substringBefore('\n'))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(contentIntent(context, 1, cityId))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        return post(context, ID_BRIEFING, notification)
    }

    /**
     * Stable notification slot for one alert, derived from its dedupe key.
     * The first 7 hex chars of the SHA-256 key give a 28-bit space (~268M
     * slots) — two live alerts sharing a slot is effectively impossible,
     * where the old 256-slot mapping silently replaced alerts ~0.4% of the
     * time.
     */
    fun alertNotificationId(alertKey: String): Int = ID_ALERT_BASE + alertKey.take(7).toInt(16)

    /** @return true when the alert was posted (false = permission missing). */
    fun showAlert(
        context: Context,
        notificationId: Int,
        headline: String,
        description: String,
        cityId: String? = null,
    ): Boolean {
        ensureChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(headline)
            .setContentText(description.take(180))
            .setStyle(NotificationCompat.BigTextStyle().bigText(description.take(1000)))
            .setContentIntent(contentIntent(context, notificationId, cityId))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        return post(context, notificationId, notification)
    }

    private fun post(context: Context, id: Int, notification: android.app.Notification): Boolean {
        val manager = NotificationManagerCompat.from(context)
        return try {
            manager.notify(id, notification)
            true
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS revoked mid-flight; the user can re-enable
            // in Settings. Reported to the caller so it can retry later.
            false
        }
    }
}
