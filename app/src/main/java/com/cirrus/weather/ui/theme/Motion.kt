package com.cirrus.weather.ui.theme

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect

/**
 * True when the user has disabled system animations (Animator duration
 * scale = 0) — the standard "reduce motion" signal on Android. Entrance
 * choreography, curve sweeps and ambient particles all switch off so the
 * screen is calm and the battery cost disappears. Re-checked on resume:
 * toggling animator scale is not a configuration change either.
 */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    fun current(): Boolean = Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    ) == 0f
    var reduced by remember { mutableStateOf(current()) }
    LifecycleResumeEffect(Unit) {
        reduced = current()
        onPauseOrDispose { }
    }
    return reduced
}
