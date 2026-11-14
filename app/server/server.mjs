// Vela backend: static files, key holder, model proxy, remote log.
// Listens on 127.0.0.1:8410; put an HTTPS reverse proxy in front for phones.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createUnderstander } from './understand.mjs';
import { createElevenLabsTTS, createKokoroTTS, createSTT } from './providers/speech.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PUBLIC = path.join(ROOT, 'public');
const LOGS = path.join(ROOT, 'logs');
const CACHE = path.join(ROOT, 'cache');
const ENV_FILE = process.env.VELA_ENV_FILE || path.join(ROOT, '.env');
const PORT = Number(process.env.PORT || 8410);
const HOST = process.env.HOST || '127.0.0.1';

// Server-side safety net (the client has its own, stricter caps: 20/min, 600/session).
const CAPS = { perMinute: 40, perDay: 4000, dollarsPerDay: 6.0 };

fs.mkdirSync(LOGS, { recursive: true });

// ---------- env + providers (re-read every minute so new keys switch adapters on) ----------
let env = {};
let P = {};
function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  // Vela's voice lives in the app's own folder (server/voice.json), so it can change without ~/.env.
  try { const v = JSON.parse(fs.readFileSync(path.join(here, 'voice.json'), 'utf8')); if (v.voice_id) out.ELEVENLABS_VOICE_ID = v.voice_id; } catch {}
  try { out.PROVIDERS_FILE = fs.readFileSync(path.join(here, 'providers.json'), 'utf8'); } catch {}
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VELA_'))) };
}
function keyFingerprint(e) {
  return ['GEMINI_TRIAGE_MODEL', 'GEMINI_SUMMARY_MODEL', 'GEMINI_FALLBACK_MODEL', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'APP_TOKEN', 'VISION_PROVIDER', 'GEMINI_MODEL', 'ELEVENLABS_VOICE_ID', 'GROQ_API_KEY', 'FEATHERLESS_API_KEY', 'PROVIDERS_FILE', 'FEATHERLESS_VISION_MODEL', 'VISION_PRIMARY']
    .map((k) => `${k}:${e[k] ? crypto.createHash('sha1').update(e[k]).digest('hex').slice(0, 8) : '-'}`).join(',');
}
let lastFp = '';
function loadProviders() {
  env = readEnv();
  const fp = keyFingerprint(env);
  if (fp === lastFp) return;
  lastFp = fp;
  // Vela remembers faces: matching runs on the device, so the server only does speech.
  // OpenAI only if explicitly allowed in server/providers.json.
  let allow = {};
  try { allow = JSON.parse(fs.readFileSync(path.join(here, 'providers.json'), 'utf8')); } catch {}
  const openaiKey = allow.allow_openai ? (env[allow.openai_key_var || 'OPENAI_API_KEY']) : null;
  P = {
    // ElevenLabs first for every line (each unique line paid once, disk cache); Kokoro only if it fails.
    ttsChain: [
      createElevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID, cacheDir: path.join(CACHE, 'tts') }),
      createKokoroTTS({ apiKey: env.FEATHERLESS_API_KEY, cacheDir: path.join(CACHE, 'tts-kokoro') }),
    ].filter(Boolean),
    understand: createUnderstander({ groqKey: env.GROQ_API_KEY }),
    stt: createSTT({ groqKey: env.GROQ_API_KEY, openaiKey }),
  };
  P.tts = P.ttsChain[0] || null;
  serverLog({ type: 'server.providers', tts: P.ttsChain.map((t) => t.name).join('>') || 'browser', stt: P.stt?.name || 'none', understand: P.understand?.name || 'none' });
}

// ---------- logging ----------
function day() { return new Date().toISOString().slice(0, 10); }
function appendLog(obj) {
  fs.appendFile(path.join(LOGS, `${day()}.jsonl`), JSON.stringify(obj) + '\n', () => {});
}
function serverLog(obj) { appendLog({ t: new Date().toISOString(), src: 'server', ...obj }); }

// ---------- spend ----------
const spend = { day: day(), calls: 0, dollars: 0, minute: [] };
function spendCheck() {
  const now = Date.now();
  if (spend.day !== day()) Object.assign(spend, { day: day(), calls: 0, dollars: 0 });
  spend.minute = spend.minute.filter((t) => now - t < 60_000);
  if (spend.minute.length >= CAPS.perMinute) return 'server cap: calls per minute';
  if (spend.calls >= CAPS.perDay) return 'server cap: calls per day';
  if (spend.dollars >= CAPS.dollarsPerDay) return 'server cap: dollars per day';
  return null;
}
function spendAdd(c) { spend.minute.push(Date.now()); spend.calls++; spend.dollars += c || 0; }
// restore today's spend from log on boot
try {
  for (const l of fs.readFileSync(path.join(LOGS, `${day()}.jsonl`), 'utf8').split('\n')) {
    if (!l.includes('"server.call"')) continue;
    const j = JSON.parse(l); spend.calls++; spend.dollars += j.cost || 0;
  }
} catch {}

// ---------- http helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
function send(res, code, body, headers = {}) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
function authed(req) {
  const tok = env.APP_TOKEN;
  if (!tok) return false;
  const got = String(req.headers['x-vela-token'] || '');
  const a = Buffer.from(got), b = Buffer.from(tok);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}

// ---------- API handlers ----------

const routes = {
  'GET /api/health': (req, res) => send(res, 200, { ok: true }),
  'GET /api/config': (req, res) => send(res, 200, {
    vision: null, // faces are matched on the device
    tts: P.tts ? { provider: P.ttsChain.map((t) => t.name).join('>'), model: P.tts.model, voice: P.tts.voice, chars_used: P.tts.usage().chars, chars_budget: P.tts.budget } : { provider: 'browser' },
    stt: P.stt ? { provider: P.stt.name } : null,
    server_caps: CAPS,
  }),
  'POST /api/tts': async (req, res) => {
    const body = await readJson(req);
    if (!P.ttsChain?.length) return send(res, 204, '');
    const text = String(body.text || '').slice(0, 300);
    if (!text) return send(res, 400, { error: 'empty' });
    for (const tts of P.ttsChain) {
      try {
        const t0 = Date.now();
        const out = await tts.speak(text);
        serverLog({ type: 'server.tts', provider: tts.name, session: body.session, cached: out.cached, chars: out.chars, latency_ms: Date.now() - t0 });
        res.setHeader('x-vela-voice', tts.name);
        if (out.file && !out.stream) return serveFile(res, out.file, 'no-store');
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-vela-voice': tts.name });
        return Readable.fromWeb(out.stream).pipe(res);
      } catch (e) {
        serverLog({ type: 'server.error', kind: 'tts', provider: tts.name, status: e.status || null, message: String(e.message).slice(0, 200) });
      }
    }
    send(res, 204, ''); // every voice failed: the client uses the browser voice
  },
  'POST /api/understand': async (req, res) => {
    const body = await readJson(req);
    if (!P.understand) return send(res, 503, { error: 'no understanding model configured' });
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { error: 'empty' });
    const t0 = Date.now();
    try {
      const out = await P.understand.understand(String(body.task || ''), text);
      serverLog({ type: 'server.understand', task: body.task, chars: text.length, latency_ms: Date.now() - t0, result: out.result });
      send(res, 200, out);
    } catch (e) {
      serverLog({ type: 'server.error', kind: 'understand', task: body.task, status: e.status || null, message: String(e.message).slice(0, 160) });
      send(res, e.status === 400 ? 400 : 502, { error: 'understanding failed' });
    }
  },
  'POST /api/stt': async (req, res) => {
    if (!P.stt) return send(res, 503, { error: 'no speech-to-text key configured' });
    const audio = await readBody(req, 12 * 1024 * 1024);
    if (audio.length < 1000) return send(res, 200, { text: '' });
    const capped = spendCheck();
    if (capped) return send(res, 429, { error: capped });
    try {
      const t0 = Date.now();
      const hint = new URL(req.url, 'http://x').searchParams.get('hint') || '';
      const out = await P.stt.transcribe({ audio, mime: String(req.headers['content-type'] || 'audio/webm'), hint });
      spendAdd(out.cost || 0);
      serverLog({ type: 'server.stt', provider: out.provider, bytes: audio.length, latency_ms: Date.now() - t0, chars: out.text.length });
      send(res, 200, { text: out.text, provider: out.provider });
    } catch (e) {
      serverLog({ type: 'server.error', kind: 'stt', status: e.status || null, message: String(e.message).slice(0, 200) });
      send(res, 502, { error: 'stt failed' });
    }
  },
  'POST /log': async (req, res) => {
    const body = await readJson(req);
    const events = Array.isArray(body.events) ? body.events : [body];
    const ua = String(req.headers['user-agent'] || '').slice(0, 160);
    for (const ev of events.slice(0, 200)) {
      if (!ev || typeof ev !== 'object') continue;
      const s = JSON.stringify(ev);
      if (s.length > 20_000) continue; // never accept images or long blobs in logs
      appendLog({ t_server: new Date().toISOString(), src: 'client', session: body.session, device: body.device, ua, ...ev });
    }
    send(res, 200, { ok: true, n: events.length });
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const key = `${req.method} ${p}`;
    if (p.startsWith('/api/') || p === '/log') {
      if (p !== '/api/health' && !authed(req)) return send(res, 401, { error: 'token required' });
      const h = routes[key];
      if (!h) return send(res, 404, { error: 'no route' });
      return await h(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (p.startsWith('/vendor/human/')) {
      const base = path.join(ROOT, 'node_modules', '@vladmandic', 'human');
      const rel = p.replace('/vendor/human/', '');
      const allowed = /^(dist\/human\.esm\.js|models\/(blazeface|facemesh|faceres|iris)\.(json|bin))$/.test(rel);
      const f = allowed && safeJoin(base, rel);
      return f ? serveFile(res, f, 'public, max-age=604800') : send(res, 404, 'not found');
    }
    let rel = p === '/' ? '/index.html' : p;
    if (rel === '/family' || rel === '/settings') rel = '/index.html';
    const f = safeJoin(PUBLIC, rel);
    if (!f) return send(res, 400, 'bad path');
    const longCache = /\.(woff2|png|wav)$/.test(f);
    return serveFile(res, f, longCache ? 'public, max-age=86400' : 'no-cache');
  } catch (e) {
    serverLog({ type: 'server.error', kind: 'http', message: String(e.message).slice(0, 200) });
    if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? 'too large' : 'server error' });
  }
});

loadProviders();
setInterval(loadProviders, 60_000).unref();
server.listen(PORT, HOST, () => {
  console.log(`vela listening on http://${HOST}:${PORT}`);
  serverLog({ type: 'server.start', port: PORT });
});
