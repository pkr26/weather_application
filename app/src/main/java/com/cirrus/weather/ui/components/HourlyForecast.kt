package com.cirrus.weather.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.domain.HourUi
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.Units
import com.cirrus.weather.ui.theme.CardHeaderStyle
import com.cirrus.weather.ui.theme.rememberClock24
import com.cirrus.weather.util.TimeFormats
import java.time.Instant
import java.time.ZoneId

// Fixed geometry so the curve and the temperature labels stay in lockstep.
private val COLUMN_WIDTH = 62.dp
private val HEADER_STACK = 56.dp     // label(20) + 8 + icon(24) + 4
private val CURVE_HEIGHT = 116.dp
private val CURVE_PAD_TOP = 18.dp
private val CURVE_PAD_BOTTOM = 32.dp

/** Hours shown in the scrolling strip — a full day reads best on the curve. */
private const val STRIP_HOURS = 24

/**
 * The signature Apple-style hourly card: horizontally scrolling columns with
 * a smooth temperature spline threaded through the labels, a highlighted
 * "Now" point, precipitation chances and a sunset marker. On first appearance
 * the curve sweeps in left-to-right and each column fades in with the sweep.
 *
 * Scrolling is discoverable and never the only way in: the strip fades out at
 * its live edge, and tapping the header (or chevron) reveals every hour in an
 * expanded grid — the answer for fingers that drag diagonally or expect a tap
 * to open things up.
 */
@Composable
fun HourlyForecastCard(
    hours: List<HourUi>,
    unitPref: UnitPref,
    sunsetToday: Instant?,
    timeZone: ZoneId,
    now: Instant,
    modifier: Modifier = Modifier,
    enterKey: Any? = null,
) {
    val nowLabel = stringResource(R.string.now)
    val clock24 = rememberClock24()
    // "Now" is matched against the actual clock (not list position) and the
    // label set is keyed on the hour bucket, so a ticking `now` only rebuilds
    // columns when the hour actually rolls over.
    val nowEpochHour = remember(now) { now.epochSecond / 3600 }
    val columns = remember(hours, sunsetToday, timeZone.id, nowEpochHour, clock24) {
        buildColumns(hours.take(STRIP_HOURS), sunsetToday, timeZone, nowLabel, nowEpochHour, clock24)
    }
    val n = columns.size
    // Sweeps once per [enterKey]: pull-to-refresh updates the data in place
    // without replaying, a scroll away-and-back restores the played state,
    // and a different city replays the sweep.
    val reveal = playOnce(enterKey, delayMs = 260, durationMs = 1100)

    // Expansion belongs to the city that owns this card, and survives the row
    // scrolling out of the lazy list.
    val hapticFeedback = LocalHapticFeedback.current
    var expandedFor by rememberSaveable { mutableStateOf<Pair<Any?, Boolean>?>(null) }
    val expanded = expandedFor?.first == enterKey && expandedFor?.second == true
    val expandedHint = stringResource(R.string.hourly_expanded_cd)
    val collapsedHint = stringResource(R.string.hourly_collapsed_cd)

    GlassCard(modifier = modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .minimumInteractiveComponentSize()
                .clickable(role = Role.Button) {
                    hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
                    expandedFor = enterKey to !expanded
                }
                .semantics {
                    role = Role.Button
                    contentDescription = if (expanded) expandedHint else collapsedHint
                },
        ) {
            Text(
                text = stringResource(R.string.hourly_title),
                color = Color.White.copy(alpha = 0.85f),
                style = CardHeaderStyle,
                modifier = Modifier.weight(1f),
            )
            ExpandChevron(expanded)
        }
        Column(modifier = Modifier.animateContentSize()) {
            if (columns.isEmpty()) {
                // A data gap renders as an honest quiet line, never a shell
                // card with a chevron that opens onto nothing.
                Text(
                    text = stringResource(R.string.hourly_empty),
                    style = CardHeaderStyle.copy(fontSize = 13.sp, letterSpacing = 0.2.sp),
                    color = Color.White.copy(alpha = 0.7f),
                    modifier = Modifier.padding(vertical = 18.dp),
                )
            } else {
                HourStrip(columns, unitPref, reveal, n)
                if (expanded) {
                    HourGrid(hours.take(STRIP_HOURS), unitPref, timeZone, Modifier.padding(top = 12.dp))
                }
            }
        }
    }
}

/** Chevron that flips when the card expands — the affordance that says "tap me". */
@Composable
private fun ExpandChevron(expanded: Boolean) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = spring(dampingRatio = 0.75f, stiffness = Spring.StiffnessMedium),
        label = "chevron",
    )
    Icon(
        imageVector = Icons.Rounded.KeyboardArrowDown,
        contentDescription = null,
        tint = Color.White.copy(alpha = 0.7f),
        modifier = Modifier
            .size(26.dp)
            .graphicsLayer { rotationZ = rotation },
    )
}

/**
 * The scrolling strip with live alpha fades at whichever edge can still move.
 * The mask makes the weather gradient bleed through the glass at the edges —
 * a strong "there is more this way" signal.
 */
@Composable
private fun HourStrip(
    columns: List<HourColumn>,
    unitPref: UnitPref,
    reveal: Animatable<Float, AnimationVector1D>,
    n: Int,
) {
    // Saveable: a font-scale/dark-mode recreation keeps the scroll
    // position instead of snapping back to "Now".
    val scrollState = rememberSaveable(saver = ScrollState.Saver) { ScrollState(0) }
    val canScrollBack by remember { derivedStateOf { scrollState.canScrollBackward } }
    val canScrollForward by remember { derivedStateOf { scrollState.canScrollForward } }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 10.dp)
    ) {
        Row(
            modifier = Modifier
                .horizontalScroll(scrollState)
                // The fade brushes live in the draw CACHE: gradient
                // coordinates are absolute in the DrawScope space, so the
                // right-edge brush must span [width-fade, width] — built
                // here where size is known, allocated once per size change,
                // never per scroll frame.
                .drawWithCache {
                    val fade = 22.dp.toPx()
                    val fadeIn = Brush.horizontalGradient(
                        0f to Color.Transparent,
                        1f to Color.Black,
                        startX = 0f,
                        endX = fade,
                    )
                    val fadeOut = Brush.horizontalGradient(
                        0f to Color.Black,
                        1f to Color.Transparent,
                        startX = size.width - fade,
                        endX = size.width,
                    )
                    onDrawWithContent {
                        drawContent()
                        if (canScrollBack) {
                            drawRect(
                                brush = fadeIn,
                                topLeft = Offset.Zero,
                                size = size.copy(width = fade),
                                blendMode = BlendMode.DstIn,
                            )
                        }
                        if (canScrollForward) {
                            drawRect(
                                brush = fadeOut,
                                topLeft = Offset(size.width - fade, 0f),
                                size = size.copy(width = fade),
                                blendMode = BlendMode.DstIn,
                            )
                        }
                    }
                },
        ) {
            Box {
                CurveOverlay(columns, reveal)
                Row {
                    columns.forEachIndexed { index, col ->
                        HourColumnContent(col, unitPref, reveal, index, n)
                    }
                }
            }
        }
    }
}

/** The expanded view: every hour visible at once, no scrolling required. */
@Composable
private fun HourGrid(
    hours: List<HourUi>,
    unitPref: UnitPref,
    timeZone: ZoneId,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        hours.chunked(4).forEach { rowHours ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                rowHours.forEach { hour ->
                    HourGridCell(hour, unitPref, timeZone, Modifier.weight(1f))
                }
                // Keep partial last rows aligned with full ones.
                repeat(4 - rowHours.size) {
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun HourGridCell(
    hour: HourUi,
    unitPref: UnitPref,
    timeZone: ZoneId,
    modifier: Modifier = Modifier,
) {
    val label = TimeFormats.hourLabel(hour.startTime, timeZone, rememberClock24())
    val precip = hour.precipProbability?.takeIf { it >= 15 }
    val description = stringResource(
        R.string.hourly_column_cd,
        label,
        Units.tempNumber(hour.temperatureC, unitPref),
    ) + (precip?.let { stringResource(R.string.hourly_column_precip_cd, it) } ?: "")
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier.semantics(mergeDescendants = true) {
            contentDescription = description
        },
    ) {
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = Color.White.copy(alpha = 0.85f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Image(
            painter = painterResource(
                WeatherIcons.forCondition(hour.conditionType, hour.isDaytime)
            ),
            contentDescription = null,
            modifier = Modifier
                .padding(vertical = 3.dp)
                .size(22.dp),
        )
        Text(
            text = "${Units.tempNumber(hour.temperatureC, unitPref)}°",
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = hour.temperatureC?.let { tempColor(it) } ?: Color.White,
        )
        if (precip != null) {
            Text(
                text = "$precip%",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = Color.White.copy(alpha = 0.88f),
            )
        }
    }
}

private class HourColumn(
    val label: String,
    val isNow: Boolean,
    val iconRes: Int,
    val tempC: Double?,
    val precipPercent: Int?,
    val isSunsetMarker: Boolean = false,
    val sunsetLabel: String? = null,
    val normY: Float = 0.5f,
)

private fun buildColumns(
    hours: List<HourUi>,
    sunset: Instant?,
    zone: ZoneId,
    nowLabel: String,
    nowEpochHour: Long,
    clock24: Boolean,
): List<HourColumn> {
    if (hours.isEmpty()) return emptyList()
    // Normalize over hours that actually have a temperature — a few nulls
    // must not drag the curve's scale toward 0 °C.
    val knownTemps = hours.mapNotNull { it.temperatureC }
    val minV = knownTemps.minOrNull() ?: 0.0
    val maxV = (knownTemps.maxOrNull() ?: (minV + 1.0)).coerceAtLeast(minV + 0.0001)
    val span = (maxV - minV).takeIf { it > 0.0001 } ?: 1.0

    // Sunset marker: the column closest in time to the actual sunset, and
    // only if sunset falls inside the visible window (not hours away).
    val sunsetIndex = sunset?.let { s ->
        val first = hours.first().startTime
        val last = hours.last().startTime
        if (s.isBefore(first.minusSeconds(3_600)) || s.isAfter(last.plusSeconds(2 * 3_600))) {
            null
        } else {
            hours.indices.minByOrNull { index ->
                kotlin.math.abs(java.time.Duration.between(hours[index].startTime, s).toMillis())
            }
        }
    }

    return hours.mapIndexed { index, hour ->
        // "Now" is the column whose hour bucket matches the wall clock —
        // wherever it falls. A stale bundle whose first hour has already
        // passed simply shows clock labels instead of a lying "Now".
        val isNow = hour.startTime.epochSecond / 3600 == nowEpochHour
        val isSunsetColumn = index == sunsetIndex
        HourColumn(
            label = if (isNow) nowLabel
            else TimeFormats.hourLabel(hour.startTime, zone, clock24),
            isNow = isNow,
            iconRes = WeatherIcons.forCondition(hour.conditionType, hour.isDaytime),
            tempC = hour.temperatureC,
            precipPercent = hour.precipProbability?.takeIf { it >= 15 },
            isSunsetMarker = isSunsetColumn,
            sunsetLabel = if (isSunsetColumn && sunset != null) TimeFormats.hourMinute(sunset, zone, clock24) else null,
            normY = hour.temperatureC?.let { 1f - (((it - minV) / span).toFloat()) } ?: 0.5f,
        )
    }
}

/** Curve drawn across all columns, aligned with the label boxes below.
 *  Spline, paths and gradient live in the draw cache: the reveal animation
 *  re-runs the draw phase every frame for ~1 s, and rebuilding them per
 *  frame would allocate hundreds of paths for nothing. */
@Composable
private fun CurveOverlay(columns: List<HourColumn>, reveal: Animatable<Float, AnimationVector1D>) {
    val curveDescription = stringResource(R.string.hourly_curve_cd)
    Spacer(
        modifier = Modifier
            .width(COLUMN_WIDTH * columns.size)
            .height(HEADER_STACK + CURVE_HEIGHT)
            .semantics { contentDescription = curveDescription }
            .drawWithCache {
                val n = columns.size
                // A single-hour bundle must not reach Spline (it requires
                // two points); render nothing rather than crash.
                if (n < 2) {
                    return@drawWithCache onDrawBehind { }
                }
                val colPx = COLUMN_WIDTH.toPx()
                val xs = FloatArray(n) { it * colPx + colPx / 2f }
                val usableTop = HEADER_STACK.toPx() + CURVE_PAD_TOP.toPx()
                val usableBottom = (HEADER_STACK + CURVE_HEIGHT - CURVE_PAD_BOTTOM).toPx()
                val ys = FloatArray(n) {
                    usableTop + columns[it].normY * (usableBottom - usableTop)
                }
                val spline = Spline(xs, ys)
                // The highlighted point belongs to the actual "Now" column,
                // wherever the clock says it is — not whichever is first.
                val nowIdx = columns.indexOfFirst { it.isNow }.takeIf { it >= 0 } ?: 0

                val step = 5f * density
                val path = Path()
                var x = xs.first()
                path.moveTo(x, spline.yAt(x))
                while (x < xs.last()) {
                    x = (x + step).coerceAtMost(xs.last())
                    path.lineTo(x, spline.yAt(x))
                }
                val fill = Path().apply {
                    addPath(path)
                    lineTo(xs.last(), size.height)
                    lineTo(xs.first(), size.height)
                    close()
                }
                val fillBrush = Brush.verticalGradient(
                    colors = listOf(
                        Color.White.copy(alpha = 0.17f),
                        Color.White.copy(alpha = 0.02f),
                    ),
                    startY = usableTop,
                    endY = size.height,
                )
                val stroke = Stroke(
                    width = 2.5f * density,
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                )
                onDrawBehind {
                    // The sweep reveals curve, fill and dot together; read in
                    // the draw phase so only it invalidates per frame.
                    val r = reveal.value.coerceIn(0f, 1f)
                    clipRect(right = size.width * r) {
                        drawPath(path = fill, brush = fillBrush)
                        drawPath(path = path, color = Color.White.copy(alpha = 0.88f), style = stroke)
                        // "Now" point with a soft halo.
                        drawCircle(
                            color = Color.White.copy(alpha = 0.22f),
                            radius = 8.5f * density,
                            center = Offset(xs[nowIdx], ys[nowIdx]),
                        )
                        drawCircle(
                            color = Color.Black.copy(alpha = 0.14f),
                            radius = 5.8f * density,
                            center = Offset(xs[nowIdx], ys[nowIdx]),
                        )
                        drawCircle(
                            color = Color.White,
                            radius = 3.6f * density,
                            center = Offset(xs[nowIdx], ys[nowIdx]),
                        )
                    }
                    // Dim ghost of the untraveled curve keeps the layout
                    // readable mid-animation instead of showing empty space.
                    if (r < 1f) {
                        clipRect(left = size.width * r) {
                            drawPath(
                                path = path,
                                color = Color.White.copy(alpha = 0.14f),
                                style = stroke,
                            )
                        }
                    }
                }
            },
    )
}

@Composable
private fun HourColumnContent(
    col: HourColumn,
    unitPref: UnitPref,
    reveal: Animatable<Float, AnimationVector1D>,
    index: Int,
    total: Int,
) {
    // One TalkBack stop per column: hour, temperature and precipitation read
    // together instead of as three sibling nodes.
    val precipSuffix = col.precipPercent
        ?.takeIf { !col.isSunsetMarker }
        ?.let { stringResource(R.string.hourly_column_precip_cd, it) } ?: ""
    val description = stringResource(
        R.string.hourly_column_cd,
        col.label,
        Units.tempNumber(col.tempC, unitPref),
    ) + precipSuffix
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .width(COLUMN_WIDTH)
            .semantics(mergeDescendants = true) { contentDescription = description }
            .graphicsLayer {
                // Each column materializes as the sweep reaches it.
                val slot = reveal.value * (total + 2)
                alpha = ((slot - index) / 2f).coerceIn(0f, 1f)
            },
    ) {
        // Header stack (fixed 56dp so the overlay aligns): label + icon.
        // Labels ellipsize instead of overlapping the curve at large font
        // scales — the fixed geometry is what keeps the spline in lockstep.
        Box(Modifier.height(20.dp), contentAlignment = Alignment.Center) {
            Text(
                text = col.label,
                fontSize = 14.sp,
                fontWeight = if (col.isNow) FontWeight.Bold else FontWeight.Medium,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(8.dp))
        Box(Modifier.height(24.dp), contentAlignment = Alignment.Center) {
            if (col.isSunsetMarker) {
                SunsetIcon(Modifier.size(22.dp))
            } else {
                Image(
                    painter = painterResource(col.iconRes),
                    contentDescription = null,
                    modifier = Modifier.size(24.dp),
                )
            }
        }
        Spacer(Modifier.height(4.dp))

        // Curve region: temperature label positioned on the spline.
        Box(Modifier.height(CURVE_HEIGHT), contentAlignment = Alignment.TopCenter) {
            if (col.isSunsetMarker) {
                Text(
                    text = col.sunsetLabel ?: "",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color.White.copy(alpha = 0.9f),
                    modifier = Modifier.padding(top = 26.dp),
                )
                Text(
                    text = stringResource(R.string.sunset),
                    fontSize = 12.sp,
                    color = Color.White.copy(alpha = 0.8f),
                    modifier = Modifier.padding(top = 46.dp),
                )
            } else {
                Text(
                    text = "${Units.tempNumber(col.tempC, unitPref)}°",
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Medium,
                    color = col.tempC?.let { tempColor(it) } ?: Color.White,
                    modifier = Modifier.offset(
                        y = CURVE_PAD_TOP +
                            (CURVE_HEIGHT - CURVE_PAD_TOP - CURVE_PAD_BOTTOM) * col.normY - 11.dp -
                            if (col.isNow) 10.dp else 0.dp
                    ),
                )
            }
        }

        // Precipitation chance under the curve.
        Box(Modifier.heightIn(min = 18.dp), contentAlignment = Alignment.TopCenter) {
            val precip = col.precipPercent
            if (precip != null && !col.isSunsetMarker) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PrecipDrop(Modifier.size(10.dp))
                    Text(
                        text = "$precip%",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = Color.White.copy(alpha = 0.9f),
                        modifier = Modifier.padding(start = 2.dp),
                    )
                }
            }
        }
    }
}

@Composable
internal fun PrecipDrop(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(w * 0.5f, 0f)
            cubicTo(w * 0.9f, h * 0.42f, w * 0.82f, h * 0.72f, w * 0.5f, h)
            cubicTo(w * 0.18f, h * 0.72f, w * 0.1f, h * 0.42f, w * 0.5f, 0f)
        }
        drawPath(path, CirrusPrecipDropColor)
    }
}

private val CirrusPrecipDropColor = Color(0xFFBBD9F7)

@Composable
internal fun SunsetIcon(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val r = size.minDimension * 0.30f
        val cx = size.width * 0.5f
        val cy = size.height * 0.60f
        drawCircle(Color(0xFFFFCC4D), radius = r, center = Offset(cx, cy))
        drawLine(
            Color.White.copy(alpha = 0.9f),
            start = Offset(0f, cy + r * 1.6f),
            end = Offset(size.width, cy + r * 1.6f),
            strokeWidth = size.height * 0.07f,
        )
    }
}
