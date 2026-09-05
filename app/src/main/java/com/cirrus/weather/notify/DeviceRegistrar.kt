package com.cirrus.weather.notify

import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.dto.DeviceCityRequest
import com.cirrus.weather.data.remote.dto.DeviceRegistrationRequest
import com.cirrus.weather.data.remote.dto.DeviceRegistrationResponse
import com.cirrus.weather.data.remote.dto.NotificationTimeRequest
import com.cirrus.weather.domain.SavedCity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    /** Persists a freshly issued secret. @return false when not persisted. */
    suspend fun storeSecret(secret: String): Boolean

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
    private val activeCity: suspend () -> SavedCity?,
    private val settings: RegistrationSettings,
) {

    /** Preferences that ride along with every registration. */
    interface RegistrationSettings {
        suspend fun language(): String
        suspend fun notificationTimeMinutes(): Int
        suspend fun units(): String
        suspend fun alertsEnabled(): Boolean
    }

    // register() is called from Application.onCreate AND every settings
    // toggle; without serialization two first-launch callers can interleave
    // their reset/re-mint cycles into a permanently mismatched id/secret pair.
    private val registerMutex = Mutex()

    // Set while the keystore vault refuses to persist secrets: identity
    // resets are pointless until a secret can actually be stored — each one
    // would only mint another orphan server record on the next app open.
    private var vaultBroken = false

    private val json = Json { ignoreUnknownKeys = true }

    suspend fun register() {
        registerMutex.withLock {
            try {
                doRegister()
            } catch (e: CancellationException) {
                throw e
            } catch (e: HttpException) {
                handleUnauthorized(e)
            } catch (_: Exception) {
                // Best-effort sync; retried on next app open / settings change.
            }
        }
    }

    /**
     * A 401 means "this identity is no longer accepted" ONLY when the server
     * is rejecting the *device secret*. The backend distinguishes its two
     * 401s (`unauthorized` vs `invalid_api_token`): a gate failure can never
     * be fixed by resetting the identity, and resetting anyway would mint a
     * ghost record per app open until the registry fills.
     */
    private suspend fun handleUnauthorized(e: HttpException) {
        if (e.code() != 401 || vaultBroken || !e.isDeviceIdentityRejection()) return
        // The server no longer accepts this identity (registry rebuilt /
        // record pruned): mint a fresh one, register once.
        identity.reset()
        try {
            doRegister()
        } catch (ce: CancellationException) {
            throw ce
        } catch (_: Exception) {
            // Best-effort sync; retried on next app open.
        }
    }

    private fun HttpException.isDeviceIdentityRejection(): Boolean {
        // Unreadable/absent bodies keep the historical behavior (reset):
        // older backends only ever said plain "unauthorized" here.
        val body = runCatching { response()?.errorBody()?.string() }.getOrNull()
            ?: return true
        val code = runCatching {
            json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull
        }.getOrNull()
        return code == null || code == "unauthorized"
    }

    private suspend fun doRegister(): DeviceRegistrationResponse? {
        // No cities (the user deleted everything): nothing to register the
        // device against — a made-up default city must not be advertised.
        val city = activeCity() ?: return null
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
        // A secret the vault refused to persist is unusable: remembering it
        // as stored would 401 forever, so the failure flag stays set and
        // blocks identity resets until the vault works again.
        response.deviceSecret?.let { secret ->
            vaultBroken = !identity.storeSecret(secret)
        }
        return response
    }
}
