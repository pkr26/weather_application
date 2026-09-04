package com.cirrus.weather.ui.theme

import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect

/**
 * The app-wide clock policy: every time shown on screen (hourly labels, sun
 * times, footers, alert ends) follows the system's 12/24-hour preference,
 * exactly like the settings time picker already did. Re-checked on every
 * resume — the toggle in system settings is not a configuration change.
 */
@Composable
fun rememberClock24(): Boolean {
    val context = LocalContext.current
    var clock24 by remember { mutableStateOf(DateFormat.is24HourFormat(context)) }
    LifecycleResumeEffect(Unit) {
        clock24 = DateFormat.is24HourFormat(context)
        onPauseOrDispose { }
    }
    return clock24
}
