// GlassesDevice: Meta Ray-Ban Gen2 glasses through the Vela Android shell.
//
// Implements the app's VelaDevice interface (see VelaDevice.js) on top of window.VelaNative,
// which the shell injects into this page (contract: glasses repo, web/README.md).
//
//   start()     connect the glasses (DAT session); the shell covers with the phone's rear camera
//               when no glasses are connected, so Vela keeps watch either way.
//   getFrame()  one still photo from the glasses -> Blob (image/jpeg, long edge <= frameMaxPx).
//   audio()     mono mic MediaStream (getUserMedia; the shell can route it to the glasses' mic).
//   say()       chime + one line on the phone's media output, which Android sends to the
//               glasses' open-ear speakers over Bluetooth (A2DP) when they are connected.
//
// Extra fields the UI may read: source ('glasses'|'mock'|'phone'|null), notice (one calm
// sentence when we are covering with the phone camera), lastFrame (timing metadata), native
// (the shell's full status object).
import { BaseDevice, speakLine } from './VelaDevice.js';

// No platform echo cancellation on the phone mic: with it, Chromium opens a VOICE_COMMUNICATION
// input and puts Android in call mode (MODE_IN_COMMUNICATION), which sends Vela's voice to the
// phone earpiece instead of the glasses (A2DP). NS + AGC are fine: verified on Álvaro's phone with
// adb (MODE_NORMAL, bt_a2dp). Same values as the app's SHELL_MIC (public/js/api.js).
const MIC_PHONE = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true };
const MIC_GLASSES = { channelCount: 1, echoCancellation: true };

const CONNECT_WAIT_MS = 25000;

// Native codes -> the error codes the app already understands.
const CODE = {
  camera_permission: 'denied',
  glasses_camera_permission: 'denied',
  busy: 'busy',
  not_registered: 'disconnected',
  no_device: 'disconnected',
  disconnected: 'disconnected',
  session_timeout: 'disconnected',
  session_failed: 'disconnected',
};

const NOTICE = {
  not_registered: 'Glasses not linked yet, so Vela is using the phone camera.',
  no_device: 'Glasses not found, so Vela is using the phone camera.',
  disconnected: 'The glasses disconnected, so Vela is using the phone camera.',
  session_timeout: 'The glasses did not answer, so Vela is using the phone camera.',
  paused: 'The glasses paused, so Vela is using the phone camera.',
  too_warm: 'The glasses are resting, so Vela is using the phone camera.',
  battery: 'The glasses battery is low, so Vela is using the phone camera.',
};

let logFn = null;
import('../api.js').then((m) => { logFn = m.log; }).catch(() => {});
const log = (type, data) => { try { logFn?.(type, data); } catch {} };

function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(String(b64).replace(/^data:[^,]+,/, ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}

export class GlassesDevice extends BaseDevice {
  constructor({ rate = 0.9, frameMaxPx = 1280, source = 'auto' } = {}) {
    super('glasses');
    this.rate = rate;
    this.pref = source;
    this.mic = null;
    this.source = null;
    this.notice = null;
    this.native = null;
    this.lastFrame = null;
    this._unsub = null;
    this._stopped = true;
    this.capabilities = { frameMaxPx, audioKind: 'mediastream', speaker: 'glasses' };
  }

  get bridge() { return window.VelaNative || null; }

  /** True when this page runs inside the Vela Android shell. */
  static available() { return !!window.VelaNative; }

  async start() {
    if (this.state === 'ready') return;
    this._stopped = false;
    this._setState('connecting');
    const N = this.bridge;
    if (!N) {
      this._setState('error', { code: 'nobridge', message: 'Glasses not available here. Open Vela from the Vela glasses app.' });
      throw new Error('no VelaNative bridge');
    }
    this._unsub?.();
    this._unsub = N.onState((_, s) => this._apply(s));
    let s;
    try {
      if (this.pref && this.pref !== 'auto') await N.setSource(this.pref);
      s = await N.connect();
    } catch (e) {
      this._setState('error', { code: 'disconnected', message: 'Could not reach the glasses.' });
      throw e;
    }
    this._apply(s);
    if (this.state === 'connecting') s = await this._waitSettled();
    if (this.state !== 'ready') throw new Error(this.error?.message || 'glasses not ready');

    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: MIC_PHONE,
      });
    } catch (e) { this.mic = null; this.micError = e.name; }
    this._refreshSpeaker();
    log('glasses.start', { source: this.source, mode: this.native?.glasses?.captureMode, mock: this.native?.glasses?.mock, mic: !!this.mic });
  }

  _waitSettled() {
    return new Promise((resolve) => {
      const t = setTimeout(() => { off(); resolve(this.native); }, CONNECT_WAIT_MS);
      const off = this.onStateChange((st) => {
        if (st !== 'connecting') { clearTimeout(t); off(); resolve(this.native); }
      });
    }).then(() => {
      if (this.state === 'connecting') {
        this._setState('error', { code: 'disconnected', message: 'The glasses did not connect.' });
      }
    });
  }

  // Map the shell's status object onto VelaDevice state + error + notice.
  _apply(s) {
    if (!s || this._stopped) return;
    const prevSource = this.source, prevNotice = this.notice;
    this.native = s;
    this.source = s.source || null;
    this.notice = s.state === 'ready' && this.source === 'phone' && this.pref !== 'phone'
      ? (NOTICE[s.code] || NOTICE[s.glasses?.code] || 'Vela is using the phone camera for now.')
      : null;
    if (s.state === 'ready') this._setState('ready');
    else if (s.state === 'connecting') this._setState('connecting');
    else if (s.state === 'idle') { /* shell not started yet; keep our own state */ }
    else {
      this._setState('error', {
        code: CODE[s.code] || s.code || 'disconnected',
        message: s.message || (s.state === 'disconnected' ? 'The glasses are not connected.' : 'The glasses reported a problem.'),
      });
    }
    if (prevSource !== this.source || prevNotice !== this.notice) {
      log('glasses.source', { source: this.source, code: s.code, glasses: s.glasses?.state, worn: s.glasses?.worn, battery: s.glasses?.battery });
      this._refreshSpeaker();
      // Same state, new source: tell listeners anyway (BaseDevice skips unchanged states).
      for (const cb of this._cbs) { try { cb(this.state, this.error); } catch (e) { console.error(e); } }
    }
  }

  async _refreshSpeaker() {
    try {
      const r = await this.bridge?.audioRoute();
      if (r) this.capabilities = { ...this.capabilities, speaker: r.output === 'glasses' ? 'glasses' : 'phone' };
    } catch {}
  }

  async stop() {
    this._stopped = true;
    this._unsub?.(); this._unsub = null;
    for (const t of this.mic?.getTracks() || []) t.stop();
    this.mic = null;
    try { await this.bridge?.disconnect(); } catch {}
    this.source = null; this.notice = null;
    this._setState('idle');
  }

  /**
   * One still JPEG. Live mode (default): the sharpest glasses frame from the last ~0.7 s, never
   * the same frame twice, usually in < 150 ms. opts: { maxAgeMs, pick: 'sharpest' | 'latest' }.
   */
  async getFrame(opts = {}) {
    if (this.state !== 'ready') throw new Error('glasses not ready');
    const t0 = performance.now();
    let f;
    try {
      f = await this.bridge.captureFrame({ maxEdge: this.capabilities.frameMaxPx, ...opts });
    } catch (e) {
      log('glasses.frame_error', { code: e.code, message: String(e.message).slice(0, 160) });
      const err = new Error(e.message || 'no frame from glasses'); err.code = e.code; throw err;
    }
    if (!f?.jpeg) throw new Error('no frame from glasses');
    this.lastFrame = {
      source: f.source, width: f.width, height: f.height, bytes: f.bytes,
      captureMs: f.captureMs, bridgeMs: Math.round(performance.now() - t0), ts: f.ts,
      mode: f.mode, ageMs: f.ageMs, sharpness: f.sharpness,
    };
    return b64ToBlob(f.jpeg, f.mime || 'image/jpeg');
  }

  audio() { return this.mic; }

  /**
   * Optional: listen through the glasses' own (beamformed) mic instead of the phone's.
   * Bluetooth HFP: while on, Vela's voice drops to call quality. Untested on hardware.
   */
  async useGlassesMic(on) {
    const r = await this.bridge?.setMicRoute(on ? 'glasses' : 'phone');
    if (this.mic) {
      for (const t of this.mic.getTracks()) t.stop();
      // Glasses mic = HFP, which is call mode anyway; the phone mic must stay out of call mode.
      try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: on ? MIC_GLASSES : MIC_PHONE }); } catch { this.mic = null; }
    }
    log('glasses.mic', { route: r?.input });
    return r;
  }

  /** Mutes the mic while Vela speaks (no AEC on the phone mic, so she must not hear herself). */
  async say(audio, opts = {}) {
    const tracks = this.mic ? this.mic.getAudioTracks() : [];
    for (const t of tracks) t.enabled = false;
    try { return await speakLine(audio, { rate: this.rate, ...opts }); }
    finally { for (const t of tracks) t.enabled = true; }
  }
}
