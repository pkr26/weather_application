package com.cirrus.weather.notify

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkerParameters
import com.cirrus.weather.CirrusApp
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.dto.BriefingResponse
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import com.cirrus.weather.data.remote.dto.WeatherAlertDto
import com.cirrus.weather.domain.SavedCity
import kotlinx.coroutines.flow.first
import retrofit2.HttpException
import java.time.Duration
import java.time.LocalDateTime

/**
 * Shared lookup: the city notifications are about — the active city, else
 * the first saved one. Null when the user has deleted every city: nothing
 * should notify about a place the user never chose to keep.
 */
suspend fun com.cirrus.weather.di.AppContainer.activeCity(): SavedCity? {
    val cities = settings.cities.first()
    val activeId = settings.activeCityId.first()
    return cities.firstOrNull { it.id == activeId }
        ?: cities.firstOrNull()
}

/**
 * The notification-relevant slice of settings the use cases read/write.
 * Extracted from SettingsStore so the flows are unit-testable without
 * DataStore/Android.
 */
interface NotificationPrefs {
    suspend fun notifLanguage(): String
    suspend fun unitsKey(): String
    suspend fun seenKeys(): Set<String>
    suspend fun markSeen(keys: Set<String>)
    suspend fun recordBriefingPostedAt(epochMs: Long)
}

/**
 * Fetches the localized briefing and posts it. Framework-free — even the
 * notification post is injected — so the flow (language, city, units)
 * reads as one unit and runs in plain JVM unit tests.
 */
class BriefingUseCase(
    private val api: CirrusApi,
    private val prefs: NotificationPrefs,
    private val activeCity: suspend () -> SavedCity?,
    private val showBriefing: suspend (String, String, String) -> Boolean,
) {
    /** @return true when a briefing was actually posted. */
    suspend fun post(): Boolean {
        val city = activeCity() ?: return false
        val briefing: BriefingResponse = api.briefing(
            latitude = city.latitude,
            longitude = city.longitude,
            city = city.displayName,
            languageCode = prefs.notifLanguage(),
            units = prefs.unitsKey(),
        )
        val posted = showBriefing(
            briefing.title.ifBlank { city.displayName },
            briefing.body,
            city.id,
        )
        if (posted) prefs.recordBriefingPostedAt(System.currentTimeMillis())
        return posted
    }
}

/**
 * Polls for severe-weather alerts at the active city and notifies about
 * ones not seen before. Dedupe keys are marked seen only when their
 * notification actually posted (or they were beyond the flood cap) — a
 * posting failure (permission revoked mid-flight) must not swallow the
 * alert forever. Alerts without any usable headline are marked seen
 * immediately: they could otherwise occupy the per-poll cap forever and
 * starve the alerts that can actually be shown.
 */
class AlertUseCase(
    private val api: CirrusApi,
    private val prefs: NotificationPrefs,
    private val activeCity: suspend () -> SavedCity?,
    private val showAlert: suspend (Int, String, String, String?) -> Boolean,
) {
    suspend fun poll() {
        val city = activeCity() ?: return
        val response: PublicAlertsResponse =
            api.alerts(city.latitude, city.longitude, prefs.notifLanguage())
        val alerts = response.weatherAlerts
        val seen = prefs.seenKeys()

        val fresh = alerts.filterNot { AlertWorker.alertKey(it.headline, it.eventStartTime) in seen }
        // Postable = a real headline or at least a typed event; the rest are
        // unshowable and resolved (marked seen) rather than retried forever.
        val postable = fresh.filter { it.displayHeadline() != null }
        val shown = postable.take(AlertWorker.MAX_ALERT_NOTIFICATIONS)
        val posted = mutableSetOf<String>()
        shown.forEach { alert ->
            val key = AlertWorker.alertKey(alert.headline, alert.eventStartTime)
            val headline = checkNotNull(alert.displayHeadline())
            if (
                showAlert(
                    Notifier.alertNotificationId(key),
                    headline,
                    alert.description?.text ?: "",
                    city.id,
                )
            ) {
                posted += key
            }
        }
        // Everything fresh resolves except shown-but-failed posts: those
        // must stay unseen so the next poll retries them once the user has
        // re-granted the notification permission.
        val freshKeys = fresh.map { AlertWorker.alertKey(it.headline, it.eventStartTime) }.toSet()
        val shownKeys = shown.map { AlertWorker.alertKey(it.headline, it.eventStartTime) }.toSet()
        prefs.markSeen(freshKeys - (shownKeys - posted))
    }
}

/** Headline for one alert: its own text, else the typed event as a stand-in
 *  (underscores to spaces, matching the in-app banner's fallback). */
private fun WeatherAlertDto.displayHeadline(): String? =
    headline?.takeIf { it.isNotBlank() }
        ?: alertType?.takeIf { it.isNotBlank() }?.replace('_', ' ')

/**
 * Fetches the localized "here's what today brings" briefing from the
 * backend and posts it. After each *scheduled* run it re-enqueues itself
 * for the next occurrence of the user's chosen time. When retries run out
 * (a long offline morning), a connectivity-triggered catch-up run is
 * scheduled so the briefing is late rather than skipped — and the catch-up
 * itself never appends to the chain, because the failure path already put
 * tomorrow's run there (appending twice would duplicate every future
 * morning's briefing).
 */
class BriefingWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as CirrusApp).container
        // Armor starts before the first preferences read: an unreadable
        // DataStore must degrade this one run, not throw the worker into
        // FAILURE and take the whole chain (and its reschedules) with it.
        val timeMinutes = try {
            container.settings.notificationTimeMinutes.first()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // Preferences unavailable (corruption/disk): there is nothing to
            // compute a schedule from — the next process start re-arms.
            return Result.success()
        }
        val isCatchUp = inputData.getBoolean(NotificationScheduler.KEY_CATCHUP, false)

        // A briefing many hours after its target is noise, not information:
        // an all-day airplane-mode morning would otherwise post "good
        // morning" at 22:00 with long-stale content.
        if (isTooLateToPost(LocalDateTime.now(), timeMinutes)) {
            return skipToday(timeMinutes, isCatchUp)
        }

        val posted = try {
            if (!container.settings.notificationsEnabled.first()) {
                return Result.success() // user turned notifications off since scheduling
            }
            if (container.activeCity() == null) {
                // Nothing to brief about — but the chain must stay armed for the
                // day the user adds a city again, without relying on the next
                // process start to re-arm it.
                NotificationScheduler.scheduleDailyBriefing(
                    applicationContext,
                    timeMinutes,
                    ExistingWorkPolicy.APPEND_OR_REPLACE,
                )
                return Result.success()
            }
            container.briefingUseCase.post()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // cancellation must propagate, never masquerade as failure
        } catch (e: Exception) {
            // Auth is broken server-side (rotated token/secret): retries can
            // only burn fetches. Keep tomorrow armed and give up on today.
            if (e is HttpException && (e.code() == 401 || e.code() == 403)) {
                return skipToday(timeMinutes, isCatchUp)
            }
            return retryOrGiveUp(isCatchUp, timeMinutes)
        }

        if (posted) {
            if (rescheduleAfterPost(isCatchUp)) {
                NotificationScheduler.scheduleDailyBriefing(
                    applicationContext,
                    timeMinutes,
                    ExistingWorkPolicy.APPEND_OR_REPLACE,
                )
            }
            return Result.success()
        }
        // post()==false here can only mean the notification itself was
        // refused (POST_NOTIFICATIONS revoked): retrying a fetch cannot fix
        // a permission. Tomorrow retries naturally if the user re-grants.
        return skipToday(timeMinutes, isCatchUp)
    }

    companion object {
        /**
         * Only the scheduled chain reschedules itself after a successful
         * post. The catch-up runs BESIDE the chain — tomorrow's briefing is
         * already pending in it by the time a catch-up exists — so an
         * APPEND from the catch-up would duplicate every future morning.
         */
        fun rescheduleAfterPost(isCatchUp: Boolean): Boolean = !isCatchUp

        /** A briefing later than this many hours past today's target is
         *  skipped outright — see the call site for why. */
        const val MAX_LATE_HOURS = 6L

        fun isTooLateToPost(now: LocalDateTime, timeMinutes: Int): Boolean {
            val target = now.toLocalDate().atTime(timeMinutes / 60, timeMinutes % 60)
            return Duration.between(target, now) > Duration.ofHours(MAX_LATE_HOURS)
        }
    }

    /** Gives up on today's briefing while keeping tomorrow armed (the
     *  catch-up never appends: the chain already owns tomorrow by the time
     *  one exists). */
    private fun skipToday(timeMinutes: Int, isCatchUp: Boolean): Result {
        if (!isCatchUp) {
            NotificationScheduler.scheduleDailyBriefing(
                applicationContext,
                timeMinutes,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
            )
        }
        return Result.success()
    }

    private fun retryOrGiveUp(isCatchUp: Boolean, timeMinutes: Int): Result {
        if (runAttemptCount < 3) return Result.retry()
        if (isCatchUp) return Result.success() // catch-up already exhausted its chances
        // Backend unreachable all morning: post as soon as connectivity
        // returns, and keep the tomorrow chain alive regardless.
        NotificationScheduler.scheduleBriefingCatchUp(applicationContext)
        NotificationScheduler.scheduleDailyBriefing(
            applicationContext,
            timeMinutes,
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
        return try {
            // The preferences read lives inside the armor: an unreadable
            // DataStore is a transient infra failure, not a reason to kill
            // the periodic work.
            if (!container.settings.notificationsEnabled.first()) return Result.success()
            container.alertUseCase.poll()
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

/**
 * Re-anchors the briefing schedule after a clock or timezone change: the
 * pending worker was delayed against the *old* zone, so without this a
 * traveler's next briefing would fire at the home zone's 08:00.
 */
class RescheduleWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as CirrusApp).container
        return try {
            // Mirror the boot path: a clock change for a user who turned
            // notifications off must not re-arm anything.
            if (!container.settings.notificationsEnabled.first()) return Result.success()
            NotificationScheduler.bootReschedule(
                applicationContext,
                container.settings.notificationTimeMinutes.first(),
                container.settings.lastBriefingPostedAt.first(),
            )
            Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // Preferences unavailable: nothing to re-anchor against — the
            // next process start re-syncs the schedule.
            Result.success()
        }
    }
}
