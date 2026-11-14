plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val nshClient = rootProject.projectDir.parentFile
val nshToolchain = nshClient.resolve(".nsh/toolchain")
val nshExecutable = nshToolchain.resolve("bin/nsh")
val setupNsh = tasks.register<Exec>("setupNsh") {
    description = "Prepare the repository-pinned NSH CLI and embedding SDKs"
    workingDir(nshClient)
    inputs.files(nshClient.resolve("native-host/Cargo.toml"), nshClient.resolve("nsh-toolchain.sha256"), nshClient.resolve("justfile"))
    inputs.files(fileTree(nshClient.resolve("cli")) { include("Cargo.toml", "Cargo.lock", "src/**/*.rs") })
    // A stamp outside the symlink avoids Gradle creating an SDK directory before setup.
    outputs.file(nshClient.resolve(".nsh/toolchain-ready"))
    outputs.upToDateWhen {
        nshExecutable.isFile && nshToolchain.resolve("embed/android/nsh.aar").isFile &&
            nshToolchain.resolve("embed/android/nsh-dev.aar").isFile
    }
    commandLine("just", "setup")
}
val nshAar = files(nshToolchain.resolve("embed/android/nsh.aar")).builtBy(setupNsh)
val nshDevAar = files(nshToolchain.resolve("embed/android/nsh-dev.aar")).builtBy(setupNsh)
abstract class BundleNsh : Exec() {
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty
}

val bundleNsh = tasks.register<BundleNsh>("bundleNsh") {
    description = "Build the shared TSX into the APK's assets"
    dependsOn(setupNsh)
    workingDir(nshClient)
    environment("NSH_RUNTIME", nshToolchain.resolve("runtime").absolutePath)
    inputs.files(fileTree(nshClient) {
        include("**/*.tsx", "**/*.ts", "nsh.json")
        exclude("**/*.test.*", ".nsh/**", "native-host/**", "android-host/**", "cli/**", "node_modules/**")
    })
    inputs.file(nshClient.resolve("pnpm-lock.yaml"))
    inputs.file(nshExecutable)
    inputs.files(nshAar)
    outputDirectory.set(layout.buildDirectory.dir("generated/nshAssets"))
    commandLine(nshExecutable.absolutePath, "build", "App.tsx", "--out", outputDirectory.get().dir("nsh").asFile)
}

android {
    namespace = "com.chromeacp.nshclient"
    compileSdk = 37
    ndkVersion = "29.0.14033849"

    defaultConfig {
        applicationId = "com.chromeacp.nshclient"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

abstract class BuildImageCodec : Exec() {
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty
}
val buildImageCodec = tasks.register<BuildImageCodec>("buildImageCodec") {
    description = "Build Zed-compatible image preparation for every Android ABI"
    workingDir(nshClient)
    inputs.files(fileTree(nshClient.resolve("image-codec")) { exclude("target/**") })
    inputs.property("ndkVersion", android.ndkVersion)
    outputDirectory.set(layout.buildDirectory.dir("generated/imageCodec"))
    doFirst {
        commandLine("bash", nshClient.resolve("image-codec/build-android.sh"),
            androidComponents.sdkComponents.ndkDirectory.get().asFile, outputDirectory.get().asFile)
    }
}

androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(bundleNsh, BundleNsh::outputDirectory)
    variant.sources.jniLibs?.addGeneratedSourceDirectory(buildImageCodec, BuildImageCodec::outputDirectory)
}

dependencies {
    debugImplementation(nshDevAar)
    releaseImplementation(nshAar)
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation-layout")
}
