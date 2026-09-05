package com.cirrus.weather.ui.weather

import android.app.Activity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import com.cirrus.weather.R
import com.cirrus.weather.domain.ConditionThemes
import com.cirrus.weather.domain.DayUi
import com.cirrus.weather.domain.HourUi
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.WeatherBundle
import com.cirrus.weather.ui.components.AlertBanner
import com.cirrus.weather.ui.components.BrandedLoading
import com.cirrus.weather.ui.components.DailyForecastCard
import com.cirrus.weather.ui.components.HeroHeader
import com.cirrus.weather.ui.components.HourlyForecastCard
import com.cirrus.weather.ui.components.entrance
import com.cirrus.weather.ui.components.modules.CloudCoverModule
import com.cirrus.weather.ui.components.modules.FeelsLikeModule
import com.cirrus.weather.ui.components.modules.HumidityModule
import com.cirrus.weather.ui.components.modules.MoonModule
import com.cirrus.weather.ui.components.modules.PrecipitationModule
import com.cirrus.weather.ui.components.modules.PressureModule
import com.cirrus.weather.ui.components.modules.SunModule
import com.cirrus.weather.ui.components.modules.UvModule
import com.cirrus.weather.ui.components.modules.VisibilityModule
import com.cirrus.weather.ui.components.modules.WindModule
import com.cirrus.weather.ui.fx.AmbientBackground
import com.cirrus.weather.ui.theme.CirrusPalette
import com.cirrus.weather.ui.theme.rememberClock24
import com.cirrus.weather.util.TimeFormats
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId

@Composable
fun WeatherScreen(
    city: SavedCity,
    state: WeatherUiState,
    unitPref: UnitPref,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onOpenCities: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        // Crossfade between Loading / Error / Ready; in-place Ready updates
        // (pull-to-refresh with fresh data) keep the same content key so they
        // don't replay the transition.
        AnimatedContent(
            targetState = state,
            contentKey = { it::class },
            transitionSpec = { fadeIn(tween(420)) togetherWith fadeOut(tween(280)) },
            label = "weatherState",
        ) { s ->
            when (s) {
                is WeatherUiState.Loading -> BrandedLoading()

                is WeatherUiState.Error -> ErrorState(s.messageRes, onRefresh)

                is WeatherUiState.Ready -> ReadyContent(
                    city = city,
                    bundle = s.bundle,
                    unitPref = unitPref,
                    refreshing = refreshing,
                    stale = s.stale,
                    degraded = s.degraded,
                    onRefresh = onRefresh,
                    onOpenCities = onOpenCities,
                )
            }
        }
    }
}

/** Branded loading lives in ui/components/BrandedLoading.kt. */

@Composable
private fun ErrorState(messageRes: Int, onRetry: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF101726)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(64.dp)
                    .background(Color.White.copy(alpha = 0.10f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Warning,
                    contentDescription = null, // the message below carries the meaning
                    tint = CirrusPalette.AlertOrange,
                    modifier = Modifier.size(34.dp),
                )
            }
            Text(
                text = stringResource(messageRes),
                color = Color.White.copy(alpha = 0.85f),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 32.dp),
            )
            Text(
                text = stringResource(R.string.try_again),
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .minimumInteractiveComponentSize()
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.14f), CircleShape)
                    .clickable(role = Role.Button, onClick = onRetry)
                    .padding(horizontal = 24.dp, vertical = 10.dp),
            )
        }
    }
}

/**
 * Flips the status-bar icon color to stay readable over the current weather
 * gradient: dark icons over bright day backgrounds, light icons at night.
 */
@Composable
private fun AdaptiveStatusBar(lightBackground: Boolean) {
    val view = LocalView.current
    DisposableEffect(view, lightBackground) {
        val window = (view.context as? Activity)?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        // No-ops outside an activity (previews) — the cast is deliberately null-safe.
        // Restore the *previous* appearance on dispose, not its opposite.
        val previous = controller?.isAppearanceLightStatusBars
        controller?.isAppearanceLightStatusBars = lightBackground
        onDispose { if (previous != null) controller?.isAppearanceLightStatusBars = previous }
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun ReadyContent(
    city: SavedCity,
    bundle: WeatherBundle,
    unitPref: UnitPref,
    refreshing: Boolean,
    stale: Boolean,
    degraded: Boolean,
    onRefresh: () -> Unit,
    onOpenCities: () -> Unit,
) {
    val zone = remember(bundle.timeZoneId) { TimeFormats.zoneOf(bundle.timeZoneId) }
    // A ticking clock, not a snapshot: the sun-arc dot and the daily rows'
    // "Today"/"Tomorrow" labels must roll over while the screen is open,
    // not wait for the next data refresh to notice midnight passed.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            now = Instant.now()
        }
    }
    val archetype = remember(bundle.current.conditionType, bundle.current.isDaytime) {
        ConditionThemes.archetypeFor(bundle.current.conditionType, bundle.current.isDaytime)
    }
    // Bright day gradients need dark status-bar icons for contrast.
    AdaptiveStatusBar(archetype.bottom.luminance() > 0.5f)
    // "Today" is a calendar fact, not a list position — the same epoch-day
    // rule the daily card uses, shared by the hero, the hourly sunset marker
    // and the sun/moon modules so they can never disagree with the row
    // labeled "Today".
    val todayEpoch = remember(zone, now) {
        TimeFormats.localDate(now, zone).toEpochDay()
    }
    val today = remember(bundle.days, todayEpoch) {
        bundle.days.firstOrNull { it.dateEpochDay == todayEpoch } ?: bundle.days.firstOrNull()
    }
    // Re-choreographs only when a different city's content is composed.
    val enterKey = city.id

    Box(modifier = Modifier.fillMaxSize()) {
        AmbientBackground(
            archetype = archetype,
            windDegrees = bundle.current.windDegrees?.toFloat(),
            modifier = Modifier.fillMaxSize(),
        )

        Column(modifier = Modifier.fillMaxSize()) {
            // Pinned navigation: the saved-cities button and refresh stay
            // reachable no matter how far the forecast is scrolled, with a
            // scrim so scrolled cards dissolve underneath instead of
            // colliding with the buttons and the status bar.
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            listOf(
                                Color.Black.copy(alpha = 0.30f),
                                Color.Black.copy(alpha = 0.12f),
                                Color.Transparent,
                            )
                        )
                    ),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 6.dp)
                        .entrance(enterKey, 0),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircleIconButton(Icons.Filled.List, stringResource(R.string.saved_cities_cd), onOpenCities)
                    Spacer(Modifier.weight(1f))
                    RefreshPill(refreshing, onRefresh)
                }
            }

            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = onRefresh,
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .navigationBarsPadding(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                ) {
                    item {
                        HeroHeader(
                            cityName = city.displayName,
                            weather = bundle,
                            today = today,
                            unitPref = unitPref,
                            modifier = Modifier.entrance(enterKey, 1),
                        )
                    }
                    if (stale || degraded) {
                        // Both notices can be true at once (offline AND a
                        // truncated fetch behind it); each says something the
                        // other does not, so neither displaces the other.
                        item {
                            Column(
                                modifier = Modifier
                                    .padding(top = 4.dp)
                                    .entrance(enterKey, 2),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                if (stale) StaleDataBanner()
                                if (degraded) DegradedDataBanner()
                            }
                        }
                    }
                    if (bundle.alerts.isNotEmpty()) {
                        // Every active alert is shown, in the order the
                        // backend sends them — dropping the second warning of
                        // a storm system is not an option. Each expands
                        // independently.
                        item {
                            Column(
                                modifier = Modifier
                                    .padding(top = 4.dp)
                                    .entrance(enterKey, 2),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                bundle.alerts.forEach { alert ->
                                    AlertBanner(alert = alert, zone = zone)
                                }
                            }
                        }
                    }
                    item {
                        HourlyForecastCard(
                            hours = bundle.hours,
                            unitPref = unitPref,
                            sunsetToday = today?.sunset,
                            timeZone = zone,
                            now = now,
                            modifier = Modifier
                                .padding(top = 10.dp)
                                .entrance(enterKey, 3),
                            enterKey = enterKey,
                        )
                    }
                    item {
                        DailyForecastCard(
                            days = bundle.days,
                            currentTempC = bundle.current.temperatureC,
                            unitPref = unitPref,
                            timeZone = zone,
                            now = now,
                            modifier = Modifier
                                .padding(top = 12.dp)
                                .entrance(enterKey, 4),
                            enterKey = enterKey,
                        )
                    }
                    item {
                        ModuleGrid(
                            bundle = bundle,
                            today = today,
                            unitPref = unitPref,
                            zone = zone,
                            now = now,
                            enterKey = enterKey,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }
                    item {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 20.dp)
                                .entrance(enterKey, 10),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                text = stringResource(R.string.footer_weather_for, city.displayName),
                                fontSize = 13.sp,
                                color = Color.White.copy(alpha = 0.75f),
                            )
                            Text(
                                text = stringResource(
                                    R.string.footer_updated,
                                    TimeFormats.hourMinute(bundle.fetchedAt, zone, rememberClock24()),
                                ),
                                fontSize = 12.sp,
                                color = Color.White.copy(alpha = 0.6f),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CircleIconButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .size(44.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.18f), CircleShape)
            .clickable(onClick = onClick)
            .semantics { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = Color.White)
    }
}

@Composable
private fun RefreshPill(refreshing: Boolean, onRefresh: () -> Unit) {
    val refreshLabel = stringResource(R.string.refresh_cd)
    Box(
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .size(44.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.18f), CircleShape)
            .clickable(enabled = !refreshing, onClick = onRefresh)
            .semantics {
                role = Role.Button
                // The spinner replaces the icon: keep announcing the control
                // so it does not vanish from the accessibility tree mid-refresh.
                contentDescription = refreshLabel
            },
        contentAlignment = Alignment.Center,
    ) {
        if (refreshing) {
            CircularProgressIndicator(
                color = Color.White,
                strokeWidth = 2.dp,
                modifier = Modifier.size(18.dp),
            )
        } else {
            Icon(Icons.Rounded.Refresh, contentDescription = null, tint = Color.White)
        }
    }
}

@Composable
private fun ModuleGrid(
    bundle: WeatherBundle,
    today: DayUi?,
    unitPref: UnitPref,
    zone: ZoneId,
    now: Instant,
    enterKey: Any?,
    modifier: Modifier = Modifier,
) {
    val current = bundle.current
    val peakUvHour: HourUi? = remember(bundle.hours) {
        bundle.hours.take(24).filter { (it.uvIndex ?: 0) > 0 }.maxByOrNull { it.uvIndex ?: 0 }
    }
    // Clock-based, not position-based: with a stale bundle, hours[1] can be
    // hours in the past — "next hour" must mean the hour after now.
    val nextHour = remember(bundle.hours, now) {
        bundle.hours.firstOrNull { it.startTime.isAfter(now) }
    }
    val moonPhase = today?.moonPhase

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // IntrinsicSize.Min keeps both cards in a row equally tall so their
        // footers sit on a shared baseline instead of hanging at different depths.
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .entrance(enterKey, 5),
        ) {
            UvModule(current.uvIndex, peakUvHour, zone, Modifier.weight(1f).fillMaxHeight())
            WindModule(current, unitPref, Modifier.weight(1f).fillMaxHeight())
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .entrance(enterKey, 6),
        ) {
            FeelsLikeModule(current, unitPref, Modifier.weight(1f).fillMaxHeight())
            PrecipitationModule(current, nextHour, unitPref, Modifier.weight(1f).fillMaxHeight())
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .entrance(enterKey, 7),
        ) {
            SunModule(
                sunrise = today?.sunrise,
                sunset = today?.sunset,
                now = now,
                isDaytime = current.isDaytime,
                zone = zone,
                modifier = Modifier.weight(1f).fillMaxHeight(),
            )
            MoonModule(moonPhase, Modifier.weight(1f).fillMaxHeight())
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .entrance(enterKey, 8),
        ) {
            HumidityModule(current, unitPref, Modifier.weight(1f).fillMaxHeight())
            VisibilityModule(current, unitPref, Modifier.weight(1f).fillMaxHeight())
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .entrance(enterKey, 9),
        ) {
            PressureModule(current, bundle.history, unitPref, Modifier.weight(1f).fillMaxHeight())
            CloudCoverModule(current, Modifier.weight(1f).fillMaxHeight())
        }
    }
}

/**
 * Quiet banner shown when the last refresh failed and the screen is serving
 * the previously-loaded bundle: the user must know the numbers may be out of
 * date, but a full error screen would throw away good data.
 */
@Composable
private fun StaleDataBanner(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(0xFF7A621A).copy(alpha = 0.42f), RoundedCornerShape(20.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Info,
            contentDescription = null, // the banner text carries the meaning
            tint = Color.White.copy(alpha = 0.85f),
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(10.dp))
        Text(
            text = stringResource(R.string.stale_banner),
            fontSize = 13.sp,
            color = Color.White.copy(alpha = 0.9f),
        )
    }
}

/**
 * Quiet notice when the backend served a truncated forecast (its degraded
 * flag): the hour/day strips are shorter than promised and the user deserves
 * to know why, but the data shown is fresh — so this is deliberately calmer
 * than the stale banner, and both can appear together.
 */
@Composable
private fun DegradedDataBanner(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(0xFF33415C).copy(alpha = 0.32f), RoundedCornerShape(20.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Info,
            contentDescription = null, // the banner text carries the meaning
            tint = Color.White.copy(alpha = 0.8f),
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(10.dp))
        Text(
            text = stringResource(R.string.degraded_banner),
            fontSize = 13.sp,
            color = Color.White.copy(alpha = 0.85f),
        )
    }
}
