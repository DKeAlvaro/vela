# FAQ

## The AI
**Does an AI model look at the faces?**
No. Faces are matched on the phone with face embeddings (Human). No LLM or vision API ever sees a photo.

**Then where is AI used?**
Only for speech and voice.

| Job | Model | Where |
|---|---|---|
| Find and compare faces | Human: BlazeFace + FaceRes | on the phone |
| Speech to text | Whisper large-v3-turbo | Groq |
| Name and relation from what you said | gpt-oss-20b | Groq |
| Vela's voice | ElevenLabs Flash v2.5 | ElevenLabs |

**Why no vision model?** A photo of someone's face would have to leave the phone. Embeddings on the device are faster and private.

**Can I swap a model?** Voice: change `voice_id` in `server/voice.json`. Fallbacks (Kokoro voice, OpenAI Whisper) are in [run it](run.md).

## Privacy
**Do the glasses record all the time?**
No. They stream while Vela runs; the phone keeps only the latest sharp frame in memory and drops it after checking. Say "stop" and the camera rests. The glasses' LED is on while it watches.

**And the microphone?**
Open while Vela runs. Only speech segments are sent (to Groq, for transcription). Quiet takes are dropped.

**What about people who didn't agree to be remembered?**
A face is learned only when the wearer says who it is and confirms. Unknown faces are matched, then dropped, never stored.

**How do I delete someone?** **For family** in the app, **Remove**. Clearing the app's data removes everyone.

Full table: [privacy](privacy.md).

## Accuracy
**What if she is wrong?**
The threshold (0.52) is set to prefer silence. In our small test, 0 of 156 stranger pairs matched, while 80% of same-person checks did (2 photos each). So she sometimes stays quiet for someone she knows; rarely names the wrong one. [Numbers](../eval/README.md)

**Languages?** You can answer in English or Spanish. She speaks English.

**Offline?** Faces still match. Speaking needs a connection, except for the fixed lines.

## The app
**Is it an app or a web page?**
Both. The logic is a web app (PWA); on Ray-Ban Meta it runs inside a small Android app (APK) that talks to the glasses. Without glasses the web app uses the phone camera. Android only for the glasses. See [glasses](glasses.md).

**Does it work with the app off?**
No. The Android app must be running and Meta AI linked. With the phone locked it keeps going (foreground service); kill the app and Vela is gone.

**Does it only remember faces?**
Yes. No scam, pill or fall detection.

**Are Vela's phrases pre-generated?**
Both. ~18 fixed lines ("Anyone else?") are pre-rendered mp3s. Lines with a name are generated once and cached, so each distinct line is paid once. The server stops generating after 9,000 characters and the phone's own voice takes over. [Architecture](architecture.md#server)

**What does it cost to run?**
Groq runs on its free tier in our setup. ElevenLabs is the only metered part, capped as above.
