package com.cirrus.weather.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Vivid accent palette shared by cards, gauges and module icons —
 * the Google-Weather-style color story over the ambient weather gradient.
 */
object CirrusPalette {
    val SunAmber = Color(0xFFFFC94D)
    val SunDeep = Color(0xFFFFA726)
    val Sky = Color(0xFF8FD3F4)
    val SkyDeep = Color(0xFF4FA8E8)
    val RainBlue = Color(0xFF6FB4F5)
    val RainDeep = Color(0xFF3E7BD6)
    val Teal = Color(0xFF7FE0C8)
    val TealDeep = Color(0xFF3FBFA5)
    val Orange = Color(0xFFF5A962)
    val OrangeDeep = Color(0xFFE8863C)
    val Violet = Color(0xFFB39DDB)
    val VioletDeep = Color(0xFF8E6FD3)
    val Cloud = Color(0xFFD7E1EE)
    val MoonLight = Color(0xFFE8ECF5)
    val AlertRed = Color(0xFFFF5A5A)
    val AlertOrange = Color(0xFFFF9E45)
    val AlertYellow = Color(0xFFFFD54F)

    /** UV category color on the green→red scale. */
    fun uvColor(uv: Int): Color = when {
        uv <= 2 -> Color(0xFF64C860)
        uv <= 5 -> Color(0xFFD6C84B)
        uv <= 7 -> Color(0xFFE8A83C)
        uv <= 9 -> Color(0xFFE86A3C)
        else -> Color(0xFFE85B3C)
    }
}
