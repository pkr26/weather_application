package com.cirrus.weather.ui.components

import androidx.compose.animation.core.EaseInOutSine
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.ui.theme.rememberReducedMotion

/**
 * Branded loading: a breathing sun over the night gradient. Used both by the
 * weather screen's Loading state and the pre-DataStore bootstrap frame, so
 * the first thing the user ever sees is the app, not a bare system spinner.
 * With system animations disabled the sun holds still — a calm static mark.
 */
@Composable
fun BrandedLoading(modifier: Modifier = Modifier) {
    val reducedMotion = rememberReducedMotion()
    // With reduced motion the infinite transition is never created at all —
    // a static mark invalidates nothing instead of ticking at 60 fps.
    val pulse: Float by if (reducedMotion) {
        remember { mutableStateOf(0.95f) }
    } else {
        rememberInfiniteTransition(label = "loadingPulse").animateFloat(
            initialValue = 0.75f,
            targetValue = 1.15f,
            animationSpec = infiniteRepeatable(
                animation = tween(900, easing = EaseInOutSine),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "pulseScale",
        )
    }
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFF141B3D), Color(0xFF1B2750), Color(0xFF23325E))
                )
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Canvas(modifier = Modifier.size(72.dp)) {
                val r = size.minDimension / 2f * pulse
                // Soft glow, then core.
                drawCircle(Color(0xFFFFC94D).copy(alpha = 0.22f), radius = r * 1.35f)
                drawCircle(Color(0xFFFFC94D), radius = r * 0.62f)
            }
            Text(
                text = stringResource(R.string.app_name),
                fontSize = 30.sp,
                fontWeight = FontWeight.Thin,
                letterSpacing = 2.sp,
                color = Color.White.copy(alpha = 0.92f),
            )
            Text(
                text = stringResource(R.string.loading_tagline),
                fontSize = 14.sp,
                color = Color.White.copy(alpha = 0.55f),
            )
        }
    }
}
