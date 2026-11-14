// Token, API calls and remote log.
// The token arrives once as ?k=... in the URL, is kept in localStorage and sent as a header.

// Inside the Vela Android shell, the mic's platform processing is set here, once, for every
// getUserMedia call (the phone device, and GlassesDevice): echo cancellation
// OFF (on would put Android in call mode → Vela in the earpiece), noise suppression and auto gain
// ON (Álvaro verifying with adb that the mode stays NORMAL).
export const SHELL_MIC = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
if (window.VelaNative && navigator.mediaDevices?.getUserMedia) {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c = {}) => {
    if (c.audio) c = { ...c, audio: { ...(typeof c.audio === 'object' ? c.audio : {}), channelCount: 1, ...SHELL_MIC } };
    return orig(c);
  };
}

const TOKEN_KEY = 'vela.token';
(function captureToken() {
  const u = new URL(location.href);
  const k = u.searchParams.get('k');
  if (k) {
    localStorage.setItem(TOKEN_KEY, k);
    u.searchParams.delete('k');
    history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  }
})();

export const token = () => localStorage.getItem(TOKEN_KEY) || '';
export const SESSION = (crypto.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 8);
let deviceName = 'phone';
export function setDeviceName(n) { deviceName = n; }

export class ApiError extends Error {
  constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
}

export async function api(path, { method = 'POST', json, body, headers = {}, timeout = 15000, raw = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(path, {
      method,
      headers: { 'x-vela-token': token(), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
      signal: ctl.signal,
    });
    if (raw) { if (!r.ok && r.status !== 204) throw new ApiError(r.status, null); return r; }
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError(0, { error: 'timeout' });
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, { error: 'network' });
  } finally { clearTimeout(t); }
}

// ---- remote log: batched, never contains images ----
const queue = [];
const listeners = new Set();
export function onLog(cb) { listeners.add(cb); }
export function log(type, data = {}) {
  const ev = { t: new Date().toISOString(), ms: Math.round(performance.now()), type, ...data };
  queue.push(ev);
  for (const cb of listeners) { try { cb(ev); } catch {} }
  if (queue.length > 300) queue.splice(0, queue.length - 300);
  if (/error|fire|spoke|state/.test(type)) scheduleFlush(300);
}
let flushTimer = null;
function scheduleFlush(ms) { if (!flushTimer) flushTimer = setTimeout(flush, ms); }
export async function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  if (!queue.length || !token()) return;
  const events = queue.splice(0, 100);
  try {
    await fetch('/log', {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json', 'x-vela-token': token() },
      body: JSON.stringify({ session: SESSION, device: deviceName, events }),
    });
  } catch {
    queue.unshift(...events); // retry later
  }
}
setInterval(flush, 5000);
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('error', (e) => log('client.error', { message: String(e.message).slice(0, 200), src: e.filename?.split('/').pop(), line: e.lineno }));
addEventListener('unhandledrejection', (e) => log('client.error', { message: String(e.reason?.message || e.reason).slice(0, 200) }));
