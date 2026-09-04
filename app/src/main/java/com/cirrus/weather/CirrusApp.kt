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
        container.applicationScope.launch {
            try {
                if (container.settings.notificationsEnabled.first()) {
                    NotificationScheduler.scheduleDailyBriefing(
                        this@CirrusApp,
                        container.settings.notificationTimeMinutes.first(),
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
