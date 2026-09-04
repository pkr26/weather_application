package com.cirrus.weather.data.remote

import kotlinx.serialization.Serializable

/** City-search models — same shape the backend proxies from Open-Meteo. */

@Serializable
data class GeocodingResponse(
    val results: List<GeocodingResult> = emptyList(),
)

@Serializable
data class GeocodingResult(
    val id: Long? = null,
    val name: String? = null,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val country: String? = null,
    val country_code: String? = null,
    val admin1: String? = null,
    val timezone: String? = null,
)

/** Reverse-geocoded place for the device location — fields nullable on purpose. */
@Serializable
data class ReverseGeocodeResponse(
    val name: String? = null,
    val admin1: String? = null,
    val country: String? = null,
)
