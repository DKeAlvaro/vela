# Use it with Ray-Ban Meta glasses

An Android app (the shell) opens Vela in a WebView and hands it frames from the glasses. Glasses are camera and speakers; the phone does the thinking. If they drop, Vela falls back to the phone camera.

**Needs:** Android 12+, Meta AI V292+, Ray-Ban Meta Gen2 firmware V128+, a running [Vela server](run.md). Developer Mode is enough, no Meta developer account.

## 1. Glasses, once
1. Pair in Meta AI, allow everything incl. Location.
2. Install any glasses update, then restart the glasses (no capture after V128 until you do).
3. Meta AI, Settings, App info: tap **App version** 5 times, enable **Developer Mode** (reinstalling Meta AI resets it).
4. Xiaomi/MIUI/HyperOS: allow Autostart, battery No restrictions, for Meta AI and Vela.

## 2. Build the shell
JDK 17, Android SDK 36.
```bash
cd android
cp local.properties.example local.properties   # sdk.dir, vela.url=https://your-host/?k=<APP_TOKEN>
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
`local.properties` holds your token: never share an APK built with it. Allow Camera, Microphone, Nearby devices, Notifications.

## 3. Link, once
The first screen has one button for the next step. By hand: long-press the Vela icon, **Glasses check**, **Connect Vela in the Meta AI app**, approve, **Connect**.

## Behaviour
- 720x1280 at 7 fps while running; a request gets the sharpest frame of the last 0.7 s. Nothing is recorded.
- Voice goes to the glasses over Bluetooth. The mic is the phone's, without echo cancellation (that would send her voice to the earpiece).
- Locked phone: keeps going (native 1 s tick). Glasses folded: phone camera takes over.
- No glasses: **Glasses check, Use test glasses** runs Meta's Mock Device Kit.

## Troubleshooting
| You see | Do |
|---|---|
| Connect does nothing | Developer Mode off, Meta AI too old, or MIUI blocking it |
| "Glasses need an update" | Update in Meta AI, restart glasses |
| "Glasses did not answer" | Unfold, close Meta AI camera/Live AI, restart |
| Voice from the earpiece | Glasses check, **Where does sound go?** |
| Other server URL | `velashell://open?url=https://...`, `velashell://reset` to undo |

Limits: outside testers need a Wearables Developer Center project (`mwdat_application_id`, `mwdat_client_token` in `local.properties`); availability follows Meta's country list.

[Bridge contract](architecture.md#the-glasses-bridge) · [Toolkit notes](research/meta-dat.md)
