package com.cirrus.weather.ui.components.modules

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Air
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.Thermostat
import androidx.compose.material.icons.rounded.Umbrella
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.WaterDrop
import androidx.compose.material.icons.rounded.WbSunny
import androidx.compose.material.icons.rounded.WbTwilight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.domain.CurrentUi
import com.cirrus.weather.domain.HourUi
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.Units
import com.cirrus.weather.ui.components.GlassCard
import com.cirrus.weather.ui.theme.CirrusPalette
import com.cirrus.weather.ui.theme.ModuleFooterStyle
import com.cirrus.weather.ui.theme.rememberClock24
import java.time.Instant
import java.time.ZoneId
import kotlin.math.cos
import kotlin.math.sin

/**
 * Standard module shell: micro header with a vivid icon, big value, visual,
 * context footer — plus a large ghost watermark of the icon sinking into the
 * card's corner, the Google-Weather signature that gives the grid its color.
 */
@Composable
internal fun ModuleCard(
    title: String,
    icon: ImageVector,
    iconTint: Color,
    value: String? = null,
    footer: String,
    modifier: Modifier = Modifier,
    visualDescription: String? = null,
    visual: (@Composable () -> Unit)? = null,
) {
    GlassCard(modifier = modifier, contentPadding = PaddingValues(14.dp)) {
        Box(modifier = Modifier.fillMaxWidth()) {
            // Ghost watermark sinking into the bottom-right corner.
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconTint.copy(alpha = 0.14f),
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(top = 4.dp)
                    .size(84.dp),
            )
            Column(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = iconTint,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = title,
                        // 0.85 alpha keeps the micro headers above 4.5:1 on
                        // every archetype gradient (0.62 washed out on bright
                        // day backgrounds).
                        color = Color.White.copy(alpha = 0.85f),
                        style = androidx.compose.ui.text.TextStyle(
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = 0.8.sp,
                        ),
                    )
                }
                if (value != null) {
                    Text(
                        text = value,
                        fontSize = 34.sp,
                        fontWeight = FontWeight.Medium,
                        color = Color.White,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                if (visual != null) {
                    Box(
                        Modifier
                            .padding(top = 6.dp)
                            .let { m ->
                                if (visualDescription != null) {
                                    m.semantics { contentDescription = visualDescription }
                                } else m
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        visual()
                    }
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = footer,
                    style = ModuleFooterStyle,
                    color = Color.White.copy(alpha = 0.92f),
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

// ---------------------------------------------------------------- UV Index

@Composable
private fun uvCategoryRes(uv: Int): Int = when {
    uv <= 2 -> R.string.uv_low
    uv <= 5 -> R.string.uv_moderate
    uv <= 7 -> R.string.uv_high
    uv <= 9 -> R.string.uv_very_high
    else -> R.string.uv_extreme
}

@Composable
fun UvModule(uvIndex: Int?, peakHour: HourUi?, zone: ZoneId, modifier: Modifier = Modifier) {
    val clock24 = rememberClock24()
    // Null UV is a data gap — show "--" instead of a confident (and wrong) 0.
    val footer = when {
        uvIndex == null -> stringResource(R.string.uv_no_data)
        peakHour != null -> stringResource(
            R.string.uv_peak,
            stringResource(uvCategoryRes(peakHour.uvIndex ?: uvIndex)),
            com.cirrus.weather.util.TimeFormats.hourLabel(peakHour.startTime, zone, clock24),
        )
        else -> stringResource(R.string.uv_no_more)
    }
    // The current category is inside the gauge — announce it so it is never
    // color-only information.
    val gaugeDescription = uvIndex
        ?.let { stringResource(R.string.uv_index_cd, stringResource(uvCategoryRes(it))) }
    ModuleCard(
        title = stringResource(R.string.uv_index),
        icon = Icons.Rounded.WbSunny,
        iconTint = CirrusPalette.SunAmber,
        value = uvIndex?.toString() ?: "--",
        footer = footer,
        modifier = modifier,
        visualDescription = gaugeDescription,
    ) {
        UvGauge(uvIndex ?: 0)
    }
}

@Composable
private fun UvGauge(uv: Int) {
    Canvas(Modifier.fillMaxWidth().height(34.dp)) {
        val stroke = 7.dp.toPx()
        val r = (size.height - stroke) / 2f
        val cy = size.height - r - stroke / 2f
        val cx = size.width / 2f
        val startAngle = 180f
        val sweep = 180f

        // A sweep gradient's stops cover the full 360° starting at 3 o'clock,
        // but the arc only spans 180°→360° — so the visible stops must be
        // pinned to fractions 0.5..1.0 or the "low" colors land on the
        // undrawn bottom half.
        val brush = Brush.sweepGradient(
            colorStops = arrayOf(
                0.5f to Color(0xFF64C860),
                0.625f to Color(0xFF9BD64B),
                0.75f to Color(0xFFE8D84B),
                0.875f to Color(0xFFE8A83C),
                1.0f to Color(0xFFE85B3C),
            ),
            center = Offset(cx, cy),
        )
        drawArc(
            brush = brush,
            startAngle = startAngle,
            sweepAngle = sweep,
            useCenter = false,
            topLeft = Offset(cx - r, cy - r),
            size = Size(r * 2, r * 2),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
        // Marker in the category color, white-cored.
        val frac = (uv / 11f).coerceIn(0.03f, 1f)
        val angleRad = Math.toRadians((startAngle + sweep * frac).toDouble())
        val mx = cx + r * cos(angleRad).toFloat()
        val my = cy + r * sin(angleRad).toFloat()
        drawCircle(CirrusPalette.uvColor(uv), radius = stroke * 0.85f, center = Offset(mx, my))
        drawCircle(Color.White, radius = stroke * 0.45f, center = Offset(mx, my))
    }
}

// ---------------------------------------------------------------- Wind

@Composable
fun WindModule(
    current: CurrentUi,
    unitPref: UnitPref,
    modifier: Modifier = Modifier,
) {
    val footer = buildString {
        current.windCardinal?.let {
            append(stringResource(R.string.wind_from, it.replaceFirstChar { c -> c.uppercase() }))
        }
        current.windGustKph?.let {
            if (isNotEmpty()) append(" · ")
            append(stringResource(R.string.wind_gusts, Units.windDisplay(it, unitPref)))
        }
        if (isEmpty()) append(stringResource(R.string.wind_none))
    }
    ModuleCard(
        title = stringResource(R.string.wind),
        icon = Icons.Rounded.Air,
        iconTint = CirrusPalette.Sky,
        footer = footer,
        modifier = modifier,
    ) {
        WindCompass(
            speedNumber = Units.windNumber(current.windKph, unitPref),
            unitLabel = Units.windUnit(unitPref),
            degrees = current.windDegrees,
        )
    }
}

@Composable
private fun WindCompass(speedNumber: String, unitLabel: String, degrees: Int?) {
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(96.dp)) {
        Canvas(Modifier.size(96.dp)) {
            val c = center
            val r = size.minDimension / 2f - 6.dp.toPx()
            drawCircle(Color.White.copy(alpha = 0.14f), radius = r, center = c)
            // Tick marks
            repeat(24) { i ->
                val a = Math.toRadians((i * 15).toDouble())
                val inner = r - 5.dp.toPx()
                val len = if (i % 6 == 0) 8.dp.toPx() else 4.dp.toPx()
                drawLine(
                    Color.White.copy(alpha = if (i % 6 == 0) 0.75f else 0.3f),
                    start = Offset(
                        c.x + (inner - len) * sin(a).toFloat(),
                        c.y - (inner - len) * cos(a).toFloat(),
                    ),
                    end = Offset(
                        c.x + inner * sin(a).toFloat(),
                        c.y - inner * cos(a).toFloat(),
                    ),
                    strokeWidth = 1.6f * density * 0.7f,
                )
            }
            // Arrow: wind degrees is the direction wind comes FROM;
            // the arrow points where the wind is going.
            val deg = (degrees?.plus(180))?.toFloat() ?: 0f
            val a = Math.toRadians(deg.toDouble())
            val tip = Offset(
                c.x + (r - 10.dp.toPx()) * sin(a).toFloat(),
                c.y - (r - 10.dp.toPx()) * cos(a).toFloat(),
            )
            val tail = Offset(c.x - (r * 0.35f) * sin(a).toFloat(), c.y + (r * 0.35f) * cos(a).toFloat())
            val arrowBrush = Brush.linearGradient(
                colors = listOf(CirrusPalette.SkyDeep, CirrusPalette.Sky),
                start = tail,
                end = tip,
            )
            drawLine(arrowBrush, tail, tip, strokeWidth = 3.dp.toPx() * 0.8f, cap = StrokeCap.Round)
            // Arrowhead
            val headA = 26f
            for (side in listOf(-1f, 1f)) {
                val ha = Math.toRadians((deg + side * headA).toDouble())
                val wing = Offset(
                    tip.x - 9.dp.toPx() * sin(ha).toFloat(),
                    tip.y - 9.dp.toPx() * cos(ha).toFloat(),
                )
                drawLine(arrowBrush, tip, wing, strokeWidth = 3.dp.toPx() * 0.8f, cap = StrokeCap.Round)
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(speedNumber, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
            Text(unitLabel, fontSize = 12.sp, color = Color.White.copy(alpha = 0.85f))
        }
    }
}

// ---------------------------------------------------------------- Feels like

@Composable
fun FeelsLikeModule(current: CurrentUi, unitPref: UnitPref, modifier: Modifier = Modifier) {
    val feels = current.feelsLikeC
    val actual = current.temperatureC
    val footer = when {
        feels == null || actual == null -> stringResource(R.string.no_data)
        feels > actual + 1 -> stringResource(R.string.feels_warmer)
        feels < actual - 1 -> stringResource(R.string.feels_cooler)
        else -> stringResource(R.string.feels_same)
    }
    ModuleCard(
        title = stringResource(R.string.feels_like),
        icon = Icons.Rounded.Thermostat,
        iconTint = CirrusPalette.Orange,
        value = Units.tempDisplay(feels, unitPref),
        footer = footer,
        modifier = modifier,
    ) {
        if (feels != null && actual != null) {
            FeelsDelta(feels - actual, unitPref)
        }
    }
}

/** Small colored pill stating the delta from the actual temperature. */
@Composable
private fun FeelsDelta(deltaC: Double, unitPref: UnitPref) {
    val (sign, tint) = when {
        deltaC > 1 -> "+" to CirrusPalette.Orange
        deltaC < -1 -> "−" to CirrusPalette.Sky
        else -> return
    }
    val shown = Units.tempNumber(kotlin.math.abs(deltaC), unitPref)
    val vsActual = stringResource(R.string.feels_delta_vs_actual)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "$sign$shown° $vsActual",
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = tint,
        )
    }
}

// ---------------------------------------------------------------- Precipitation

@Composable
fun PrecipitationModule(
    current: CurrentUi,
    nextHour: HourUi?,
    unitPref: UnitPref,
    modifier: Modifier = Modifier,
) {
    val footer = when {
        nextHour != null && nextHour.precipProbability != null ->
            stringResource(R.string.precip_next_hour, nextHour.precipProbability as Int)
        nextHour == null -> stringResource(R.string.precip_no_next)
        else -> stringResource(R.string.precip_chance_na)
    }
    ModuleCard(
        title = stringResource(R.string.precipitation),
        icon = Icons.Rounded.Umbrella,
        iconTint = CirrusPalette.RainBlue,
        value = Units.precipDisplay(current.precipLast24hMm, unitPref),
        footer = footer,
        modifier = modifier,
    ) {
        Text(
            text = stringResource(R.string.precip_last_24h),
            fontSize = 13.sp,
            color = Color.White.copy(alpha = 0.9f),
            modifier = Modifier.padding(top = 0.dp),
        )
    }
}

// ---------------------------------------------------------------- Humidity

@Composable
fun HumidityModule(current: CurrentUi, unitPref: UnitPref, modifier: Modifier = Modifier) {
    val footer = if (current.dewPointC == null) {
        stringResource(R.string.dew_point_unavailable)
    } else {
        stringResource(
            R.string.dew_point_now,
            Units.tempDisplay(current.dewPointC, unitPref),
        )
    }
    ModuleCard(
        title = stringResource(R.string.humidity),
        icon = Icons.Rounded.WaterDrop,
        iconTint = CirrusPalette.Sky,
        value = "${current.humidity ?: "--"}%",
        footer = footer,
        modifier = modifier,
    ) {
        HumidityDroplet((current.humidity ?: 0) / 100f)
    }
}

/** Droplet silhouette filled from the bottom to the humidity fraction. */
@Composable
private fun HumidityDroplet(fraction: Float) {
    Canvas(Modifier.fillMaxWidth().height(46.dp)) {
        val w = size.width
        val h = size.height
        val drop = Path().apply {
            moveTo(w * 0.5f, 0f)
            cubicTo(w * 0.92f, h * 0.40f, w * 0.80f, h * 0.74f, w * 0.5f, h)
            cubicTo(w * 0.20f, h * 0.74f, w * 0.08f, h * 0.40f, w * 0.5f, 0f)
            close()
        }
        // Empty droplet
        drawPath(drop, Color.White.copy(alpha = 0.14f))
        // Filled portion, clipped to the droplet
        val fillTop = h * (1f - fraction.coerceIn(0f, 1f))
        clipPath(drop) {
            drawRect(
                brush = Brush.verticalGradient(
                    colors = listOf(CirrusPalette.Sky, CirrusPalette.SkyDeep),
                    startY = fillTop,
                    endY = h,
                ),
                topLeft = Offset(0f, fillTop),
                size = Size(w, h - fillTop),
            )
            // Liquid surface line
            if (fraction > 0.02f && fraction < 0.98f) {
                drawLine(
                    Color.White.copy(alpha = 0.5f),
                    start = Offset(0f, fillTop),
                    end = Offset(w, fillTop),
                    strokeWidth = 1.5f,
                )
            }
        }
    }
}

// ---------------------------------------------------------------- Visibility

@Composable
fun VisibilityModule(current: CurrentUi, unitPref: UnitPref, modifier: Modifier = Modifier) {
    val km = current.visibilityKm
    val footer = when {
        km == null -> stringResource(R.string.no_data)
        km >= 16 -> stringResource(R.string.vis_perfect)
        km >= 10 -> stringResource(R.string.vis_clear)
        km >= 4 -> stringResource(R.string.vis_hazy)
        else -> stringResource(R.string.vis_low)
    }
    ModuleCard(
        title = stringResource(R.string.visibility),
        icon = Icons.Rounded.Visibility,
        iconTint = CirrusPalette.Teal,
        value = Units.visibilityDisplay(km, unitPref),
        footer = footer,
        modifier = modifier,
    ) {
        LevelBar(
            fraction = ((km ?: 0.0) / 16.0).coerceIn(0.0, 1.0).toFloat(),
            brushColors = listOf(CirrusPalette.TealDeep, CirrusPalette.Teal),
        )
    }
}

// ---------------------------------------------------------------- Pressure

@Composable
fun PressureModule(
    current: CurrentUi,
    history: List<HourUi>,
    unitPref: UnitPref,
    modifier: Modifier = Modifier,
) {
    val trendRes = run {
        val pressures = history.mapNotNull { it.pressureMb }
        if (pressures.size >= 2) {
            val delta = pressures.last() - pressures.first()
            if (delta > 0.8) R.string.pressure_rising
            else if (delta < -0.8) R.string.pressure_falling
            else R.string.pressure_steady
        } else R.string.pressure_steady
    }
    ModuleCard(
        title = stringResource(R.string.pressure),
        icon = Icons.Rounded.Speed,
        iconTint = CirrusPalette.Violet,
        value = Units.pressureDisplay(current.pressureMb, unitPref),
        footer = stringResource(R.string.pressure_trend, stringResource(trendRes)),
        modifier = modifier,
    ) {
        PressureGauge(current.pressureMb)
    }
}

/** Semicircle gauge with a needle, colored from low (violet) to high (amber). */
@Composable
private fun PressureGauge(pressureMb: Double?) {
    Canvas(Modifier.fillMaxWidth().height(38.dp)) {
        val stroke = 6.dp.toPx()
        val r = (size.height - stroke) / 2f
        val cy = size.height - r - stroke / 2f
        val cx = size.width / 2f
        drawArc(
            // Sweep-gradient stops are fractions of the full 360°, but the
            // arc only spans 180°→360°: pin the stops to 0.5..1.0 so violet
            // really sits at the low (left) end of the visible arc.
            brush = Brush.sweepGradient(
                colorStops = arrayOf(
                    0.5f to CirrusPalette.Violet,
                    0.75f to CirrusPalette.Teal,
                    1.0f to CirrusPalette.SunAmber,
                ),
                center = Offset(cx, cy),
            ),
            startAngle = 180f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = Offset(cx - r, cy - r),
            size = Size(r * 2, r * 2),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
        if (pressureMb != null) {
            val frac = ((pressureMb - 960.0) / (1060.0 - 960.0)).toFloat().coerceIn(0.03f, 0.97f)
            val angleRad = Math.toRadians((180f + 180f * frac).toDouble())
            val mx = cx + r * cos(angleRad).toFloat()
            val my = cy + r * sin(angleRad).toFloat()
            // Marker colored by where the pressure sits on the scale, like
            // the UV gauge — never a constant color.
            drawCircle(pressureColor(pressureMb), radius = stroke * 0.85f, center = Offset(mx, my))
            drawCircle(Color.White, radius = stroke * 0.45f, center = Offset(mx, my))
        }
    }
}

/** Marker tint matching the gauge arc: violet (low) → teal → amber (high). */
private fun pressureColor(pressureMb: Double): Color = when {
    pressureMb < 990 -> CirrusPalette.Violet
    pressureMb < 1030 -> CirrusPalette.Teal
    else -> CirrusPalette.SunAmber
}

/** Minimal rounded gradient bar with a white position marker. */
@Composable
private fun LevelBar(fraction: Float, brushColors: List<Color>) {
    Canvas(Modifier.fillMaxWidth().height(8.dp)) {
        val w = size.width
        val h = size.height
        val bar = Size(w, h * 0.62f)
        val top = Offset(0f, (h - bar.height) / 2f)
        drawRoundRect(Color.White.copy(alpha = 0.16f), topLeft = top, size = bar, cornerRadius = androidx.compose.ui.geometry.CornerRadius(999f))
        drawRoundRect(
            brush = Brush.horizontalGradient(brushColors),
            topLeft = top,
            size = Size(bar.width * fraction.coerceIn(0f, 1f), bar.height),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(999f),
        )
        val markerX = (bar.width * fraction).coerceIn(2f, bar.width - 2f)
        drawCircle(Color.White, radius = h * 0.62f, center = Offset(markerX, h / 2f))
    }
}

// ---------------------------------------------------------------- Sun arc

@Composable
fun SunModule(
    sunrise: Instant?,
    sunset: Instant?,
    now: Instant,
    isDaytime: Boolean,
    zone: ZoneId,
    modifier: Modifier = Modifier,
) {
    val clock24 = rememberClock24()
    val header = if (isDaytime) stringResource(R.string.sunset_header) else stringResource(R.string.sunrise_header)
    val primary = if (isDaytime) sunset else sunrise
    val secondary = if (isDaytime) sunrise else sunset
    val footer = secondary?.let {
        stringResource(
            if (isDaytime) R.string.sun_secondary_sunrise else R.string.sun_secondary_sunset,
            com.cirrus.weather.util.TimeFormats.hourMinute(it, zone, clock24),
        )
    } ?: stringResource(R.string.sun_none)

    ModuleCard(
        title = header,
        icon = Icons.Rounded.WbTwilight,
        iconTint = CirrusPalette.SunAmber,
        value = primary?.let { com.cirrus.weather.util.TimeFormats.hourMinute(it, zone, clock24) } ?: "--:--",
        footer = footer,
        modifier = modifier,
    ) {
        SunArc(sunrise = sunrise, sunset = sunset, now = now, isDaytime = isDaytime)
    }
}

@Composable
private fun SunArc(sunrise: Instant?, sunset: Instant?, now: Instant, isDaytime: Boolean) {
    Canvas(Modifier.fillMaxWidth().height(52.dp)) {
        val w = size.width
        val h = size.height
        val r = (w / 2f).coerceAtMost(h * 1.15f)
        val cx = w / 2f
        val cy = h - 4.dp.toPx()

        fun pointAt(frac: Float): Offset {
            val clamped = frac.coerceIn(0f, 1f)
            val a = Math.PI * (1f - clamped)
            return Offset(
                cx + r * cos(a).toFloat(),
                cy - r * sin(a).toFloat() * 0.86f,
            )
        }

        // Full arc (dashed)
        val dash = Path().apply {
            moveTo(pointAt(0f).x, pointAt(0f).y)
            var f = 0f
            while (f < 1f) {
                f = (f + 0.02f).coerceAtMost(1f)
                lineTo(pointAt(f).x, pointAt(f).y)
            }
        }
        drawPath(
            dash,
            Color.White.copy(alpha = 0.35f),
            style = Stroke(
                2.dp.toPx(),
                pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(6f * density, 8f * density)),
            ),
        )

        if (sunrise != null && sunset != null && sunset.isAfter(sunrise)) {
            val frac = ((now.toEpochMilli() - sunrise.toEpochMilli()).toDouble() /
                (sunset.toEpochMilli() - sunrise.toEpochMilli())).toFloat()
            val clamped = frac.coerceIn(0f, 1f)
            // Traveled portion (solid, warm gradient)
            val solid = Path().apply {
                moveTo(pointAt(0f).x, pointAt(0f).y)
                var f = 0f
                while (f < clamped) {
                    f = (f + 0.02f).coerceAtMost(clamped)
                    lineTo(pointAt(f).x, pointAt(f).y)
                }
            }
            drawPath(
                solid,
                brush = Brush.horizontalGradient(
                    listOf(CirrusPalette.SunDeep, CirrusPalette.SunAmber)
                ),
                style = Stroke(2.5f.dp.toPx(), cap = StrokeCap.Round),
            )
            // Sun / moon marker with a soft glow
            val p = pointAt(clamped)
            if (isDaytime) {
                drawCircle(CirrusPalette.SunAmber.copy(alpha = 0.35f), radius = 8.dp.toPx(), center = p)
                drawCircle(CirrusPalette.SunAmber, radius = 5.dp.toPx(), center = p)
            } else {
                drawCircle(CirrusPalette.MoonLight.copy(alpha = 0.35f), radius = 8.dp.toPx(), center = p)
                drawCircle(CirrusPalette.MoonLight, radius = 5.dp.toPx(), center = p)
            }
        }
        // Horizon
        drawLine(
            Color.White.copy(alpha = 0.4f),
            start = Offset(cx - r, cy),
            end = Offset(cx + r, cy),
            strokeWidth = 1.dp.toPx(),
        )
    }
}

// ---------------------------------------------------------------- Moon

fun moonFraction(phase: String?): Float? {
    // fraction of the synodic month, 0 = new, 0.5 = full
    return when (phase?.uppercase()) {
        "NEW_MOON" -> 0f
        "WAXING_CRESCENT" -> 0.125f
        "FIRST_QUARTER" -> 0.25f
        "WAXING_GIBBOUS" -> 0.375f
        "FULL_MOON" -> 0.5f
        "WANING_GIBBOUS" -> 0.625f
        "LAST_QUARTER" -> 0.75f
        "WANING_CRESCENT" -> 0.875f
        else -> null
    }
}

@Composable
private fun moonNameRes(phase: String?): Int = when (phase?.uppercase()) {
    "NEW_MOON" -> R.string.moon_new
    "WAXING_CRESCENT" -> R.string.moon_waxing_crescent
    "FIRST_QUARTER" -> R.string.moon_first_quarter
    "WAXING_GIBBOUS" -> R.string.moon_waxing_gibbous
    "FULL_MOON" -> R.string.moon_full
    "WANING_GIBBOUS" -> R.string.moon_waning_gibbous
    "LAST_QUARTER" -> R.string.moon_last_quarter
    "WANING_CRESCENT" -> R.string.moon_waning_crescent
    else -> R.string.moon_unknown
}

@Composable
fun MoonModule(moonPhase: String?, modifier: Modifier = Modifier) {
    val frac = moonFraction(moonPhase)
    ModuleCard(
        title = stringResource(R.string.moon),
        icon = Icons.Rounded.DarkMode,
        iconTint = CirrusPalette.MoonLight,
        // No "tonight" — the module is on screen during daytime too.
        footer = stringResource(R.string.moon_footer, stringResource(moonNameRes(moonPhase))),
        modifier = modifier,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(72.dp)) {
            // Unknown phase renders a neutral dashed outline — never a
            // confident disc that contradicts the hedging footer.
            MoonDisc(frac)
        }
    }
}

@Composable
private fun MoonDisc(fraction: Float?) {
    Canvas(Modifier.size(64.dp)) {
        val r = size.minDimension / 2f
        val c = center
        if (fraction == null) {
            drawCircle(
                color = CirrusPalette.MoonLight.copy(alpha = 0.45f),
                radius = r,
                center = c,
                style = Stroke(
                    width = 1.5.dp.toPx(),
                    pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(
                        floatArrayOf(4f * density, 6f * density),
                    ),
                ),
            )
            return@Canvas
        }
        // dark base disc
        drawCircle(Color(0xFF2A3142), radius = r, center = c)
        // illuminated portion: standard two-arc shadow construction
        val illum = ((1f - cos(2f * Math.PI.toFloat() * fraction)) / 2f)
        drawMoonIllumination(r, illum, waxing = fraction < 0.5f)
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawMoonIllumination(
    r: Float,
    illum: Float,
    waxing: Boolean,
) {
    val c = center
    val light = CirrusPalette.MoonLight

    // Lit limb is a semicircle on the lit side; the terminator is a half-ellipse
    // with semi-width w. Crescent (illum < 0.5) cuts into the lit side, gibbous
    // (illum > 0.5) bulges into the dark side.
    val w = r * (1f - 2f * illum).coerceIn(-1f, 1f)
    val k = 0.5523f * r
    val litSign = if (waxing) 1f else -1f

    val path = Path().apply {
        moveTo(c.x, c.y - r)
        // Lit semicircle: top -> bottom around the lit side.
        cubicTo(
            c.x + litSign * k, c.y - r,
            c.x + litSign * r, c.y - k,
            c.x + litSign * r, c.y,
        )
        cubicTo(
            c.x + litSign * r, c.y + k,
            c.x + litSign * k, c.y + r,
            c.x, c.y + r,
        )
        // Terminator half-ellipse: bottom -> top, bulging by w (signed).
        cubicTo(
            c.x + litSign * w * 0.5523f, c.y + r,
            c.x + litSign * w, c.y + k,
            c.x + litSign * w, c.y,
        )
        cubicTo(
            c.x + litSign * w, c.y - k,
            c.x + litSign * w * 0.5523f, c.y - r,
            c.x, c.y - r,
        )
        close()
    }
    drawPath(path, light)
}

// ---------------------------------------------------------------- Cloud cover

@Composable
fun CloudCoverModule(current: CurrentUi, modifier: Modifier = Modifier) {
    val cover = current.cloudCover
    ModuleCard(
        title = stringResource(R.string.cloud_cover),
        icon = Icons.Rounded.Cloud,
        iconTint = CirrusPalette.Cloud,
        value = "${cover ?: "--"}%",
        footer = when {
            cover == null -> stringResource(R.string.no_data)
            cover >= 90 -> stringResource(R.string.cloud_overcast)
            cover >= 60 -> stringResource(R.string.cloud_mostly)
            cover >= 30 -> stringResource(R.string.cloud_partly)
            else -> stringResource(R.string.cloud_clear)
        },
        modifier = modifier,
    ) {
        LevelBar(
            fraction = ((cover ?: 0) / 100f),
            brushColors = listOf(CirrusPalette.Sky.copy(alpha = 0.6f), CirrusPalette.Cloud),
        )
    }
}
