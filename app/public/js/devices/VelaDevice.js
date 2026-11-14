// The plug-in point. Everything above this file (pipeline, watches, prompts, UI) talks only to
// this interface. PhoneDevice implements it today; GlassesDevice (Meta Ray-Ban Gen2 via the
// Android shell's window.VelaNative bridge) implements it later. Nothing else changes.
//
// interface VelaDevice {
//   start(): Promise<void>; stop(): Promise<void>;
//   getFrame(): Promise<Blob>;                          // one still photo, not a video feed
//   audio(): MediaStream | AsyncIterable<Int16Array>;   // mono mic
//   say(audio: Blob | string): Promise<void>;           // one short line, chime first
//   state: 'idle'|'connecting'|'ready'|'error'; onStateChange(cb): void;
// }
//
// Extras every device may set (optional, read by the UI):
//   name: string                 shown in the debug panel and logs
//   error: { code, message }     why state is 'error' ('denied'|'busy'|'nocamera'|'ended'|'disconnected'|...)
//   capabilities: { frameMaxPx, audioKind: 'mediastream'|'pcm16', speaker: 'phone'|'glasses' }

export class BaseDevice {
  constructor(name) {
    this.name = name;
    this.state = 'idle';
    this.error = null;
    this._cbs = new Set();
  }
  onStateChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  _setState(state, error = null) {
    if (this.state === state && !error) return;
    this.state = state;
    this.error = error;
    for (const cb of this._cbs) { try { cb(state, error); } catch (e) { console.error(e); } }
  }
}

// ---- shared speaker: the chime, then the line. Used by PhoneDevice, reusable by GlassesDevice
// when the glasses act as a Bluetooth headset for the phone's audio output. ----
let ctx = null;
let chimeBuf = null;
let player = null;
let speakingUntil = 0;

// One AudioContext for the whole app, created inside the user's tap (WebViews keep contexts
// created later suspended, which silently stopped listening in the glasses shell).
export function getAudioContext() { return ctx; }

export async function unlockAudio() {
  // Must run inside a user gesture (the Start tap) on mobile browsers.
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!chimeBuf) {
      const r = await fetch('/chime.wav');
      chimeBuf = await ctx.decodeAudioData(await r.arrayBuffer());
    }
  } catch (e) { console.warn('audio unlock', e); }
  if (!player) { player = new Audio(); player.preload = 'auto'; }
  try { player.src = '/chime.wav'; player.volume = 0; await player.play(); player.pause(); player.volume = 1; } catch {}
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch {}
}

export function playChime() {
  // Returns ms until the voice may start (the chime's tail overlaps the first word softly).
  if (ctx && chimeBuf) {
    const src = ctx.createBufferSource();
    const g = ctx.createGain(); g.gain.value = 0.55;
    src.buffer = chimeBuf; src.connect(g).connect(ctx.destination); src.start();
    return 420;
  }
  return 0;
}

// "Your turn" cue: two soft, quick notes when Vela starts listening (the glasses have no light).
export function playListenCue() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const [f, dt] of [[880, 0], [1175, 0.09]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t + dt); g.gain.linearRampToValueAtTime(0.07, t + dt + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.16);
    o.connect(g).connect(ctx.destination); o.start(t + dt); o.stop(t + dt + 0.2);
  }
}

const VOICE_PREFS = [
  /Google UK English Female/i, /en-GB.*(Female|Libby|Sonia|Maisie)/i, /Serena|Kate|Martha|Stephanie|Moira|Fiona|Karen|Tessa|Samantha/i,
  /Google US English/i, /en-GB/i, /en-US/i, /^en/i,
];
let cachedVoice = null;
function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  for (const re of VOICE_PREFS) {
    const v = voices.find((x) => re.test(`${x.name} ${x.lang}`) && /^en/i.test(x.lang));
    if (v) { cachedVoice = v; return v; }
  }
  cachedVoice = voices.find((v) => /^en/i.test(v.lang)) || voices[0];
  return cachedVoice;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };

export function isSpeaking() { return performance.now() < speakingUntil; }

// Barge-in: stop whatever Vela is saying right now.
let cutCurrent = null;
export function stopSpeaking() {
  try { player?.pause(); } catch {}
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch {}
  speakingUntil = 0;
  cutCurrent?.();
}

// Speak one line: chime, then either an audio Blob (ElevenLabs) or a string (browser voice).
// Resolves when finished. Calls onStart(ms) when the voice actually begins.
// opts.chimeAt: performance.now() when the caller already started the chime (so the line can be
// fetched while it rings); the voice then waits only for what is left of the lead-in.
export async function speakLine(audio, { rate = 1.05, onStart, chimeAt = null, signal = null } = {}) {
  if (chimeAt == null) {
    const lead = playChime();
    await new Promise((r) => setTimeout(r, lead));
  } else {
    const left = 420 - (performance.now() - chimeAt);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
  if (audio instanceof Blob) {
    if (!player) player = new Audio();
    const url = URL.createObjectURL(audio);
    try {
      player.src = url;
      player.volume = 1;
      const started = new Promise((res) => player.addEventListener('playing', res, { once: true }));
      const done = new Promise((res) => { player.onended = res; player.onerror = res; });
      // Hard timeouts: a WebView that blocks or stalls playback must never hang a line.
      const playing = Promise.race([player.play().then(() => started), new Promise((_, rej) => setTimeout(() => rej(new Error('play timeout')), 4000))]);
      await playing; onStart?.(performance.now());
      speakingUntil = performance.now() + 15000;
      await Promise.race([done, new Promise((r) => setTimeout(r, 15000)), new Promise((r) => { cutCurrent = r; })]);
    } finally { URL.revokeObjectURL(url); speakingUntil = 0; cutCurrent = null; }
    return;
  }
  const text = String(audio);
  // ~360 ms per word at rate 1.05 (about ElevenLabs' pace), plus a short tail.
  const est = 300 + text.split(/\s+/).length * 380 / rate;
  speakingUntil = performance.now() + est;
  const noVoice = !('speechSynthesis' in window) || speechSynthesis.getVoices().length === 0;
  if (noVoice) {
    // No voice installed (headless tests, some WebViews): take the time a voice would take.
    onStart?.(performance.now());
    await Promise.race([new Promise((r) => setTimeout(r, est)), new Promise((r) => { cutCurrent = r; })]);
    speakingUntil = 0; cutCurrent = null;
    return;
  }
  await new Promise((resolve) => {
    let finished = false;
    const end = () => { if (!finished) { finished = true; speakingUntil = 0; cutCurrent = null; resolve(); } };
    cutCurrent = end;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
      u.rate = rate; u.pitch = 0.95; u.volume = 1;
      u.onstart = () => onStart?.(performance.now());
      u.onend = end; u.onerror = end;
      speechSynthesis.speak(u);
      // Headless browsers or no voices: onstart may never fire. Don't hang.
      setTimeout(() => { if (!finished) onStart?.(performance.now()); }, 600);
      setTimeout(end, est + 2500);
    } catch { onStart?.(performance.now()); end(); }
  });
}
