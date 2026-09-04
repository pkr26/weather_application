package com.cirrus.weather.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val CirrusColors = darkColorScheme(
    primary = Color.White,
    onPrimary = Color(0xFF1A2433),
    secondary = Color(0xFFB8C7DB),
    onSecondary = Color(0xFF1A2433),
    tertiary = Color(0xFFFFD966),
    background = Color(0xFF101726),
    onBackground = Color.White,
    surface = Color.Transparent,
    onSurface = Color.White,
    surfaceVariant = Color.Transparent,
    onSurfaceVariant = Color(0xCCFFFFFF),
    error = Color(0xFFFF6B6B),
)

@Composable
fun CirrusTheme(content: @Composable () -> Unit) {
    // The app is always presented over a dark weather gradient, so the
    // scheme is constant — no light/dark branch and no mode subscription.
    MaterialTheme(
        colorScheme = CirrusColors,
        typography = CirrusTypography,
        content = content,
    )
}
