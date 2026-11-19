pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ClipBox"

// The app: Compose screens, QR scanner, share sheet, wiring.
include(":app")
// Models, Keystore-backed encryption and atomic encrypted file storage. No network code.
include(":core")
// Private notes. Must never depend on :network — enforced by the build and a unit test.
include(":private-notes")
// Server API client, live updates, QR link parsing, server profiles and failover.
include(":network")
