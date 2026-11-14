# Run it yourself

Node 22+. One runtime dependency (Human).

```bash
cd app
npm install
cp .env.example .env     # fill in keys
npm start                # http://127.0.0.1:8410
npm test
```

Open `http://127.0.0.1:8410/?k=<APP_TOKEN>` once. Phones need HTTPS for camera and mic: put a reverse proxy (e.g. Caddy) in front. `&debug=1` shows the debug panel.

| Key in `app/.env` | For |
|---|---|
| `APP_TOKEN` | shared secret for every API call |
| `GROQ_API_KEY` | speech to text, name parsing |
| `ELEVENLABS_API_KEY` | Vela's voice (browser voice without it) |
| `FEATHERLESS_API_KEY` | optional TTS fallback |
| `OPENAI_API_KEY` | optional Whisper fallback |

Also read: `PORT`, `HOST`, `VELA_ENV_FILE`.

Other tests: `npm run test:glasses` (adapter vs fake shell), `node test/faces-flow.mjs` (end to end, fake camera), [eval/](../eval/README.md) (matching accuracy).

Glasses: [glasses.md](glasses.md).
