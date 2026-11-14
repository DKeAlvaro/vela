// TTS (ElevenLabs) and STT (OpenAI / ElevenLabs Scribe / Gemini) adapters.
// Each switches on by itself when its key appears in ~/.env (the server re-reads it every minute).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ElevenLabs: low-latency Flash model, a warm unhurried adult female voice by default
// (override with ELEVENLABS_VOICE_ID). Fixed lines are cached on disk so they cost one call ever.
// The team's ElevenLabs plan is a small shared Starter plan: the app may use at most 5,000
// characters in total. We stop at CHAR_BUDGET and fall back to the browser voice after that.
export const VELA_VOICE_ID = 'pFZP5JQG7iQjIQuC4Bku'; // "Lily": warm, clear, middle-aged British female
export const CHAR_BUDGET = 9000; // cumulative for the app (Álvaro: ElevenLabs for every line, ~1k chars per test session)

export const VOICE_SPEED = 1.05; // normal conversational pace (Álvaro: 0.9 felt far too slow)

export function createElevenLabsTTS({ apiKey, voiceId, model = 'eleven_flash_v2_5', cacheDir, budget = CHAR_BUDGET }) {
  if (!apiKey) return null;
  const voice = voiceId || VELA_VOICE_ID;
  fs.mkdirSync(cacheDir, { recursive: true });
  const usageFile = path.join(cacheDir, 'usage.json');
  const inflight = new Map();
  const usage = () => { try { return JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch { return { chars: 0, calls: 0 }; } };
  return {
    name: 'elevenlabs',
    model,
    voice,
    usage,
    budget,
    // Returns { cached, file } or { stream } (a web ReadableStream of mp3 bytes, also teed to cache).
    async speak(text) {
      const key = crypto.createHash('sha1').update(`${voice}|${model}|${VOICE_SPEED}|${text}`).digest('hex');
      const file = path.join(cacheDir, `${key}.mp3`);
      if (fs.existsSync(file)) return { cached: true, file, chars: 0 };
      // The same line requested twice at once (prefetch + speak): generate once, serve the file.
      if (inflight.has(key)) { await inflight.get(key).catch(() => {}); if (fs.existsSync(file)) return { cached: true, file, chars: 0 }; }
      const u = usage();
      if (u.chars + text.length > budget) throw Object.assign(new Error('elevenlabs budget used up'), { status: 402, budget: true });
      u.chars += text.length; u.calls += 1;
      fs.writeFileSync(usageFile, JSON.stringify(u));
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_64&optimize_streaming_latency=2`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: VOICE_SPEED },
        }),
      });
      if (!r.ok || !r.body) throw Object.assign(new Error(`elevenlabs ${r.status}`), { status: r.status });
      const [a, b] = r.body.tee();
      // Write the cache copy in the background.
      const writing = (async () => {
        const chunks = [];
        for await (const c of b) chunks.push(Buffer.from(c));
        fs.writeFileSync(file, Buffer.concat(chunks));
      })();
      inflight.set(key, writing);
      writing.catch(() => {}).finally(() => inflight.delete(key));
      return { cached: false, stream: a, chars: text.length };
    },
  };
}

// Kokoro TTS on Featherless: Vela's voice when the ElevenLabs budget is used up.
// British female "bf_emma", the closest to Lily. Every line is generated once and cached.
export function createKokoroTTS({ apiKey, voice = 'bf_emma', cacheDir }) {
  if (!apiKey) return null;
  fs.mkdirSync(cacheDir, { recursive: true });
  const inflight = new Map();
  return {
    name: 'kokoro', model: 'hexgrad/Kokoro-82M', voice,
    usage: () => ({ chars: 0 }), budget: null,
    async speak(text) {
      const key = crypto.createHash('sha1').update(`kokoro|${voice}|${text}`).digest('hex');
      const file = path.join(cacheDir, `${key}.mp3`);
      if (fs.existsSync(file)) return { cached: true, file, chars: 0 };
      if (!inflight.has(key)) {
        inflight.set(key, (async () => {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
          try {
            const r = await fetch('https://api.featherless.ai/v1/audio/speech', {
              method: 'POST', signal: ctl.signal,
              headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
              body: JSON.stringify({ model: 'hexgrad/Kokoro-82M', input: text, voice, response_format: 'mp3', speed: 1.0 }),
            });
            if (!r.ok) throw Object.assign(new Error(`kokoro ${r.status}`), { status: r.status });
            fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          } finally { clearTimeout(t); }
        })().finally(() => inflight.delete(key)));
      }
      await inflight.get(key);
      return { cached: false, file, chars: text.length };
    },
  };
}

// Whisper invents text from near-silence: echoes of the hint prompt, or stock phrases.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|thank you for watching\.?|you\.?|bye\.?|subtitles by.*|\.+)$/i;
export function dropHallucination(text, prompt) {
  const t = text.trim();
  if (!t || HALLUCINATIONS.test(t)) return '';
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nt = norm(t), np = norm(prompt);
  if (np && nt.length > 8 && (np.includes(nt) || nt.includes('the speaker says') || nt.includes('for example'))) return '';
  return t;
}

export const STT_HINTS = {
  name: 'The speaker says their first name, for example Carmen or Marta.',
  yesno: 'The speaker answers yes or no.',
  person: 'The speaker says a person\'s name and who they are, for example Pedro, my neighbour, or Pedro, mi vecino.',
  relation: 'The speaker says who someone is to them, for example my grandson, mi vecina, my doctor.',
  command: 'Vela, remember this person. Vela, start. Vela, who is this?',
};

// Speech-to-text chain: OpenAI first (cheapest, fast), Gemini audio as the fallback. An OpenAI
// account with no credit is skipped for 10 minutes instead of being retried on every segment.
export function createSTT({ groqKey, openaiKey, gemini, geminiBackup }) {
  const list = [];
  // Groq Whisper (free tier, ~0.3 s): first choice.
  if (groqKey) {
    list.push({
      name: 'groq', until: 0,
      async transcribe({ audio, mime, hint }) {
        const type = (mime || 'audio/webm').split(';')[0];
        const ext = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[type] || 'webm';
        const call = async (language) => {
          const fd = new FormData();
          fd.append('model', 'whisper-large-v3-turbo');
          fd.append('response_format', language ? 'json' : 'verbose_json'); // verbose: tells which language it heard
          if (language) fd.append('language', language);
          // A short context for what the answer is likely to be helps Whisper a lot with one-word
          // answers and names (it is a hint, not a constraint).
          if (STT_HINTS[hint]) fd.append('prompt', STT_HINTS[hint]);
          fd.append('file', new Blob([audio], { type }), `audio.${ext}`);
          const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${groqKey}` }, body: fd });
          if (!r.ok) {
            const ra = Number(r.headers.get('retry-after'));
            throw Object.assign(new Error(`groq stt ${r.status}`), { status: r.status, coolMs: ra ? ra * 1000 : r.status === 429 ? 30_000 : 10_000 });
          }
          return r.json();
        };
        // Names and relations may be said in Spanish, so the language is detected there. When the
        // guess is neither English nor Spanish ("Dyrði stégu." for "It's Pedro"), ask again in English.
        let j;
        if (hint === 'person' || hint === 'relation') {
          j = await call(null);
          if (!/^(en|english|es|spanish)$/i.test(String(j.language || 'en'))) j = await call('en');
        } else j = await call('en');
        return { text: dropHallucination((j.text || '').trim(), STT_HINTS[hint]), provider: 'groq', cost: 0 };
      },
    });
  }
  if (openaiKey) {
    list.push({
      name: 'openai', until: 0,
      async transcribe({ audio, mime }) {
        const fd = new FormData();
        fd.append('model', 'gpt-4o-mini-transcribe');
        const type = (mime || 'audio/webm').split(';')[0];
        const ext = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[type] || 'webm';
        fd.append('file', new Blob([audio], { type }), `audio.${ext}`);
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${openaiKey}` }, body: fd });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          const noCredit = /insufficient_quota|credit_balance_exhausted/.test(body);
          throw Object.assign(new Error(`openai stt ${r.status}${noCredit ? ' no credit' : ''}`), { status: r.status, coolMs: noCredit ? 600_000 : r.status === 429 ? 30_000 : 10_000 });
        }
        const j = await r.json();
        return { text: (j.text || '').trim(), provider: 'openai', cost: null };
      },
    });
  }
  if (gemini) list.push({ name: 'gemini', until: 0, transcribe: (a) => gemini.transcribe(a) });
  if (geminiBackup) list.push({ name: 'gemini-backup', until: 0, transcribe: (a) => geminiBackup.transcribe(a) });
  if (!list.length) return null;
  return {
    name: list.map((p) => p.name).join('>'),
    async transcribe(args) {
      let last;
      const live = list.filter((p) => Date.now() >= p.until);
      for (const p of (live.length ? live : list.slice(-1))) {
        try { return await p.transcribe(args); } catch (e) { last = e; p.until = Date.now() + (e.coolMs || (e.status === 429 ? 30_000 : 10_000)); }
      }
      throw last;
    },
  };
}
