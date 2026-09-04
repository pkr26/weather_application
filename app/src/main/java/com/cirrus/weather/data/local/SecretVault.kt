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
    suspend fun set(secret: String)
    suspend fun clear()
}

/**
 * Keystore-backed vault. Android-framework-bound by nature (Keystore keys
 * cannot exist in a JVM unit test), so it is deliberately tiny and excluded
 * from mutation targets; the registrar logic around it is fully tested
 * against the [SecretVault] interface.
 */
class KeystoreSecretVault(context: Context) : SecretVault {

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "cirrus_device_secret",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    // Keystore + file I/O never touches the main thread: first access
    // (master key creation + full-file decrypt) is real disk/keystore work
    // and callers arrive here from viewModelScope (Main.immediate).
    override suspend fun get(): String? = withContext(Dispatchers.IO) { prefs.getString(KEY, null) }

    override suspend fun set(secret: String) = withContext(Dispatchers.IO) {
        prefs.edit().putString(KEY, secret).apply()
    }

    override suspend fun clear() = withContext(Dispatchers.IO) {
        prefs.edit().remove(KEY).apply()
        Unit
    }

    private companion object {
        const val KEY = "device_secret"
    }
}
