// Watching: Vela remembers faces. Every few seconds one still photo from the device (glasses or
// phone) → skip it if the view barely changed → find faces and match them ON THE DEVICE against
// the people the wearer enrolled → say "That's Marta, your granddaughter." once per person per
// 10 minutes. Unknown faces: silence. No photo ever leaves the device.
import { log } from './api.js';
import { decode, signature, diff, FRAME } from './frames.js';
import { candidates, arbitrate, commit, newWatchState, THRESHOLDS } from './watches.js';
import { getSettings, addMoment } from './store.js';
import * as faces from './faces.js';
import { say } from './voice.js';
import * as listen from './listen.js';
import { isSpeaking } from './devices/VelaDevice.js';
import { backgroundMode } from './background.js';

// Adaptive cadence: a photo every 3 s while the scene changes, backing off to every 10 s when it
// doesn't; every ~2 s (never skipped as unchanged) for 8 s after a face was seen.
const TICK_MIN_MS = 3000, TICK_MAX_MS = 10000, TICK_FACE_MS = 2000;
const FORCE_RECHECK_MS = 60000; // even an unchanged view is looked at again now and then

export class Vela extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.running = false;
    this.status = 'idle';
    this.ws = newWatchState();
    this.stats = { frames: 0, skipped: 0, facesSeen: 0, matches: 0, lines: 0, lastFacesMs: null };
    this.lastSig = null;
    this.lastCheckAt = 0;
    this.busy = false;
    this.wakeLock = null;
    this.timer = null;
    this.hidden = document.visibilityState === 'hidden' && !backgroundMode();
    document.addEventListener('visibilitychange', () => this._onVisibility());
    addEventListener('online', () => { log('net.online'); if (this.running) this._setStatus('watching'); });
    addEventListener('offline', () => { log('net.offline'); if (this.running) this._setStatus('offline', 'No connection. Vela still knows faces, but may not be able to speak.'); });
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setStatus(s, note = '') {
    if (this.status === s && this.statusNote === note) return;
    this.status = s; this.statusNote = note;
    log('status', { status: s, note });
    this.emit('status', { status: s, note });
  }

  setDevice(device) {
    this.device = device;
    device.onStateChange((state, err) => {
      log('device.state', { device: device.name, state, error: err?.code });
      this.emit('device', { state, error: err });
      if (!this.running) return;
      if (state === 'error') this._setStatus('nocamera', err?.message || '');
      else if (state === 'ready') this._setStatus('watching');
    });
  }

  // ---------------- lifecycle ----------------
  // quietEars: don't open the listening loop yet (the first conversation is still talking).
  async start({ quietEars = false } = {}) {
    if (this.running) return;
    this.running = true;
    this._setStatus('starting');
    try {
      await this.device.start();
    } catch (e) {
      this.running = false;
      this._setStatus('nocamera', this.device.error?.message || 'The camera could not start.');
      throw e;
    }
    await this._wake();
    faces.loadFaces().catch(() => {});
    if (!quietEars) this.startEars();
    this._useNativeTick();
    this._setStatus(navigator.onLine ? 'watching' : 'offline');
    log('vela.start', { device: this.device.name, people: getSettings().people?.length || 0, listen: listen.listenMode() });
    this._schedule(300);
  }

  // One listening loop while the device is on, for "Vela, …" commands (the app sets earsHandler).
  startEars() {
    listen.startEars(async (t) => { await this.earsHandler?.(t); }, this.device.audio?.());
  }

  // keepDevice: "Vela, stop" rests the camera loop but keeps the mic, so "Vela, start" works.
  async stop({ keepDevice = false } = {}) {
    this.running = false;
    clearTimeout(this.timer);
    if (!keepDevice) listen.stopEars();
    try { await this.wakeLock?.release(); } catch {}
    this.wakeLock = null;
    if (!keepDevice) await this.device?.stop();
    this._setStatus('idle');
    log('vela.stop', { frames: this.stats.frames, matches: this.stats.matches });
  }

  async _wake() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => log('wakelock.released'));
      }
    } catch (e) { log('wakelock.error', { message: e.message }); }
  }

  async _onVisibility() {
    // In the shell's background mode the screen can be off: keep watching and listening.
    this.hidden = document.visibilityState === 'hidden' && !backgroundMode();
    if (document.visibilityState === 'hidden' && !this.hidden) { log('visibility.hidden_background_mode'); return; }
    if (!this.running) return;
    if (this.hidden) {
      this._setStatus('paused', 'Vela pauses while the screen is off.');
      listen.pauseEars();
    } else {
      await this._wake();
      if (this.device.state !== 'ready') {
        try { await this.device.start(); } catch { this._setStatus('nocamera', this.device.error?.message || ''); return; }
      }
      listen.resumeEars();
      this._setStatus(navigator.onLine ? 'watching' : 'offline');
      this._schedule(200);
    }
  }

  // Shell 0.2.0: VelaNative.onTick(cb) is a native 1 s heartbeat. While the page is hidden in
  // background mode, timers may be throttled, so the heartbeat runs the loop when it is due.
  _useNativeTick() {
    if (this._tickHooked || !window.VelaNative?.onTick) return;
    this._tickHooked = true;
    try {
      window.VelaNative.onTick(() => {
        if (!this.running || this.busy || document.visibilityState !== 'hidden' || !backgroundMode()) return;
        if (performance.now() - (this.lastTickAt || 0) < (this.tickMs || TICK_MIN_MS) - 200) return;
        clearTimeout(this.timer);
        this._tick();
      });
    } catch {}
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    if (!this.running) return;
    const started = performance.now();
    this.lastTickAt = started;
    try {
      if (!this.hidden && this.device.state === 'ready' && !this.busy) {
        const blob = await this.device.getFrame();
        await this.processFrame(blob, { source: 'camera', t0: started });
      }
    } catch (e) {
      log('tick.error', { message: String(e.message).slice(0, 200) });
    }
    this._schedule(Math.max(200, (this.tickMs || TICK_MIN_MS) - (performance.now() - started)));
  }

  // ---------------- one frame ----------------
  async processFrame(blob, { source = 'camera', force = false, t0 = performance.now() } = {}) {
    this.busy = true;
    try {
      this.stats.frames++;
      const img = await decode(blob);
      const sig = signature(img);
      const d = diff(sig, this.lastSig);
      const faceInView = Date.now() < (this.faceUntil || 0);
      const stale = Date.now() - this.lastCheckAt > FORCE_RECHECK_MS;
      if (!force && d < FRAME.diffThreshold && !stale && !faceInView) {
        this.tickMs = Math.min(TICK_MAX_MS, (this.tickMs || TICK_MIN_MS) + 1500); // calm scene: slow down
        this.stats.skipped++;
        this.emit('stats', this.stats);
        return { skipped: true, diff: d };
      }
      this.lastSig = sig;
      this.lastCheckAt = Date.now();
      this.tickMs = faceInView ? TICK_FACE_MS : TICK_MIN_MS;
      if (faces.facesStatus === 'unavailable') return { error: 'faces unavailable' };
      const settings = getSettings();
      const tf = performance.now();
      const found = await faces.detect(img);
      const matches = faces.match(found, settings.people || []);
      const facesMs = Math.round(performance.now() - tf);
      this.stats.lastFacesMs = facesMs;
      if (found.length) {
        this.stats.facesSeen++;
        this.faceUntil = Date.now() + 8000; this.tickMs = TICK_FACE_MS;
        log('faces.seen', { n: found.length, best: matches[0] ? { id: matches[0].id, score: +matches[0].score.toFixed(3) } : null, ms: facesMs, source });
      }
      if (matches[0] && matches[0].score >= THRESHOLDS.face) {
        this.stats.matches++;
        log('faces.match', { name: matches[0].name, score: +matches[0].score.toFixed(3), hidden: document.visibilityState === 'hidden', ms: facesMs });
      }
      this.emit('stats', this.stats);
      const list = candidates({ faces: matches, enabled: { faces: true }, settings, now: new Date() });
      return await this._maybeSpeak(list, { t0, source, facesMs });
    } finally { this.busy = false; }
  }

  // ---------------- speaking ----------------
  async _maybeSpeak(list, { t0, source, facesMs = 0 }) {
    if (!list.length) return { spoke: null };
    const { chosen, suppressed } = arbitrate(this.ws, list, Date.now(), { busy: isSpeaking() });
    if (suppressed.length) log('suppressed', { items: suppressed });
    if (!chosen) return { spoke: null, suppressed };
    commit(this.ws, chosen);
    this.lastLine = chosen.line;
    this.stats.lines++;
    addMoment({ watch: chosen.watch, line: chosen.line });
    listen.pauseEars();
    this.emit('spoke', { watch: chosen.watch, line: chosen.line });
    const { startedAt } = await say(this.device, chosen.line, { watch: chosen.watch });
    const latency = { capture_to_voice_ms: Math.round(startedAt - t0), faces_ms: facesMs };
    log('fire', { watch: chosen.watch, key: chosen.key, line: chosen.line, source, evidence: chosen.evidence, ...latency });
    this.emit('fired', { watch: chosen.watch, line: chosen.line, ...latency });
    listen.resumeEars();
    return { spoke: chosen, latency };
  }

  // A short reply in a dialogue (not a recognition): shown as the caption and spoken.
  async _reply(text, watch) {
    this.emit('spoke', { watch, line: text, reply: true });
    return say(this.device, text, { watch });
  }
}
