package com.cirrus.weather

import com.cirrus.weather.data.remote.dto.BundleResponse
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.remote.GeocodingResponse
import com.cirrus.weather.data.remote.ReverseGeocodeResponse
import com.cirrus.weather.data.remote.dto.LanguagesResponse
import com.cirrus.weather.data.remote.dto.CurrentConditionsResponse
import com.cirrus.weather.data.remote.dto.TimeZoneDto
import com.cirrus.weather.data.repo.WeatherRepository
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.ui.weather.WeatherUiState
import com.cirrus.weather.ui.weather.WeatherViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException

/**
 * A CirrusApi whose bundle endpoint can be scripted per test. All other
 * endpoints are unused by the view model under test.
 */
private class FakeApi(var behavior: suspend (Double, Double) -> BundleResponse) : CirrusApi {
    var bundleCalls = 0
    override suspend fun bundle(latitude: Double, longitude: Double, languageCode: String): BundleResponse {
        bundleCalls++
        return behavior(latitude, longitude)
    }

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
    ): com.cirrus.weather.data.remote.dto.BriefingResponse = com.cirrus.weather.data.remote.dto.BriefingResponse()

    override suspend fun alerts(
        latitude: Double,
        longitude: Double,
        languageCode: String,
    ): com.cirrus.weather.data.remote.dto.PublicAlertsResponse =
        com.cirrus.weather.data.remote.dto.PublicAlertsResponse()

    override suspend fun registerDevice(
        body: com.cirrus.weather.data.remote.dto.DeviceRegistrationRequest,
        deviceSecret: String?,
    ): com.cirrus.weather.data.remote.dto.DeviceRegistrationResponse =
        com.cirrus.weather.data.remote.dto.DeviceRegistrationResponse()
}

class WeatherViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val hyderabad = SavedCity(id = "hyd", name = "Hyderabad", latitude = 17.0, longitude = 78.0)
    private val delhi = SavedCity(id = "del", name = "Delhi", latitude = 28.0, longitude = 77.0)

    private lateinit var api: FakeApi

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        api = FakeApi { _, _ ->
            BundleResponse(currentConditions = CurrentConditionsResponse(timeZone = TimeZoneDto("Asia/Kolkata")))
        }
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun viewModel(): WeatherViewModel = WeatherViewModel(WeatherRepository(api))

    /**
     * Runs one scenario against a fresh view model and always cancels its
     * scope before the test body ends: the view model's endless
     * auto-refresh loop schedules on the test scheduler, and runTest would
     * otherwise chase its re-scheduling forever at exit.
     */
    private suspend fun TestScope.withViewModel(block: suspend TestScope.(WeatherViewModel) -> Unit) {
        val vm = viewModel()
        try {
            block(vm)
        } finally {
            vm.viewModelScope.cancel()
            runCurrent()
        }
    }

    @Test
    fun `setCity loads the bundle and reaches Ready`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            assertTrue(vm.state.value is WeatherUiState.Ready)
            assertEquals("Asia/Kolkata", (vm.state.value as WeatherUiState.Ready).bundle.timeZoneId)
            assertEquals(1, api.bundleCalls)
        }
    }

    @Test
    fun `setCity with the same id is a no-op`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            vm.setCity(hyderabad.copy(name = "Hyderabad (renamed)"))
            runCurrent()
            assertEquals(1, api.bundleCalls)
        }
    }

    @Test
    fun `switching cities cancels the previous city and reloads`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            vm.setCity(delhi)
            runCurrent()
            assertEquals(2, api.bundleCalls)
            assertTrue(vm.state.value is WeatherUiState.Ready)
        }
    }

    @Test
    fun `a failed first load surfaces the error screen`() = runTest(dispatcher) {
        api.behavior = { _, _ -> throw IOException("backend down") }
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            assertTrue(vm.state.value is WeatherUiState.Error)
        }
    }

    @Test
    fun `a failed manual refresh keeps the last good data`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            assertTrue(vm.state.value is WeatherUiState.Ready)

            api.behavior = { _, _ -> throw IOException("backend down") }
            vm.refresh(silent = false)
            runCurrent()

            // The user still sees weather — losing good data to a failed pull-
            // to-refresh would be worse than the blip itself — but flagged as
            // stale so the UI can say so.
            val state = vm.state.value as WeatherUiState.Ready
            assertEquals(true, state.stale)
            assertEquals(false, vm.refreshing.value)
        }
    }

    @Test
    fun `a successful refresh clears the stale flag`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()

            api.behavior = { _, _ -> throw IOException("backend down") }
            vm.refresh(silent = false)
            runCurrent()
            assertTrue((vm.state.value as WeatherUiState.Ready).stale)

            api.behavior = { _, _ ->
                BundleResponse(currentConditions = CurrentConditionsResponse(timeZone = TimeZoneDto("Asia/Kolkata")))
            }
            vm.refresh(silent = false)
            runCurrent()
            assertEquals(false, (vm.state.value as WeatherUiState.Ready).stale)
        }
    }

    @Test
    fun `re-locating (same id, new coordinates) reloads`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            assertEquals(1, api.bundleCalls)

            // The device moved: same id "device-like", new pin — the screen
            // must follow the pin, not the row id.
            vm.setCity(hyderabad.copy(latitude = 18.0, longitude = 79.0))
            runCurrent()
            assertEquals(2, api.bundleCalls)
        }
    }

    @Test
    fun `offline city switch never shows the previous city as stale`() = runTest(dispatcher) {
        withViewModel { vm ->
            vm.setCity(hyderabad)
            runCurrent()
            assertTrue(vm.state.value is WeatherUiState.Ready)

            // Delhi fails while Hyderabad's good data is on screen: the old
            // content belongs to a different city and must NOT be passed off
            // as Delhi's "last forecast" — the error screen is the honest answer.
            api.behavior = { _, _ -> throw IOException("backend down") }
            vm.setCity(delhi)
            runCurrent()
            assertTrue(vm.state.value is WeatherUiState.Error)
        }
    }
}
