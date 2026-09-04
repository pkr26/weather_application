plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.pitest)
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}

// Mutation testing (PIT) over the pure domain logic this module owns:
// unit conversions, domain models, time formatting, briefing scheduling.
// The *Ui data classes and SavedCity are excluded — PIT would only mutate
// Kotlin-generated equals/copy/getter boilerplate there, not hand-written
// logic. VoidMethodCallMutator is excluded because in this module it only
// ever mutates compiler-injected Intrinsics null checks, never real calls.
pitest {
    targetClasses.set(listOf("com.cirrus.weather.*"))
    targetTests.set(listOf("com.cirrus.weather.*"))
    excludedClasses.set(
        listOf(
            "com.cirrus.weather.domain.CurrentUi",
            "com.cirrus.weather.domain.HourUi",
            "com.cirrus.weather.domain.DayUi",
            "com.cirrus.weather.domain.AlertUi",
            "com.cirrus.weather.domain.WeatherBundle",
            "com.cirrus.weather.domain.SavedCity",
        ),
    )
    // Explicit mutator set: the DEFAULTS+STRONGER groups minus
    // VOID_METHOD_CALLS, which in this module only ever mutates
    // compiler-injected Intrinsics null checks, never real calls (the
    // Arcmutate Kotlin plugin would suppress those properly; enumerating
    // the mutators achieves the same without a commercial license).
    mutators.set(
        listOf(
            "CONDITIONALS_BOUNDARY",
            "INCREMENTS",
            "INVERT_NEGS",
            "MATH",
            "NEGATE_CONDITIONALS",
            "REMOVE_CONDITIONALS",
            "TRUE_RETURNS",
            "FALSE_RETURNS",
            "NULL_RETURNS",
            "EMPTY_RETURNS",
            "PRIMITIVE_RETURNS",
        ),
    )
    threads.set(4)
    outputFormats.set(listOf("HTML", "XML"))
    timestampedReports.set(false)
    coverageThreshold.set(98)
    mutationThreshold.set(98)
}
