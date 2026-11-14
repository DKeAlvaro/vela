# FAQ

**Do the glasses record all the time?**
They stream while Vela is running, but nothing is recorded or uploaded. The phone keeps only the latest sharp frame in memory and checks it every ~3 s (10 s if the view is static, ~2 s with a face in view). Say "stop" and the camera rests. The glasses' LED is on while it watches. Details: [privacy](privacy.md).

**And the microphone?**
Open while Vela runs, listening for speech. Only speech segments are sent (to Groq, for transcription). Quiet takes are dropped.

**Does it work with the app off?**
No. The Android app must be running and Meta AI linked. With the phone locked it keeps going (foreground service); kill the app and Vela is gone.

**Does it only remember faces?**
Yes. Nothing else: no scam, pill or fall detection.

**Is it an app or a web page?**
Both. The logic is a web app (PWA); on Ray-Ban Meta it runs inside a small Android app (APK) that talks to the glasses. Without glasses the web app uses the phone camera. Android only for the glasses. See [glasses](glasses.md).

**Does an AI model look at the faces?**
No. Faces are matched on the phone with face embeddings (Human). No LLM or vision API ever sees a photo. AI is used only for speech: Groq Whisper (speech to text) and gpt-oss-20b (pull the name and relation out of what you said).

**Are Vela's phrases pre-generated?**
Both. ~18 fixed lines ("Anyone else?") are pre-rendered mp3s. Lines with a name ("That's Pedro, your neighbour") are generated once with ElevenLabs and cached, so each distinct line is paid once. [Architecture](architecture.md#server).
