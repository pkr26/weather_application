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

    // Lazy so construction (Application.onCreate, main thread) never does
    // disk I/O — the directory is materialized on first use, which always
    // happens on a caller-provided dispatcher.
    private val dir by lazy { File(context.filesDir, "weather_cache").apply { mkdirs() } }
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

    /**
     * Drops every cached snapshot whose key starts with [keyPrefix] — a city
     * id, whose coordinate-qualified variants all share the prefix. Deleting
     * a city must not leave its snapshots orphaned on disk forever. Note the
     * on-disk name sanitizes the "id@lat,lon" key's separators to "_", so
     * the prefix match uses the sanitized separator.
     */
    fun removeAll(keyPrefix: String) {
        val safe = sanitize(keyPrefix) ?: return
        runCatching {
            dir.listFiles()?.forEach { file ->
                if (file.name.startsWith("${safe}_") || file.name == "$safe.json") {
                    file.delete()
                }
            }
        }
    }

    private fun fileFor(key: String): File? {
        val safe = sanitize(key) ?: return null
        return File(dir, "$safe.json")
    }

    // City ids are app-controlled ([a-z0-9_-]); guard anyway so a weird id
    // can never escape the cache directory.
    private fun sanitize(key: String): String? {
        val safe = key.replace(Regex("[^A-Za-z0-9._-]"), "_")
        if (safe.isEmpty() || safe == "." || safe == "..") return null
        return safe
    }
}
