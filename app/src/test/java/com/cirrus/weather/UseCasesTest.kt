package com.cirrus.weather

import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.dto.BriefingResponse
import com.cirrus.weather.data.remote.dto.BundleResponse
import com.cirrus.weather.data.remote.dto.CurrentConditionsResponse
import com.cirrus.weather.data.remote.dto.LanguagesResponse
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import com.cirrus.weather.data.remote.dto.WeatherAlertDto
import com.cirrus.weather.data.remote.GeocodingResponse
import com.cirrus.weather.data.remote.ReverseGeocodeResponse
import com.cirrus.weather.data.remote.dto.DeviceRegistrationRequest
import com.cirrus.weather.data.remote.dto.DeviceRegistrationResponse
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.notify.AlertUseCase
import com.cirrus.weather.notify.AlertWorker
import com.cirrus.weather.notify.BriefingUseCase
import com.cirrus.weather.notify.BriefingWorker
import com.cirrus.weather.notify.NotificationPrefs
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the notification use cases — the flows the fix commit
 * claimed but never exercised: seen-only-when-posted, the flood cap,
 * null-headline starvation, catch-up dedupe bookkeeping, and briefing
 * day-recording.
 */
class UseCasesTest {

    private val city = SavedCity(id = "hyd", name = "Hyderabad", latitude = 17.0, longitude = 78.0)

    /** In-memory NotificationPrefs capturing markSeen calls. */
    private class FakePrefs : NotificationPrefs {
        var language = "te"
        var units = "metric"
        val seen = mutableSetOf<String>()
        var recordedAtMs: Long? = null

        override suspend fun notifLanguage(): String = language
        override suspend fun unitsKey(): String = units
        override suspend fun seenKeys(): Set<String> = seen.toSet()
        override suspend fun markSeen(keys: Set<String>) { seen += keys }
        override suspend fun recordBriefingPostedAt(epochMs: Long) { recordedAtMs = epochMs }
    }

    private class FakeApi(
        var alertsResponse: PublicAlertsResponse = PublicAlertsResponse(),
        var briefingResponse: BriefingResponse = BriefingResponse(),
    ) : CirrusApi {
        var alertCalls = 0
        var briefingCalls = 0

        override suspend fun bundle(latitude: Double, longitude: Double, languageCode: String): BundleResponse =
            BundleResponse(currentConditions = CurrentConditionsResponse())

        override suspend fun current(latitude: Double, longitude: Double): CurrentConditionsResponse =
            CurrentConditionsResponse()

        override suspend fun geocode(query: String, count: Int): GeocodingResponse = GeocodingResponse()

        override suspend fun reverseGeocode(latitude: Double, longitude: Double): ReverseGeocodeResponse =
            ReverseGeocodeResponse()

        override suspend fun languages(): LanguagesResponse = LanguagesResponse()

        override suspend fun briefing(
            latitude: Double,
            longitude: Double,
            city: String,
            languageCode: String,
            units: String,
        ): BriefingResponse {
            briefingCalls++
            return briefingResponse
        }

        override suspend fun alerts(latitude: Double, longitude: Double, languageCode: String): PublicAlertsResponse {
            alertCalls++
            return alertsResponse
        }

        override suspend fun registerDevice(
            body: DeviceRegistrationRequest,
            deviceSecret: String?,
        ): DeviceRegistrationResponse = DeviceRegistrationResponse()
    }

    private fun alert(h: String?, type: String? = null, start: String? = "2026-09-04T00:00:00Z") =
        WeatherAlertDto(alertType = type, headline = h, eventStartTime = start)

    private fun keyOf(h: String?, start: String? = "2026-09-04T00:00:00Z") =
        AlertWorker.alertKey(h, start)

    // ------------------------------------------------------------- alerts

    @Test
    fun `posted alerts are marked seen`() = runTest {
        val prefs = FakePrefs()
        val api = FakeApi(alertsResponse = PublicAlertsResponse(listOf(alert("Storm coming"))))
        val useCase = AlertUseCase(api, prefs, { city }) { _, _, _, _ -> true }
        useCase.poll()
        assertEquals(setOf(keyOf("Storm coming")), prefs.seen)
    }

    @Test
    fun `a failed post stays unseen so the next poll retries it`() = runTest {
        val prefs = FakePrefs()
        val api = FakeApi(alertsResponse = PublicAlertsResponse(listOf(alert("Storm coming"))))
        val useCase = AlertUseCase(api, prefs, { city }) { _, _, _, _ -> false }
        useCase.poll()
        assertTrue(prefs.seen.isEmpty())

        // Permission restored: the same alert posts on the next poll.
        val retry = AlertUseCase(api, prefs, { city }) { _, _, _, _ -> true }
        retry.poll()
        assertEquals(setOf(keyOf("Storm coming")), prefs.seen)
    }

    @Test
    fun `null-headline alerts never starve the cap`() = runTest {
        // Five alerts with neither headline nor type: previously these
        // occupied all four flood slots forever without ever being shown,
        // silently swallowing every postable alert behind them.
        val unshowable = (0 until 5).map { alert(null, type = null, start = "2026-09-04T0$it:00:00Z") }
        val showable = alert("Real warning", start = "2026-09-04T10:00:00Z")
        val prefs = FakePrefs()
        val api = FakeApi(alertsResponse = PublicAlertsResponse(unshowable + showable))
        val postedKeys = mutableListOf<String>()
        val useCase = AlertUseCase(api, prefs, { city }) { _, headline, _, _ ->
            postedKeys += headline
            true
        }
        useCase.poll()

        // The real warning was posted despite the junk ahead of it…
        assertEquals(listOf("Real warning"), postedKeys)
        // …and everything — junk included — is resolved as seen, so the junk
        // can never re-occupy the cap on the next poll.
        assertEquals(
            (unshowable.map { keyOf(null, it.eventStartTime) } + keyOf("Real warning", "2026-09-04T10:00:00Z")).toSet(),
            prefs.seen,
        )
    }

    @Test
    fun `a typed event stands in for a missing headline`() = runTest {
        val prefs = FakePrefs()
        val api = FakeApi(alertsResponse = PublicAlertsResponse(listOf(alert(null, type = "THUNDERSTORM"))))
        val headlines = mutableListOf<String>()
        val useCase = AlertUseCase(api, prefs, { city }) { _, headline, _, _ ->
            headlines += headline
            true
        }
        useCase.poll()
        assertEquals(listOf("THUNDERSTORM"), headlines)
    }

    @Test
    fun `at most MAX_ALERT_NOTIFICATIONS post per poll`() = runTest {
        val many = (0 until 8).map { alert("Alert $it", start = "2026-09-04T0$it:00:00Z") }
        val prefs = FakePrefs()
        val api = FakeApi(alertsResponse = PublicAlertsResponse(many))
        val posted = mutableListOf<String>()
        val useCase = AlertUseCase(api, prefs, { city }) { _, headline, _, _ ->
            posted += headline
            true
        }
        useCase.poll()
        assertEquals(AlertWorker.MAX_ALERT_NOTIFICATIONS, posted.size)
        // Beyond-cap alerts are marked seen by policy (documented trade-off:
        // 8 simultaneous alerts is a flood, not information).
        assertEquals(many.size, prefs.seen.size)
    }

    @Test
    fun `already-seen alerts are not re-posted`() = runTest {
        val prefs = FakePrefs()
        prefs.seen += keyOf("Storm coming")
        val api = FakeApi(alertsResponse = PublicAlertsResponse(listOf(alert("Storm coming"))))
        val posted = mutableListOf<String>()
        val useCase = AlertUseCase(api, prefs, { city }) { _, headline, _, _ ->
            posted += headline
            true
        }
        useCase.poll()
        assertTrue(posted.isEmpty())
    }

    @Test
    fun `no cities means no polling at all`() = runTest {
        val api = FakeApi()
        val useCase = AlertUseCase(api, FakePrefs(), { null }) { _, _, _, _ -> true }
        useCase.poll()
        assertEquals(0, api.alertCalls)
    }

    // ----------------------------------------------------------- briefing

    @Test
    fun `a posted briefing records the epoch day`() = runTest {
        val prefs = FakePrefs()
        val api = FakeApi(briefingResponse = BriefingResponse(title = "Today", body = "Sunny"))
        val useCase = BriefingUseCase(api, prefs, { city }) { _, _, _ -> true }
        assertTrue(useCase.post())
        assertNotNull(prefs.recordedAtMs)
    }

    @Test
    fun `a failed briefing post does not record the day`() = runTest {
        val prefs = FakePrefs()
        val api = FakeApi()
        val useCase = BriefingUseCase(api, prefs, { city }) { _, _, _ -> false }
        assertFalse(useCase.post())
        assertEquals(null, prefs.recordedAtMs)
    }

    @Test
    fun `no cities means no briefing`() = runTest {
        val api = FakeApi()
        val useCase = BriefingUseCase(api, FakePrefs(), { null }) { _, _, _ -> true }
        assertFalse(useCase.post())
        assertEquals(0, api.briefingCalls)
    }

    @Test
    fun `a blank briefing title falls back to the city name`() = runTest {
        val api = FakeApi(briefingResponse = BriefingResponse(title = "", body = "Rain later"))
        val titles = mutableListOf<String>()
        val useCase = BriefingUseCase(api, FakePrefs(), { city }) { title, _, _ ->
            titles += title
            true
        }
        useCase.post()
        assertEquals(listOf(city.displayName), titles)
    }
}

class BriefingChainPolicyTest {
    @Test
    fun `a scheduled success re-arms the chain`() {
        assertTrue(BriefingWorker.rescheduleAfterPost(isCatchUp = false))
    }

    @Test
    fun `a catch-up success never appends to the chain`() {
        // The P0-7 fix: the catch-up appending would duplicate every future
        // morning's briefing (chain stays at length 2 indefinitely).
        assertFalse(BriefingWorker.rescheduleAfterPost(isCatchUp = true))
    }
}
