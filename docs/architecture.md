# Architecture

```mermaid
flowchart LR
  subgraph G["Glasses (or just the phone)"]
    cam["Camera"]
    mic["Microphone"]
    spk["Speaker"]
  end

  subgraph P["Phone: photos and faces never leave it"]
    face{"A face<br/>she knows?"}
    people[("People you taught her<br/>name, relation, face")]
    line["#quot;That's Marta,<br/>your granddaughter.#quot;"]
    quiet["Silence"]
    learn["Learn a new person"]
  end

  subgraph C["Online: only sound and text"]
    stt["Speech to text<br/><i>Groq Whisper</i>"]
    llm["Pick out name and relation<br/><i>Groq gpt-oss-20b</i>"]
    tts["Vela's voice<br/><i>ElevenLabs</i>"]
  end

  cam -->|a photo every few seconds| face
  people -.->|compare| face
  face -->|yes| line
  face -->|no| quiet
  line -->|text| tts
  tts -->|audio| spk

  mic -->|"#quot;Vela, this is Pedro, my neighbour#quot;"| stt
  stt -->|text| llm
  llm --> learn
  cam -.->|photo of the person| learn
  learn -->|after you say yes| people
```

**Recognising** (top path): the camera takes a still, the phone looks for a face and compares it with the people you taught her. A match is spoken once per person every 10 minutes; a stranger gets silence and is not kept.

**Teaching** (bottom path): you say who someone is, your words become text, a small model pulls out the name and relation, and the phone stores them next to the face.

In code: faces are `faces.js` (Human: BlazeFace + FaceRes, WebGL); the mic goes through a voice-activity segmenter to `/api/stt` and `/api/understand`; Vela's lines play from `voice/el/*.mp3` on an exact text match, else `/api/tts` (cached). The Vela server only relays those three calls and holds the keys.

| Folder | What |
|---|---|
| `app/public/` | PWA: vanilla ES modules, no build |
| `app/server/` | Node 22, no runtime deps: static files, `/api/stt`, `/api/understand`, `/api/tts`, `/api/config`, `POST /log` |
| `android/` | Kotlin shell: WebView, Meta DAT session, phone fallback, foreground service |
| `eval/` | [face matching test](../eval/README.md) |
| `landing/` | static site, meetvela.tech |

## Server
- Every `/api/*` and `/log` call needs `x-vela-token` (`APP_TOKEN`).
- Voice: ElevenLabs Flash, voice "Lily" (`server/voice.json`). Fixed lines in `public/voice/el/manifest.json` play on an exact text match; any other line is generated once and cached on disk. Kokoro only if ElevenLabs fails.
- Speech: Groq `whisper-large-v3-turbo`; hallucinations ("Thank you.") and very quiet takes are dropped.

## VelaDevice
```ts
interface VelaDevice {
  start(): Promise<void>; stop(): Promise<void>;
  getFrame(): Promise<Blob>;                          // one JPEG still
  audio(): MediaStream | AsyncIterable<Int16Array>;   // mono mic
  say(audio: Blob | string): Promise<void>;           // one short line
  state: 'idle'|'connecting'|'ready'|'error'; onStateChange(cb): void;
}
```
`PhoneDevice` (rear camera) and `GlassesDevice` (over `window.VelaNative`, picked by `?device=glasses`).

## The glasses bridge
`window.VelaNative` is injected into the app's origin only. Every call returns a Promise.

| Call | Result |
|---|---|
| `captureFrame({maxEdge, maxAgeMs})` | sharpest recent JPEG (base64) + size, source, timing |
| `glasses()` / `connectGlasses()` | `{status, action, message}` and the one button |
| `connect()` / `disconnect()` / `state()` / `onState(cb)` | session control |
| `setSource('auto'\|'glasses'\|'phone')` | auto = glasses when ready, else phone |
| `backgroundMode()` / `onTick(cb)` | foreground service on; native 1 s heartbeat |
| `audioRoute()` / `setMicRoute()` | where sound goes; mic on glasses or phone |
| `openMetaAi('app'\|'settings'\|'store')` | opens Meta AI |
| `useMock({enabled})` | Meta's Mock Device Kit |

Mic in the shell: `echoCancellation:false, noiseSuppression:true, autoGainControl:true`, which keeps Android out of call mode.

## Shell code (`android/app/src/main/java/app/vela/shell/`)
`GlassesSource.kt` session, capture, recovery · `LiveFrames.kt` YUV to JPEG, sharpness · `PhoneCameraSource.kt` fallback · `FrameHub.kt`, `SourcePolicy.kt` which camera serves a frame · `MainActivity.kt` WebView, bridge · `WatchService.kt` foreground service · `AudioRouter.kt` Bluetooth routing · `MetaAi.kt` Meta AI detection.

[Toolkit notes](research/meta-dat.md)
