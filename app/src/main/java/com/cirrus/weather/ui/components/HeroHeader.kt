package com.cirrus.weather.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cirrus.weather.R
import com.cirrus.weather.domain.CurrentUi
import com.cirrus.weather.domain.DayUi
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.domain.Units
import com.cirrus.weather.domain.WeatherBundle

@Composable
fun HeroHeader(
    cityName: String,
    weather: WeatherBundle,
    today: DayUi?,
    unitPref: UnitPref,
    modifier: Modifier = Modifier,
) {
    val current: CurrentUi = weather.current
    // A readable text shadow over every gradient — white without it washes
    // out on bright clear-day backgrounds.
    val textShadow = Shadow(Color.Black.copy(alpha = 0.38f), blurRadius = 10f)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = cityName,
            fontSize = 34.sp,
            fontWeight = FontWeight.Medium,
            color = Color.White,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = androidx.compose.ui.text.TextStyle(shadow = textShadow),
        )
        // Big colorful condition glyph — the hero's focal color moment. The
        // condition is announced by the text below; a contentDescription here
        // would make TalkBack read it twice.
        Image(
            painter = painterResource(
                WeatherIcons.forCondition(current.conditionType, current.isDaytime)
            ),
            contentDescription = null,
            modifier = Modifier
                .padding(top = 6.dp)
                .size(76.dp),
        )
        Text(
            text = Units.tempNumber(current.temperatureC, unitPref) + "°",
            fontSize = 92.sp,
            fontWeight = FontWeight.Thin,
            letterSpacing = (-3).sp,
            color = Color.White,
            style = androidx.compose.ui.text.TextStyle(
                shadow = Shadow(Color.Black.copy(alpha = 0.22f), blurRadius = 14f),
            ),
        )
        Text(
            text = current.conditionText,
            fontSize = 19.sp,
            fontWeight = FontWeight.Medium,
            color = Color.White.copy(alpha = 0.96f),
            style = androidx.compose.ui.text.TextStyle(shadow = textShadow),
        )
        Row(
            modifier = Modifier.padding(top = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Without a forecast for today, past-24h extremes are shown —
            // labeled as such so they're never mistaken for today's forecast.
            // White with a shadow: the old amber/sky tints measured ~1.2:1
            // against bright clear-day gradients.
            Text(
                text = stringResource(
                    if (today?.maxTempC == null) R.string.hero_past_high else R.string.hero_high,
                    Units.tempNumber(today?.maxTempC ?: current.past24hMaxC, unitPref),
                ),
                fontSize = 19.sp,
                fontWeight = FontWeight.Medium,
                color = Color.White.copy(alpha = 0.95f),
                style = androidx.compose.ui.text.TextStyle(shadow = textShadow),
            )
            Text(
                text = stringResource(
                    if (today?.minTempC == null) R.string.hero_past_low else R.string.hero_low,
                    Units.tempNumber(today?.minTempC ?: current.past24hMinC, unitPref),
                ),
                fontSize = 19.sp,
                fontWeight = FontWeight.Medium,
                color = Color.White.copy(alpha = 0.95f),
                style = androidx.compose.ui.text.TextStyle(shadow = textShadow),
            )
        }
    }
}
