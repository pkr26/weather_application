package com.cirrus.weather.ui.fx

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import kotlinx.coroutines.android.awaitFrame
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

private class Particle(
    var x: Float,
    var y: Float,
    val speed: Float,
    val size: Float,
    // Baked at spawn: rebuilding a per-particle color every tick is thousands
    // of allocations per second in heavy rain.
    val color: Color,
    val phase: Float,
    val freq: Float,
)

private fun particlesOf(count: Int, rand: Random, spawn: (Random) -> Particle): List<Particle> =
    List(count) { spawn(rand) }

/**
 * Frame-clock driven animation loop that survives recomposition, capped at
 * ~32 fps: ambient particles never need display refresh rate, and skipping
 * alternate vsync frames halves the redraw cost on 90–120 Hz screens.
 *
 * The callback is read through [rememberUpdatedState]: keying the effect on
 * the lambda itself would work too, but would restart the timing state each
 * time the caller recomposes with new captures (e.g. a wind update changes
 * the rain's slant) — the holder keeps the ~32 Hz cadence continuous while
 * always invoking the *current* lambda, never the first composition's.
 */
@Composable
private fun FrameLoop(onFrame: (Float) -> Unit) {
    val currentOnFrame by rememberUpdatedState(onFrame)
    LaunchedEffect(Unit) {
        var last = awaitFrame()
        var lastEmitted = last
        while (true) {
            val now = awaitFrame()
            if (now - lastEmitted >= MIN_FRAME_NS) {
                val dt = ((now - last) / 1_000_000f).coerceIn(0f, 64f) / 1000f
                last = now
                lastEmitted = now
                currentOnFrame(dt)
            }
        }
    }
}

private const val MIN_FRAME_NS = 31_000_000L

/**
 * Slanted rain streaks. Slant follows the wind direction's horizontal component.
 */
@Composable
fun RainEffect(intensity: Float, windDegrees: Float?, modifier: Modifier = Modifier) {
    val drops = remember(intensity) {
        val count = (70 * intensity).toInt().coerceIn(24, 140)
        particlesOf(count, Random(System.nanoTime())) { r ->
            val alpha = 0.18f + r.nextFloat() * 0.25f
            Particle(
                x = r.nextFloat(),
                y = r.nextFloat(),
                speed = 0.9f + r.nextFloat() * 0.7f,   // screen heights per second
                size = 10f + r.nextFloat() * 16f,      // streak length, dp
                color = Color.White.copy(alpha = alpha),
                phase = 0f,
                freq = 0f,
            )
        }
    }
    var frame by remember { mutableStateOf(0f) }
    // Slant: horizontal drift fraction derived from wind's east-west component.
    val slant = remember(windDegrees) {
        val rad = Math.toRadians((windDegrees ?: 270f).toDouble())
        (-sin(rad) * 0.28f).toFloat().coerceIn(-0.32f, 0.32f)
    }

    FrameLoop { dt ->
        drops.forEach { p ->
            p.y += p.speed * dt
            p.x += slant * p.speed * dt
            if (p.y > 1.05f) { p.y = -0.05f; p.x = kotlin.random.Random.nextFloat() * 1.2f - 0.1f }
            if (p.x < -0.1f) p.x += 1.2f
            if (p.x > 1.1f) p.x -= 1.2f
        }
        frame += dt
    }

    Canvas(modifier) {
        // Reading `frame` subscribes this draw scope to the tick state —
        // without a snapshot read the canvas never invalidates and the rain
        // renders exactly one frozen frame.
        @Suppress("UNUSED_EXPRESSION") frame
        val h = size.height
        val w = size.width
        drops.forEach { p ->
            val x0 = p.x * w
            val y0 = p.y * h
            val dx = slant * p.size * density
            drawLine(
                color = p.color,
                start = Offset(x0, y0),
                end = Offset(x0 + dx, y0 + p.size * density),
                strokeWidth = 1.4f * density * (0.6f + intensity * 0.4f),
            )
        }
    }
}

/**
 * Slowly swaying snowflakes.
 */
@Composable
fun SnowEffect(intensity: Float, modifier: Modifier = Modifier) {
    val flakes = remember(intensity) {
        val count = (48 * intensity).toInt().coerceIn(16, 96)
        particlesOf(count, Random(System.nanoTime())) { r ->
            val alpha = 0.45f + r.nextFloat() * 0.45f
            Particle(
                x = r.nextFloat(),
                y = r.nextFloat(),
                speed = 0.05f + r.nextFloat() * 0.09f,  // screen heights per second
                size = 2.5f + r.nextFloat() * 4f,        // radius, dp
                color = Color.White.copy(alpha = alpha),
                phase = r.nextFloat() * (2f * Math.PI.toFloat()),
                freq = 0.4f + r.nextFloat() * 0.8f,
            )
        }
    }
    var time by remember { mutableFloatStateOf(0f) }

    FrameLoop { dt ->
        time += dt
        flakes.forEach { p ->
            p.y += p.speed * dt
            p.x += sin(time * p.freq + p.phase) * 0.0006f
            if (p.y > 1.04f) { p.y = -0.04f; p.x = kotlin.random.Random.nextFloat() }
            if (p.x < -0.05f) p.x += 1.1f
            if (p.x > 1.05f) p.x -= 1.1f
        }
    }

    Canvas(modifier) {
        // Reading `time` subscribes this draw scope to the tick state —
        // without a snapshot read the canvas never invalidates and the snow
        // renders exactly one frozen frame.
        @Suppress("UNUSED_EXPRESSION") time
        val h = size.height
        val w = size.width
        flakes.forEach { p ->
            drawCircle(
                color = p.color,
                radius = p.size * density * 0.5f,
                center = Offset(p.x * w, p.y * h),
            )
        }
    }
}

/**
 * Twinkling stars over the upper part of the sky.
 */
@Composable
fun StarField(modifier: Modifier = Modifier) {
    val stars = remember {
        particlesOf(90, Random(System.nanoTime())) { r ->
            val alpha = 0.25f + r.nextFloat() * 0.6f
            Particle(
                x = r.nextFloat(),
                y = r.nextFloat() * 0.62f,
                speed = 0.4f + r.nextFloat() * 1.6f,
                size = 0.8f + r.nextFloat() * 1.6f,
                color = Color.White.copy(alpha = alpha),
                phase = r.nextFloat() * (2f * Math.PI.toFloat()),
                freq = 0f,
            )
        }
    }
    var time by remember { mutableFloatStateOf(0f) }
    FrameLoop { dt -> time += dt }

    Canvas(modifier) {
        val h = size.height
        val w = size.width
        stars.forEach { p ->
            val twinkle = 0.35f + 0.65f * abs(sin(time * p.speed + p.phase))
            drawCircle(
                color = p.color,
                // Twinkle applied as the draw-scope alpha (it composes with
                // the color's own alpha) instead of building a new Color per
                // star per tick — same rendered value, zero allocation.
                alpha = twinkle,
                radius = p.size * density * 0.5f,
                center = Offset(p.x * w, p.y * h),
            )
        }
    }
}

/**
 * Occasional lightning flashes with a double-strike envelope for storms.
 */
@Composable
fun LightningOverlay(modifier: Modifier = Modifier) {
    var flash by remember { mutableFloatStateOf(0f) }
    var nextStrike by remember { mutableFloatStateOf(3f + Random.nextFloat() * 6f) }

    FrameLoop { dt ->
        if (flash > 0f) {
            flash = (flash - dt * 2.6f).coerceAtLeast(0f)
        } else {
            nextStrike -= dt
            if (nextStrike <= 0f) {
                flash = 1f
                nextStrike = 4f + Random.nextFloat() * 9f
            }
        }
    }

    Canvas(modifier) {
        if (flash <= 0f) return@Canvas
        // Double-strike: two peaks within the decay envelope. Peak intensity
        // is deliberately soft — a full-screen strobe is a photosensitivity
        // hazard, a glow is atmosphere.
        val pulse = if (flash > 0.72f) 1f else if (flash > 0.5f) 0.25f else flash * 1.6f
        drawRect(color = Color(0xFFEAF1FF).copy(alpha = 0.20f * pulse))
    }
}
