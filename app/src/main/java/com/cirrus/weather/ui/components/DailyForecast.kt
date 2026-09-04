package com.cirrus.weather.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.domain.DayUi
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.Units
import com.cirrus.weather.ui.theme.CardHeaderStyle
import com.cirrus.weather.ui.theme.rememberClock24
import com.cirrus.weather.util.TimeFormats
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** How many days the card shows; the backend sends 10, the UI keeps it digestible. */
private const val DISPLAYED_DAYS = 5

/**
 * The 5-day forecast card. Each row shows an icon, min/max temps and a
 * gradient range bar normalized across the whole 5-day span; today's bar
 * carries a dot for the current temperature. Rows expand on tap — with a
 * rotating chevron so the tap targets are discoverable, and an announced
 * expanded/collapsed state for TalkBack.
 */
@Composable
fun DailyForecastCard(
    days: List<DayUi>,
    currentTempC: Double?,
    unitPref: UnitPref,
    timeZone: ZoneId,
    now: Instant,
    modifier: Modifier = Modifier,
    enterKey: Any? = null,
) {
    val todayEpoch = remember(timeZone, now) {
        TimeFormats.localDate(now, timeZone).toEpochDay()
    }
    val expandedState = stringResource(R.string.row_expanded)
    val collapsedState = stringResource(R.string.row_collapsed)

    GlassCard(modifier = modifier.fillMaxWidth()) {
        if (days.isEmpty()) {
            // A missing daily forecast is a visible, honest line — not a
            // card that silently vanishes from the screen.
            Text(
                text = stringResource(R.string.daily_empty),
                style = CardHeaderStyle.copy(fontSize = 13.sp, letterSpacing = 0.2.sp),
                color = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.padding(vertical = 18.dp),
            )
            return@GlassCard
        }
        val shownDays = remember(days) { days.take(DISPLAYED_DAYS) }
        val globalMin = remember(shownDays) {
            shownDays.mapNotNull { it.minTempC }.minOrNull() ?: 0.0
        }
        val globalMax = remember(shownDays) {
            shownDays.mapNotNull { it.maxTempC }.maxOrNull() ?: 1.0
        }
        // Title states exactly what's shown — if the upstream ever sends
        // fewer days, the card must not over-promise.
        Text(
            text = stringResource(R.string.daily_title, shownDays.size),
            color = Color.White.copy(alpha = 0.85f),
            style = CardHeaderStyle,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Column(modifier = Modifier.animateContentSize()) {
            val hapticFeedback = LocalHapticFeedback.current
            shownDays.forEachIndexed { index, day ->
                // Keyed by date: if the forecast list shifts or truncates on
                // refresh, each row's saved expansion state follows its day
                // instead of migrating to whatever now occupies the index.
                key(day.dateEpochDay) {
                    // Expansion state survives the row scrolling out of the
                    // lazy list, but resets when a different city's forecast
                    // takes over the slot: the saved value carries the key it
                    // belongs to.
                    var expandedFor by rememberSaveable {
                        mutableStateOf<Pair<Any?, Boolean>?>(null)
                    }
                    val savedExpansion = expandedFor
                    val expanded = savedExpansion != null &&
                        savedExpansion.first == enterKey &&
                        savedExpansion.second
                    val label = when (day.dateEpochDay) {
                        todayEpoch -> stringResource(R.string.today)
                        todayEpoch + 1 -> stringResource(R.string.tomorrow)
                        else -> weekdayLabel(day.dateEpochDay)
                    }
                    DayRow(
                        day = day,
                        isToday = day.dateEpochDay == todayEpoch,
                        // Date-based, matching isToday — index-based labels would
                        // call a stale first row "Today" after local midnight.
                        label = label,
                        globalMin = globalMin,
                        globalMax = globalMax,
                        currentTempC = if (day.dateEpochDay == todayEpoch) currentTempC else null,
                        unitPref = unitPref,
                        timeZone = timeZone,
                        expanded = expanded,
                        expandedState = expandedState,
                        collapsedState = collapsedState,
                        onToggle = {
                            hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
                            expandedFor = enterKey to !expanded
                        },
                        barDelayMs = 420 + index * 55,
                        enterKey = enterKey,
                    )
                }
            }
        }
    }
}

@Composable
private fun DayRow(
    day: DayUi,
    isToday: Boolean,
    label: String,
    globalMin: Double,
    globalMax: Double,
    currentTempC: Double?,
    unitPref: UnitPref,
    timeZone: ZoneId,
    expanded: Boolean,
    expandedState: String,
    collapsedState: String,
    onToggle: () -> Unit,
    barDelayMs: Int,
    enterKey: Any?,
) {
    // A spring reads physically natural for a toggle; a fixed tween reads
    // mechanical next to the animated row content.
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = spring(dampingRatio = 0.75f, stiffness = Spring.StiffnessMedium),
        label = "dayChevron",
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .semantics {
                role = Role.Button
                stateDescription = if (expanded) expandedState else collapsedState
            },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                // Grows with text at accessibility font scales instead of
                // vertically clipping — same graceful-degradation policy as
                // the hourly strip's fixed geometry. 48dp keeps the whole
                // row at the Material touch-target minimum.
                .heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontSize = 16.sp,
                fontWeight = if (isToday) FontWeight.SemiBold else FontWeight.Medium,
                color = Color.White,
                // "Tomorrow" at 16sp needs ~74dp — narrower widths wrap it
                // onto a second line inside the 46dp row.
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(84.dp),
            )
            Image(
                painter = painterResource(
                    WeatherIcons.forCondition(day.daytimeConditionType, true)
                ),
                contentDescription = null,
                modifier = Modifier.size(24.dp),
            )
            Box(Modifier.width(46.dp), contentAlignment = Alignment.Center) {
                val p = day.precipProbability?.takeIf { it >= 15 }
                if (p != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PrecipDrop(Modifier.size(8.dp))
                        Text(
                            text = "$p%",
                            fontSize = 12.sp,
                            color = Color.White.copy(alpha = 0.9f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(start = 1.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.width(6.dp))
            Text(
                text = Units.tempDisplay(day.minTempC, unitPref),
                fontSize = 16.sp,
                color = Color.White.copy(alpha = 0.85f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(40.dp),
            )
            RangeBar(
                day = day,
                globalMin = globalMin,
                globalMax = globalMax,
                currentTempC = currentTempC,
                delayMs = barDelayMs,
                enterKey = enterKey,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = Units.tempDisplay(day.maxTempC, unitPref),
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .width(40.dp)
                    .padding(start = 6.dp),
            )
            Icon(
                imageVector = Icons.Rounded.KeyboardArrowDown,
                contentDescription = null,
                tint = Color.White.copy(alpha = 0.7f),
                modifier = Modifier
                    .size(22.dp)
                    .graphicsLayer { rotationZ = rotation },
            )
        }
        if (expanded) {
            ExpandedDayDetails(day, unitPref, timeZone)
        }
    }
}

@Composable
private fun RangeBar(
    day: DayUi,
    globalMin: Double,
    globalMax: Double,
    currentTempC: Double?,
    delayMs: Int,
    enterKey: Any?,
    modifier: Modifier = Modifier,
) {
    val span = (globalMax - globalMin).takeIf { it > 0.01 } ?: 1.0
    // One-shot per city + row: the gradient grows outward from its low end
    // and the current-temperature dot slides in with it, row after row.
    val progress = playOnce(
        key = enterKey ?: day.dateEpochDay,
        delayMs = delayMs.toLong(),
        durationMs = 650,
    )
    // Gradient endpoints are stable per day — computed once in composition,
    // never per draw frame (the entrance sweep re-draws every row ~40×).
    val gradientColors = remember(day.minTempC, day.maxTempC, globalMin, globalMax) {
        listOf(
            tempColor(day.minTempC ?: globalMin),
            tempColor(day.maxTempC ?: globalMax),
        )
    }
    Spacer(
        modifier = modifier
            .height(6.dp)
            .padding(horizontal = 4.dp)
            .drawWithCache {
                val w = size.width
                val h = size.height
                val trackHeight = 3.dp.toPx().coerceAtMost(h)
                val barTop = Offset(0f, h / 2f - trackHeight / 2f)
                val corner = CornerRadius(999f)
                val startFraction = (((day.minTempC ?: globalMin) - globalMin) / span)
                    .toFloat().coerceIn(0f, 1f)
                val endFraction = (((day.maxTempC ?: globalMax) - globalMin) / span)
                    .toFloat().coerceIn(0f, 1f)
                val x0 = startFraction * w
                val x1Full = (endFraction * w).coerceAtLeast(x0 + 2f)
                val gradient =
                    if (x1Full - x0 > 1f) Brush.horizontalGradient(gradientColors, x0, x1Full)
                    else null
                val dotX = currentTempC?.let {
                    (((it - globalMin) / span).toFloat() * w).coerceIn(0f, w)
                }
                onDrawBehind {
                    // Track
                    drawRoundRect(
                        color = Color.White.copy(alpha = 0.18f),
                        topLeft = barTop,
                        size = Size(w, trackHeight),
                        cornerRadius = corner,
                    )
                    val p = progress.value
                    // Gradient fill between this day's min and max, growing
                    // on entrance.
                    val x1 = x0 + (x1Full - x0) * p
                    if (gradient != null && x1 - x0 > 1f) {
                        drawRoundRect(
                            brush = gradient,
                            topLeft = Offset(x0, barTop.y),
                            size = Size(x1 - x0, trackHeight),
                            cornerRadius = corner,
                        )
                    }
                    // Current temperature dot on today's bar
                    if (dotX != null) {
                        val cx = x0 + (dotX - x0) * p
                        drawCircle(
                            color = Color.White.copy(alpha = p),
                            radius = h * 0.82f,
                            center = Offset(cx, h / 2f),
                        )
                        drawCircle(
                            color = tempColor(currentTempC!!).copy(alpha = p),
                            radius = h * 0.52f,
                            center = Offset(cx, h / 2f),
                        )
                    }
                }
            },
    )
}

@Composable
private fun ExpandedDayDetails(day: DayUi, unitPref: UnitPref, timeZone: ZoneId) {
    val clock24 = rememberClock24()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 90.dp, top = 2.dp, bottom = 12.dp, end = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        DetailLine(stringResource(R.string.detail_day), day.daytimeConditionText)
        DetailLine(stringResource(R.string.detail_night), day.nighttimeConditionText)
        day.sunrise?.let {
            DetailLine(stringResource(R.string.detail_sunrise), TimeFormats.hourMinute(it, timeZone, clock24))
        }
        day.sunset?.let {
            DetailLine(stringResource(R.string.detail_sunset), TimeFormats.hourMinute(it, timeZone, clock24))
        }
        DetailLine(
            stringResource(R.string.detail_feels_like),
            "${Units.tempDisplay(day.feelsLikeMinC, unitPref)} – ${Units.tempDisplay(day.feelsLikeMaxC, unitPref)}"
        )
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row {
        Text(
            text = label,
            fontSize = 13.sp,
            color = Color.White.copy(alpha = 0.75f),
            modifier = Modifier.width(72.dp),
        )
        Text(
            text = value,
            fontSize = 13.sp,
            color = Color.White.copy(alpha = 0.92f),
        )
    }
}

private fun weekdayLabel(epochDay: Long): String {
    // Locale-aware short weekday ("Mon"/"lun."/"सोम") — the screen's other
    // copy is backend-localized, so English day names would stick out.
    return java.time.format.DateTimeFormatter.ofPattern("EEE", java.util.Locale.getDefault())
        .format(LocalDate.ofEpochDay(epochDay))
}

/** Apple's cold-to-hot gradient stops — hoisted: this lookup runs twice per
 *  frame during each row's entrance animation, so no per-call allocation. */
private val TEMP_STOPS = listOf(
    -20.0 to Color(0xFF5B6BD6),
    -10.0 to Color(0xFF5B9EFF),
    0.0 to Color(0xFF62C6E8),
    10.0 to Color(0xFF5BC8A8),
    16.0 to Color(0xFF7DC96B),
    20.0 to Color(0xFFC9CE5B),
    25.0 to Color(0xFFE8B84B),
    30.0 to Color(0xFFE88A3C),
    35.0 to Color(0xFFE85B3C),
    40.0 to Color(0xFFD63B3B),
)

/** Maps a celsius temperature onto the gradient stops. */
fun tempColor(celsius: Double): Color {
    val stops = TEMP_STOPS
    if (celsius <= stops.first().first) return stops.first().second
    if (celsius >= stops.last().first) return stops.last().second
    for (i in 0 until stops.size - 1) {
        val (t0, c0) = stops[i]
        val (t1, c1) = stops[i + 1]
        if (celsius in t0..t1) {
            val f = ((celsius - t0) / (t1 - t0)).toFloat()
            return lerpColor(c0, c1, f)
        }
    }
    return stops[4].second
}

private fun lerpColor(a: Color, b: Color, t: Float): Color = Color(
    red = a.red + (b.red - a.red) * t,
    green = a.green + (b.green - a.green) * t,
    blue = a.blue + (b.blue - a.blue) * t,
    alpha = 1f,
)
