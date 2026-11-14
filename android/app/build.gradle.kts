import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val localProps = Properties().apply {
  val f = rootDir.resolve("local.properties")
  if (f.exists()) f.inputStream().use { load(it) }
}
fun prop(name: String, env: String, default: String) =
  localProps.getProperty(name) ?: System.getenv(env) ?: default

android {
  namespace = "app.vela.shell"
  compileSdk = 36

  buildFeatures { buildConfig = true }

  defaultConfig {
    applicationId = "app.vela.shell"
    minSdk = 31 // DAT 1.0 sample targets API 31+; setCommunicationDevice needs 31 too.
    targetSdk = 36
    versionCode = 4
    versionName = "0.2.0"

    // The web app the shell opens. `&device=glasses` is appended at runtime.
    buildConfigField("String", "VELA_URL", "\"" + prop("vela.url", "VELA_URL", "https://app.meetvela.tech/") + "\"")

    // Meta Wearables DAT: "0" = Developer Mode (no Wearables Developer Center project needed).
    // For a release channel, put the real values in local.properties.
    manifestPlaceholders["mwdat_application_id"] = prop("mwdat_application_id", "MWDAT_APPLICATION_ID", "0")
    manifestPlaceholders["mwdat_client_token"] = prop("mwdat_client_token", "MWDAT_CLIENT_TOKEN", "0")
  }

  buildTypes {
    release { isMinifyEnabled = false }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
  testOptions { unitTests.isReturnDefaultValues = true }
  lint { abortOnError = false; checkReleaseBuilds = false }
}

kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

val mwdat = "1.0.1"
val camerax = "1.5.1"

dependencies {
  implementation("com.meta.wearable:mwdat-core:$mwdat")
  implementation("com.meta.wearable:mwdat-camera:$mwdat")
  implementation("com.meta.wearable:mwdat-mockdevice:$mwdat")

  implementation("androidx.appcompat:appcompat:1.7.1")
  implementation("androidx.activity:activity-ktx:1.11.0")
  implementation("androidx.webkit:webkit:1.14.0")
  implementation("androidx.exifinterface:exifinterface:1.4.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
  implementation("androidx.camera:camera-core:$camerax")
  implementation("androidx.camera:camera-camera2:$camerax")
  implementation("androidx.camera:camera-lifecycle:$camerax")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20250517")
}
