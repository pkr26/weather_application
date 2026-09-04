package com.cirrus.weather.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.domain.AlertUi
import com.cirrus.weather.ui.theme.CirrusPalette
import com.cirrus.weather.ui.theme.rememberClock24
import com.cirrus.weather.util.TimeFormats
import java.time.ZoneId
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.platform.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback

/**
 * Severe weather warning banner. Tint follows severity; tap to expand the
 * full description.
 */
@Composable
fun AlertBanner(alert: AlertUi, modifier: Modifier = Modifier, zone: ZoneId? = null) {
    val hapticFeedback = LocalHapticFeedback.current
    // Saveable + keyed to the alert: scrolling away and back keeps the
    // expanded state, matching the hourly and daily cards.
    var expandedFor by rememberSaveable { mutableStateOf<Pair<String, Boolean>?>(null) }
    val expanded = expandedFor?.first == alert.headline && expandedFor?.second == true
    val clock24 = rememberClock24()
    val expandedState = stringResource(R.string.row_expanded)
    val collapsedState = stringResource(R.string.row_collapsed)

    val severity = alert.severity.uppercase()
    val (accent, tint) = when {
        severity.contains("EXTREME") || severity.contains("SEVERE") ->
            CirrusPalette.AlertRed to Color(0xFFB3261E)
        severity.contains("MODERATE") ->
            CirrusPalette.AlertOrange to Color(0xFF8A5A19)
        else ->
            CirrusPalette.AlertYellow to Color(0xFF7A621A)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize()
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(tint.copy(alpha = 0.42f), RoundedCornerShape(24.dp))
                .clickable(role = Role.Button) { {
        hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
        expandedFor = alert.headline to !(expanded)
    }
                .semantics(mergeDescendants = true) {
                    stateDescription = if (expanded) expandedState else collapsedState
                },
        ) {
            // Severity accent edge.
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .width(4.dp)
                    .background(
                        Brush.verticalGradient(listOf(accent, accent.copy(alpha = 0.4f))),
                        RoundedCornerShape(topStart = 24.dp, bottomStart = 24.dp),
                    )
            )
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 20.dp, end = 16.dp, top = 14.dp, bottom = 14.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("⚠️", fontSize = 20.sp)
                    Spacer(Modifier.size(10.dp))
                    Column {
                        Text(
                            text = alert.headline,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White,
                        )
                        if (!expanded && alert.description.isNotBlank()) {
                            Text(
                                text = alert.description,
                                fontSize = 13.sp,
                                color = Color.White.copy(alpha = 0.8f),
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                if (expanded && alert.description.isNotBlank()) {
                    Text(
                        text = alert.description,
                        fontSize = 13.sp,
                        color = Color.White.copy(alpha = 0.85f),
                        modifier = Modifier.padding(start = 30.dp, top = 4.dp),
                    )
                    // Wall-clock time in the city's zone — a raw ISO-8601
                    // UTC instant means nothing to a user. Without a zone we
                    // omit the line rather than print machine timestamps.
                    if (zone != null) {
                        alert.endsAt?.let {
                            Text(
                                text = stringResource(
                                    R.string.alert_until,
                                    TimeFormats.hourMinute(it, zone, clock24),
                                ),
                                fontSize = 12.sp,
                                color = Color.White.copy(alpha = 0.6f),
                                modifier = Modifier.padding(start = 30.dp, top = 2.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
