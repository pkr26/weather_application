package com.cirrus.weather.ui.citylist

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.minimumInteractiveComponentSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.domain.CurrentUi
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.Units
import com.cirrus.weather.ui.components.GlassCard
import com.cirrus.weather.ui.components.WeatherIcons
import com.cirrus.weather.ui.theme.CardHeaderStyle

/**
 * Apple list-view style saved-cities screen with search-as-you-type
 * city discovery and per-city live conditions.
 */
@Composable
fun CityListScreen(
    viewModel: CityListViewModel,
    onCityChosen: () -> Unit,
    onBack: () -> Unit,
    onLocateMe: () -> Unit,
    onOpenSettings: () -> Unit = {},
) {
    val cities by viewModel.cities.collectAsState()
    val mini by viewModel.mini.collectAsState()
    val activeId by viewModel.activeId.collectAsState()
    val query by viewModel.query.collectAsState()
    val search by viewModel.search.collectAsState()
    val unitPref by viewModel.unitPref.collectAsState()
    val storageReset by viewModel.storageReset.collectAsState()

    // Deleting is a destructive, unrecoverable action — it always confirms.
    var pendingDelete by rememberSaveable { mutableStateOf<SavedCity?>(null) }
    var resetBannerDismissed by rememberSaveable { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                androidx.compose.ui.graphics.Brush.verticalGradient(
                    listOf(Color(0xFF1B2A4A), Color(0xFF2A3B5E), Color(0xFF3C4F79))
                )
            ),
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = stringResource(R.string.app_name),
                        fontSize = 22.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                    )
                    Spacer(Modifier.weight(1f))
                    UnitToggle(unitPref, viewModel::setUnitPref)
                    Spacer(Modifier.width(10.dp))
                    IconButton(onClick = onLocateMe) {
                        Icon(
                            Icons.Filled.LocationOn,
                            contentDescription = stringResource(R.string.use_my_location_cd),
                            tint = Color.White,
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = stringResource(R.string.notification_settings_cd),
                            tint = Color.White,
                        )
                    }
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = stringResource(R.string.close_cd),
                            tint = Color.White,
                        )
                    }
                }
            }
            item {
                SearchField(
                    query = query,
                    onQueryChange = viewModel::setQuery,
                    onClear = viewModel::clearSearch,
                )
            }

            when (val s = search) {
                is SearchUi.Results -> {
                    items(s.results, key = { "r-${it.id}-${it.latitude}-${it.longitude}" }) { result ->
                        SearchResultRow(result, Modifier.animateItem()) {
                            viewModel.addCity(result) {
                                onCityChosen()
                            }
                        }
                    }
                }
                SearchUi.Searching -> item(key = "search-status") {
                    SearchStatusRow(stringResource(R.string.searching), Modifier.animateItem())
                }
                SearchUi.NoMatches -> item(key = "search-status") {
                    SearchStatusRow(
                        stringResource(R.string.no_matches, query),
                        Modifier.animateItem(),
                    )
                }
                SearchUi.Failed -> item(key = "search-status") {
                    SearchStatusRow(
                        stringResource(R.string.search_failed),
                        Modifier.animateItem().clickable { viewModel.retrySearch() },
                    )
                }
                SearchUi.Idle -> {
                    if (storageReset && !resetBannerDismissed) {
                        item(key = "storage-reset-banner") {
                            StorageResetBanner(
                                onDismiss = { resetBannerDismissed = true },
                                modifier = Modifier.animateItem(),
                            )
                        }
                    }
                    item {
                        Text(
                            text = stringResource(R.string.my_locations),
                            color = Color.White.copy(alpha = 0.8f),
                            style = CardHeaderStyle,
                            modifier = Modifier
                                .padding(top = 6.dp, start = 4.dp)
                                .animateItem(),
                        )
                    }
                    if (cities.isEmpty()) {
                        // Defensive honesty: the list is never empty in
                        // practice (the device-location city can't be
                        // deleted), but if storage ever loses everything the
                        // header must not float over nothing.
                        item(key = "cities-empty") {
                            Text(
                                text = stringResource(R.string.cities_empty),
                                fontSize = 14.sp,
                                color = Color.White.copy(alpha = 0.7f),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 18.dp, horizontal = 4.dp),
                            )
                        }
                    }
                    items(cities, key = { it.id }) { city ->
                        CityCard(
                            city = city,
                            miniState = mini[city.id],
                            isActive = city.id == activeId,
                            unitPref = unitPref,
                            modifier = Modifier.animateItem(),
                            onClick = {
                                viewModel.select(city)
                                onCityChosen()
                            },
                            onRetryMini = { viewModel.retryMini(city) },
                            onDelete = if (city.isDeviceLocation) null else {
                                { pendingDelete = city }
                            },
                        )
                    }
                }
            }
        }
    }

    pendingDelete?.let { city ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.delete_confirm_title, city.displayName)) },
            text = { Text(stringResource(R.string.delete_confirm_text)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.delete(city)
                    pendingDelete = null
                }) {
                    Text(stringResource(R.string.delete_confirm_yes))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }
}

/** One-time notice when the persisted city list couldn't be decoded. */
@Composable
private fun StorageResetBanner(onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Color(0xFF7A5A1A).copy(alpha = 0.45f))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.cities_reset_banner),
            fontSize = 13.sp,
            color = Color.White.copy(alpha = 0.92f),
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onDismiss, modifier = Modifier.size(40.dp)) {
            Icon(
                Icons.Filled.Close,
                contentDescription = stringResource(R.string.close_cd),
                tint = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun UnitToggle(pref: UnitPref, onChange: (UnitPref) -> Unit) {
    Row(
        modifier = Modifier
            .background(Color.White.copy(alpha = 0.12f), RoundedCornerShape(16.dp))
            .padding(2.dp),
    ) {
        ToggleOption("°C", pref == UnitPref.METRIC) { onChange(UnitPref.METRIC) }
        ToggleOption("°F", pref == UnitPref.IMPERIAL) { onChange(UnitPref.IMPERIAL) }
    }
}

@Composable
private fun ToggleOption(label: String, selected: Boolean, onClick: () -> Unit) {
    val bg by animateColorAsState(
        targetValue = if (selected) Color.White.copy(alpha = 0.22f) else Color.Transparent,
        animationSpec = tween(220),
        label = "toggleBg",
    )
    Box(
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .clip(RoundedCornerShape(14.dp))
            // Selectable, not just clickable: TalkBack announces which of
            // °C/°F is on.
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .background(bg, RoundedCornerShape(14.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = Color.White,
        )
    }
}

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit, onClear: () -> Unit) {
    TextField(
        value = query,
        onValueChange = onQueryChange,
        placeholder = {
            Text(
                stringResource(R.string.search_placeholder),
                color = Color.White.copy(alpha = 0.55f),
            )
        },
        leadingIcon = {
            Icon(
                Icons.Filled.Search,
                contentDescription = stringResource(R.string.search_cd),
                tint = Color.White.copy(alpha = 0.7f),
            )
        },
        trailingIcon = {
            if (query.isNotEmpty()) {
                IconButton(onClick = onClear) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.clear_cd),
                        tint = Color.White.copy(alpha = 0.7f),
                    )
                }
            }
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        shape = RoundedCornerShape(18.dp),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Color.White.copy(alpha = 0.12f),
            unfocusedContainerColor = Color.White.copy(alpha = 0.12f),
            focusedTextColor = Color.White,
            unfocusedTextColor = Color.White,
            cursorColor = Color.White,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
        ),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SearchStatusRow(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = Color.White.copy(alpha = 0.7f),
        fontSize = 14.sp,
        modifier = modifier.padding(vertical = 10.dp, horizontal = 4.dp),
    )
}

@Composable
private fun CityCard(
    city: SavedCity,
    miniState: MiniState?,
    isActive: Boolean,
    unitPref: UnitPref,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    onRetryMini: () -> Unit,
    onDelete: (() -> Unit)?,
) {
    val tint by animateColorAsState(
        targetValue = if (isActive) Color.White.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.10f),
        animationSpec = tween(240),
        label = "cityTint",
    )
    GlassCard(
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick),
        tint = tint,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = city.displayName,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val myLocationLabel = stringResource(R.string.my_location)
                val subtitle = buildList {
                    if (city.isDeviceLocation) add(myLocationLabel)
                    listOf(city.region, city.country).filter { it.isNotBlank() }.let(::addAll)
                }.joinToString(" · ")
                if (subtitle.isNotBlank()) {
                    Text(
                        text = subtitle,
                        fontSize = 13.sp,
                        color = Color.White.copy(alpha = 0.7f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            when (miniState) {
                is MiniState.Loaded -> {
                    val current = miniState.current
                    Text(
                        text = Units.tempNumber(current.temperatureC, unitPref) + "°",
                        fontSize = 34.sp,
                        fontWeight = FontWeight.Thin,
                        color = Color.White,
                    )
                    Spacer(Modifier.width(10.dp))
                    Image(
                        painter = painterResource(
                            WeatherIcons.forCondition(current.conditionType, current.isDaytime)
                        ),
                        contentDescription = null,
                        modifier = Modifier.size(28.dp),
                    )
                }
                MiniState.Failed -> {
                    // A failed card offers an explicit retry instead of spinning forever.
                    Text(
                        text = "—",
                        fontSize = 26.sp,
                        fontWeight = FontWeight.Thin,
                        color = Color.White.copy(alpha = 0.5f),
                    )
                    Spacer(Modifier.width(6.dp))
                    // Default IconButton size = 48dp touch target.
                    IconButton(onClick = onRetryMini) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = stringResource(R.string.retry_mini_cd, city.displayName),
                            tint = Color.White.copy(alpha = 0.55f),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                else -> {
                    androidx.compose.material3.CircularProgressIndicator(
                        color = Color.White.copy(alpha = 0.5f),
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            if (onDelete != null) {
                Spacer(Modifier.width(6.dp))
                // Default IconButton size = 48dp touch target — the old
                // 32dp button invited mis-taps next to a tappable card.
                IconButton(onClick = onDelete) {
                    Icon(
                        Icons.Filled.Delete,
                        contentDescription = stringResource(R.string.delete_city_cd, city.displayName),
                        tint = Color.White.copy(alpha = 0.55f),
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SearchResultRow(result: SearchedPlace, modifier: Modifier = Modifier, onAdd: () -> Unit) {
    GlassCard(
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onAdd),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.LocationOn,
                contentDescription = null,
                tint = Color.White.copy(alpha = 0.6f),
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    text = result.name,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val detail = listOf(result.admin1, result.country)
                    .filter { it.isNotBlank() }
                    .joinToString(" · ")
                if (detail.isNotBlank()) {
                    Text(
                        text = detail,
                        fontSize = 13.sp,
                        color = Color.White.copy(alpha = 0.7f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
