package com.cirrus.weather.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import com.cirrus.weather.ui.theme.rememberReducedMotion
import kotlinx.coroutines.delay

/** Shared easing for all entrance choreography: fast start, long soft settle. */
val EnterEasing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

/**
 * Returns a progress Animatable that animates 0 -> 1 exactly once per [key].
 *
 * Lazy lists dispose off-screen items and recompose them on return, so a
 * plain `remember`-held Animatable would replay its animation every scroll.
 * The played-state is `rememberSaveable` and stores *which key* the animation
 * last ran for:
 *  - scrolled away and back (same key) -> restored, animation skipped;
 *  - key changed (e.g. a different city's content in the same slot) -> replays;
 *  - pull-to-refresh in place -> composition survives, nothing replays.
 *
 * Read `progress.value` inside deferred blocks (graphicsLayer / Canvas draw)
 * so animation frames invalidate drawing only, not composition.
 */
@Composable
internal fun playOnce(
    key: Any?,
    delayMs: Long = 0L,
    durationMs: Int = 560,
): Animatable<Float, AnimationVector1D> {
    // String keys only — rememberSaveable stores the value in a Bundle,
    // which cannot hold arbitrary objects (this crashed the app on state
    // save before the key was normalized to a String).
    val effectiveKey: String = key?.toString() ?: "playOnce-default"
    val reducedMotion = rememberReducedMotion()
    var playedFor by rememberSaveable { mutableStateOf<String?>(null) }
    // Keyed on effectiveKey: when a different city's content takes over the
    // slot, the Animatable must restart from 0 or animateTo(1f) starts at 1
    // and the sweep is over in a single frame. Same-key recomposition keeps
    // the instance, so a running animation is never restarted mid-flight.
    val progress = remember(effectiveKey) {
        Animatable(
            if (playedFor == effectiveKey || reducedMotion) 1f else 0f
        )
    }
    LaunchedEffect(effectiveKey) {
        if (playedFor == effectiveKey || reducedMotion) {
            playedFor = effectiveKey
            return@LaunchedEffect
        }
        if (delayMs > 0) delay(delayMs)
        progress.animateTo(1f, tween(durationMs, easing = EnterEasing))
        playedFor = effectiveKey
    }
    return progress
}

/**
 * One-shot entrance: fades in while rising [distance]dp, delayed by
 * [index] * [staggerMs]. Runs once per distinct [key] (see [playOnce]).
 */
fun Modifier.entrance(
    key: Any?,
    index: Int = 0,
    staggerMs: Int = 45,
    distanceDp: Float = 26f,
    durationMs: Int = 560,
): Modifier = composed {
    val progress = playOnce(
        key = key,
        delayMs = (index.coerceAtLeast(0) * staggerMs).toLong(),
        durationMs = durationMs,
    )
    graphicsLayer {
        val p = progress.value
        alpha = p
        translationY = (1f - p) * distanceDp * density
    }
}
