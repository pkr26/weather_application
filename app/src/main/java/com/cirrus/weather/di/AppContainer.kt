package com.cirrus.weather.di

import android.content.Context
import com.cirrus.weather.BuildConfig
import com.cirrus.weather.data.local.LastKnownWeatherStore
import com.cirrus.weather.data.local.SettingsStore
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.repo.WeatherRepository
import com.cirrus.weather.notify.AlertUseCase
import com.cirrus.weather.notify.BriefingUseCase
import com.cirrus.weather.notify.DeviceRegistrar
import com.cirrus.weather.notify.Notifier
import com.cirrus.weather.notify.activeCity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Manual dependency container — small app, no DI framework needed.
 */
class AppContainer(context: Context) {

    val appContext: Context = context.applicationContext

    /** App-lifetime scope for fire-and-forget work (device registration, schedulers). */
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val json: Json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    // When the backend is deployed with API_TOKEN set, every request carries
    // it — an empty token (the default) sends nothing and the API stays open.
    private val apiTokenInterceptor = Interceptor { chain ->
        val request =
            if (BuildConfig.API_TOKEN.isNotBlank()) {
                chain.request().newBuilder()
                    .header("X-Api-Token", BuildConfig.API_TOKEN)
                    .build()
            } else {
                chain.request()
            }
        chain.proceed(request)
    }

    private val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // Bounds the whole call (connection + headers + body): a slow proxy
        // dribbling bytes under the read timeout can no longer hang a refresh.
        .callTimeout(45, TimeUnit.SECONDS)
        // On-disk HTTP cache: when the backend serves cacheable responses
        // (geocode, languages) they survive process death and short offline
        // windows without any extra code.
        .cache(okhttp3.Cache(File(context.cacheDir, "http_cache"), 5L * 1024 * 1024))
        .addInterceptor(apiTokenInterceptor)
        .build()

    val cirrusApi: CirrusApi = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .client(okHttp)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(CirrusApi::class.java)

    val settings: SettingsStore = SettingsStore(context)

    /** Last-known weather per city — powers the offline "stale but shown" path. */
    val lastKnownWeather: LastKnownWeatherStore = LastKnownWeatherStore(context)

    val weatherRepository: WeatherRepository = WeatherRepository(cirrusApi, lastKnownWeather)

    /** Keeps the backend device registry in sync with local preferences. */
    val deviceRegistrar: DeviceRegistrar = DeviceRegistrar(
        identity = settings,
        api = cirrusApi,
        activeCity = { activeCity() },
        settings = settings,
    )

    /** Notification work, extracted from the workers so the flow is readable. */
    val briefingUseCase = BriefingUseCase(
        api = cirrusApi,
        prefs = settings,
        activeCity = { activeCity() },
        showBriefing = { title, body, cityId ->
            Notifier.showBriefing(appContext, title, body, cityId)
        },
    )
    val alertUseCase = AlertUseCase(
        api = cirrusApi,
        prefs = settings,
        activeCity = { activeCity() },
        showAlert = { notificationId, headline, description, cityId ->
            Notifier.showAlert(appContext, notificationId, headline, description, cityId)
        },
    )
}
