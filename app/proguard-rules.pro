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
-keep class com.google.crypto.tink.** { *; }
