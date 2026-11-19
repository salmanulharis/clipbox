// Private notes: encrypted on this device only.
// PRIVACY RULE: this module must never depend on :network or any HTTP client, and its sources
// must not open sockets or URLs. PrivacyGuardTest fails the build if that ever changes.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "io.github.salmanulharis.clipbox.privatenotes"
    compileSdk {
        version = release(37)
    }
    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
}
