package com.cirrus.weather.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

/** The card silhouette — shared by every glass card, allocated once. */
private val CardShape = RoundedCornerShape(24.dp)

/** The sheen falloff — allocation-free per composition. */
private val SheenColors = listOf(
    Color.White.copy(alpha = 0.07f),
    Color.Transparent,
)

/**
 * Apple Weather-style translucent card: a soft white gradient fill (brighter
 * at the top, like light catching the glass), hairline border, generous
 * corner radius — plus a faint diagonal sheen so the glass reads colorful
 * against the weather gradient behind it.
 */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(16.dp),
    tint: Color = Color.White.copy(alpha = 0.12f),
    content: @Composable ColumnScope.() -> Unit,
) {
    // Vertical falloff: +30% tint at the top edge fading to the base tint.
    val tintBrush = Brush.verticalGradient(
        colors = listOf(tint.copy(alpha = (tint.alpha * 1.3f).coerceAtMost(0.4f)), tint),
    )
    Box(
        modifier = modifier
            .background(tintBrush, CardShape)
            .border(
                width = 0.75.dp,
                color = Color.White.copy(alpha = 0.22f),
                shape = CardShape,
            )
    ) {
        // Diagonal light streak across the top corner — the "glass" cue.
        // End point is density-scaled so the streak keeps its shape on
        // every screen instead of shrinking on high-density displays.
        val density = LocalDensity.current
        val sheenEnd = with(density) { androidx.compose.ui.geometry.Offset(225.dp.toPx(), 75.dp.toPx()) }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp)
                .clip(CardShape)
                .background(
                    Brush.linearGradient(
                        colors = SheenColors,
                        start = androidx.compose.ui.geometry.Offset(0f, 0f),
                        end = sheenEnd,
                    )
                )
        )
        Column(
            modifier = Modifier.padding(contentPadding),
            content = content,
        )
    }
}
