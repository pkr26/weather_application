package com.cirrus.weather.ui.fx

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.cirrus.weather.domain.Archetype
import com.cirrus.weather.ui.theme.rememberReducedMotion

/**
 * Full-bleed weather gradient that cross-fades when the archetype changes,
 * with the matching ambient particle effect layered on top. With system
 * animations disabled (reduce motion) the gradient stays — particles and
 * lightning don't run at all.
 */
@Composable
fun AmbientBackground(
    archetype: Archetype,
    windDegrees: Float?,
    modifier: Modifier = Modifier,
) {
    val reducedMotion = rememberReducedMotion()
    val colorSpec = if (reducedMotion) snap<Color>() else tween<Color>(1200)
    val top by animateColorAsState(archetype.top, colorSpec, label = "gradTop")
    val middle by animateColorAsState(archetype.middle, colorSpec, label = "gradMid")
    val bottom by animateColorAsState(archetype.bottom, colorSpec, label = "gradBot")
    // The color list is hoisted: after the (optional) cross-fade settles,
    // the draw phase allocates nothing per frame.
    val gradientColors = remember(top, middle, bottom) { listOf(top, middle, bottom) }

    Canvas(modifier = modifier) {
        drawRect(
            brush = Brush.verticalGradient(
                colors = gradientColors,
                startY = 0f,
                endY = size.height,
            )
        )
    }

    if (reducedMotion) return

    when (archetype.fx) {
        com.cirrus.weather.domain.Fx.RAIN -> RainEffect(intensity = 0.55f, windDegrees, modifier)
        com.cirrus.weather.domain.Fx.HEAVY_RAIN -> RainEffect(intensity = 1f, windDegrees, modifier)
        com.cirrus.weather.domain.Fx.SNOW -> SnowEffect(intensity = 0.55f, modifier)
        com.cirrus.weather.domain.Fx.HEAVY_SNOW -> SnowEffect(intensity = 1f, modifier)
        com.cirrus.weather.domain.Fx.STARS -> StarField(modifier)
        com.cirrus.weather.domain.Fx.STORM -> {
            RainEffect(intensity = 0.9f, windDegrees, modifier)
            LightningOverlay(modifier)
        }
        com.cirrus.weather.domain.Fx.NONE -> Unit
    }
}

internal fun Color.lighten(fraction: Float): Color =
    Color(
        red = red + (1f - red) * fraction,
        green = green + (1f - green) * fraction,
        blue = blue + (1f - blue) * fraction,
        alpha = alpha,
    )

internal fun lerpOffset(a: Offset, b: Offset, t: Float): Offset =
    Offset(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
