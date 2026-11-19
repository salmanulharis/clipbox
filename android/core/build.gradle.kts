// Models, JSON mapping, Keystore-backed encryption and atomic encrypted file storage.
// No network code lives here.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "io.github.salmanulharis.clipbox.core"
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
    testImplementation(libs.junit)
    testImplementation(libs.org.json) // real org.json on the JVM (Android's is a stub in unit tests)
}
