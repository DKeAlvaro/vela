# Privacy

No photo, face or embedding leaves the phone.

**On the phone:** camera frames (checked, dropped), face matching, and the people Vela knows (name, relation, embeddings, 96 px thumbnail) in local storage. **Remove** deletes a person.

**Leaves the phone:**
| What | Where | Why |
|---|---|---|
| Short audio clips of your answers | Groq (Whisper) | speech to text |
| The transcript | Groq (gpt-oss-20b) | name and relation |
| The text Vela speaks | ElevenLabs | her voice (cached) |
| Event logs: states, names, match scores, lines | Vela server | debugging |

Logs never hold images, audio or embeddings. Quiet takes are not sent.

**Rules:** a face is learned only when you say who it is and confirm. Unknown faces are never kept. Every `/api/*` and `/log` call needs the app token. The glasses' LED stays on while Vela watches.

[Architecture](architecture.md) · [Run it](run.md)
