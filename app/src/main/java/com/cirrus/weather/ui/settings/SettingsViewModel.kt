package com.cirrus.weather.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cirrus.weather.data.local.SettingsStore
import com.cirrus.weather.data.remote.dto.LanguageInfo
import com.cirrus.weather.di.AppContainer
import com.cirrus.weather.notify.NotificationScheduler
import com.cirrus.weather.notify.Notifier
import com.cirrus.weather.notify.activeCity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Offline-safe mirror of the backend's language catalog — the picker works
 * before the first successful fetch, then upgrades to the server list.
 */
object LanguageCatalogDefaults {
    val languages: List<LanguageInfo> = listOf(
        LanguageInfo("en", "English", "English"),
        LanguageInfo("hi", "हिन्दी", "Hindi"),
        LanguageInfo("te", "తెలుగు", "Telugu"),
        LanguageInfo("ta", "தமிழ்", "Tamil"),
        LanguageInfo("bn", "বাংলা", "Bengali"),
        LanguageInfo("mr", "मराठी", "Marathi"),
        LanguageInfo("gu", "ગુજરાતી", "Gujarati"),
        LanguageInfo("kn", "ಕನ್ನಡ", "Kannada"),
        LanguageInfo("ml", "മലയാളം", "Malayalam"),
        LanguageInfo("pa", "ਪੰਜਾਬੀ", "Punjabi"),
        LanguageInfo("ur", "اردو", "Urdu", rtl = true),
        LanguageInfo("es", "Español", "Spanish"),
        LanguageInfo("fr", "Français", "French"),
        LanguageInfo("de", "Deutsch", "German"),
        LanguageInfo("it", "Italiano", "Italian"),
        LanguageInfo("pt", "Português", "Portuguese"),
        LanguageInfo("nl", "Nederlands", "Dutch"),
        LanguageInfo("ru", "Русский", "Russian"),
        LanguageInfo("tr", "Türkçe", "Turkish"),
        LanguageInfo("ar", "العربية", "Arabic", rtl = true),
        LanguageInfo("id", "Bahasa Indonesia", "Indonesian"),
        LanguageInfo("th", "ไทย", "Thai"),
        LanguageInfo("vi", "Tiếng Việt", "Vietnamese"),
        LanguageInfo("ja", "日本語", "Japanese"),
        LanguageInfo("ko", "한국어", "Korean"),
        LanguageInfo("zh-CN", "简体中文", "Chinese (Simplified)"),
        LanguageInfo("zh-TW", "繁體中文", "Chinese (Traditional)"),
    )
}

class SettingsViewModel(private val container: AppContainer) : ViewModel() {

    val enabled: StateFlow<Boolean> = container.settings.notificationsEnabled
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    val language: StateFlow<String> = container.settings.notificationLanguage
        .stateIn(viewModelScope, SharingStarted.Eagerly, "en")

    val timeMinutes: StateFlow<Int> = container.settings.notificationTimeMinutes
        .stateIn(viewModelScope, SharingStarted.Eagerly, 8 * 60)

    private val _languages = MutableStateFlow(LanguageCatalogDefaults.languages)
    val languages: StateFlow<List<LanguageInfo>> = _languages.asStateFlow()

    init {
        viewModelScope.launch {
            val fetched = runCatching { container.cirrusApi.languages().languages }
                .getOrNull()
            if (!fetched.isNullOrEmpty()) _languages.value = fetched
        }
    }

    fun languageInfo(code: String): LanguageInfo? =
        _languages.value.firstOrNull { it.code == code }

    fun setEnabled(value: Boolean) {
        viewModelScope.launch {
            container.settings.setNotificationsEnabled(value)
            if (value) {
                NotificationScheduler.scheduleDailyBriefing(
                    container.appContext,
                    container.settings.notificationTimeMinutes.first(),
                )
                NotificationScheduler.scheduleAlertPolling(container.appContext)
            } else {
                NotificationScheduler.cancelDailyBriefing(container.appContext)
                NotificationScheduler.cancelAlertPolling(container.appContext)
            }
            container.deviceRegistrar.register()
        }
    }

    fun setLanguage(code: String) {
        viewModelScope.launch {
            container.settings.setNotificationLanguage(code)
            container.deviceRegistrar.register()
        }
    }

    fun setTimeMinutes(minutes: Int) {
        viewModelScope.launch {
            container.settings.setNotificationTimeMinutes(minutes)
            if (container.settings.notificationsEnabled.first()) {
                NotificationScheduler.scheduleDailyBriefing(container.appContext, minutes)
            }
            container.deviceRegistrar.register()
        }
    }

    /** Outcome of the "Send test notification" button, surfaced as a snackbar. */
    sealed interface TestSendState {
        data object Idle : TestSendState
        data object Sending : TestSendState
        data object Sent : TestSendState
        data object Failed : TestSendState
    }

    private val _testSend = MutableStateFlow<TestSendState>(TestSendState.Idle)
    val testSend: StateFlow<TestSendState> = _testSend.asStateFlow()

    /**
     * Fetches and posts the briefing right here (the same call the worker's
     * manual path makes) instead of enqueueing background work — a preview
     * must tell the user immediately whether it worked or failed.
     */
    fun sendTestNotification() {
        if (_testSend.value is TestSendState.Sending) return
        _testSend.value = TestSendState.Sending
        viewModelScope.launch {
            try {
                val city = container.activeCity()
                if (city == null) {
                    // No cities: there is nothing to preview a briefing for.
                    _testSend.value = TestSendState.Failed
                    return@launch
                }
                val language = container.settings.notificationLanguage.first()
                val units = container.settings.unitPref.first().key
                val briefing = container.cirrusApi.briefing(
                    latitude = city.latitude,
                    longitude = city.longitude,
                    city = city.displayName,
                    languageCode = language,
                    units = units,
                )
                // The post itself can fail (permission revoked in system
                // settings) — report that honestly instead of "sent".
                val posted = Notifier.showBriefing(
                    container.appContext,
                    title = briefing.title.ifBlank { city.displayName },
                    body = briefing.body,
                )
                _testSend.value = if (posted) TestSendState.Sent else TestSendState.Failed
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _testSend.value = TestSendState.Failed
            }
        }
    }

    fun consumeTestSendResult() {
        _testSend.value = TestSendState.Idle
    }

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            SettingsViewModel(container) as T
    }
}
