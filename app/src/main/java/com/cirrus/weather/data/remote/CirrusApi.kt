package com.cirrus.weather.data.remote

import com.cirrus.weather.data.remote.dto.CurrentConditionsResponse
import com.cirrus.weather.data.remote.dto.ForecastDaysResponse
import com.cirrus.weather.data.remote.dto.ForecastHoursResponse
import com.cirrus.weather.data.remote.dto.HistoryHoursResponse
import com.cirrus.weather.data.remote.dto.PublicAlertsResponse
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * The dedicated Cirrus backend. All weather/geocoding traffic goes through
 * it — the Google Weather API key never ships inside the APK — and it is
 * also the source of localized notification content and the language
 * catalog, plus the device registry for server-side dispatch.
 */
interface CirrusApi {

    /** Full weather bundle for one location in a single round-trip. */
    @GET("weather/bundle")
    suspend fun bundle(
        @Query("lat") latitude: Double,
        @Query("lon") longitude: Double,
        @Query("lang") languageCode: String = "en",
    ): BundleResponse

    /** Minimal current conditions (city list cards). */
    @GET("weather/current")
    suspend fun current(
        @Query("lat") latitude: Double,
        @Query("lon") longitude: Double,
    ): CurrentConditionsResponse

    /** Worldwide city search (proxied Open-Meteo geocoding). */
    @GET("geocode")
    suspend fun geocode(
        @Query("name") query: String,
        @Query("count") count: Int = 12,
    ): GeocodingResponse

    /** Coordinates → place name, for devices whose platform Geocoder is absent. */
    @GET("geocode/reverse")
    suspend fun reverseGeocode(
        @Query("lat") latitude: Double,
        @Query("lon") longitude: Double,
    ): ReverseGeocodeResponse

    /** Notification language catalog for the settings picker. */
    @GET("languages")
    suspend fun languages(): LanguagesResponse

    /** Localized "here's what's happening today" notification content. */
    @GET("notifications/briefing")
    suspend fun briefing(
        @Query("lat") latitude: Double,
        @Query("lon") longitude: Double,
        @Query("city") city: String,
        @Query("lang") languageCode: String,
        @Query("units") units: String,
    ): BriefingResponse

    /** Active severe-weather alerts (already localized where available). */
    @GET("notifications/alerts")
    suspend fun alerts(
        @Query("lat") latitude: Double,
        @Query("lon") longitude: Double,
        @Query("lang") languageCode: String,
    ): PublicAlertsResponse

    /**
     * Registers/updates this device so the backend knows its language, city
     * and time. When [deviceSecret] is presented and matches, the backend
     * updates the record in place; a fresh secret comes back only on first
     * registration (or rotation).
     */
    @POST("devices")
    suspend fun registerDevice(
        @Body body: DeviceRegistrationRequest,
        @Header("X-Device-Secret") deviceSecret: String? = null,
    ): DeviceRegistrationResponse
}

// ---------------------------------------------------------------- models

@Serializable
data class BundleResponse(
    val currentConditions: CurrentConditionsResponse = CurrentConditionsResponse(),
    val forecastHours: ForecastHoursResponse = ForecastHoursResponse(),
    val forecastDays: ForecastDaysResponse = ForecastDaysResponse(),
    val historyHours: HistoryHoursResponse = HistoryHoursResponse(),
    val publicAlerts: PublicAlertsResponse = PublicAlertsResponse(),
)

@Serializable
data class LanguageInfo(
    val code: String,
    val nativeName: String,
    val englishName: String,
    val rtl: Boolean = false,
)

@Serializable
data class LanguagesResponse(
    val languages: List<LanguageInfo> = emptyList(),
)

@Serializable
data class BriefingResponse(
    val title: String = "",
    val body: String = "",
    val condition: String = "",
    val highC: Double? = null,
    val lowC: Double? = null,
    val alertCount: Int = 0,
    val language: String = "en",
)

@Serializable
data class DeviceRegistrationRequest(
    val deviceId: String,
    val language: String,
    val city: DeviceCityRequest,
    val notificationTime: NotificationTimeRequest,
    val units: String,
    val alertsEnabled: Boolean = true,
)

@Serializable
data class DeviceRegistrationResponse(
    val deviceId: String = "",
    val updatedAt: String = "",
    /** Present only when the server issued (or rotated) a fresh secret. */
    val deviceSecret: String? = null,
)

@Serializable
data class DeviceCityRequest(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val timeZone: String? = null,
)

@Serializable
data class NotificationTimeRequest(
    val hour: Int,
    val minute: Int,
)
