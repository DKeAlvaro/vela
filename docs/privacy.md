# Privacy

Faces are detected and matched on the phone. No photo, no face and no embedding is sent anywhere.

## Stays on the phone
- Camera frames (checked, then dropped; the shell stores nothing).
- Face detection and matching (Human: BlazeFace and FaceRes, running in WebGL).
- The people Vela knows: name, relation, face embeddings and a 96 px thumbnail, in the browser's local storage.
- **Remove** in the app deletes a person and their face.

## Leaves the phone
| What | Where | Why |
|---|---|---|
| Short audio clips of your answers | Groq (Whisper) | speech to text |
| The transcript | Groq (gpt-oss-20b) | name and relation |
| The text Vela speaks | ElevenLabs | her voice (lines are cached) |
| Event logs: states, names, match scores, spoken lines | the Vela server | debugging |

Logs never contain images, audio or embeddings. Quiet takes are not sent at all.

## Rules Vela keeps
- She learns a face only when you tell her who the person is and confirm.
- Unknown faces: silence, nothing kept.
- Every `/api/*` and `/log` call needs the app token.
- The glasses' camera LED stays on while Vela watches. That is Meta's privacy light.

Next: [Architecture](architecture.md) · [Run it yourself](run.md)
