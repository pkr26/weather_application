package com.cirrus.weather.data.repo

import com.cirrus.weather.data.local.LastKnownWeatherStore
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.dto.BundleResponse
import com.cirrus.weather.domain.CurrentUi
import com.cirrus.weather.domain.WeatherBundle
import com.cirrus.weather.domain.toAlertUis
import com.cirrus.weather.domain.toCurrentUi
import com.cirrus.weather.domain.toDayUis
import com.cirrus.weather.domain.toHourUis
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * Loads weather through the Cirrus backend. The backend performs the five
 * upstream calls server-side (with caching), so the app makes one
 * round-trip per refresh and no API key ships in the APK.
 *
 * Also keeps a last-known copy of every fetched bundle (keyed by city id):
 * on a successful load it is persisted; when the network is unavailable the
 * UI can hydrate yesterday's/morning's numbers flagged as stale instead of
 * showing a dead error screen.
 */
class WeatherRepository(
    private val api: CirrusApi,
    private val lastKnown: LastKnownWeatherStore? = null,
) {

    suspend fun loadBundle(
        latitude: Double,
        longitude: Double,
        cacheKey: String? = null,
        languageCode: String = "en",
    ): WeatherBundle {
        val b = api.bundle(latitude, longitude, languageCode)
        if (cacheKey != null && lastKnown != null) {
            withContext(Dispatchers.IO) { lastKnown.put(cacheKey, b) }
        }
        return b.toWeatherBundle()
    }

    /** The last successfully fetched bundle for this city, with its true fetch time. */
    suspend fun cachedBundle(cacheKey: String): WeatherBundle? {
        val store = lastKnown ?: return null
        val (b, fetchedAtMs) = withContext(Dispatchers.IO) { store.get(cacheKey) } ?: return null
        return b.toWeatherBundle().copy(fetchedAt = Instant.ofEpochMilli(fetchedAtMs))
    }

    /** Drops every stored snapshot for a city (all its coordinate variants). */
    suspend fun clearCityCache(cityId: String) {
        val store = lastKnown ?: return
        withContext(Dispatchers.IO) { store.removeAll(cityId) }
    }

    /** Minimal fetch used by the city list cards. */
    suspend fun loadMini(latitude: Double, longitude: Double): CurrentUi =
        api.current(latitude, longitude).toCurrentUi()

    private fun BundleResponse.toWeatherBundle(): WeatherBundle {
        val timeZoneId = currentConditions.timeZone?.id
            ?: forecastHours.timeZone?.id
            ?: forecastDays.timeZone?.id
            ?: "UTC"

        return WeatherBundle(
            timeZoneId = timeZoneId,
            current = currentConditions.toCurrentUi(),
            hours = forecastHours.toHourUis(),
            days = forecastDays.toDayUis(),
            history = historyHours.toHourUis(),
            alerts = publicAlerts.toAlertUis(),
        )
    }
}
