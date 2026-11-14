# Architecture

```
glasses / phone camera --> VelaDevice.getFrame() --> faces.js (Human: BlazeFace + FaceRes, WebGL, on the phone)
mic --> voice-activity segmenter --> /api/stt (Groq Whisper) --> /api/understand (Groq gpt-oss-20b)
Vela's lines --> public/voice/el/*.mp3 (exact text) or /api/tts (ElevenLabs, cached) --> VelaDevice.say()
```

## Parts
| Folder | What |
|---|---|
| `app/public/` | the PWA: vanilla ES modules, no build step, installable |
| `app/server/` | Node 22 server, no runtime dependencies: static files, `/api/stt`, `/api/understand`, `/api/tts`, `/api/config`, `POST /log` |
| `android/` | Kotlin shell: WebView, Meta DAT session, phone-camera fallback, foreground service |
| `eval/` | face matching test ([results](../eval/README.md)) |
| `landing/` | the static site at meetvela.tech |

## PWA
`js/app.js` screens, `js/pipeline.js` watching, `js/watches.js` recognition rules (unit tested), `js/faces.js` on-device matching, `js/voice/` onboarding, dialog and commands, `js/listen.js` segmenter, `js/voice.js` playback, `js/background.js` shell background mode, `js/devices/` plug-in point.

## Server
- Every `/api/*` and `/log` call needs the `x-vela-token` header (`APP_TOKEN`). There are no vision-model calls.
- Voice: ElevenLabs Flash, voice "Lily" (`server/voice.json`). Lines in `public/voice/el/manifest.json` play on an exact text match; any other line goes once through `/api/tts` and is cached on disk. Kokoro (Featherless) only if ElevenLabs fails.
- Speech: Groq `whisper-large-v3-turbo` with a short hint per question. Whisper hallucinations ("Thank you.") and very quiet takes are dropped.
- Client events (never images or audio) go to `POST /log` as JSONL.

## The VelaDevice contract
```ts
interface VelaDevice {
  start(): Promise<void>; stop(): Promise<void>;
  getFrame(): Promise<Blob>;                          // one JPEG still
  audio(): MediaStream | AsyncIterable<Int16Array>;   // mono mic
  say(audio: Blob | string): Promise<void>;           // one short line
  state: 'idle'|'connecting'|'ready'|'error'; onStateChange(cb): void;
}
```
`PhoneDevice` (rear camera) and `GlassesDevice` (adapter over `window.VelaNative`). `?device=glasses` selects the second.

## The glasses bridge
The shell injects `window.VelaNative` at document start, into the app's origin only. Every call returns a Promise.

| Call | Result |
|---|---|
| `captureFrame({maxEdge, maxAgeMs})` | sharpest recent JPEG as base64 plus size, source, timing |
| `glasses()` / `connectGlasses()` | plain status `{status, action, message}` and the one button |
| `connect()` / `disconnect()` / `state()` / `onState(cb)` | session control and status |
| `setSource('auto'\|'glasses'\|'phone')` | auto uses the glasses when ready, else the phone camera |
| `backgroundMode()` / `onTick(cb)` | true while the foreground service runs; native 1 s heartbeat |
| `audioRoute()` / `setMicRoute()` | where sound goes; mic on glasses or phone |
| `openMetaAi('app'\|'settings'\|'store')` | opens Meta AI, its settings or Play Store page |
| `useMock({enabled})` | Meta's Mock Device Kit |

Mic constraints inside the shell: `echoCancellation:false, noiseSuppression:true, autoGainControl:true`, which keeps Android out of call mode.

## Shell code map (`android/app/src/main/java/app/vela/shell/`)
`GlassesSource.kt` DAT registration, session, capture, recovery · `LiveFrames.kt` YUV to NV21, sharpness score · `PhoneCameraSource.kt` CameraX fallback · `FrameHub.kt`, `SourcePolicy.kt`, `GlassesStatus.kt` which camera serves a frame · `MainActivity.kt` WebView, permissions, bridge · `WatchService.kt` foreground service · `AudioRouter.kt` Bluetooth routing · `MetaAi.kt` Meta AI detection.

More: [research](research/meta-dat.md) · [ElevenLabs notes](research/elevenlabs.md)
