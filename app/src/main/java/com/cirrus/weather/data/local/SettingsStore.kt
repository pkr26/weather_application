package com.cirrus.weather.data.local

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.cirrus.weather.domain.SavedCity
import com.cirrus.weather.domain.UnitPref
import com.cirrus.weather.notify.DeviceIdentity
import com.cirrus.weather.notify.DeviceRegistrar
import com.cirrus.weather.notify.NotificationPrefs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.Locale
import java.util.UUID

private val Context.dataStore by preferencesDataStore(name = "cirrus_settings")

/**
 * Persists saved cities, the active city, unit preference and notification
 * preferences (enabled, language, daily time, seen alerts, device id) — and
 * doubles as the registrar's [DeviceIdentity] (id in DataStore, secret in a
 * Keystore-encrypted [SecretVault]).
 */
class SettingsStore(
    context: Context,
    private val vault: SecretVault = KeystoreSecretVault(context),
) : DeviceIdentity, DeviceRegistrar.RegistrationSettings, NotificationPrefs {

    private val json = Json { ignoreUnknownKeys = true }
    private val store = context.dataStore

    private val citiesKey = stringPreferencesKey("cities_json")
    private val activeKey = stringPreferencesKey("active_city_id")
    private val unitsKey = stringPreferencesKey("unit_pref")

    private val notifEnabledKey = booleanPreferencesKey("notif_enabled")
    private val notifLangKey = stringPreferencesKey("notif_language")
    private val notifTimeKey = intPreferencesKey("notif_time_minutes")
    private val seenAlertsKey = stringSetPreferencesKey("seen_alert_keys")
    private val seenAlertsJsonKey = stringPreferencesKey("seen_alerts_json")
    private val deviceIdKey = stringPreferencesKey("device_id")
    private val deviceSecretKey = stringPreferencesKey("device_secret")
    private val onboardingDoneKey = booleanPreferencesKey("onboarding_done")
    private val lastBriefingAtKey = longPreferencesKey("last_briefing_posted_at_ms")

    /** Serializes id/secret first-use minting across concurrent callers. */
    private val identityMutex = Mutex()

    val cities: Flow<List<SavedCity>> = store.data.map { prefs ->
        decodeCities(prefs[citiesKey]).cities
    }

    /**
     * True when a persisted city list existed but couldn't be decoded and the
     * defaults silently took its place — the UI shows a one-time notice so
     * saved cities never just disappear.
     */
    val citiesWereReset: Flow<Boolean> = store.data.map { prefs ->
        val raw = prefs[citiesKey]
        raw != null && decodeCities(raw).corrupted
    }

    /** False until the user has seen (or dismissed) the first-run location prompt. */
    val onboardingDone: Flow<Boolean> = store.data.map { prefs ->
        prefs[onboardingDoneKey] ?: false
    }

    suspend fun setOnboardingDone() {
        store.edit { prefs ->
            prefs[onboardingDoneKey] = true
        }
    }

    val activeCityId: Flow<String?> = store.data.map { prefs ->
        prefs[activeKey]
    }

    val unitPref: Flow<UnitPref> = store.data.map { prefs ->
        UnitPref.fromKey(prefs[unitsKey])
    }

    /** Whether the user wants the daily briefing + alert notifications. */
    val notificationsEnabled: Flow<Boolean> = store.data.map { prefs ->
        prefs[notifEnabledKey] ?: false
    }

    /** BCP-47 code of the language notification content is generated in. */
    val notificationLanguage: Flow<String> = store.data.map { prefs ->
        prefs[notifLangKey] ?: defaultNotificationLanguage()
    }

    /** Local minutes-from-midnight the daily briefing should arrive (default 8:00). */
    val notificationTimeMinutes: Flow<Int> = store.data.map { prefs ->
        prefs[notifTimeKey] ?: 8 * 60
    }

    /** Alert dedupe keys already notified — prevents re-buzzing on every poll. */
    val seenAlertKeys: Flow<Set<String>> = store.data.map { prefs ->
        seenAlerts(prefs).keys
    }

    val deviceId: Flow<String> = store.data.map { prefs ->
        prefs[deviceIdKey] ?: ""
    }

    /**
     * Reads the device id, minting one on first use. Mutex-guarded: without
     * it, two first-launch callers (app open + first registration) could
     * both mint an id and one would register a ghost device server-side.
     */
    override suspend fun deviceId(): String = identityMutex.withLock {
        val existing = deviceId.first()
        if (existing.isNotBlank()) return existing
        val id = UUID.randomUUID().toString()
        store.edit { prefs -> prefs[deviceIdKey] = id }
        id
    }

    /**
     * The registry secret — stored only in the Keystore-encrypted vault.
     * A secret written by older versions into DataStore is migrated (and
     * scrubbed from the plaintext preferences) on first read.
     */
    override suspend fun secret(): String? {
        vault.get()?.let { return it }
        val legacy = store.data.first()[deviceSecretKey] ?: return null
        // Scrub the plaintext copy ONLY once the vault confirmed the write —
        // on a broken vault this must stay the last surviving copy.
        if (vault.set(legacy)) {
            store.edit { it.remove(deviceSecretKey) }
        }
        return legacy
    }

    override suspend fun storeSecret(secret: String): Boolean = vault.set(secret)

    /** Forgets the whole identity: a 401 from the registry means the server
     *  no longer knows this device, so the next register() mints fresh. */
    override suspend fun reset() {
        identityMutex.withLock {
            vault.clear()
            store.edit { prefs ->
                prefs.remove(deviceIdKey)
                prefs.remove(deviceSecretKey)
            }
        }
    }

    // ---- RegistrationSettings: notification preferences the registrar syncs.

    override suspend fun language(): String = notificationLanguage.first()

    override suspend fun notificationTimeMinutes(): Int = notificationTimeMinutes.first()

    override suspend fun units(): String = unitPref.first().key

    override suspend fun alertsEnabled(): Boolean = notificationsEnabled.first()

    // ---- NotificationPrefs: the use cases' (test-friendly) slice.

    override suspend fun notifLanguage(): String = notificationLanguage.first()

    override suspend fun unitsKey(): String = unitPref.first().key

    override suspend fun seenKeys(): Set<String> = seenAlertKeys.first()

    override suspend fun markSeen(keys: Set<String>) = markAlertsSeen(keys)

    override suspend fun recordBriefingPostedAt(epochMs: Long) = setLastBriefingPostedAt(epochMs)

    private data class DecodedCities(val cities: List<SavedCity>, val corrupted: Boolean)

    private fun decodeCities(raw: String?): DecodedCities {
        if (raw.isNullOrBlank()) return DecodedCities(defaultCities(), corrupted = false)
        return runCatching { json.decodeFromString<List<SavedCity>>(raw) }
            .fold(
                onSuccess = { DecodedCities(it, corrupted = false) },
                onFailure = { DecodedCities(defaultCities(), corrupted = true) },
            )
    }

    suspend fun saveCities(cities: List<SavedCity>) {
        store.edit { prefs ->
            prefs[citiesKey] = json.encodeToString(cities)
        }
    }

    suspend fun setActiveCity(id: String) {
        store.edit { prefs ->
            prefs[activeKey] = id
        }
    }

    suspend fun setUnitPref(pref: UnitPref) {
        store.edit { prefs ->
            prefs[unitsKey] = pref.key
        }
    }

    suspend fun setNotificationsEnabled(enabled: Boolean) {
        store.edit { prefs ->
            prefs[notifEnabledKey] = enabled
        }
    }

    suspend fun setNotificationLanguage(code: String) {
        store.edit { prefs ->
            prefs[notifLangKey] = code
        }
    }

    suspend fun setNotificationTimeMinutes(minutes: Int) {
        store.edit { prefs ->
            prefs[notifTimeKey] = minutes.coerceIn(0, 24 * 60 - 1)
        }
    }

    /**
     * Wall-clock epoch ms when the briefing last actually posted (0 = never).
     * Lets a boot / timezone reschedule notice that today's briefing was
     * missed while the device was offline and catch up instead of silently
     * jumping to tomorrow — while the 20-hour window stops a timezone hop
     * across local midnight from double-posting within hours of the real one.
     */
    val lastBriefingPostedAt: Flow<Long> = store.data.map { prefs ->
        prefs[lastBriefingAtKey] ?: 0L
    }

    suspend fun setLastBriefingPostedAt(epochMs: Long) {
        store.edit { prefs ->
            prefs[lastBriefingAtKey] = epochMs
        }
    }

    /**
     * Records dedupe keys with the time they were seen. Eviction keeps the
     * MOST RECENTLY SEEN keys — the value is keyed by seen-at epoch millis,
     * not by the hex digest, so a still-active alert whose key happens to
     * sort early is never the one dropped (lexicographic eviction re-buzzed
     * random alerts).
     */
    suspend fun markAlertsSeen(keys: Set<String>) {
        if (keys.isEmpty()) return
        store.edit { prefs ->
            val now = System.currentTimeMillis()
            val combined = seenAlerts(prefs) + keys.associateWith { now }
            val kept = if (combined.size <= SEEN_ALERTS_CAP) {
                combined
            } else {
                combined.entries.sortedByDescending { it.value }.take(SEEN_ALERTS_CAP).associate { it.toPair() }
            }
            prefs[seenAlertsJsonKey] = json.encodeToString(kept)
            // The legacy unordered set is superseded; drop it so the two
            // stores can never disagree.
            prefs.remove(seenAlertsKey)
        }
    }

    /** seen-alerts map from prefs, migrating the legacy unordered set once. */
    private fun seenAlerts(prefs: androidx.datastore.preferences.core.Preferences): Map<String, Long> {
        prefs[seenAlertsJsonKey]?.let { raw ->
            runCatching { json.decodeFromString<Map<String, Long>>(raw) }
                .getOrNull()
                ?.let { return it }
        }
        // Legacy format (pre-timestamps): import with time 0 so those keys
        // are the first evicted — they were seen longest ago by definition.
        val legacy = prefs[seenAlertsKey] ?: return emptyMap()
        return legacy.associateWith { 0L }
    }

    companion object {
        /** Upper bound for the persisted seen-alert dedupe set. */
        const val SEEN_ALERTS_CAP = 128

        fun defaultCities(): List<SavedCity> = listOf(
            SavedCity(
                id = "hyderabad",
                name = "Hyderabad",
                region = "Telangana",
                country = "India",
                latitude = 17.385,
                longitude = 78.4867,
                timeZone = "Asia/Kolkata",
            )
        )

        /**
         * Prefills the picker with the device locale. Region is kept only
         * for Chinese (which has two written forms); everything else maps
         * to a plain language code that exists in the backend catalog.
         */
        fun defaultNotificationLanguage(): String {
            val locale = Locale.getDefault()
            val lang = locale.language
            return when {
                lang == "zh" && locale.country in setOf("TW", "HK", "MO") -> "zh-TW"
                lang == "zh" -> "zh-CN"
                else -> lang
            }
        }
    }
}
