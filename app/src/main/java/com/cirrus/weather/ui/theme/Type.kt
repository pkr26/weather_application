package com.cirrus.weather.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val CirrusTypography = Typography().let { base ->
    base.copy(
        displayLarge = base.displayLarge.copy(
            fontSize = 92.sp,
            fontWeight = FontWeight.Thin,
            letterSpacing = (-3).sp,
        ),
        displayMedium = base.displayMedium.copy(
            fontSize = 44.sp,
            fontWeight = FontWeight.Thin,
            letterSpacing = (-1).sp,
        ),
        headlineMedium = base.headlineMedium.copy(
            fontSize = 30.sp,
            fontWeight = FontWeight.Medium,
        ),
        titleMedium = base.titleMedium.copy(
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
        ),
        bodyLarge = base.bodyLarge.copy(fontSize = 17.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 14.sp),
        bodySmall = base.bodySmall.copy(fontSize = 12.sp),
        labelSmall = base.labelSmall.copy(
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 1.sp,
        ),
    )
}

val CardHeaderStyle = TextStyle(
    fontSize = 13.sp,
    fontWeight = FontWeight.SemiBold,
    letterSpacing = 0.8.sp,
)

val ModuleFooterStyle = TextStyle(
    fontSize = 13.sp,
    fontWeight = FontWeight.Normal,
    letterSpacing = 0.1.sp,
)
