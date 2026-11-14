// PhoneDevice: the phone's rear camera, mic and speaker stand in for the glasses.
// Applies the glasses' limits on purpose: still photos on demand (no video upload),
// mono mic, one short spoken line at a time.
import { BaseDevice, speakLine } from './VelaDevice.js';

const ERR = {
  NotAllowedError: ['denied', 'Camera permission was refused.'],
  SecurityError: ['denied', 'Camera is blocked on this page.'],
  NotReadableError: ['busy', 'The camera is busy in another app.'],
  AbortError: ['busy', 'The camera could not start.'],
  NotFoundError: ['nocamera', 'No camera found.'],
  OverconstrainedError: ['nocamera', 'No suitable camera found.'],
  NotSupportedError: ['denied', 'The browser did not allow the camera.'],
  TypeError: ['unsupported', 'This browser cannot open the camera.'],
};

export class PhoneDevice extends BaseDevice {
  constructor({ rate = 1.05 } = {}) {
    super('phone');
    this.rate = rate;
    this.stream = null;
    this.video = null;
    this.capabilities = { frameMaxPx: 1280, audioKind: 'mediastream', speaker: 'phone' };
  }

  async start() {
    if (this.state === 'ready') return;
    this._setState('connecting');
    if (!navigator.mediaDevices?.getUserMedia) {
      this._setState('error', { code: 'unsupported', message: 'This browser cannot open the camera (needs HTTPS).' });
      throw new Error('unsupported');
    }
    const video = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } };
    // Inside the Vela Android shell, platform processing must be off: with echo cancellation on,
    // Chromium puts Android in call mode and Vela's voice plays in the earpiece (Álvaro couldn't
    // hear her). In a normal browser the processing stays on.
    const shell = !!window.VelaNative;
    // Shell: AEC off (no call mode), NS + AGC on (see SHELL_MIC in api.js). Browser: all on.
    const audio = { channelCount: 1, echoCancellation: !shell, noiseSuppression: true, autoGainControl: true };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (e) {
      // Mic busy or refused: keep going with the camera only (listening falls back to buttons).
      try { stream = await navigator.mediaDevices.getUserMedia({ video }); this.micError = e.name; }
      catch (e2) {
        const [code, message] = ERR[e2.name] || ['error', 'The camera could not start.'];
        this._setState('error', { code, message });
        throw e2;
      }
    }
    this.stream = stream;
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => {
        if (this.state !== 'idle') this._setState('error', { code: 'ended', message: t.kind === 'video' ? 'The camera stopped.' : 'The microphone stopped.' });
      });
    }
    const v = this.video || document.createElement('video');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', '');
    v.srcObject = stream;
    this.video = v;
    await v.play().catch(() => {});
    await new Promise((r) => (v.readyState >= 2 ? r() : v.addEventListener('loadeddata', r, { once: true })));
    this._setState('ready');
  }

  async stop() {
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this._setState('idle');
  }

  async getFrame() {
    const v = this.video;
    if (!v || this.state !== 'ready' || !v.videoWidth) throw new Error('camera not ready');
    const scale = Math.min(1, this.capabilities.frameMaxPx / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    const c = this._canvas || (this._canvas = document.createElement('canvas'));
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no frame'))), 'image/jpeg', 0.85));
  }

  audio() {
    const tracks = this.stream?.getAudioTracks() || [];
    return tracks.length ? new MediaStream(tracks) : null;
  }

  say(audio, opts = {}) { return speakLine(audio, { rate: this.rate, ...opts }); }
}
