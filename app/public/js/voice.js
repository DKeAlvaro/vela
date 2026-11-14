// Voice: one line, chime first. ElevenLabs when the server has a key, else the browser voice.
import { api, log, SESSION } from './api.js';
import { playChime } from './devices/VelaDevice.js';
import { pauseEars, resumeEars } from './listen.js';

let ttsProvider = 'browser';
// Lines pre-generated with ElevenLabs (public/voice/el/manifest.json): exact text → file.
let manifest = {};
fetch('/voice/el/manifest.json').then((r) => (r.ok ? r.json() : null)).then((m) => { if (m?.lines) manifest = m.lines; }).catch(() => {});
async function manifestBlob(text) {
  const f = manifest[text];
  if (!f) return null;
  try { const r = await fetch(`/voice/el/${f}`); return r.ok ? await r.blob() : null; } catch { return null; }
}
export function setTtsProvider(p) { ttsProvider = p || 'browser'; }
export function getTtsProvider() { return ttsProvider; }

// Fixed lines (short replies) are fetched once at Start and kept in memory,
// so the most time-critical lines play without a network round-trip.
const ready = new Map();
export async function prefetch(lines) {
  if (ttsProvider === 'browser') return;
  try { if (JSON.parse(localStorage.getItem('vela.opts') || '{}').tts === 'browser') return; } catch {}
  for (const text of lines) {
    if (ready.has(text)) continue;
    if (manifest[text]) { const b = await manifestBlob(text); if (b) { ready.set(text, b); continue; } }
    try {
      const r = await api('/api/tts', { json: { text, session: SESSION }, raw: true, timeout: 8000 });
      if (r.status === 200) ready.set(text, await r.blob());
    } catch { /* fine: falls back to fetching at speak time */ }
  }
  log('tts.prefetched', { n: ready.size });
}

// Fixed tails Vela adds after a dynamic part; they are cached once and reused.
const FIXED_TAILS = [' Right?', ' Is that right? If not, say no, and tell me again.', ' Is that right?', " If that's wrong, say no.", ' Say no if that\'s wrong.'];
export function splitFixedTail(text) {
  for (const t of FIXED_TAILS) if (text.endsWith(t) && text.length > t.length) return [text.slice(0, -t.length), t.trim()];
  return [text];
}

// Returns { startedAt } (performance.now() when the voice began).
export async function say(device, text, meta = {}) {
  let audio = text;
  const t0 = performance.now();
  // The chime starts now; the line is fetched while it rings (hides most of the TTS fetch).
  // Devices that play audio elsewhere (glasses) get chimeAt too and skip their own chime.
  // In a conversation only the first line has a chime (meta.chime === false for the rest).
  if (meta.chime !== false) playChime();
  const chimeAt = meta.chime === false ? performance.now() - 1000 : performance.now();
  const browserOnly = (() => { try { return JSON.parse(localStorage.getItem('vela.opts') || '{}').tts === 'browser'; } catch { return false; } })();
  if (browserOnly) { /* tests and budget saving: browser voice */ }
  else if (ready.has(text)) audio = ready.get(text);
  else if (manifest[text]) audio = (await manifestBlob(text)) || text;
  else if (ttsProvider !== 'browser' && navigator.onLine) {
    // Where the browser has no voice of its own (the glasses shell's WebView), falling back would
    // mean silence: wait longer for the real voice there.
    const hasBrowserVoice = 'speechSynthesis' in window && speechSynthesis.getVoices().length > 0;
    const limit = hasBrowserVoice ? 5000 : 12000;
    // A read-back like "Álvaro. Is that right?": only the short first part is new; the fixed tail
    // is cached. Generate them separately and play one after the other.
    const parts = splitFixedTail(text);
    try {
      const blobs = await Promise.all(parts.map(async (p) => {
        const pre = await manifestBlob(p);
        if (pre) return pre;
        const r = await api('/api/tts', { json: { text: p, session: SESSION }, raw: true, timeout: limit });
        if (r.status !== 200) throw new Error(`tts ${r.status}`);
        return Promise.race([r.blob(), new Promise((_, rej) => setTimeout(() => rej(new Error('tts body timeout')), limit))]);
      }));
      audio = blobs.length === 1 ? blobs[0] : new Blob(blobs, { type: 'audio/mpeg' });
    } catch (e) { log('tts.fallback', { message: e.message, browser_voice: hasBrowserVoice }); }
  }
  let startedAt = null;
  document.body.classList.add('speaking'); // the firefly glows while Vela speaks
  pauseEars(); // never listen to herself (her lines can contain "Vela, start")
  try {
    try {
      await device.say(audio, { chimeAt, onStart: (t) => { startedAt = startedAt ?? t; } });
    } catch (e) {
      // Audio playback blocked or stalled (some WebViews): say it with the browser voice instead.
      log('voice.play_error', { message: String(e.message).slice(0, 120) });
      if (audio instanceof Blob) { audio = text; await device.say(text, { chimeAt: performance.now() - 1000, onStart: (t) => { startedAt = startedAt ?? t; } }); }
    }
  } finally { document.body.classList.remove('speaking'); resumeEars(); }
  log('voice.done', { ...meta, tts: audio instanceof Blob ? ttsProvider : 'browser', fetch_ms: Math.round((startedAt ?? performance.now()) - t0) });
  return { startedAt: startedAt ?? performance.now() };
}
