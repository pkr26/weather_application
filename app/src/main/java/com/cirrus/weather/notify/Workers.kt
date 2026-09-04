package com.cirrus.weather.notify

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkerParameters
import com.cirrus.weather.CirrusApp
import com.cirrus.weather.data.local.SettingsStore
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.dto.BriefingResponse
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import com.cirrus.weather.domain.SavedCity
import kotlinx.coroutines.flow.first

/** Shared lookup: the city notifications are about (active city, else first). */
suspend fun com.cirrus.weather.di.AppContainer.activeCity(): SavedCity {
    val cities = settings.cities.first()
    val activeId = settings.activeCityId.first()
    return cities.firstOrNull { it.id == activeId }
        ?: cities.firstOrNull()
        ?: SettingsStore.defaultCities().first()
}

/**
 * Fetches the localized briefing and posts it. Framework-free except for
 * the notification post itself, so the flow (language, city, units) reads
 * as one unit and can be exercised without WorkManager.
 */
class BriefingUseCase(
    private val api: CirrusApi,
    private val settings: SettingsStore,
    private val activeCity: suspend () -> SavedCity,
) {
    /** @return true when a briefing was actually posted. */
    suspend fun post(context: Context): Boolean {
        val city = activeCity()
        val briefing: BriefingResponse = api.briefing(
            latitude = city.latitude,
            longitude = city.longitude,
            city = city.displayName,
            languageCode = settings.notificationLanguage.first(),
            units = settings.unitPref.first().key,
        )
        return Notifier.showBriefing(
            context,
            title = briefing.title.ifBlank { city.displayName },
            body = briefing.body,
            cityId = city.id,
        )
    }
}

/**
 * Polls for severe-weather alerts at the active city and notifies about
 * ones not seen before. Dedupe keys are marked seen only when their
 * notification actually posted (or they were beyond the flood cap) — a
 * posting failure (permission revoked mid-flight) must not swallow the
 * alert forever.
 */
class AlertUseCase(
    private val api: CirrusApi,
    private val settings: SettingsStore,
    private val activeCity: suspend () -> SavedCity,
) {
    suspend fun poll(context: Context) {
        val city = activeCity()
        val response: PublicAlertsResponse =
            api.alerts(city.latitude, city.longitude, settings.notificationLanguage.first())
        val alerts = response.weatherAlerts
        val seen = settings.seenAlertKeys.first()

        val fresh = alerts.filterNot { AlertWorker.alertKey(it.headline, it.eventStartTime) in seen }
        val shown = fresh.take(AlertWorker.MAX_ALERT_NOTIFICATIONS)
        val posted = mutableSetOf<String>()
        shown.forEach { alert ->
            val key = AlertWorker.alertKey(alert.headline, alert.eventStartTime)
            val headline = alert.headline ?: return@forEach
            if (
                Notifier.showAlert(
                    context,
                    notificationId = Notifier.alertNotificationId(key),
                    headline = headline,
                    description = alert.description?.text ?: "",
                    cityId = city.id,
                )
            ) {
                posted += key
            }
        }
        // Everything fresh resolves except shown-but-failed posts: those
        // must stay unseen so the next poll retries them once the user has
        // re-granted the notification permission.
        val freshKeys = fresh.map { AlertWorker.alertKey(it.headline, it.eventStartTime) }.toSet()
        val failedShown = shown.map { AlertWorker.alertKey(it.headline, it.eventStartTime) }.toSet() - posted
        settings.markAlertsSeen(freshKeys - failedShown)
    }
}

/**
 * Fetches the localized "here's what today brings" briefing from the
 * backend and posts it. After each run it re-enqueues itself for the next
 * occurrence of the user's chosen time. When retries run out (a long
 * offline morning), a connectivity-triggered catch-up run is scheduled so
 * the briefing is late rather than skipped.
 */
class BriefingWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as CirrusApp).container
        if (!container.settings.notificationsEnabled.first()) {
            return Result.success() // user turned notifications off since scheduling
        }
        val isCatchUp = inputData.getBoolean(NotificationScheduler.KEY_CATCHUP, false)

        return try {
            val posted = container.briefingUseCase.post(applicationContext)
            if (posted) {
                NotificationScheduler.scheduleDailyBriefing(
                    applicationContext,
                    container.settings.notificationTimeMinutes.first(),
                    ExistingWorkPolicy.APPEND_OR_REPLACE,
                )
                Result.success()
            } else {
                retryOrGiveUp(container, isCatchUp)
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // cancellation must propagate, never masquerade as failure
        } catch (_: Exception) {
            retryOrGiveUp(container, isCatchUp)
        }
    }

    private suspend fun retryOrGiveUp(container: com.cirrus.weather.di.AppContainer, isCatchUp: Boolean): Result {
        if (runAttemptCount < 3) return Result.retry()
        if (isCatchUp) return Result.success() // catch-up already exhausted its chances
        // Backend unreachable all morning: post as soon as connectivity
        // returns, and keep the tomorrow chain alive regardless.
        NotificationScheduler.scheduleBriefingCatchUp(applicationContext)
        NotificationScheduler.scheduleDailyBriefing(
            applicationContext,
            container.settings.notificationTimeMinutes.first(),
            ExistingWorkPolicy.APPEND_OR_REPLACE,
        )
        return Result.success()
    }
}

/**
 * Periodically checks the backend for new severe-weather alerts at the
 * active city and notifies about ones not seen before (dedup by
 * headline + start time, persisted in DataStore).
 */
class AlertWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as CirrusApp).container
        if (!container.settings.notificationsEnabled.first()) return Result.success()

        return try {
            container.alertUseCase.poll(applicationContext)
            Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a stopped worker must not answer with Result.retry()
        } catch (_: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.success()
        }
    }

    companion object {
        /** Notifications per poll at most — enough for real events, not a flood. */
        const val MAX_ALERT_NOTIFICATIONS = 4

        /** Stable, collision-resistant dedupe key for one alert. */
        fun alertKey(headline: String?, startsAt: String?): String {
            val raw = "${headline ?: ""}|${startsAt ?: ""}"
            val digest = java.security.MessageDigest.getInstance("SHA-256")
                .digest(raw.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }.take(16)
        }
    }
}
