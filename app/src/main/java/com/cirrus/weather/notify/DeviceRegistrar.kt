package com.cirrus.weather.notify

import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.DeviceCityRequest
import com.cirrus.weather.data.remote.DeviceRegistrationRequest
import com.cirrus.weather.data.remote.DeviceRegistrationResponse
import com.cirrus.weather.data.remote.NotificationTimeRequest
import com.cirrus.weather.domain.SavedCity
import kotlinx.coroutines.CancellationException
import retrofit2.HttpException

/**
 * The device's registry identity: an opaque ID plus the secret that proves
 * ownership. Implemented over DataStore (+ Keystore-backed secret storage);
 * faked in unit tests.
 */
interface DeviceIdentity {
    /** Reads the device id, minting one on first use. */
    suspend fun deviceId(): String

    /** The stored secret, or null when none has been issued yet. */
    suspend fun secret(): String?

    /** Persists a freshly issued secret. */
    suspend fun storeSecret(secret: String)

    /** Forgets id and secret — used when the server no longer knows us. */
    suspend fun reset()
}

/**
 * Keeps the backend's device registry in sync with local preferences
 * (language, city, notification time, units). Fire-and-forget: called on
 * app open and whenever notification settings change.
 *
 * If the server answers 401 (registry rebuilt, or the record was pruned by
 * its TTL), the client mints a fresh identity and registers once more —
 * that is the sanctioned recovery path now that the server refuses
 * unauthenticated takeovers.
 */
class DeviceRegistrar(
    private val identity: DeviceIdentity,
    private val api: CirrusApi,
    private val activeCity: suspend () -> SavedCity,
    private val settings: RegistrationSettings,
) {

    /** Preferences that ride along with every registration. */
    interface RegistrationSettings {
        suspend fun language(): String
        suspend fun notificationTimeMinutes(): Int
        suspend fun units(): String
        suspend fun alertsEnabled(): Boolean
    }

    suspend fun register() {
        try {
            doRegister()
        } catch (e: CancellationException) {
            throw e
        } catch (e: HttpException) {
            if (e.code() == 401) {
                // The server no longer accepts this identity (registry
                // rebuilt / record pruned): mint a fresh one, register once.
                identity.reset()
                try {
                    doRegister()
                } catch (ce: CancellationException) {
                    throw ce
                } catch (_: Exception) {
                    // Best-effort sync; retried on next app open.
                }
            }
            // Other HTTP errors follow the same best-effort policy as below.
        } catch (_: Exception) {
            // Best-effort sync; retried on next app open / settings change.
        }
    }

    private suspend fun doRegister(): DeviceRegistrationResponse {
        val city = activeCity()
        val time = settings.notificationTimeMinutes()
        val response = api.registerDevice(
            DeviceRegistrationRequest(
                deviceId = identity.deviceId(),
                language = settings.language(),
                city = DeviceCityRequest(
                    id = city.id,
                    name = city.displayName,
                    latitude = city.latitude,
                    longitude = city.longitude,
                    timeZone = city.timeZone,
                ),
                notificationTime = NotificationTimeRequest(time / 60, time % 60),
                units = settings.units(),
                alertsEnabled = settings.alertsEnabled(),
            ),
            // Presenting the stored secret makes this an in-place update
            // instead of a fresh registration on every app open.
            deviceSecret = identity.secret(),
        )
        response.deviceSecret?.let { identity.storeSecret(it) }
        return response
    }
}
