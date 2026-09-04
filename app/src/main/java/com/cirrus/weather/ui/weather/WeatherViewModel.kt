package com.cirrus.weather.ui.weather

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cirrus.weather.R
import com.cirrus.weather.data.repo.WeatherRepository
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.domain.WeatherBundle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt

/** How often the view model silently re-fetches the bundle. */
private const val REFRESH_INTERVAL_MS = 10 * 60 * 1000L

/** Safety floor for the silent-refresh loop — never spin without suspending. */
private const val SPIN_GUARD_INTERVAL_MS = 60_000L

sealed interface WeatherUiState {
    data object Loading : WeatherUiState

    /**
     * Fresh, usable data. [stale] is true when the last refresh failed and
     * this is the previously-loaded bundle — the UI must tell the user the
     * numbers on screen may be out of date instead of failing silently.
     */
    data class Ready(val bundle: WeatherBundle, val stale: Boolean = false) : WeatherUiState

    /**
     * Full-error state. Carries a string resource, not literal copy — user
     * facing text belongs in strings.xml with everything else (and stays
     * translatable).
     */
    data class Error(val messageRes: Int) : WeatherUiState
}

/**
 * Cache/ownership key for one city snapshot: id plus rounded coordinates, so
 * the moving device city ("device", new pin) never hydrates or keeps the
 * previous pin's numbers, while fixed cities keep a stable key.
 */
fun SavedCity.weatherCacheKey(): String =
    "$id@${(latitude * 1000).roundToInt()},${(longitude * 1000).roundToInt()}"

/**
 * Owns the weather bundle for whichever city is active. One instance lives
 * for the whole activity: [setCity] swaps the data source in place, so old
 * cities never leave abandoned polling loops running in the background.
 */
class WeatherViewModel(
    private val repository: WeatherRepository,
    /** On-screen data language (the backend localizes condition text). */
    private val languageCode: suspend () -> String = { "en" },
) : ViewModel() {

    private val _state = MutableStateFlow<WeatherUiState>(WeatherUiState.Loading)
    val state: StateFlow<WeatherUiState> = _state.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val activeCity = AtomicReference<SavedCity?>(null)
    private var loadJob: Job? = null
    private var autoRefreshJob: Job? = null

    /** True while the host is at least STARTED — pauses background polling. */
    private var screenVisible = true

    /** Cache key of the city the on-screen bundle actually belongs to. */
    private var contentKey: String? = null

    /** Wall-clock deadline of the next silent refresh — survives visibility flaps. */
    @Volatile
    private var nextSilentRefreshAt: Long = 0L

    /**
     * Points the screen at [city]. A no-op when the same coordinates are
     * already showing: identity is the place on the map, not the row id, so
     * re-locating the device (same id "device", new coordinates) reloads.
     */
    fun setCity(city: SavedCity) {
        val current = activeCity.get()
        if (current != null &&
            current.id == city.id &&
            current.latitude == city.latitude &&
            current.longitude == city.longitude
        ) {
            return
        }
        val firstLoad = current == null
        val key = city.weatherCacheKey()
        activeCity.set(city)
        // Cancel whatever the previous city had in flight (load + its
        // auto-refresh cycle) before starting fresh — nothing of the old city
        // keeps running in the background.
        loadJob?.cancel()
        // Keep the previous city's content on screen while the new one loads
        // (the refresh pill signals the swap) — only the very first city
        // shows the branded loading screen. The ownership key below is what
        // keeps a *failed* swap from leaving city A's numbers under city B's
        // name: [fallback] refuses to flag foreign content as merely stale.
        if (firstLoad || _state.value !is WeatherUiState.Ready) {
            _state.value = WeatherUiState.Loading
            // Hydrate the last-known bundle for this city immediately: an
            // offline launch shows this morning's numbers flagged stale
            // instead of a dead error screen.
            viewModelScope.launch {
                val cached = repository.cachedBundle(key)
                if (cached != null && activeCity.get()?.id == city.id &&
                    _state.value is WeatherUiState.Loading
                ) {
                    contentKey = key
                    _state.value = WeatherUiState.Ready(cached, stale = true)
                }
            }
        }
        refresh()
        ensureAutoRefreshLoop()
    }

    /**
     * A single deadline-driven loop per view model: going invisible does not
     * restart the countdown (the deadline keeps ticking), and flapping
     * visibility cannot postpone the silent refresh indefinitely. The
     * deadline itself is owned by [refresh] — every completed attempt, fresh
     * or silent, schedules the next one a full interval out.
     */
    private fun ensureAutoRefreshLoop() {
        if (autoRefreshJob?.isActive == true) return
        autoRefreshJob = viewModelScope.launch {
            while (isActive) {
                val wait = nextSilentRefreshAt - System.currentTimeMillis()
                if (wait > 0) delay(wait)
                if (!isActive) break
                if (System.currentTimeMillis() < nextSilentRefreshAt) continue
                if (screenVisible) {
                    refresh(silent = true) // resets the deadline itself
                } else {
                    nextSilentRefreshAt = System.currentTimeMillis() + REFRESH_INTERVAL_MS
                }
                // Spin guard: if the deadline is somehow still in the past
                // (e.g. refresh skipped on an in-flight load without moving
                // it), re-arm a minute out instead of looping without any
                // suspension point.
                if (nextSilentRefreshAt <= System.currentTimeMillis()) {
                    nextSilentRefreshAt = System.currentTimeMillis() + SPIN_GUARD_INTERVAL_MS
                }
            }
        }
    }

    /**
     * Called by the host on lifecycle START/STOP: background polling pauses
     * with the screen and resumes on the same schedule.
     */
    fun setScreenVisible(visible: Boolean) {
        if (screenVisible == visible) return
        screenVisible = visible
    }

    /**
     * Reloads the bundle. Single-flight: a silent refresh never stacks onto a
     * running one, and a manual refresh replaces whatever is in flight so the
     * freshest request always wins.
     */
    fun refresh(silent: Boolean = false) {
        val city = activeCity.get() ?: return
        if (silent && loadJob?.isActive == true) return
        loadJob?.cancel()
        // Every attempt owns the schedule: the next silent fetch is a full
        // interval after this one, fresh or not.
        nextSilentRefreshAt = System.currentTimeMillis() + REFRESH_INTERVAL_MS
        val key = city.weatherCacheKey()
        loadJob = viewModelScope.launch {
            if (!silent) _refreshing.value = true
            val job = coroutineContext[Job]
            try {
                val bundle = repository.loadBundle(
                    city.latitude,
                    city.longitude,
                    cacheKey = key,
                    languageCode = languageCode(),
                )
                // A cancelled predecessor must not clobber a newer city's data.
                if (activeCity.get()?.id == city.id) {
                    contentKey = key
                    _state.value = WeatherUiState.Ready(bundle)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                if (activeCity.get()?.id == city.id) {
                    _state.value = fallback(key, R.string.error_offline)
                }
            } catch (_: Exception) {
                // No raw exception text on the error screen — users get the
                // plain-language copy; the exception belongs in logs.
                if (activeCity.get()?.id == city.id) {
                    _state.value = fallback(key, R.string.error_generic)
                }
            } finally {
                // Only the request that still owns the spinner may clear it —
                // a cancelled predecessor must not hide a newer refresh's.
                if (loadJob === job) _refreshing.value = false
            }
        }
    }

    /** Keep the last good bundle on refresh failures — flagged stale so the
     *  UI can say so — and only surface a full error screen when there is
     *  nothing to show. Content that belongs to a *different* city is never
     *  passed off as "the last forecast" for the city now on screen: the new
     *  city's own last-known bundle is used, or the error screen. */
    private suspend fun fallback(key: String, messageRes: Int): WeatherUiState {
        if (contentKey == key) {
            return (_state.value as? WeatherUiState.Ready)?.copy(stale = true)
                ?: WeatherUiState.Error(messageRes)
        }
        val cached = repository.cachedBundle(key)
        if (cached != null) {
            contentKey = key
            return WeatherUiState.Ready(cached, stale = true)
        }
        contentKey = null
        return WeatherUiState.Error(messageRes)
    }

    class Factory(
        private val repository: WeatherRepository,
        private val languageCode: suspend () -> String = { "en" },
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            WeatherViewModel(repository, languageCode) as T
    }
}
