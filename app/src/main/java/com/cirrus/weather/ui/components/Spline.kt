package com.cirrus.weather.ui.components

import kotlin.math.max
import kotlin.math.min

/**
 * Catmull-Rom spline through a fixed set of sample points.
 * Used by the hourly temperature curve; also exposes [yAt] so labels can sit
 * exactly on the curve.
 */
class Spline(
    val xs: FloatArray,
    val ys: FloatArray,
) {
    init {
        require(xs.size == ys.size && xs.size >= 2) { "spline needs >= 2 points" }
    }

    /** Catmull-Rom interpolation of y at x (x must lie within [first, last]). */
    fun yAt(x: Float): Float {
        val n = xs.size
        if (x <= xs[0]) return ys[0]
        if (x >= xs[n - 1]) return ys[n - 1]
        var i = 0
        while (i < n - 2 && x > xs[i + 1]) i++
        val p0x = xs[max(i - 1, 0)]; val p0y = ys[max(i - 1, 0)]
        val p1x = xs[i]; val p1y = ys[i]
        val p2x = xs[i + 1]; val p2y = ys[i + 1]
        val p3x = xs[min(i + 2, n - 1)]; val p3y = ys[min(i + 2, n - 1)]
        val t = (x - p1x) / (p2x - p1x)
        val t2 = t * t
        val t3 = t2 * t
        return 0.5f * (
            (2f * p1y) +
                (-p0y + p2y) * t +
                (2f * p0y - 5f * p1y + 4f * p2y - p3y) * t2 +
                (-p0y + 3f * p1y - 3f * p2y + p3y) * t3
            )
    }

    companion object {
        /**
         * Builds normalized spline sample points from a values list.
         * Returns (xs, ys) in a 0..1 space, y already flipped (higher value = smaller y).
         */
        fun normalized(values: List<Double>): Pair<FloatArray, FloatArray> {
            val n = values.size
            val xs = FloatArray(n) { if (n == 1) 0f else it / (n - 1).toFloat() }
            val minV = values.min()
            val maxV = values.max()
            val span = (maxV - minV).takeIf { it > 0.0001 } ?: 1.0
            val ys = FloatArray(n) {
                val norm = ((values[it] - minV) / span).toFloat()
                1f - norm // flip: larger values map to smaller y (screen space)
            }
            return xs to ys
        }
    }
}
