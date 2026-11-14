# Use it with Ray-Ban Meta glasses

An Android app (the shell, version 0.2.0) opens Vela in a WebView and hands it frames from the glasses through `window.VelaNative`. The glasses are the camera and the speakers; the phone does the thinking. If they drop out, Vela carries on with the phone camera and says so.

## You need
| Item | Minimum |
|---|---|
| Android phone | Android 12 (API 31) |
| Meta AI app | V292 or newer |
| Ray-Ban Meta Gen2 | firmware V128 or newer |
| A running Vela server | see [run.md](run.md) |

No Meta developer account is needed. Developer Mode is enough.

## 1. Prepare the glasses (once)
1. Pair them in Meta AI and allow everything it asks, including Location.
2. Install any glasses update, then restart the glasses (the camera does not capture after V128 until you do).
3. Meta AI, Settings, App info: tap **App version** five times, switch on **Developer Mode**. Reinstalling Meta AI can switch it off.
4. On Xiaomi, MIUI or HyperOS, allow Autostart and set battery to No restrictions for Meta AI and Vela.

## 2. Build and install the shell
Needs JDK 17 and the Android SDK 36.
```bash
cd android
cp local.properties.example local.properties   # set sdk.dir and vela.url=https://your-host/?k=<APP_TOKEN>
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
`local.properties` is gitignored: it holds your server URL and token, so never share an APK built with it. The toolkit is `com.meta.wearable:mwdat-*:1.0.1` from Maven Central.

Open Vela and allow Camera (phone fallback), Microphone, Nearby devices and Notifications ("Vela is watching" keeps it running with the phone locked).

## 3. Link (once)
The app's first screen, "Your glasses", has one button for the next step. By hand: long-press the Vela icon, **Glasses check**, **Connect Vela in the Meta AI app**, approve, then **Connect** and allow camera access. The status should read "Ready".

## What to expect
- While Vela runs, the glasses stream 720x1280 at 7 fps; a photo request gets the sharpest frame of the last 0.7 s. Nothing is recorded.
- Vela's voice goes through the phone's media output to the glasses over Bluetooth. The mic is the phone's, without echo cancellation (that would send her voice to the earpiece).
- Locked phone: it keeps going, driven by a native 1 s tick.
- Glasses off or folded: the session pauses and the phone camera takes over.
- Without glasses, **Glasses check, Use test glasses** runs Meta's Mock Device Kit.

## Troubleshooting
| You see | Do |
|---|---|
| Connect does nothing | Developer Mode off, Meta AI too old, or MIUI blocking it (step 1) |
| "The glasses need an update" | Update in Meta AI, restart the glasses, Connect again |
| "The glasses did not answer" | Unfold them, close Meta AI's camera or Live AI, restart them |
| Voice from the earpiece | Glasses check, **Where does sound go?** |
| Another URL | `velashell://open?url=https://...` (HTTPS only), `velashell://reset` to undo |

## Limits
- Developer Mode only: outside testers need a Wearables Developer Center project (set `mwdat_application_id` and `mwdat_client_token` in `local.properties`).
- Availability follows Meta's list of supported countries.
- Streaming uses more battery than single photos.

## More
Bridge contract: [architecture.md](architecture.md#the-glasses-bridge) · Toolkit notes: [research/meta-dat.md](research/meta-dat.md)
