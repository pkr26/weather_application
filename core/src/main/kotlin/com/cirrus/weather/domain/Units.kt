package com.cirrus.weather.domain

import java.util.Locale
import kotlin.math.roundToInt

enum class UnitPref(val key: String) { METRIC("metric"), IMPERIAL("imperial");

    companion object {
        fun fromKey(key: String?): UnitPref =
            if (key == IMPERIAL.key) IMPERIAL else METRIC
    }
}

object Units {

    fun celsiusToFahrenheit(c: Double): Double = c * 9.0 / 5.0 + 32.0

    fun kmhToMph(kmh: Double): Double = kmh / 1.609344

    fun kmToMiles(km: Double): Double = km / 1.609344

    fun mmToInches(mm: Double): Double = mm / 25.4

    fun mbToInHg(mb: Double): Double = mb / 33.8639

    /** Display temperature in the preferred unit, rounded to a whole degree. */
    fun tempDisplay(celsius: Double?, pref: UnitPref): String {
        if (celsius == null) return "--"
        val v = if (pref == UnitPref.IMPERIAL) celsiusToFahrenheit(celsius) else celsius
        return "${v.roundToInt()}°"
    }

    /** Same as [tempDisplay] but without the degree symbol (for hero layout). */
    fun tempNumber(celsius: Double?, pref: UnitPref): String {
        if (celsius == null) return "--"
        val v = if (pref == UnitPref.IMPERIAL) celsiusToFahrenheit(celsius) else celsius
        return v.roundToInt().toString()
    }

    fun windDisplay(kmh: Double?, pref: UnitPref): String {
        if (kmh == null) return "--"
        val v = if (pref == UnitPref.IMPERIAL) kmhToMph(kmh) else kmh
        val unit = if (pref == UnitPref.IMPERIAL) "mph" else "km/h"
        return "${v.roundToInt()} $unit"
    }

    fun windNumber(kmh: Double?, pref: UnitPref): String {
        if (kmh == null) return "--"
        val v = if (pref == UnitPref.IMPERIAL) kmhToMph(kmh) else kmh
        return v.roundToInt().toString()
    }

    fun windUnit(pref: UnitPref): String =
        if (pref == UnitPref.IMPERIAL) "mph" else "km/h"

    fun visibilityDisplay(km: Double?, pref: UnitPref): String {
        if (km == null) return "--"
        val v = if (pref == UnitPref.IMPERIAL) kmToMiles(km) else km
        val unit = if (pref == UnitPref.IMPERIAL) "mi" else "km"
        // Locale pinned: decimal separators must not follow the device
        // locale ("12,5 km") when the unit is metric-English.
        return "${if (v < 10) "%.1f".format(Locale.US, v) else v.roundToInt()} $unit"
    }

    fun precipDisplay(mm: Double?, pref: UnitPref): String {
        if (mm == null) return "--"
        return if (pref == UnitPref.IMPERIAL) {
            "\"${"%.2f".format(Locale.US, mmToInches(mm))}"
        } else {
            "${if (mm < 10) "%.1f".format(Locale.US, mm) else mm.roundToInt()} mm"
        }
    }

    fun pressureDisplay(mb: Double?, pref: UnitPref): String {
        if (mb == null) return "--"
        return if (pref == UnitPref.IMPERIAL) {
            "%.2f inHg".format(Locale.US, mbToInHg(mb))
        } else {
            "${mb.roundToInt()} mb"
        }
    }
}
