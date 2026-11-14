# Run it yourself

Needs Node 22 or newer. The app has one runtime dependency (Human).

```bash
cd app
npm install
cp .env.example .env     # fill in the keys, see below
npm start                # http://127.0.0.1:8410
npm test                 # unit tests
```

Open `http://127.0.0.1:8410/?k=<APP_TOKEN>` once; the token then stays in the browser. Phones need HTTPS for camera and microphone, so put a reverse proxy in front (for example Caddy to `127.0.0.1:8410`). Add `&debug=1` for the debug panel.

## Keys (`app/.env`, never committed)
| Variable | Used for |
|---|---|
| `APP_TOKEN` | shared secret for every API call |
| `GROQ_API_KEY` | speech to text and name parsing |
| `ELEVENLABS_API_KEY` | Vela's voice |
| `FEATHERLESS_API_KEY` | optional TTS fallback |
| `OPENAI_API_KEY` | optional Whisper fallback |

`PORT`, `HOST` and `VELA_ENV_FILE` are also read. Without a TTS key the app falls back to the browser voice.

## More
- Glasses adapter against a fake shell: `npm run test:glasses` (headless Chromium via Playwright).
- End to end: `node test/faces-flow.mjs` (Playwright; the header of the file says how to make the fake camera clip).
- Face matching numbers: [eval/](../eval/README.md). Run `node facetest.mjs` in `eval/facetest` after `npm install`.
- Glasses shell: [glasses.md](glasses.md). Website: `landing/` is static, serve it as is.

Next: [Architecture](architecture.md)
