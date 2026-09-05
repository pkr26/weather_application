package com.cirrus.weather

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Geocoder
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cirrus.weather.di.AppContainer
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.notify.Notifier
import com.cirrus.weather.ui.citylist.CityListScreen
import com.cirrus.weather.ui.citylist.CityListViewModel
import com.cirrus.weather.ui.components.BrandedLoading
import com.cirrus.weather.ui.theme.CirrusTheme
import com.cirrus.weather.ui.theme.rememberReducedMotion
import com.cirrus.weather.ui.weather.WeatherScreen
import com.cirrus.weather.ui.weather.WeatherViewModel
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.time.ZoneId
import java.util.Locale
import kotlin.coroutines.resume

class MainActivity : ComponentActivity() {

    /** City id from a notification tap — consumed once, then cleared. */
    private val deepLinkCityId = mutableStateOf<String?>(null)

    private companion object {
        const val STATE_PENDING_DEEP_LINK = "pending_deep_link_city_id"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as CirrusApp).container
        // A pending (not yet consumed) link survives recreation via the
        // instance state; a fresh launch reads it from the intent exactly
        // once (the extra is stripped, so later recreations never replay a
        // consumed link).
        deepLinkCityId.value = savedInstanceState?.getString(STATE_PENDING_DEEP_LINK)
            ?: intent?.getStringExtra(Notifier.EXTRA_CITY_ID)?.also {
                intent?.removeExtra(Notifier.EXTRA_CITY_ID)
            }
        setContent {
            CirrusTheme {
                CirrusAppRoot(container, deepLinkCityId)
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        // Preserve an unconsumed deep link across rotation/font-scale/process
        // death — the splash gate can delay consumption past a recreation.
        deepLinkCityId.value?.let { outState.putString(STATE_PENDING_DEEP_LINK, it) }
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // SINGLE_TOP relaunch from a notification while the app is open.
        deepLinkCityId.value = intent.getStringExtra(Notifier.EXTRA_CITY_ID)
    }
}

@Composable
private fun CirrusAppRoot(container: AppContainer, deepLinkCityId: androidx.compose.runtime.MutableState<String?>) {
    // Saveable: a dark-mode/font-scale/locale change recreates the activity,
    // and the user must not lose the open sheet over the weather screen.
    var showCityList by rememberSaveable { mutableStateOf(false) }
    var showSettings by rememberSaveable { mutableStateOf(false) }

    val cityListViewModel: CityListViewModel = viewModel(
        factory = CityListViewModel.Factory(
            container.settings, container.cirrusApi, container.weatherRepository,
        )
    )

    val settingsViewModel: com.cirrus.weather.ui.settings.SettingsViewModel = viewModel(
        factory = com.cirrus.weather.ui.settings.SettingsViewModel.Factory(container),
    )

    val cities by cityListViewModel.cities.collectAsStateWithLifecycle()
    val activeId by cityListViewModel.activeId.collectAsStateWithLifecycle()
    val unitPref by cityListViewModel.unitPref.collectAsStateWithLifecycle()
    val bootstrapped by cityListViewModel.bootstrapped.collectAsStateWithLifecycle()

    val activeCity = remember(cities, activeId) {
        cities.firstOrNull { it.id == activeId } ?: cities.firstOrNull()
    }

    // One weather view model for the whole activity — it swaps cities in
    // place, so browsing N cities never leaves N background polling loops.
    // On-screen data is fetched in the notification language, so a Telugu
    // user gets Telugu condition text, not English.
    val weatherViewModel: WeatherViewModel = viewModel(
        factory = WeatherViewModel.Factory(container.weatherRepository) {
            container.settings.notificationLanguage.first()
        },
    )

    // Background polling pauses with the screen (STOPPED) and resumes when
    // visible again — no silent 10-minute refresh cycles for pixels nobody
    // sees. Evaluated from lifecycle *state*, not from any single event: the
    // observer also fires for ON_RESUME (which must keep polling on) and is
    // replayed on registration while already RESUMED.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, _ ->
            weatherViewModel.setScreenVisible(
                lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            )
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // First frame: a branded splash until DataStore has said anything at all
    // about the saved cities — never a blank screen, never a bare spinner.
    if (!bootstrapped) {
        BrandedLoading()
        return
    }

    // Notification deep link: open the app on the city the alert/briefing
    // was about, then consume the request exactly once.
    val pendingDeepLink = deepLinkCityId.value
    if (pendingDeepLink != null) {
        LaunchedEffect(pendingDeepLink, cities) {
            cities.firstOrNull { it.id == pendingDeepLink }?.let { city ->
                cityListViewModel.select(city)
            }
            deepLinkCityId.value = null
        }
    }

    val city: SavedCity = activeCity ?: run {
        EmptyHome(onAddCity = { showCityList = true })
        return
    }
    // Keyed on coordinates, not just the id: re-locating the device keeps
    // the id "device" but moves the pin — the screen must follow the pin.
    LaunchedEffect(city.id, city.latitude, city.longitude) { weatherViewModel.setCity(city) }
    val weatherState by weatherViewModel.state.collectAsStateWithLifecycle()
    val refreshing by weatherViewModel.refreshing.collectAsStateWithLifecycle()

    val locatePermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            container.requestDeviceLocation { located ->
                cityListViewModel.setDeviceCity(located ?: return@requestDeviceLocation)
            }
        }
    }

    val onLocateMe: () -> Unit = {
        val granted = ContextCompat.checkSelfPermission(
            container.appContext, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            container.requestDeviceLocation { located ->
                cityListViewModel.setDeviceCity(located ?: return@requestDeviceLocation)
            }
        } else {
            locatePermissionLauncher.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
        }
    }

    // ------------------------------------------------ first-run onboarding
    // The one question a weather app must ask: "where are you?". Asked once,
    // opt-in, and never blocking — declining simply keeps the default city.
    // Tri-stated: `null` means DataStore has not answered yet, and the
    // dialog must not flash for returning users during that window.
    val onboardingDone by remember {
        container.settings.onboardingDone.map { it as Boolean? }
    }.collectAsStateWithLifecycle(initialValue = null)
    var onboardingHandled by remember { mutableStateOf(false) }
    if (onboardingDone == false && !onboardingHandled) {
        val hasPermission = ContextCompat.checkSelfPermission(
            container.appContext, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (hasPermission) {
            // Reinstall (or permission granted outside the app): locate
            // silently instead of asking again.
            LaunchedEffect(Unit) {
                container.applicationScope.launch { container.settings.setOnboardingDone() }
                onboardingHandled = true
                container.requestDeviceLocation { located ->
                    cityListViewModel.setDeviceCity(located ?: return@requestDeviceLocation)
                }
            }
        } else {
            FirstRunLocationDialog(
                onUseLocation = {
                    container.applicationScope.launch { container.settings.setOnboardingDone() }
                    onboardingHandled = true
                    onLocateMe()
                },
                onNotNow = {
                    container.applicationScope.launch { container.settings.setOnboardingDone() }
                    onboardingHandled = true
                },
            )
        }
    }

    // Back gesture / button closes the topmost sheet instead of leaving the
    // app. While settings is open it owns back exclusively.
    BackHandler(enabled = showSettings) { showSettings = false }
    BackHandler(enabled = showCityList && !showSettings) { showCityList = false }

    // Modal-sheet choreography: the list slides up over the weather screen,
    // which gently sinks and dims; reversed when the sheet is dismissed.
    // With system animations disabled the sheets snap — motion choreography
    // is exactly what "reduce motion" asks to remove.
    val reducedMotion = rememberReducedMotion()
    // AnimatedContent disposes the outgoing branch once the transition ends,
    // which would throw away every rememberSaveable below it — the weather
    // screen's scroll position, row expansions and entrance played-flags
    // reset to first-frame on the single most common navigation gesture. A
    // shared holder keyed per screen keeps that state alive across sheet
    // toggles and hands it back on re-entry.
    val stateHolder = rememberSaveableStateHolder()
    AnimatedContent(
        targetState = when {
            showSettings -> "settings"
            showCityList -> "cities"
            else -> "weather"
        },
        transitionSpec = {
            val slide = if (reducedMotion) snap<IntOffset>() else tween<IntOffset>(380)
            val fade = if (reducedMotion) snap<Float>() else tween<Float>(220)
            if (targetState != "weather") {
                (slideInVertically(slide) { it } + fadeIn(fade)) togetherWith
                    (slideOutVertically(slide) { -it / 10 } + fadeOut(fade))
            } else {
                (slideInVertically(slide) { -it / 10 } + fadeIn(fade)) togetherWith
                    (slideOutVertically(slide) { it } + fadeOut(fade))
            }
        },
        label = "rootNav",
    ) { screen ->
        stateHolder.SaveableStateProvider(screen) {
            when (screen) {
                "settings" -> com.cirrus.weather.ui.settings.SettingsScreen(
                    viewModel = settingsViewModel,
                    onBack = { showSettings = false },
                )
                "cities" -> CityListScreen(
                    viewModel = cityListViewModel,
                    onCityChosen = { showCityList = false },
                    onBack = { showCityList = false },
                    onLocateMe = onLocateMe,
                    onOpenSettings = { showSettings = true },
                )
                else -> WeatherScreen(
                    city = city,
                    state = weatherState,
                    unitPref = unitPref,
                    refreshing = refreshing,
                    onRefresh = weatherViewModel::refresh,
                    onOpenCities = { showCityList = true },
                )
            }
        }
    }
}

/** Honest empty state when the user deleted every city — not an eternal splash. */
@Composable
private fun EmptyHome(onAddCity: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.empty_home_message))
        Button(
            onClick = onAddCity,
            modifier = Modifier.padding(top = 16.dp),
        ) {
            Text(stringResource(R.string.empty_home_add_city))
        }
    }
}

@Composable
private fun FirstRunLocationDialog(
    onUseLocation: () -> Unit,
    onNotNow: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onNotNow,
        title = { Text(stringResource(R.string.onboarding_title)) },
        text = { Text(stringResource(R.string.onboarding_message)) },
        confirmButton = {
            TextButton(onClick = onUseLocation) {
                Text(stringResource(R.string.onboarding_use_location))
            }
        },
        dismissButton = {
            TextButton(onClick = onNotNow) {
                Text(stringResource(R.string.onboarding_not_now))
            }
        },
    )
}

/**
 * Resolves the device location (needs permission already granted by the
 * caller) to a named city. Name resolution is a chain: platform Geocoder →
 * backend reverse geocoding → the generic "My Location" label — so devices
 * without a Geocoder backend (emulators, many AOSP builds) still get a real
 * place name. All network work runs off the main thread, and the whole
 * attempt — location fix included — is bounded by a timeout: a Play
 * Services vendor bug that never calls back can never wedge the flow.
 */
@SuppressLint("MissingPermission")
fun AppContainer.requestDeviceLocation(onResult: (SavedCity?) -> Unit) {
    val client = LocationServices.getFusedLocationProviderClient(appContext)
    applicationScope.launch {
        val location = withTimeoutOrNull(LOCATION_FIX_TIMEOUT_MS) {
            suspendCancellableCoroutine { cont ->
                client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
                    .addOnSuccessListener { location ->
                        if (cont.isActive) cont.resume(location)
                    }
                    .addOnFailureListener {
                        if (cont.isActive) cont.resume(null)
                    }
            }
        }
        if (location == null) {
            withContext(Dispatchers.Main) { onResult(null) }
            return@launch
        }
        val place = withTimeoutOrNull(GEOCODE_TIMEOUT_MS) {
            withContext(Dispatchers.IO) { platformGeocoderName(location.latitude, location.longitude) }
        } ?: runCatching {
            withTimeoutOrNull(GEOCODE_TIMEOUT_MS) {
                withContext(Dispatchers.IO) {
                    cirrusApi.reverseGeocode(location.latitude, location.longitude)
                }
            }
        }.getOrNull()?.let { rev ->
            rev.name?.let { Place(it, rev.admin1 ?: "", rev.country ?: "") }
        }

        val resolved = SavedCity(
            id = "device",
            name = place?.name ?: appContext.getString(R.string.my_location),
            region = place?.admin1 ?: "",
            country = place?.country ?: "",
            latitude = location.latitude,
            longitude = location.longitude,
            // The phone's zone matches where it physically is; the weather
            // bundle's zone refines the screen, but the registry needs a
            // sane value for notification timing.
            timeZone = ZoneId.systemDefault().id,
            isDeviceLocation = true,
        )
        withContext(Dispatchers.Main) { onResult(resolved) }
    }
}

/** Blocking platform Geocoder call — returns null when absent or empty. */
private fun AppContainer.platformGeocoderName(lat: Double, lon: Double): Place? {
    if (!Geocoder.isPresent()) return null
    return runCatching {
        @Suppress("DEPRECATION")
        Geocoder(appContext, Locale.getDefault())
            .getFromLocation(lat, lon, 1)
            ?.firstOrNull()
            ?.let { geo ->
                val name = geo.locality ?: geo.subAdminArea ?: geo.adminArea
                if (name.isNullOrBlank()) null
                else Place(name, geo.adminArea ?: "", geo.countryName ?: "")
            }
    }.getOrNull()
}

private data class Place(val name: String, val admin1: String, val country: String)

private const val GEOCODE_TIMEOUT_MS = 5_000L
private const val LOCATION_FIX_TIMEOUT_MS = 15_000L
