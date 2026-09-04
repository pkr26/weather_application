package com.cirrus.weather.ui.citylist

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cirrus.weather.data.local.SettingsStore
import com.cirrus.weather.data.remote.CirrusApi
import com.cirrus.weather.data.repo.WeatherRepository
import com.cirrus.weather.domain.CurrentUi
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.domain.UnitPref
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A search hit, already in domain terms — geocoding DTOs stop at this layer. */
data class SearchedPlace(
    val id: String,
    val name: String,
    val admin1: String,
    val country: String,
    val latitude: Double,
    val longitude: Double,
    val timezone: String,
)

/** What the search section under the query field is showing. */
sealed interface SearchUi {
    data object Idle : SearchUi
    data object Searching : SearchUi
    data class Results(val results: List<SearchedPlace>) : SearchUi
    data object NoMatches : SearchUi
    data object Failed : SearchUi
}

/** Mini conditions for one saved-city card: loaded, loading, or failed. */
sealed interface MiniState {
    data class Loaded(val current: CurrentUi) : MiniState
    data object Loading : MiniState
    data object Failed : MiniState
}

private const val MINI_STALE_MS = 10 * 60 * 1000L

class CityListViewModel(
    private val settings: SettingsStore,
    private val api: CirrusApi,
    private val weatherRepository: WeatherRepository,
) : ViewModel() {

    val unitPref: StateFlow<UnitPref> = settings.unitPref
        .stateIn(viewModelScope, SharingStarted.Eagerly, UnitPref.METRIC)

    private val _cities = MutableStateFlow<List<SavedCity>>(emptyList())
    val cities: StateFlow<List<SavedCity>> = _cities.asStateFlow()

    /** True once DataStore has produced its first cities value (splash gate). */
    private val _bootstrapped = MutableStateFlow(false)
    val bootstrapped: StateFlow<Boolean> = _bootstrapped.asStateFlow()

    private val _activeId = MutableStateFlow<String?>(null)
    val activeId: StateFlow<String?> = _activeId.asStateFlow()

    private val _mini = MutableStateFlow<Map<String, MiniState>>(emptyMap())
    val mini: StateFlow<Map<String, MiniState>> = _mini.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    /** True when the persisted list was corrupt and defaults replaced it. */
    val storageReset: StateFlow<Boolean> = settings.citiesWereReset
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val _search = MutableStateFlow<SearchUi>(SearchUi.Idle)
    val search: StateFlow<SearchUi> = _search.asStateFlow()

    /** City-list writes (add/delete/device) run one at a time — no lost updates. */
    private val mutationMutex = Mutex()

    private val miniFetchedAt = MutableStateFlow<Map<String, Long>>(emptyMap())

    init {
        viewModelScope.launch {
            settings.cities.collect { list ->
                _cities.value = list
                _bootstrapped.value = true
                list.forEach { city -> refreshMiniIfStale(city) }
            }
        }
        viewModelScope.launch {
            settings.activeCityId.collect { _activeId.value = it }
        }
        observeSearch()
    }

    fun setQuery(value: String) {
        _query.value = value
    }

    fun clearSearch() {
        _query.value = ""
        _search.value = SearchUi.Idle
    }

    /** Re-runs the current query after a failure. */
    fun retrySearch() {
        if (_query.value.length >= 2) _search.value = SearchUi.Searching
        runSearch(_query.value)
    }

    @OptIn(FlowPreview::class)
    private fun observeSearch() {
        viewModelScope.launch {
            _query
                .debounce(300)
                .distinctUntilChanged()
                .collect { q -> runSearch(q) }
        }
    }

    private fun runSearch(q: String) {
        if (q.isBlank() || q.length < 2) {
            _search.value = SearchUi.Idle
            return
        }
        _search.value = SearchUi.Searching
        viewModelScope.launch {
            val state = try {
                // Map to domain here: hits without coordinates or a name
                // cannot become cities, so they never reach the UI at all.
                val results = api.geocode(q).results.mapNotNull { r ->
                    val lat = r.latitude ?: return@mapNotNull null
                    val lon = r.longitude ?: return@mapNotNull null
                    val name = r.name ?: return@mapNotNull null
                    SearchedPlace(
                        id = r.id ?: "$lat,$lon",
                        name = name,
                        admin1 = r.admin1 ?: "",
                        country = r.country ?: "",
                        latitude = lat,
                        longitude = lon,
                        timezone = r.timezone ?: "UTC",
                    )
                }
                if (results.isEmpty()) SearchUi.NoMatches else SearchUi.Results(results)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e // cancellation is not a search failure
            } catch (_: Exception) {
                SearchUi.Failed
            }
            // Ignore answers that arrived after the query changed again.
            if (_query.value == q) _search.value = state
        }
    }

    fun addCity(result: SearchedPlace, onAdded: (SavedCity) -> Unit) {
        val city = SavedCity(
            id = "geo-${result.id}",
            name = result.name,
            region = result.admin1,
            country = result.country,
            latitude = result.latitude,
            longitude = result.longitude,
            timeZone = result.timezone,
        )
        viewModelScope.launch {
            mutationMutex.withLock {
                val current = _cities.value
                if (current.none { it.id == city.id }) {
                    settings.saveCities(current + city)
                }
                settings.setActiveCity(city.id)
            }
            onAdded(city)
        }
    }

    fun select(city: SavedCity) {
        viewModelScope.launch {
            settings.setActiveCity(city.id)
        }
    }

    fun delete(city: SavedCity) {
        viewModelScope.launch {
            mutationMutex.withLock {
                val remaining = _cities.value.filterNot { it.id == city.id }
                // The last city may be deleted too — the home screen shows an
                // honest empty state with an "add a city" action instead of
                // silently ignoring the delete.
                settings.saveCities(remaining)
                if (_activeId.value == city.id) {
                    settings.setActiveCity(remaining.firstOrNull()?.id ?: "")
                }
            }
        }
    }

    fun setUnitPref(pref: UnitPref) {
        viewModelScope.launch { settings.setUnitPref(pref) }
    }

    fun setDeviceCity(city: SavedCity) {
        viewModelScope.launch {
            mutationMutex.withLock {
                val withoutDevice = _cities.value.filterNot { it.isDeviceLocation }
                settings.saveCities(listOf(city) + withoutDevice)
                settings.setActiveCity(city.id)
            }
        }
    }

    /** Manual retry for a city card whose mini conditions failed to load. */
    fun retryMini(city: SavedCity) {
        refreshMini(city, force = true)
    }

    private fun refreshMiniIfStale(city: SavedCity) {
        val fresh = miniFetchedAt.value[city.id]
        val state = _mini.value[city.id]
        val needsLoad = when (state) {
            null -> true
            MiniState.Loading -> false
            MiniState.Failed -> false // only retried on user tap
            is MiniState.Loaded -> fresh == null || System.currentTimeMillis() - fresh > MINI_STALE_MS
        }
        if (needsLoad) refreshMini(city, force = false)
    }

    private fun refreshMini(city: SavedCity, force: Boolean) {
        if (!force && _mini.value[city.id] is MiniState.Loading) return
        _mini.value = _mini.value + (city.id to MiniState.Loading)
        viewModelScope.launch {
            val current = runCatching {
                weatherRepository.loadMini(city.latitude, city.longitude)
            }.getOrNull()
            // The city may have been deleted while loading — don't resurrect it.
            if (_cities.value.none { it.id == city.id }) return@launch
            _mini.value = if (current != null) {
                miniFetchedAt.value = miniFetchedAt.value + (city.id to System.currentTimeMillis())
                _mini.value + (city.id to MiniState.Loaded(current))
            } else {
                _mini.value + (city.id to MiniState.Failed)
            }
        }
    }

    class Factory(
        private val settings: SettingsStore,
        private val api: CirrusApi,
        private val weatherRepository: WeatherRepository,
    ) : androidx.lifecycle.ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            CityListViewModel(settings, api, weatherRepository) as T
    }
}
