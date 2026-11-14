# Meta Wearables Device Access Toolkit (DAT) - Android research (checked 2026-11-14)

Sources (all fetched 2026-11-14): GitHub README/CHANGELOG/samples/skills of
https://github.com/facebook/meta-wearables-dat-android (docs now also link github.com/meta/meta-wearables-dat-android),
docs via https://wearables.developer.meta.com/llms.txt (guides), FAQ https://developers.meta.com/wearables/faq/,
Maven Central metadata https://repo1.maven.org/maven2/com/meta/wearable/mwdat-core/maven-metadata.xml.

## 0. Headline answers
- SDK downloads from **Maven Central, anonymous. No GitHub PAT, no Meta login, no extra repo block.**
  Verified: HTTP 200 on https://repo1.maven.org/maven2/com/meta/wearable/mwdat-camera/1.0.1/mwdat-camera-1.0.1.aar
  (Older 0.x docs used GitHub Packages + PAT; that is obsolete. Versions 0.7.0..1.0.1 are on Central.)
- **Developer Mode** in the Meta AI app lets an unpublished app register and use the glasses with
  `APPLICATION_ID=0` and `CLIENT_TOKEN=0`. No Wearables Developer Center account needed for dev.
- Still photos: use `camera.photo.capturePhoto(...)` (experimental, up to 4032x3024 JPEG/HEIC bytes) or
  `camera.stream.capturePhoto()` while a video stream runs (Bitmap or HEIC).

## 1. Versions, devices, firmware
- Developer preview began ~Dec 2025 (blog updated 2025-12-04). **1.0 GA rolled out from 2026-09-30** (FAQ: "No longer in developer preview").
  README still says "developer preview" (stale wording).
- Releases (CHANGELOG): 1.0.1 = 2026-10-09 (latest, HEVC buffer corruption + Stream perf fixes); 1.0.0 = 2026-09-24;
  0.9.0 = 2026-08-03. Maven also has 0.7.0, 0.8.0.
- Supported glasses (docs "Setup" page): Ray-Ban Meta Gen 1 **and Gen 2**, Ray-Ban Meta Optics, Meta glasses, Meta Ray-Ban Display,
  Oakley Meta HSTN, Oakley Meta Vanguard. MockDevice kit does not simulate Display glasses (FAQ), though 1.0 added MockDisplayKit.
- Version table (docs "Version Dependencies"), SDK 1.0.1: **Meta AI app (Android) V292**, glasses firmware **V128**
  (Ray-Ban Meta, Oakley HSTN, Vanguard, Display all V128). SDK 1.0.0: Meta AI V290, firmware V128. 0.9.0: V282 / V126.
- Known issue: after OTA to firmware v128, camera capture does not work until glasses are rebooted.
- OS: Android 10+ (docs), Android Studio Flamingo+; Kotlin **2.2+** required (SDK compiled with 2.2).
- Sample CameraAccess uses: AGP 8.11.1, Kotlin 2.2.21, compileSdk 36, targetSdk 36, **minSdk 31**, JVM 17, Compose BOM 2026.05.01.
  (minSdk 31 is the sample's choice; docs say Android 10+. HFP route code in docs needs API 31 / S.)
- README says Android Studio Narwhal 2025.1.1+, JDK 17+.

## 2. Android SDK install (verbatim from README / samples)
Repository: only what is already default:
```kotlin
// settings.gradle.kts (samples/CameraAccess)
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}
```
Coordinates (group `com.meta.wearable`, all same version, latest **1.0.1**):
```toml
[versions]
mwdat = "1.0.1"
[libraries]
mwdat-core = { group = "com.meta.wearable", name = "mwdat-core", version.ref = "mwdat" }
mwdat-camera = { group = "com.meta.wearable", name = "mwdat-camera", version.ref = "mwdat" }
mwdat-display = { group = "com.meta.wearable", name = "mwdat-display", version.ref = "mwdat" }
mwdat-inputs = { group = "com.meta.wearable", name = "mwdat-inputs", version.ref = "mwdat" }
mwdat-motion = { group = "com.meta.wearable", name = "mwdat-motion", version.ref = "mwdat" }
mwdat-mockdevice = { group = "com.meta.wearable", name = "mwdat-mockdevice", version.ref = "mwdat" }
mwdat-speech = { group = "com.meta.wearable", name = "mwdat-speech", version.ref = "mwdat" }
```
Plain Gradle: `implementation("com.meta.wearable:mwdat-core:1.0.1")`, `...:mwdat-camera:1.0.1`, `...:mwdat-mockdevice:1.0.1`.
CameraAccess sample dependencies (only these three DAT modules):
```kotlin
  implementation(libs.mwdat.core)
  implementation(libs.mwdat.camera)
  implementation(libs.mwdat.mockdevice)
```
Sample defaultConfig (verbatim):
```kotlin
    manifestPlaceholders["mwdat_application_id"] = localProperties.getProperty("mwdat_application_id", "")
    manifestPlaceholders["mwdat_client_token"] = localProperties.getProperty("mwdat_client_token", "")
```
Docs for Developer Mode say set both to `"0"` (skills/getting-started and build-integration-android).
Account needs: none to download or build. Runtime: APPLICATION_ID/CLIENT_TOKEN meta-data must exist; value `0` works only
with Developer Mode on in Meta AI app. Production (non-dev-mode) needs Wearables Developer Center project (wearables.developer.meta.com,
Meta account; org setup; per-project Application ID + Client Token; one "Beta" release channel, invite-only, up to ~100 testers per FAQ).
Optional manifest meta-data: `com.meta.wearable.mwdat.ANALYTICS_OPT_OUT`, `...CRASH_REPORTING_OPT_OUT` = true.
Release builds in sample use `isMinifyEnabled = true` + proguard-rules.pro [check DAT consumer rules if R8 breaks].

## 3. Developer Mode (Meta AI app)
- Meta AI app > Settings > App Info > tap **App version five times** > toggle **Developer Mode** > Enable.
- Glasses must be paired to the Meta AI app, firmware at/above table (V128) and Meta AI app >= V292 for SDK 1.0.1.
- Unlocks: unpublished app registers/uses glasses without publishing review; no attestation (app ID/token ignored, use 0);
  listed under Meta AI settings > App connections > Developer mode apps; also needed for release channels.
- Without registering in the developer center: works in Developer Mode. Yes.
- Sample README: "Turn 'Developer Mode' on in the Meta AI app. Launch app. Press Connect to complete registration."

## 4. Permissions and registration flow
Manifest (docs build-integration-android):
```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.INTERNET" />
<!-- only for phone camera as mock feed -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<application ...>
  <meta-data android:name="com.meta.wearable.mwdat.APPLICATION_ID" android:value="${mwdat_application_id}" />
  <meta-data android:name="com.meta.wearable.mwdat.CLIENT_TOKEN" android:value="${mwdat_client_token}" />
  <activity android:name=".MainActivity" ...>
    <intent-filter>   <!-- Meta AI calls back here -->
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="myexampleapp" />
    </intent-filter>
  </activity>
</application>
```
Sample also adds RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, FOREGROUND_SERVICE(+_CONNECTED_DEVICE), WAKE_LOCK, and a
`foregroundServiceType="connectedDevice"` service for background streaming/recording.
Android runtime: BLUETOOTH_CONNECT must be granted at runtime (API 31+).
Flow: (1) `Wearables.initialize(app)` in Application.onCreate; (2) `Wearables.startRegistration(activity)` opens Meta AI app, user approves,
Meta AI returns via the URI scheme; observe `Wearables.registrationState` until `RegistrationState.REGISTERED`;
(3) camera permission on glasses: `Wearables.checkPermissionStatus(Permission.CAMERA)` / `Wearables.RequestPermissionContract()`
(Meta AI shows Allow once / Always allow / Don't allow); (4) `Wearables.createSession(...)`.
Since 1.0.0 Meta AI can also start registration: call `Wearables.handleIntent(intent, ::onRegistrationRequest)` in onCreate + onNewIntent
(callback gets request; `request.continueRegistration(this)` / `cancelRegistration`).
Unregister: `Wearables.startUnregistration(activity)`. Needs Internet during registration.

## 5. Camera API
Classes (package `com.meta.wearable.dat.*`): `core.Wearables`, `core.selectors.AutoDeviceSelector`/`SpecificDeviceSelector`,
`core.session.DeviceSession`/`DeviceSessionState` (IDLE, STARTING, STARTED, PAUSED, STOPPING, STOPPED),
`camera.Camera`, `camera.addCamera` (extension on DeviceSession), `camera.types.StreamConfiguration`, `VideoQuality`, `StreamState`,
`PhotoData` (sealed: `PhotoData.Bitmap(bitmap)` / `PhotoData.HEIC(data: ByteBuffer)`), `Photo`, `PhotoResolution`, `PhotoQuality`, `PhotoState`.
Results are `DatResult` with `.onSuccess{}` / `.onFailure{ error, _ -> }` / `.fold` / `.getOrThrow()`.
**Video stream** (`camera.stream`): `StreamConfiguration(videoQuality, frameRate, compressVideo=false, audioCodec=null)`.
- VideoQuality: HIGH 720x1280, MEDIUM 504x896, LOW 360x640 (portrait 9:16 crop). Frame rates: 2, 7, 15, 24, 30.
- Link is Bluetooth Classic; auto ladder drops resolution one step then fps (never below 15). Per-frame adaptive compression, so lower res/fps = sharper frames.
- Glasses crop 9:16, undistort, stabilise, HEVC-encode. Default: SDK decodes on phone, `VideoFrame.buffer` = YUV pixel data
  [exact layout not stated; likely I420/NV12 - unverified]. `compressVideo=true` gives raw HEVC (`frame.isCompressed`, `frame.isCodecConfig`).
- StreamState: STOPPED, STARTING, STARTED, STREAMING, STOPPING, CLOSED, PAUSED (device pause, e.g. single cap-touch tap; may auto-resume).
- Latency figures: none published [unverified]. Expect seconds for FULL photos over BT Classic (progress API exists).
**Photo, in-stream:** `camera.stream.capturePhoto()` only while STREAMING; one at a time (`CaptureError.CaptureInProgress`).
**Photo, standalone (experimental, 1.0.0+, apps using it cannot be published to production channels yet; fine in Developer Mode/beta):**
`camera.photo`; `photo.capturePhoto(resolution = PhotoResolution.FULL, quality = PhotoQuality.HIGH)`.
- PhotoResolution: SMALL (~480p), MEDIUM (~720p, default), LARGE (~1080p), FULL (4032x3024). PhotoQuality: LOW/MEDIUM(default)/HIGH.
- Result `PhotoCaptureData`: `imageData: ByteArray` (JPEG or HEIC "as produced by the glasses"), `metadata: ByteArray?` (opaque, not EXIF),
  `timestamp: Long` (ms, phone-side). Progress: `photo.transferProgressStream` (`progress.fraction`). States: `PhotoState` STARTING/STARTED/STOPPING/STOPPED.
- Stream and Photo compete for the camera; stop Stream before Photo. Photo is terminal after stop; to capture again `removeCamera()` + `addCamera()`
  (or `camera.stop()` then new camera) and access `.photo` again. Android reports device failures as `CAPTURE_FAILURE`.
- `photoStream`/`errors`/`transferProgressStream` are non-replaying SharedFlows: subscribe BEFORE accessing result. Photo activates implicitly on first `camera.photo` access.
- Add camera only after session STARTED (else `DeviceSessionError.SESSION_IDLE`). Possible `CAPABILITY_DENIED` (server-side gating).
- JPEG vs HEIC: HEIC must be handled (Android `BitmapFactory` decodes HEIC on API 28+; WebView `<img>` may not) -> convert to JPEG Bitmap natively before handing to WebView. [unverified which format glasses emit by default]

## 6. Microphone / audio
- DAT exposes mic only experimentally in-stream: `StreamConfiguration(audioCodec = AudioCodec.PCM(sampleRate = AudioSampleRate.RATE_16000, numberOfChannels = 1))`
  then `camera.stream.audioStream.collect { frame -> frame.buffer, frame.presentationTimeUs }` (16-bit PCM; 16k/44.1k/48k Hz).
  Needs DAT `Permission.MICROPHONE` + Audio Streaming approval in WDC for non-dev; beta/dev channels only, not production. Not beamformed.
  MockDeviceKit cannot inject mock audio.
- Standard Bluetooth: A2DP = output only, hi-fi; **HFP = bidirectional mono 16 or 8 kHz** (beamformed to wearer's voice). Mutually exclusive:
  HFP drops output to mono voice quality.
- Android HFP route (docs, API 31+):
```kotlin
val audioManager = context.getSystemService(AudioManager::class.java)
val bluetoothDevice = audioManager.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } ?: return false
audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
return audioManager.setCommunicationDevice(bluetoothDevice)
```
- Implication for WebView: with the glasses as the Android communication device and RECORD_AUDIO granted (plus WebChromeClient.onPermissionRequest
  granting RESOURCE_AUDIO_CAPTURE), `getUserMedia({audio:true})` should capture from the glasses mic [unverified, standard Android routing; test on device].
  Alternative: pipe `audioStream` PCM into JS via a bridge (experimental).
- Known issue (iOS only): iPhone 17 + iOS 26 HFP silent; irrelevant on Android.

## 7. Mock Device Kit (`mwdat-mockdevice`)
- Add with `implementation` (not testImplementation); runs inside the app on device/emulator. Needs no glasses and **no Meta AI app**
  (fake registration + permissions). Coordinates: `com.meta.wearable:mwdat-mockdevice:1.0.1`.
```kotlin
val mockDeviceKit = MockDeviceKit.getInstance(context)
mockDeviceKit.enable()   // auto-initializes Wearables; registrationState -> REGISTERED
// mockDeviceKit.enable(MockDeviceKitConfig(initiallyRegistered = false))
val device = mockDeviceKit.pairGlasses(GlassesModel.RAYBAN_META).getOrThrow()
device.powerOn(); device.unfold(); device.don()
mockDeviceKit.permissions.set(Permission.CAMERA, PermissionStatus.Denied)  // optional
```
- Video stream feed: `device.services.camera.setCameraFeed(videoUri)` (HEVC/H.264 file; Android does not transcode, docs recommend h.265 .mov,
  e.g. `ffmpeg -i in.mp4 -c:v libx265 -tag:v hvc1 -vf scale=540:960 out.mov`), or `setCameraFeed(CameraFacing)` = phone camera (needs android.permission.CAMERA granted).
- In-stream photo: `device.services.camera.setCapturedImage(imageUri)` (JPEG/PNG).
- Standalone photo: `glasses.services.cameraCapture.setCapturedPhoto(imageUri)` (real file URI; `simulateCaptureFailure()` for errors) - `MockCameraCaptureKit`.
- Sample CameraAccess has Debug menu: Pair RayBan Meta, PowerOn/Unfold/Don, pick media, Start streaming.
- Test server: `startTestServer(port)` / `stopTestServer()` / `simulateRegistrationOutcome(Boolean)` (1.0.0).

## 8. Limits, distribution
- Markets: SDK download open worldwide; "only those in AI glasses supported countries" get full toolkit + Wearables Developer Center (FAQ). No country/age list found [unverified].
  Release-channel testers need a regular Meta account (Managed Meta Account not supported). Glasses require adult-account Meta AI; age rule [unverified].
- Distribution: private invite-only release channel (one "Beta", ~100 testers). Public store publishing: FAQ "soon"/not open as of the FAQ (no date) [verify];
  experimental features (photo capture standalone, audio streaming, inputs, motion, speech) cannot go to production channels.
- For development: Developer Mode only, test on your own phone and glasses, no publishing.
- Known issues: v128 OTA needs reboot before camera works; resumed sessions need beta capabilities restarted; session PAUSED when glasses
  folded/removed, another experience takes device, or BT drops (create new session after STOPPED).
- Acceptable Use Policy governs camera/mic data; Meta collects analytics (opt-out via manifest meta-data).

## 9. Samples and code (official)
- https://github.com/facebook/meta-wearables-dat-android/tree/main/samples : CameraAccess (use this), DisplayAccess, BirdSpotter. Also AGENTS.md and
  plugins/mwdat-android/skills/* (copied below). Flutter wrapper exists (pub.dev meta_wearables_dat_flutter) - third-party.
- API reference: https://wearables.developer.meta.com/docs/reference/android/dat/latest ; MCP docs server: https://mcp.developer.meta.com/wearables
Init (skills/getting-started):
```kotlin
class MyApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Wearables.initialize(this)
            .onFailure { error, _ -> Log.e("DATWearables", "Failed to initialize DAT: ${error.description}") }
    }
}
```
Registration + session (skills/getting-started):
```kotlin
fun connect(activity: Activity) { Wearables.startRegistration(activity) }
Wearables.createSession(AutoDeviceSelector()).fold(
    onSuccess = { session ->
        lifecycleScope.launch { session.errors.collect { error -> showError(error.description) } }
        lifecycleScope.launch { session.state.collect { state -> if (state == DeviceSessionState.STARTED) addCameraStreaming(session) } }
        session.start()   // fire-and-forget
    },
    onFailure = { error, _ -> showError(error.description) },
)
```
Permission (skills/permissions-registration):
```kotlin
private val permissionLauncher = registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
    result.onSuccess { status -> if (status == PermissionStatus.Granted) startStreaming() }
          .onFailure { error, _ -> showPermissionError(error.description) }
}
permissionLauncher.launch(Permission.CAMERA)
```
Video stream + in-stream photo (skills/camera-streaming):
```kotlin
session.addCamera(StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 24)).fold(
    onSuccess = { camera -> camera.stream.start().onFailure { e, _ -> showError(e.description) } },
    onFailure = { error, _ -> showError(error.description) })
camera.stream.videoStream.collect { frame -> updatePreview(frame) }
camera.stream.capturePhoto()
    .onSuccess { photoData -> when (photoData) {
        is PhotoData.Bitmap -> savePhoto(photoData.bitmap)
        is PhotoData.HEIC -> saveHeic(photoData.data) } }   // ByteBuffer
    .onFailure { error, _ -> showCaptureError(error.description) }
camera.stop(); session.stop()    // camera.stop() cascades; session.removeCamera() to re-add
```
Standalone photo (docs/camera-capture; condensed from the doc startPhotoCapture):
```kotlin
val camera = session.addCamera().getOrThrow()     // default config
val photo = camera.photo                           // implicitly starts; subscribe first!
scope.launch { photo.photoStream.collect { data -> saveImage(data.imageData) } }     // ByteArray JPEG/HEIC
scope.launch { photo.transferProgressStream.collect { p -> updateProgress(p.fraction) } }
scope.launch { photo.errors.collect { e -> showError(e.description) } }
// wait: photo.state.first { it == PhotoState.STARTED }  (with timeout; STOPPED after STARTING = setup failure)
photo.capturePhoto(resolution = PhotoResolution.FULL, quality = PhotoQuality.HIGH)
camera.stop()
```
(Photo flow imports: `com.meta.wearable.dat.camera.addCamera`, `...camera.types.*`; `kotlinx.coroutines.flow.onSubscription`.)

## 10. What it means for Vela
Recommended path (Developer Mode, no accounts):
1. New Android app (Kotlin 2.2.x, AGP 8.11+, compileSdk 36, minSdk 31, JDK 17). Dependencies: mwdat-core, mwdat-camera, mwdat-mockdevice 1.0.1 from mavenCentral().
   Clone/copy from samples/CameraAccess (manifest, MainActivity, view model) rather than write from scratch.
2. Manifest placeholders `mwdat_application_id=0`, `mwdat_client_token=0`; custom URI scheme (e.g. `vela`); Bluetooth/Internet perms (+RECORD_AUDIO for WebView mic).
3. Photo capture to WebView: stream-less path = `camera.photo.capturePhoto(SMALL or MEDIUM, MEDIUM)` (small payload = faster over BT);
   decode bytes natively (HEIC->JPEG via BitmapFactory + compress), then pass to WebView as base64 via `evaluateJavascript` / `@JavascriptInterface`
   or serve through `WebViewAssetLoader`/local blob URL. If standalone Photo misbehaves, fall back to start stream (LOW/MEDIUM, 7-15 fps)
   and `stream.capturePhoto()`, which returns a Bitmap directly (504x896 max portrait).
4. Mic: route Android communication device to the glasses (HFP snippet above) and let WebView getUserMedia use it; fallback `audioStream` PCM (experimental).
5. Build an in-app "Mock glasses" toggle with MockDeviceKit (phone camera or fixture JPEG) so the pipeline is demoable/testable without glasses or Meta AI app.
Owner unblock steps (hardware/accounts only; no token needed to build):
- On the demo phone: install Meta AI app >= V292 (Android), pair Ray-Ban Meta Gen 2, update glasses to firmware V128 and **reboot glasses after OTA**.
- Meta AI > Settings > App Info > tap version 5x > enable Developer Mode.
- Install Vela APK, tap Connect, approve in Meta AI, grant Camera permission (Allow always).
- Only if Developer Mode is not enough / for outside testers: create a Wearables Developer Center account (Meta account, https://wearables.developer.meta.com),
  project, copy Application ID + Client Token into local.properties (`mwdat_application_id`, `mwdat_client_token`), create a version + invite testers by email.
- The build needs only internet to Maven Central + Google Maven; no secrets.
Risks: standalone photo is "experimental" (fine for dev); photo latency unpublished; country availability of the dev center; HEIC output handling; firmware v128 camera bug.

## Field notes from real hardware (2026-11-14, Android 14, MIUI, Meta AI 298.0.0.28.160)

- `startRegistration()` returns nothing. Failures arrive only on `Wearables.registrationErrorStream`
  (`META_AI_NOT_INSTALLED`, `FAILED_TO_REGISTER`…), so a silent "nothing happens" is likely there.
- Reinstalling or updating Meta AI can switch Developer Mode off. MIUI also blocked Meta AI's
  autostart, and Meta AI needs Location to keep the glasses connected.
- Session start failed with `DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED` (fixed by updating the
  glasses in Meta AI). A session that never reaches STARTED means: look at `DeviceSession.errors`.
- Standalone photo capture: 5–11 s per photo from app request to JPEG on this phone, and the
  photo channel threw `DwaCapabilityChannel 0xc001 SERVICE_NOT_FOUND`, then `0xc010
  SERVICE_RESTORED`. Vela uses a kept-open 720p/7 fps stream and serve the sharpest recent
  decoded frame instead (latency to be measured).
- Audio: a WebView `getUserMedia` with echo cancellation puts Android in `MODE_IN_COMMUNICATION`
  with the earpiece as the route, so A2DP output to the glasses goes silent. AEC off (NS/AGC on)
  keeps `MODE_NORMAL` with output on `bt_a2dp` (verified with adb).
