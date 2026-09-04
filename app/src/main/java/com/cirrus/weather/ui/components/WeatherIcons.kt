package com.cirrus.weather.ui.components

import com.cirrus.weather.R

/**
 * Maps an API condition type (+ day/night) onto one of our hand-drawn glyphs.
 */
object WeatherIcons {

    fun forCondition(conditionType: String?, isDaytime: Boolean): Int {
        val day = isDaytime
        return when (conditionType?.uppercase()) {
            "CLEAR", "MOSTLY_CLEAR" ->
                if (day) R.drawable.ic_w_clear_day else R.drawable.ic_w_clear_night

            "PARTLY_CLOUDY", "MOSTLY_CLOUDY" ->
                if (day) R.drawable.ic_w_partly_day else R.drawable.ic_w_partly_night

            "CLOUDY" -> R.drawable.ic_w_cloudy
            "WINDY" -> R.drawable.ic_w_wind
            "WIND_AND_RAIN" -> R.drawable.ic_w_rain

            "LIGHT_RAIN_SHOWERS", "CHANCE_OF_SHOWERS", "SCATTERED_SHOWERS",
            "LIGHT_RAIN", "LIGHT_TO_MODERATE_RAIN" -> R.drawable.ic_w_rain_light

            "RAIN_SHOWERS", "RAIN", "MODERATE_TO_HEAVY_RAIN",
            "RAIN_PERIODICALLY_HEAVY" -> R.drawable.ic_w_rain

            "HEAVY_RAIN_SHOWERS", "HEAVY_RAIN" -> R.drawable.ic_w_rain_heavy

            "LIGHT_SNOW_SHOWERS", "CHANCE_OF_SNOW_SHOWERS", "SCATTERED_SNOW_SHOWERS",
            "LIGHT_SNOW", "LIGHT_TO_MODERATE_SNOW" -> R.drawable.ic_w_snow_light

            "SNOW_SHOWERS", "SNOW", "MODERATE_TO_HEAVY_SNOW",
            "SNOW_PERIODICALLY_HEAVY" -> R.drawable.ic_w_snow

            "HEAVY_SNOW_SHOWERS", "HEAVY_SNOW", "HEAVY_SNOW_STORM",
            "SNOWSTORM", "BLOWING_SNOW" -> R.drawable.ic_w_snow

            "RAIN_AND_SNOW" -> R.drawable.ic_w_sleet
            "HAIL", "HAIL_SHOWERS" -> R.drawable.ic_w_hail

            "THUNDERSTORM", "THUNDERSHOWER", "LIGHT_THUNDERSTORM_RAIN",
            "SCATTERED_THUNDERSTORMS", "HEAVY_THUNDERSTORM" -> R.drawable.ic_w_thunder

            else -> if (day) R.drawable.ic_w_partly_day else R.drawable.ic_w_partly_night
        }
    }
}
