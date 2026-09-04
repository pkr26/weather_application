# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.cirrus.weather.** {
    *** Companion;
}
-keepclasseswithmembers class com.cirrus.weather.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# Retrofit
-keepattributes Signature, Exceptions
-dontwarn okhttp3.**
-dontwarn retrofit2.**
# Tink (via androidx.security:security-crypto) — references optional deps
-dontwarn com.google.errorprone.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**
# Tink is loaded reflectively by security-crypto: keep its registry-facing
# entry points, but let R8 strip the wide algorithm surface we never touch
# (the previous blanket `-keep class com.google.crypto.tink.** { *; }`
# defeated shrinking for the entire library).
-keep class com.google.crypto.tink.integration.android.** { *; }
-keep class * implements com.google.crypto.tink.KeyManager { *; }
-keep class com.google.crypto.tink.KeyTemplate { *; }
-keepclassmembers class com.google.crypto.tink.** {
    public static *** registerKeyManager(...);
    public static *** register(...);
}
