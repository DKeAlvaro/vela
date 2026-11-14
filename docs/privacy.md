# Privacy

**No photo, face or embedding leaves the phone.**

| What | Where it goes | Why |
|---|---|---|
| Camera frames | Glasses to phone over Bluetooth, checked, dropped | find faces |
| Faces of people you taught her | Phone storage only: name, relation, up to 5 embeddings, a 96 px thumbnail | recognise them |
| Short audio clips of your speech | Groq (Whisper) | speech to text |
| The transcript | Groq (gpt-oss-20b) | name and relation |
| The text she speaks | ElevenLabs, then cached | her voice |
| Event logs: states, names, match scores, lines | Vela server, one file per day | debugging |

Logs never hold images, audio or embeddings. They do hold names. They are not deleted automatically: whoever runs the server can delete the `logs/` folder.

Groq's and ElevenLabs' own policies apply to what they receive. Quiet takes are not sent.

**Meta:** frames reach the phone through Meta's glasses stack (Meta AI app). Vela does not change what Meta does.

## Rules
- A face is learned only when you say who it is and confirm.
- Unknown faces are never kept.
- **Remove** in **For family** deletes a person; clearing app data deletes everyone.
- Every `/api/*` and `/log` call needs the app token.
- The glasses' LED stays on while Vela watches.

[Architecture](architecture.md) · [Run it](run.md)
