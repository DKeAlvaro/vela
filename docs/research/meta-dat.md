# Meta Wearables Device Access Toolkit (DAT), Android

Checked 2026-11-14. Source: [meta-wearables-dat-android](https://github.com/facebook/meta-wearables-dat-android), [docs](https://wearables.developer.meta.com/llms.txt).

## Facts
- DAT 1.0 is GA (since 2026-09-30); Vela uses 1.0.1 (`com.meta.wearable:mwdat-core|camera|mockdevice`), anonymous from Maven Central.
- **Developer Mode** in Meta AI lets an unpublished app use the glasses with `APPLICATION_ID=0`, `CLIENT_TOKEN=0`. No developer account.
- Needs Meta AI V292+, glasses firmware V128+ (reboot after the update or the camera fails), Kotlin 2.2+, JDK 17.
- Supports Ray-Ban Meta Gen 1 and 2, Optics, Display, Oakley HSTN and Vanguard. Display glasses are not simulated by the Mock Device Kit.
- Publishing: private invite-only channel (~100 testers); experimental features (standalone photo, audio streaming) cannot go to production.

## Camera
- Stream: 720x1280 / 504x896 / 360x640 (9:16) at 2, 7, 15, 24 or 30 fps over Bluetooth Classic; lower settings give sharper frames. Frames are YUV on the phone.
- Photos: `camera.photo.capturePhoto(...)` (standalone, experimental) or `camera.stream.capturePhoto()` while streaming. Stream and photo compete for the camera.
- Add the camera only after the session is STARTED. The session pauses if the glasses are folded, taken over or Bluetooth drops.

## Audio
- A2DP is output only; HFP is bidirectional mono 16 or 8 kHz, and they are mutually exclusive.
- DAT can stream mic PCM in-stream (experimental, not in the Mock Device Kit).

## Field notes (Android 14, MIUI, Meta AI 298)
- `startRegistration()` returns nothing; failures only show on `Wearables.registrationErrorStream`.
- Reinstalling Meta AI resets Developer Mode. MIUI blocks Meta AI autostart; Meta AI needs Location to keep the glasses connected.
- `DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED` on session start: update the glasses in Meta AI.
- Standalone photos took 5-11 s and the photo channel threw `SERVICE_NOT_FOUND`. Vela keeps a 720p/7 fps stream open and serves the sharpest recent frame.
- WebView `getUserMedia` with echo cancellation puts Android in `MODE_IN_COMMUNICATION` and sends sound to the earpiece. With AEC off (NS/AGC on) it stays `MODE_NORMAL` on `bt_a2dp` (checked with adb).
