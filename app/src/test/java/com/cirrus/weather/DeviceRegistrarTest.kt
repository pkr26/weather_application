package com.cirrus.weather

import com.cirrus.weather.data.remote.dto.BriefingResponse
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.dto.DeviceRegistrationRequest
import com.cirrus.weather.data.remote.dto.DeviceRegistrationResponse
import com.cirrus.weather.data.remote.GeocodingResponse
import com.cirrus.weather.data.remote.dto.LanguagesResponse
import com.cirrus.weather.data.remote.ReverseGeocodeResponse
import com.cirrus.weather.data.remote.dto.CurrentConditionsResponse
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import com.cirrus.weather.data.remote.dto.BundleResponse
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.notify.DeviceIdentity
import com.cirrus.weather.notify.DeviceRegistrar
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/** CirrusApi fake whose register endpoint is scripted per test. */
private class FakeRegistrarApi(
    var onRegister: suspend (body: DeviceRegistrationRequest, secret: String?) -> DeviceRegistrationResponse,
) : CirrusApi {
    var calls = mutableListOf<Pair<DeviceRegistrationRequest, String?>>()

    override suspend fun bundle(latitude: Double, longitude: Double, languageCode: String): BundleResponse =
        BundleResponse()

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
    ): BriefingResponse = BriefingResponse()

    override suspend fun alerts(
        latitude: Double,
        longitude: Double,
        languageCode: String,
    ): PublicAlertsResponse = PublicAlertsResponse()

    override suspend fun registerDevice(
        body: DeviceRegistrationRequest,
        deviceSecret: String?,
    ): DeviceRegistrationResponse {
        calls += body to deviceSecret
        return onRegister(body, deviceSecret)
    }
}

/** In-memory DeviceIdentity with observable reset behaviour. */
private class FakeIdentity(
    var id: String = "device-0001",
    var stored: String? = null,
    /** Simulates a keystore vault that refuses every write. */
    val persistFails: Boolean = false,
) : DeviceIdentity {
    var resets = 0

    override suspend fun deviceId(): String = id

    override suspend fun secret(): String? = stored

    override suspend fun storeSecret(secret: String): Boolean {
        if (persistFails) return false
        stored = secret
        return true
    }

    override suspend fun reset() {
        resets++
        id = "device-minted-${resets}"
        stored = null
    }
}

private class FakeSettings(
    var minutes: Int = 8 * 60,
    var lang: String = "en",
    var units: String = "metric",
    var alerts: Boolean = true,
) : DeviceRegistrar.RegistrationSettings {
    override suspend fun language(): String = lang
    override suspend fun notificationTimeMinutes(): Int = minutes
    override suspend fun units(): String = units
    override suspend fun alertsEnabled(): Boolean = alerts
}

private fun httpError(code: Int, body: String = ""): HttpException =
    HttpException(Response.error<Unit>(code, body.toResponseBody("application/json".toMediaType())))

private val hyderabad = SavedCity(id = "hyd", name = "Hyderabad", latitude = 17.38, longitude = 78.48)

class DeviceRegistrarTest {

    private fun registrar(
        api: CirrusApi,
        identity: DeviceIdentity,
        settings: DeviceRegistrar.RegistrationSettings = FakeSettings(),
    ) = DeviceRegistrar(identity, api, { hyderabad }, settings)

    @Test
    fun `registers with minted id and stores the issued secret`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = null)
        val api = FakeRegistrarApi { _, _ -> DeviceRegistrationResponse(deviceSecret = "fresh-secret") }

        registrar(api, identity).register()

        assertEquals(1, api.calls.size)
        val (body, presented) = api.calls[0]
        assertEquals("device-0001", body.deviceId)
        assertEquals("hyd", body.city.id)
        assertEquals("Hyderabad", body.city.name)
        assertEquals(8, body.notificationTime.hour)
        assertEquals(0, body.notificationTime.minute)
        assertEquals("metric", body.units)
        assertTrue(body.alertsEnabled)
        assertNull(presented) // nothing stored yet — first registration
        assertEquals("fresh-secret", identity.stored)
    }

    @Test
    fun `presents the stored secret so re-registration is an in-place update`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = "existing-secret")
        val api = FakeRegistrarApi { _, _ -> DeviceRegistrationResponse() } // 200: no new secret

        registrar(api, identity).register()

        assertEquals("existing-secret", api.calls[0].second)
        assertEquals("existing-secret", identity.stored) // untouched when none issued
    }

    @Test
    fun `401 resets the identity and registers fresh`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = "stale-secret")
        val api = FakeRegistrarApi { _, _ -> throw httpError(401) }
        var secondCall = false
        api.onRegister = { _, _ ->
            if (secondCall) DeviceRegistrationResponse(deviceSecret = "recovered-secret")
            else { secondCall = true; throw httpError(401) }
        }

        registrar(api, identity).register()

        assertEquals(2, api.calls.size)
        assertEquals(1, identity.resets)
        // Second attempt carries the minted id and no stale secret.
        assertEquals("device-minted-1", api.calls[1].first.deviceId)
        assertNull(api.calls[1].second)
        assertEquals("recovered-secret", identity.stored)
    }

    @Test
    fun `401 twice is swallowed — retried on next app open`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = null)
        val api = FakeRegistrarApi { _, _ -> throw httpError(401) }

        registrar(api, identity).register()

        assertEquals(2, api.calls.size)
        assertEquals(1, identity.resets)
        assertNull(identity.stored)
    }

    @Test
    fun `other HTTP errors are swallowed without reset`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = "secret")
        val api = FakeRegistrarApi { _, _ -> throw httpError(503) }

        registrar(api, identity).register()

        assertEquals(1, api.calls.size)
        assertEquals(0, identity.resets)
        assertEquals("secret", identity.stored)
    }

    @Test
    fun `network failures are swallowed without reset`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = null)
        val api = FakeRegistrarApi { _, _ -> throw java.io.IOException("offline") }

        registrar(api, identity).register()

        assertEquals(1, api.calls.size)
        assertEquals(0, identity.resets)
    }

    @Test
    fun `cancellation propagates instead of being swallowed`() = runTest {
        val identity = FakeIdentity()
        val api = FakeRegistrarApi { _, _ -> throw CancellationException("cancelled") }

        var propagated = false
        try {
            registrar(api, identity).register()
        } catch (e: CancellationException) {
            propagated = true
        }
        assertTrue(propagated)
        assertEquals(0, identity.resets)
    }

    @Test
    fun `cancellation during 401 recovery propagates too`() = runTest {
        val identity = FakeIdentity()
        val api = FakeRegistrarApi { _, _ -> throw httpError(401) }
        var secondCall = false
        api.onRegister = { _, _ ->
            if (secondCall) throw CancellationException("cancelled")
            else { secondCall = true; throw httpError(401) }
        }

        var propagated = false
        try {
            registrar(api, identity).register()
        } catch (e: CancellationException) {
            propagated = true
        }
        assertTrue(propagated)
    }

    @Test
    fun `notification time splits into hours and minutes`() = runTest {
        val identity = FakeIdentity()
        val api = FakeRegistrarApi { _, _ -> DeviceRegistrationResponse() }

        registrar(api, identity, FakeSettings(minutes = 18 * 60 + 45)).register()

        val time = api.calls[0].first.notificationTime
        assertEquals(18, time.hour)
        assertEquals(45, time.minute)
    }

    @Test
    fun `a 401 from the api-token gate never resets the identity`() = runTest {
        // A rotated deployment token is unfixable from the client: resetting
        // would only mint a ghost registry record per app open.
        val identity = FakeIdentity(id = "device-0001", stored = "secret")
        val api = FakeRegistrarApi { _, _ ->
            throw httpError(401, """{"error":"invalid_api_token","message":"no"}""")
        }

        registrar(api, identity).register()

        assertEquals(1, api.calls.size)
        assertEquals(0, identity.resets)
        assertEquals("secret", identity.stored)
    }

    @Test
    fun `an explicit unauthorized body still resets`() = runTest {
        val identity = FakeIdentity(id = "device-0001", stored = null)
        val api = FakeRegistrarApi { _, _ ->
            throw httpError(401, """{"error":"unauthorized","message":"no"}""")
        }
        var secondCall = false
        api.onRegister = { _, _ ->
            if (secondCall) DeviceRegistrationResponse(deviceSecret = "fresh")
            else {
                secondCall = true
                throw httpError(401, """{"error":"unauthorized","message":"no"}""")
            }
        }

        registrar(api, identity).register()

        assertEquals(2, api.calls.size)
        assertEquals(1, identity.resets)
    }

    @Test
    fun `a vault that cannot persist secrets stops the reset churn`() = runTest {
        // First open: server registers us and issues a secret the vault then
        // loses. Second open: the unpresentable secret 401s — but resetting
        // would only orphan another record, so the registrar must stand down.
        // One registrar instance throughout, matching the app's singleton.
        val identity = FakeIdentity(id = "device-0001", persistFails = true)
        val api = FakeRegistrarApi { _, _ -> DeviceRegistrationResponse(deviceSecret = "lost-secret") }
        val reg = registrar(api, identity)

        reg.register() // 200 + secret the vault drops
        api.onRegister = { _, _ -> throw httpError(401) } // takeover refused
        reg.register()

        assertEquals(2, api.calls.size) // one per open — no reset/re-mint extras
        assertEquals(0, identity.resets)
    }
}
