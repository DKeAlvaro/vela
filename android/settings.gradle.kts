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
    // Meta Wearables Device Access Toolkit (com.meta.wearable:mwdat-*) is on Maven Central:
    // no token, no Meta login needed to download it.
    mavenCentral()
  }
}

rootProject.name = "VelaShell"
include(":app")
