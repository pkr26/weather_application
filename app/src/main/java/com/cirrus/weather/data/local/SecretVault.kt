package com.cirrus.weather.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Storage for the device-registry secret. The default implementation keeps
 * it inside the Android Keystore-encrypted preferences file, so a plain
 * filesystem read of the app's data directory never yields the credential.
 */
interface SecretVault {
    suspend fun get(): String?

    /** @return false when the value could not be persisted (broken vault). */
    suspend fun set(secret: String): Boolean

    /** @return false when the vault is unavailable. */
    suspend fun clear(): Boolean
}

/**
 * Keystore-backed vault. Android-framework-bound by nature (Keystore keys
 * cannot exist in a JVM unit test), so it is deliberately tiny and excluded
 * from mutation targets; the registrar logic around it is fully tested
 * against the [SecretVault] interface.
 *
 * Self-healing: a corrupted keystore entry or encrypted-prefs file (vendor
 * bugs, OS upgrades) is scrubbed once and reopened — a vault that stays
 * broken would silently kill device registration forever, because the
 * 401-recovery path can never trigger without a successful HTTP call.
 */
class KeystoreSecretVault(context: Context) : SecretVault {

    private val appContext = context.applicationContext
    private var cached: SharedPreferences? = null
    private var exhausted = false

    private fun build(): SharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            "cirrus_device_secret",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    // Synchronized: the IO pool can open the vault from the registrar and
    // the workers concurrently — two racing rebuilds could otherwise delete
    // a file the other just created.
    @Synchronized
    private fun open(): SharedPreferences? {
        if (exhausted) return null
        cached?.let { return it }
        val first = runCatching { build() }
        if (first.isSuccess) { cached = first.getOrThrow(); return cached }
        // Scrub the encrypted file (and any half-created key state) and try
        // exactly once more — the secret is re-issued on the next
        // registration, so losing it here costs nothing.
        runCatching { appContext.deleteSharedPreferences("cirrus_device_secret") }
        val second = runCatching { build() }
        if (second.isSuccess) { cached = second.getOrThrow(); return cached }
        exhausted = true
        return null
    }

    // Keystore + file I/O never touches the main thread: first access
    // (master key creation + full-file decrypt) is real disk/keystore work
    // and callers arrive here from viewModelScope (Main.immediate).
    override suspend fun get(): String? = withContext(Dispatchers.IO) { open()?.getString(KEY, null) }

    override suspend fun set(secret: String): Boolean = withContext(Dispatchers.IO) {
        open()?.edit()?.putString(KEY, secret)?.apply() != null
    }

    override suspend fun clear(): Boolean = withContext(Dispatchers.IO) {
        open()?.edit()?.remove(KEY)?.apply() != null
    }

    private companion object {
        const val KEY = "device_secret"
    }
}
