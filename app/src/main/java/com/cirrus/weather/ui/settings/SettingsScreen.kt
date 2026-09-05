package com.cirrus.weather.ui.settings

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.text.format.DateFormat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.cirrus.weather.R
import com.cirrus.weather.ui.theme.CirrusPalette
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Notification settings: daily briefing on/off, delivery time, language
 * (27 languages from the backend catalog) and a "send it now" preview with
 * immediate feedback.
 */
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val enabled by viewModel.enabled.collectAsStateWithLifecycle()
    val language by viewModel.language.collectAsStateWithLifecycle()
    val timeMinutes by viewModel.timeMinutes.collectAsStateWithLifecycle()
    val languages by viewModel.languages.collectAsStateWithLifecycle()
    val testSend by viewModel.testSend.collectAsStateWithLifecycle()

    var showLanguagePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val sentMessage = stringResource(R.string.test_sent)
    val failedMessage = stringResource(R.string.test_failed)

    // Surface the test-notification outcome instead of firing silently.
    LaunchedEffect(testSend) {
        when (testSend) {
            SettingsViewModel.TestSendState.Sent -> {
                snackbarHostState.showSnackbar(sentMessage)
                viewModel.consumeTestSendResult()
            }
            SettingsViewModel.TestSendState.Failed -> {
                snackbarHostState.showSnackbar(failedMessage)
                viewModel.consumeTestSendResult()
            }
            else -> Unit
        }
    }

    // Runtime permission (Android 13+): requested when the user flips the
    // toggle. After a permanent denial the system answers false instantly —
    // in that case the only honest path left is the app's system settings.
    val context = LocalContext.current
    val blockedMessage = stringResource(R.string.notifications_blocked)
    val settingsActionLabel = stringResource(R.string.open_app_settings)
    val scope = rememberCoroutineScope()
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        viewModel.setEnabled(granted)
        if (!granted) {
            // A denial (permanent or not) has exactly one recovery path the
            // app can offer: the system's notification settings for the app.
            scope.launch {
                val result = snackbarHostState.showSnackbar(
                    message = blockedMessage,
                    actionLabel = settingsActionLabel,
                    duration = SnackbarDuration.Long,
                )
                if (result == SnackbarResult.ActionPerformed) {
                    context.startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS,
                        ).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName),
                    )
                }
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFF1B2A4A), Color(0xFF2A3B5E), Color(0xFF3C4F79)),
                ),
            ),
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.notifications_title),
                        fontSize = 22.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                    )
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = stringResource(R.string.close_cd),
                            tint = Color.White,
                        )
                    }
                }
            }

            item {
                SettingsCard {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        // The whole row toggles — the switch is not the only
                        // touch target — and announces as a switch.
                        modifier = Modifier
                            .fillMaxWidth()
                            .toggleable(
                                value = enabled,
                                role = Role.Switch,
                                onValueChange = { want ->
                                    if (want && Build.VERSION.SDK_INT >= 33 &&
                                        ContextCompat.checkSelfPermission(
                                            context, Manifest.permission.POST_NOTIFICATIONS,
                                        ) != PackageManager.PERMISSION_GRANTED
                                    ) {
                                        permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    } else {
                                        viewModel.setEnabled(want)
                                    }
                                },
                            )
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                    ) {
                        Icon(
                            Icons.Filled.Notifications,
                            contentDescription = null,
                            tint = CirrusPalette.Sky,
                        )
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                stringResource(R.string.briefing_title),
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Medium,
                                color = Color.White,
                            )
                            Text(
                                stringResource(R.string.briefing_subtitle),
                                fontSize = 13.sp,
                                color = Color.White.copy(alpha = 0.75f),
                            )
                        }
                        Switch(
                            checked = enabled,
                            onCheckedChange = null, // the row owns toggling
                            colors = SwitchDefaults.colors(
                                checkedTrackColor = CirrusPalette.SkyDeep,
                            ),
                        )
                    }
                }
            }

            if (enabled) {
                item {
                    SettingsCard {
                        SettingRow(
                            icon = {
                                Icon(
                                    Icons.Filled.Schedule,
                                    tint = CirrusPalette.Sky,
                                    contentDescription = null,
                                )
                            },
                            title = stringResource(R.string.delivery_time),
                            value = formatTime(timeMinutes),
                            onClick = { showTimePicker = true },
                        )
                        SettingRow(
                            icon = {
                                Icon(
                                    Icons.Filled.Translate,
                                    tint = CirrusPalette.Sky,
                                    contentDescription = null,
                                )
                            },
                            title = stringResource(R.string.notif_language),
                            value = languageLabel(languages, language),
                            onClick = { showLanguagePicker = true },
                            isLast = true,
                        )
                    }
                }

                item {
                    SettingsCard {
                        Column(Modifier.padding(16.dp)) {
                            Text(
                                stringResource(R.string.preview),
                                fontSize = 13.sp,
                                color = Color.White.copy(alpha = 0.75f),
                            )
                            Spacer(Modifier.height(6.dp))
                            Text(
                                stringResource(R.string.preview_body),
                                fontSize = 14.sp,
                                color = Color.White.copy(alpha = 0.92f),
                            )
                            Spacer(Modifier.height(12.dp))
                            val sending = testSend is SettingsViewModel.TestSendState.Sending
                            val notificationsOn = remember(enabled) {
                                androidx.core.app.NotificationManagerCompat
                                    .from(context).areNotificationsEnabled()
                            }
                            Button(
                                onClick = viewModel::sendTestNotification,
                                enabled = !sending && enabled && notificationsOn,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = CirrusPalette.SkyDeep,
                                    contentColor = Color(0xFF10203C),
                                ),
                            ) {
                                if (sending) {
                                    CircularProgressIndicator(
                                        strokeWidth = 2.dp,
                                        color = Color(0xFF10203C),
                                        modifier = Modifier.size(16.dp),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                }
                                Text(
                                    stringResource(
                                        if (sending) R.string.send_test_sending else R.string.send_test
                                    )
                                )
                            }
                        }
                    }
                }
            }

            item {
                Text(
                    stringResource(R.string.alerts_footnote),
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    color = Color.White.copy(alpha = 0.75f),
                    modifier = Modifier.padding(top = 4.dp, start = 4.dp, end = 4.dp),
                )
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            // Inset padding: without it the snackbar renders underneath the
            // gesture-navigation bar and behind the keyboard.
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .imePadding(),
        ) { data ->
            Snackbar(
                snackbarData = data,
                containerColor = Color(0xFF223354),
                contentColor = Color.White,
            )
        }
    }

    if (showLanguagePicker) {
        LanguagePickerDialog(
            languages = languages,
            selected = language,
            onSelect = {
                viewModel.setLanguage(it)
                showLanguagePicker = false
            },
            onDismiss = { showLanguagePicker = false },
        )
    }

    if (showTimePicker) {
        TimePickerDialog(
            initialMinutes = timeMinutes,
            onConfirm = {
                viewModel.setTimeMinutes(it)
                showTimePicker = false
            },
            onDismiss = { showTimePicker = false },
        )
    }
}

// ------------------------------------------------------------- components

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0x1FFFFFFF)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column { content() }
    }
}

@Composable
private fun SettingRow(
    icon: @Composable () -> Unit,
    title: String,
    value: String,
    onClick: () -> Unit,
    isLast: Boolean = false,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        icon()
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp, color = Color.White)
            Text(value, fontSize = 13.sp, color = CirrusPalette.Sky)
        }
    }
    if (!isLast) {
        Box(
            Modifier
                .padding(start = 46.dp)
                .height(0.5.dp)
                .fillMaxWidth()
                .background(Color.White.copy(alpha = 0.12f)),
        )
    }
}

@Composable
private fun LanguagePickerDialog(
    languages: List<com.cirrus.weather.data.remote.dto.LanguageInfo>,
    selected: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val filtered = remember(query, languages) {
        if (query.isBlank()) languages
        else languages.filter {
            it.nativeName.contains(query, ignoreCase = true) ||
                it.englishName.contains(query, ignoreCase = true) ||
                it.code.equals(query, ignoreCase = true)
        }
    }
    val selectedLabel = stringResource(R.string.selected_cd)

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.close_cd)) }
        },
        title = { Text(stringResource(R.string.language_dialog_title)) },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.search_cd)) },
                    leadingIcon = {
                        Icon(
                            Icons.Filled.Search,
                            contentDescription = stringResource(R.string.search_cd),
                        )
                    },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    colors = OutlinedTextFieldDefaults.colors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(10.dp))
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(360.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    items(filtered, key = { it.code }) { lang ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                // Radio-style selection: TalkBack hears which
                                // language is on, not just a mute tap target.
                                .selectable(
                                    selected = lang.code == selected,
                                    role = Role.RadioButton,
                                    onClick = { onSelect(lang.code) },
                                )
                                .padding(horizontal = 8.dp, vertical = 10.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    lang.nativeName,
                                    fontSize = 16.sp,
                                    fontWeight = if (lang.code == selected) FontWeight.SemiBold else FontWeight.Normal,
                                )
                                Text(
                                    lang.englishName,
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (lang.code == selected) {
                                Icon(
                                    Icons.Filled.Check,
                                    // Selection state is announced, not icon-only.
                                    contentDescription = selectedLabel,
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimePickerDialog(
    initialMinutes: Int,
    onConfirm: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    // Respect the system's 12/24-hour clock preference in both the picker
    // and the displayed delivery time.
    val is24Hour = DateFormat.is24HourFormat(LocalContext.current)
    val state = rememberTimePickerState(
        initialHour = initialMinutes / 60,
        initialMinute = initialMinutes % 60,
        is24Hour = is24Hour,
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.time_dialog_title)) },
        text = { TimePicker(state = state) },
        confirmButton = {
            TextButton(onClick = { onConfirm(state.hour * 60 + state.minute) }) {
                Text(stringResource(R.string.save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.close_cd)) }
        },
    )
}

@Composable
private fun formatTime(minutes: Int): String {
    val hour = minutes / 60
    val minute = minutes % 60
    // Locale-aware pattern: "a" localizes the day period (a. m./p. m., 오전…)
    // instead of hardcoding English AM/PM for every 12-hour locale.
    val pattern = if (DateFormat.is24HourFormat(LocalContext.current)) "H:mm" else "h:mm a"
    // This row recomposes on every settings change; the formatter depends
    // only on (pattern, locale), so build it once per combination.
    val locale = Locale.getDefault()
    val formatter = remember(pattern, locale) {
        DateTimeFormatter.ofPattern(pattern, locale)
    }
    return formatter.format(java.time.LocalTime.of(hour, minute))
}

private fun languageLabel(
    languages: List<com.cirrus.weather.data.remote.dto.LanguageInfo>,
    code: String,
): String {
    val info = languages.firstOrNull { it.code == code }
    return if (info != null && info.englishName != info.nativeName) {
        "${info.nativeName} · ${info.englishName}"
    } else {
        info?.englishName ?: code
    }
}
