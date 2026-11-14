// Listening: yes/no replies and answers.
//
// Order of preference:
//  1. Recorder + server speech-to-text (when the server has an STT key; OpenAI today). It records
//     from the device's own mic stream (the same getUserMedia stream, or the glasses' mic), so
//     there is no second mic owner, and it is silent. A small voice-activity detector sends only
//     speech segments, never silence.
//  2. Browser SpeechRecognition, when no STT key is configured. Two known problems on Android
//     Chrome: it opens the mic a second time while getUserMedia holds it (on some phones it then
//     fails with 'audio-capture'), and it plays a short beep on every start and stop, which a
//     continuous loop turns into constant beeping. That's why it is only the fallback.
//  3. Always: big on-screen Yes / No buttons. A spoken answer is never the only way.
import { api, log, SESSION } from './api.js';
import { getAudioContext } from './devices/VelaDevice.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let srBroken = !SR;
let sttAvailable = false;
export function setSttAvailable(v) { sttAvailable = !!v; }
export function listenMode() { return sttAvailable ? 'recorder+stt' : !srBroken ? 'speech-recognition' : 'buttons'; }

// ---------------- server speech-to-text ----------------
const STT_PER_MIN = 15; // Groq Whisper free tier; Gemini audio is only the fallback
const sttCalls = [];
async function transcribe(blob, hint = '') {
  if (!blob || blob.size < 1500) return '';
  const now = Date.now();
  while (sttCalls.length && now - sttCalls[0] > 60000) sttCalls.shift();
  if (sttCalls.length >= STT_PER_MIN) { log('stt.capped'); return ''; }
  sttCalls.push(now);
  const r = await api(`/api/stt${hint ? `?hint=${encodeURIComponent(hint)}` : ''}`, { body: blob, headers: { 'content-type': blob.type || 'audio/webm' }, timeout: 15000 });
  return r?.text || '';
}

// ---------------- voice-activity segmenter ----------------
// Records only while someone is speaking. Raw audio is kept in a short rolling buffer, so each
// utterance starts ~600 ms before the voice was detected: short answers like "yes" keep their
// first sound. Segments are encoded as 16 kHz mono WAV (small, and every STT accepts it).
let vadCtx = null;
const PREROLL_S = 0.6;
function encodeWav(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  // downsample to 16 kHz
  const target = 16000, ratio = rate / target, outLen = Math.floor(len / ratio);
  const pcm = new Int16Array(outLen);
  let off = 0;
  const all = new Float32Array(len); for (const c of chunks) { all.set(c, off); off += c.length; }
  // Average each window (a simple low-pass) instead of picking samples: avoids aliasing, which
  // made short names ("Carmen") hard for Whisper.
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b && j < len; j++) sum += all[j];
    pcm[i] = Math.max(-1, Math.min(1, sum / (b - a))) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2); const dv = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, target, true);
  dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
class Segmenter {
  constructor(stream, { onSegment, onActivity, onLevel, maxMs = 12000, silenceMs = 900 } = {}) {
    Object.assign(this, { stream, onSegment, onActivity, onLevel, maxMs, silenceMs, paused: false, floor: 0.01, ring: [], rec: null });
  }
  start() {
    if (!this.stream) return false;
    vadCtx = getAudioContext() || vadCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (vadCtx.state !== 'running') { log('listen.ctx', { state: vadCtx.state }); vadCtx.resume?.().catch(() => {}); }
    this.rate = vadCtx.sampleRate;
    this.frames = 0;
    // Safety timer: if no audio arrives, say so in the logs (the timeout still ends the listen).
    this.noAudioTimer = setTimeout(() => { if (!this.frames) log('listen.no_audio', { ctx: vadCtx.state, tracks: this.stream.getAudioTracks().map((t) => t.readyState).join(',') }); }, 2000);
    this.src = vadCtx.createMediaStreamSource(this.stream);
    this.proc = vadCtx.createScriptProcessor(2048, 1, 1);
    this.mute = vadCtx.createGain(); this.mute.gain.value = 0; // keep the graph running, silently
    this.src.connect(this.proc); this.proc.connect(this.mute); this.mute.connect(vadCtx.destination);
    this.proc.onaudioprocess = (e) => this.frame(e.inputBuffer.getChannelData(0));
    return true;
  }
  // Adaptive noise floor: the mic may be opened without echo cancellation / noise suppression /
  // auto gain (the glasses shell needs that so Vela plays through the media route, not the
  // earpiece), so room noise can sit far above any fixed threshold. The floor is a low percentile
  // of the last ~3 s of frame levels, tracked all the time (also while recording); the first
  // ~250 ms calibrate it before any speech is accepted.
  noiseFloor(rms) {
    this.levels = this.levels || [];
    this.levels.push(rms);
    const keep = Math.ceil((3 * this.rate) / 2048);
    if (this.levels.length > keep) this.levels.shift();
    const sorted = [...this.levels].sort((a, b) => a - b);
    return Math.max(0.002, sorted[Math.floor(sorted.length * 0.15)]);
  }
  frame(data) {
    this.frames++;
    const chunk = new Float32Array(data);
    let sum = 0; for (const v of chunk) sum += v * v;
    const rms = Math.sqrt(sum / chunk.length);
    const now = performance.now();
    this.floor = this.noiseFloor(rms);
    const calibrating = this.frames * 2048 / this.rate < 0.25;
    // Speech: clearly above the floor. Silence (to end an answer): back near the floor.
    const loud = rms > Math.max(0.006, this.floor * 2.5);
    // End of an answer: back near the noise floor, OR well below this answer's own peak. With auto
    // gain on, the phone raises the gain in pauses, so "silence" may never get back near the floor
    // (his 16:34 session hit the length cap on almost every answer).
    const quiet = rms < Math.max(0.004, this.floor * 1.6, (this.recPeak || 0) * 0.3);
    const speaking = !this.paused && !calibrating && (this.rec ? !quiet : loud);
    this.onLevel?.(rms, this.floor, !!this.rec);
    if (this.rec) { this.rec.push(chunk); this.recPeak = Math.max(this.recPeak || 0, rms); }
    else {
      this.ring.push(chunk);
      const keep = Math.ceil((PREROLL_S * this.rate) / chunk.length);
      while (this.ring.length > keep) this.ring.shift();
    }
    if (speaking) { this.lastVoice = now; this.onActivity?.(); }
    if (speaking && !this.rec) { this.rec = [...this.ring]; this.ring = []; this.recStart = now; this.recPeak = rms; }
    if (this.rec && (now - this.lastVoice > this.silenceMs || now - this.recStart > this.maxMs || this.paused)) {
      if (now - this.recStart > this.maxMs) { log('listen.cap', { ms: Math.round(now - this.recStart), floor: +this.floor.toFixed(4), peak: +(this.recPeak || 0).toFixed(4), last: +rms.toFixed(4) }); this.onCap?.(); }
      this.end(now);
    }
  }
  end(now = performance.now()) {
    const chunks = this.rec; this.rec = null;
    if (!chunks) return;
    const ms = now - this.recStart;
    // Too quiet to be someone talking to Vela: don't send it (Whisper invents text from noise).
    if (this.recPeak < Math.max(0.01, this.floor * 3)) { log('listen.too_quiet', { peak: +this.recPeak.toFixed(4), floor: +this.floor.toFixed(4) }); return; }
    if (ms > 250) this.onSegment?.(encodeWav(chunks, this.rate), ms);
  }
  stop() { clearTimeout(this.noAudioTimer); try { this.proc.onaudioprocess = null; this.src?.disconnect(); this.proc?.disconnect(); this.mute?.disconnect(); } catch {} this.rec = null; }
}

// ---------------- browser SpeechRecognition (fallback) ----------------
let active = null;
function stopActive() { try { active?.abort(); } catch {} active = null; }
function recognise({ continuous = false, lang = 'en-GB', onText, onEnd }) {
  stopActive();
  const r = new SR();
  r.lang = lang; r.continuous = continuous; r.interimResults = false; r.maxAlternatives = 1;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText?.(e.results[i][0].transcript.trim());
  };
  r.onerror = (e) => {
    log('listen.error', { error: e.error });
    if (['audio-capture', 'not-allowed', 'service-not-allowed', 'language-not-supported'].includes(e.error)) srBroken = true;
  };
  r.onend = () => { if (active === r) active = null; onEnd?.(); };
  try { r.start(); active = r; } catch (e) { srBroken = true; log('listen.error', { error: String(e.message) }); onEnd?.(); }
  return r;
}

export function parseYesNo(text) {
  const t = ` ${String(text).toLowerCase()} `;
  if (/\b(no|nope|don't|do not|not now|later|stop|no thanks)\b/.test(t)) return 'no';
  if (/\b(yes|yeah|yep|yup|please|sure|ok|okay|go ahead|do it|call (her|him|them)|sí|si|vale)\b/.test(t)) return 'yes';
  return null;
}

// ---------------- yes / no ----------------
let pendingResolve = null;
export function answer(v) { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(v); } }

export function waitYesNo({ stream, timeoutMs = 10000 } = {}) {
  pauseEars();
  return new Promise((resolve) => {
    let done = false, seg = null;
    const finish = (v, how) => {
      if (done) return; done = true; pendingResolve = null; clearTimeout(timer);
      seg?.stop(); stopActive();
      log('listen.answer', { answer: v, how, mode: listenMode() });
      resolve(v);
    };
    pendingResolve = (v) => finish(v, 'button');
    const timer = setTimeout(() => finish('none', 'timeout'), timeoutMs);
    if (sttAvailable && stream) {
      seg = new Segmenter(stream, {
        maxMs: 5000, silenceMs: 700,
        onSegment: async (blob, ms) => { try { const t = await transcribe(blob, 'yesno'); const v = parseYesNo(t); log('listen.segment', { ms: Math.round(ms), words: t.split(/\s+/).filter(Boolean).length, parsed: v }); if (v) finish(v, 'voice-stt'); } catch (e) { log('listen.segment', { error: e.message }); } },
      });
      seg.start();
    } else if (!srBroken) {
      const once = () => recognise({ onText: (t) => { const v = parseYesNo(t); if (v) finish(v, 'voice'); }, onEnd: () => { if (!done && !srBroken) setTimeout(() => !done && once(), 150); } });
      once();
    }
  });
}

// ---------------- ears: speech while watching ----------------
let ears = null;
export function startEars(onText, stream) {
  stopEars();
  if (sttAvailable && stream) {
    const seg = new Segmenter(stream, {
      silenceMs: 1600, maxMs: 15000,
      onSegment: async (blob, ms) => {
        if (ms < 600) return; // a cough: not worth a call
        try { const t = (await transcribe(blob, 'command')).trim(); if (t && !/^[.\s]*$/.test(t)) onText(t); } catch (e) { log('ears.stt_error', { message: e.message }); }
      },
    });
    if (!seg.start()) return false;
    ears = { seg };
    log('ears.on', { mode: 'recorder+stt' });
    return true;
  }
  if (srBroken) { log('ears.off', { mode: listenMode() }); return false; }
  ears = { on: true, paused: false };
  const loop = () => { if (!ears?.on || ears.paused || srBroken) return; recognise({ continuous: true, onText: (t) => onText(t), onEnd: () => setTimeout(loop, 400) }); };
  ears.loop = loop; loop();
  log('ears.on', { mode: 'speech-recognition' });
  return true;
}
export function pauseEars() {
  if (!ears) return;
  if (ears.seg) ears.seg.paused = true;
  else { ears.paused = true; stopActive(); }
}
export function resumeEars() {
  if (!ears) return;
  if (ears.seg) setTimeout(() => { if (ears?.seg) ears.seg.paused = false; }, 400); // let her own voice fade
  else if (ears.paused) { ears.paused = false; setTimeout(() => ears?.loop?.(), 300); }
}
export function stopEars() {
  if (!ears) return;
  ears.seg?.stop(); ears.on = false; ears = null; stopActive();
}


export { SESSION };

// ---------------- one answer (dialog) ----------------
// Listens for one spoken answer: resolves with the transcript of the first utterance, '' after
// timeoutMs of silence, or a button token ('#yes', '#no', '#skip') via answer().
export function listenOnce(stream, { timeoutMs = 9000, silenceMs = 900, maxMs = 6000, onSpeech, onLevel, onCap, onSent, hint = '' } = {}) {
  pauseEars();
  return new Promise((resolve) => {
    let done = false, seg = null, speaking = false;
    const finish = (v) => { if (done) return; done = true; pendingResolve = null; clearTimeout(timer); seg?.stop(); stopActive(); resolve(v); };
    pendingResolve = (v) => finish(`#${v}`);
    // The timeout only counts silence: once someone is talking, wait for them to finish.
    let timer = setTimeout(() => !speaking && finish(''), timeoutMs);
    if (sttAvailable && stream) {
      seg = new Segmenter(stream, {
        silenceMs, maxMs, onLevel,
        onActivity: () => { if (!speaking) { speaking = true; onSpeech?.(); clearTimeout(timer); timer = setTimeout(() => finish(''), maxMs + 8000); } },
        onSegment: async (blob, ms) => {
          if (ms < 400) return;
          onSent?.();
          try { const t = (await transcribe(blob, hint)).trim(); if (t && !/^[.\s]*$/.test(t)) finish(t); else speaking = false; } catch { finish(''); }
        },
      });
      seg.onCap = onCap;
      seg.start();
    } else if (!srBroken) {
      recognise({ onText: (t) => finish(t), onEnd: () => {} });
    }
  });
}

// ---------------- barge-in ----------------
// While Vela speaks a question: if someone talks over her (sustained, well above the noise and
// above her own voice leaking into the mic), call onSpeech once. Returns a stop function.
export function watchForSpeech(stream, { onSpeech, holdMs = 300, minRms = 0.05 } = {}) {
  if (!stream) return () => {};
  vadCtx = getAudioContext() || vadCtx || new (window.AudioContext || window.webkitAudioContext)();
  const src = vadCtx.createMediaStreamSource(stream);
  const an = vadCtx.createAnalyser(); an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let floor = 0.01, since = 0, fired = false;
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const loud = rms > Math.max(minRms, floor * 8);
    if (!loud) { floor = floor * 0.9 + rms * 0.1; since = 0; return; }
    since = since || performance.now();
    if (!fired && performance.now() - since > holdMs) { fired = true; onSpeech?.(); }
  }, 50);
  return () => { clearInterval(timer); try { src.disconnect(); } catch {} };
}
