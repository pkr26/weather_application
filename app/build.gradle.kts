import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// The app talks only to the Cirrus backend. Debug builds may fall back to
// the emulator loopback, but a release build must never ship pointing at
// 10.0.2.2 — that APK is dead on arrival on any real device.
val emulatorBaseUrl = "http://10.0.2.2:8080/api/v1/"
// -PapiBaseUrl lets CI (or a local R8 smoke build) override without
// touching local.properties; the file stays the developer-default source.
val configuredBaseUrl = gradle.startParameter.projectProperties["apiBaseUrl"]
    ?: localProps.getProperty("API_BASE_URL")
val apiBaseUrl = configuredBaseUrl?.takeIf { it.isNotBlank() } ?: emulatorBaseUrl
// Optional shared API token: when the backend sets API_TOKEN, the app must
// present the same value as X-Api-Token on every request. Empty = open API.
val apiToken = localProps.getProperty("API_TOKEN")?.trim() ?: ""
val buildingRelease = gradle.startParameter.taskNames.any {
    it.contains("release", ignoreCase = true) || it.equals("bundle", ignoreCase = true) ||
        it.equals("assemble", ignoreCase = true)
}
if (buildingRelease && apiBaseUrl == emulatorBaseUrl) {
    throw GradleException(
        "Release build refuses to ship with the default emulator API URL. " +
            "Set API_BASE_URL in local.properties to your production backend first."
    )
}

android {
    namespace = "com.cirrus.weather"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cirrus.weather"
        minSdk = 26
        targetSdk = 35
        // Version comes from the tag-driven release workflow
        // (-PversionCode/-PversionName); local builds fall back to these.
        versionCode = (gradle.startParameter.projectProperties["versionCode"] ?: "3").toInt()
        versionName = gradle.startParameter.projectProperties["versionName"] ?: "1.2.0"

        // The app talks only to the Cirrus backend; the Google Weather API key
        // lives server-side (backend/.env) and is never shipped in the APK.
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
        // Blank unless the deployment gates the API with a shared token.
        // Quotes/backslashes are escaped so a value containing them cannot
        // break out of the generated string literal.
        val apiTokenLiteral = apiToken.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "API_TOKEN", "\"$apiTokenLiteral\"")
    }

    // Release signing comes from the environment (CI secrets or a local
    // export) — a keystore must never live in the repo:
    //   CIRRUS_KEYSTORE_FILE (path), CIRRUS_KEYSTORE_PASSWORD,
    //   CIRRUS_KEY_ALIAS, CIRRUS_KEY_PASSWORD
    // Without them, release builds fall back to the debug key so they remain
    // locally installable for R8 smoke tests; CI upload builds set the env.
    signingConfigs {
        if (System.getenv("CIRRUS_KEYSTORE_FILE") != null) {
            create("release") {
                storeFile = file(System.getenv("CIRRUS_KEYSTORE_FILE"))
                storePassword = System.getenv("CIRRUS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CIRRUS_KEY_ALIAS")
                keyPassword = System.getenv("CIRRUS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // R8 shrinks and obfuscates: keep rules for kotlinx-serialization
            // and Retrofit live in proguard-rules.pro.
            isMinifyEnabled = true
            // Shrink resources with the code — shipping dead resources is
            // just a bigger APK for nothing.
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (System.getenv("CIRRUS_KEYSTORE_FILE") != null) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    debugImplementation(libs.androidx.ui.tooling)

    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.play.services.location)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

