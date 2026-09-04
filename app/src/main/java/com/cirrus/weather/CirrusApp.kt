package com.cirrus.weather

import android.app.Application
import com.cirrus.weather.di.AppContainer
import com.cirrus.weather.notify.NotificationScheduler
import com.cirrus.weather.notify.Notifier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class CirrusApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)

        Notifier.ensureChannels(this)

        // Keep notification schedules aligned with persisted preferences and
        // sync the device registry with the backend. Both are idempotent.
        // bootReschedule (not a plain REPLACE) so a briefing that was still
        // pending-and-offline when the process started is caught up today
        // instead of silently skipped to tomorrow.
        container.applicationScope.launch {
            try {
                if (container.settings.notificationsEnabled.first()) {
                    NotificationScheduler.bootReschedule(
                        this@CirrusApp,
                        container.settings.notificationTimeMinutes.first(),
                        container.settings.lastBriefingPostedAt.first(),
                    )
                    NotificationScheduler.scheduleAlertPolling(this@CirrusApp)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Preferences unavailable this boot; workers re-sync later.
            }
        }
        container.applicationScope.launch {
            container.deviceRegistrar.register()
        }
    }
}
