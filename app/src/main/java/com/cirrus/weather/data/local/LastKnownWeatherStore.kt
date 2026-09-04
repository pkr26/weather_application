package com.cirrus.weather.data.local

import android.content.Context
import com.cirrus.weather.data.remote.dto.BundleResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Last-known weather per city, persisted as JSON so an offline launch can
 * still show this morning's numbers (flagged stale) instead of a dead error
 * screen. One small file per city — the cache the network layer never had.
 * Synchronous by design; callers bring their own dispatcher.
 */
class LastKnownWeatherStore(context: Context) {

    private val dir = File(context.filesDir, "weather_cache").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }

    @Serializable
    private data class Cached(val fetchedAtMs: Long, val bundle: BundleResponse)

    /** The cached bundle plus when it was fetched, or null when never/undecodable. */
    fun get(key: String): Pair<BundleResponse, Long>? {
        val file = fileFor(key) ?: return null
        return runCatching {
            val cached = json.decodeFromString<Cached>(file.readText())
            cached.bundle to cached.fetchedAtMs
        }.getOrNull()
    }

    fun put(key: String, bundle: BundleResponse) {
        val file = fileFor(key) ?: return
        runCatching {
            val payload = json.encodeToString(Cached(System.currentTimeMillis(), bundle))
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(payload)
            // Atomic swap; the fallback rewrite covers exotic rename failures.
            if (!tmp.renameTo(file)) {
                file.writeText(payload)
                tmp.delete()
            }
        }
    }

    private fun fileFor(key: String): File? {
        // City ids are app-controlled ([a-z0-9_-]); guard anyway so a weird
        // id can never escape the cache directory.
        val safe = key.replace(Regex("[^A-Za-z0-9._-]"), "_")
        if (safe.isEmpty() || safe == "." || safe == "..") return null
        return File(dir, "$safe.json")
    }
}
