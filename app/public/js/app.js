// UI glue: main screen, settings, family view, debug panel. Talks to the pipeline and the
// device only through the Vela class and the VelaDevice interface.
import { api, log, onLog, token, SESSION, setDeviceName, flush } from './api.js';
import { getSettings, saveSettings, getToday, getOpts, setOpt, clearToday } from './store.js';
import { Vela } from './pipeline.js';
import { PhoneDevice } from './devices/PhoneDevice.js';
import { unlockAudio } from './devices/VelaDevice.js';
import { setTtsProvider, getTtsProvider } from './voice.js';
import * as listen from './listen.js';
import * as faces from './faces.js';
import { Dialog } from './voice/dialog.js';
import { runOnboarding, isOnboarded } from './voice/onboarding.js';
import { say as sayLine, prefetch } from './voice.js';
import { createCommands } from './voice/commands.js';
import { whoIsThis } from './voice/faces-voice.js';
import { firstRunLines, learnPerson } from './voice/onboarding.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const vela = new Vela();
window.vela = vela; // for the self-test harness and the debug panel
window.__events = [];
document.addEventListener('visibilitychange', () => log('page.visibility', { state: document.visibilityState }));
onLog((ev) => { window.__events.push(ev); if (window.__events.length > 500) window.__events.shift(); renderDebugLog(); });

let config = null;

// ---------------- device selection: ?device=glasses is the plug-in slot ----------------
async function makeDevice() {
  const rate = getOpts().rate;
  if (params.get('device') === 'glasses') {
    try {
      const mod = await import('/js/devices/GlassesDevice.js');
      const d = new mod.GlassesDevice({ rate });
      setDeviceName('glasses');
      return d;
    } catch (e) {
      log('device.glasses_unavailable', { message: e.message });
    }
  }
  setDeviceName('phone');
  return new PhoneDevice({ rate });
}

async function useDevice(d) {
  vela.setDevice(d);
  d.onStateChange((state, err) => {
    // The glasses adapter may cover with the phone camera and explain why (device.notice).
    if (d.notice && vela.running && state === 'ready') showStatus(vela.status, d.notice);
    // Glasses disconnected: pause clearly, offer the phone.
    if (d.name === 'glasses' && state === 'error') {
      showStatus('nocamera', `${err?.message || 'The glasses disconnected.'} Tap Start to use the phone instead.`);
      fallbackToPhone = true;
    }
  });
}
let fallbackToPhone = false;

// ---------------- status ----------------
const STATUS_TEXT = { idle: 'Paused', starting: 'Starting…', watching: 'Watching', paused: 'Paused', nocamera: 'No camera', offline: 'Offline', error: 'Needs attention' };
const STATUS_NOTE = {}; // no sub-lines: a note appears only when something needs fixing
function showStatus(s, note) {
  const c = getSettings().contact?.name;
  $('#family-link').textContent = c ? `For ${c}` : 'For family';
  const el = $('#status');
  el.textContent = STATUS_TEXT[s] || s;
  el.dataset.s = s;
  $('#status-note').textContent = note || STATUS_NOTE[s] || '';
  const on = vela.running;
  $('#start').textContent = on ? 'Pause' : (s === 'nocamera' ? 'Try again' : 'Start');
  $('#main-firefly').classList.toggle('on', on && s === 'watching');
  $('#start').classList.toggle('on', on);
}
vela.addEventListener('status', (e) => {
  let note = e.detail.note;
  if (e.detail.status === 'nocamera' && !note) note = 'Vela needs the camera to keep watch.';
  if (e.detail.status === 'nocamera' && vela.device?.error?.code === 'denied') note = 'Camera permission is off. Allow it in the browser’s site settings, then tap Try again.';
  showStatus(e.detail.status, note);
});

// ---------------- what Vela just said (caption on the main screen) ----------------
vela.addEventListener('spoke', (e) => { $('#main-line').textContent = (e.detail.line || '').replace(/'/g, '\u2019'); window.__events.push({ t: new Date().toISOString(), type: 'ui.spoke', watch: e.detail.watch, line: e.detail.line }); });

// ---------------- start / stop ----------------
$('#start').addEventListener('click', async () => {
  if (vela.running) { await vela.stop(); return; }
  await unlockAudio(); // inside the tap, so the phone lets Vela speak later
  if (fallbackToPhone) { fallbackToPhone = false; await useDevice(new PhoneDevice({ rate: getOpts().rate })); setDeviceName('phone'); }
  try { await vela.start(); attachPreview(); } catch (e) { log('start.error', { message: e.message, code: vela.device?.error?.code }); }
});

// ---------------- routing ----------------
function route() {
  const r = location.hash.replace('#', '') || '/';
  $('#view-main').hidden = r !== '/';
  $('#view-settings').hidden = r !== '/settings';
  $('#view-family').hidden = r !== '/family';
  $('#view-setup').hidden = r !== '/setup';
  $('#view-talk').hidden = r !== '/talk';
  if (r === '/settings') renderSettings();
  if (r === '/setup') { setupPath = null; setupStep('glasses'); }
  if (r === '/family') renderFamily();
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);

// ---------------- settings ----------------
const COLOURS = ['blue', 'white', 'yellow', 'pink', 'orange', 'red', 'green', 'brown'];
function renderSettings() {
  const s = getSettings();
  const o = getOpts();
  const f = $('#settings-form');
  f.innerHTML = `
  <fieldset>
    <legend>People Vela knows</legend>
    ${s.people.map((p, i) => `
      <div class="item">
        <div class="item-head"><strong>${esc(p.name)}</strong><button type="button" class="linkbtn" data-del-person="${i}">Remove</button></div>
        <label class="field"><span>Who they are</span><input name="rel-${i}" value="${esc(p.relation || '')}" placeholder="your grandson"></label>
        <div class="face-row">
          ${p.photo ? `<img class="face-thumb" src="${p.photo}" alt="">` : '<span class="face-thumb"></span>'}
          <span>${p.embeddings?.length ? `${p.embeddings.length} photo${p.embeddings.length > 1 ? 's' : ''}` : 'No photo yet'}</span>
        </div>
      </div>`).join('') || '<p class="empty">Nobody yet. Say: Vela, remember this person.</p>'}
  </fieldset>
  <fieldset>
    <legend>Voice</legend>
    <label class="field"><span>Speaking pace</span><select name="o-rate">
      ${[['0.95', 'Slower'], ['1.05', 'Normal'], ['1.15', 'Quicker']].map(([v, l]) => `<option value="${v}" ${Number(v) === o.rate ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
  </fieldset>
  <fieldset>
    <legend>Start over</legend>
    <button type="button" class="btn btn-line btn-small" id="setup-again">Set up again with Vela</button>
  </fieldset>`;
}

function readSettingsForm() {
  const v = (n) => $('#settings-form').elements[n]?.value?.trim();
  setOpt('rate', Number(v('o-rate') || 1.05));
  const s = getSettings();
  s.people.forEach((p, i) => { const r = v(`rel-${i}`); if (r !== undefined) p.relation = r ? (/^your\s/i.test(r) ? r : `your ${r.replace(/^(my|the)\s+/i, '')}`) : ''; });
  saveSettings(s);
  if (vela.device) vela.device.rate = getOpts().rate;
  return getSettings();
}
$('#settings-form').addEventListener('change', () => readSettingsForm());
$('#settings-form').addEventListener('click', (e) => {
  const t = e.target;
  const s = getSettings();
  if (t.dataset.delPerson) { s.people.splice(Number(t.dataset.delPerson), 1); saveSettings(s); renderSettings(); }
  else if (t.id === 'setup-again') { localStorage.removeItem('vela.onboarded'); location.hash = '#/setup'; }
});

async function enrol(person, blob) {
  const emb = await faces.embedFromBlob(blob);
  person.embeddings = [...(person.embeddings || []), emb].slice(-5);
  // tiny local thumbnail for the settings list only
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const s = Math.min(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 96, 96);
  person.photo = c.toDataURL('image/jpeg', 0.7);
  log('faces.enrolled', { id: person.id, n: person.embeddings.length });
}

// ---------------- family view ----------------
const WATCH_NAME = { faces: 'Recognised' };
function renderFamily() {
  // Vision doc §8: one screen. "Today: all fine." Below it, the few moments Vela stepped in,
  // (the people Vela recognised today). Never a camera feed.
  const d = getToday();
  const s = getSettings();
  const hm = (iso) => new Date(iso).toTimeString().slice(0, 5);
  const moments = d.moments.filter((m) => m.watch === 'faces');
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#family').innerHTML = `
    <p class="fam-day">${esc(s.wearer || '')}${s.wearer ? ' · ' : ''}${dateStr}</p>
    <h2 class="fam-head">Today: <span class="fine">all fine.</span></h2>
    <section class="fam-moments">
      ${moments.slice().reverse().map((m) => `<div class="moment"><time>${hm(m.t)}</time><div><span class="w">${WATCH_NAME[m.watch] || m.watch}</span><span class="l">“${esc(m.line)}”</span></div></div>`).join('')}
    </section>
  `;
}

// ---------------- camera preview (optional, for aiming) ----------------
function attachPreview() {
  const v = $('#preview');
  const stream = vela.device?.stream;
  if (getOpts().preview && stream && vela.running) { v.srcObject = stream; v.hidden = false; v.play().catch(() => {}); }
  else { v.hidden = true; v.srcObject = null; }
}

// ---------------- debug panel (long-press the wordmark) ----------------
let pressT = null;
const mark = $('#mark');
mark.addEventListener('pointerdown', () => { pressT = setTimeout(toggleDebug, 700); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => mark.addEventListener(ev, () => clearTimeout(pressT)));
mark.addEventListener('contextmenu', (e) => e.preventDefault());

function toggleDebug(force) {
  const el = $('#debug');
  el.hidden = typeof force === 'boolean' ? !force : !el.hidden;
  if (!el.hidden) renderDebug();
}
function renderDebug() {
  const el = $('#debug');
  api('/api/config', { method: 'GET' }).then((c) => { config = c; renderDebugStats(); }).catch(() => {});
  el.innerHTML = `
    <div class="bar" style="justify-content:space-between;align-items:center"><strong style="font-size:18px">Debug</strong><button id="dbg-close">Close</button></div>
    <div class="grid" id="dbg-stats"></div>
    <h4>Inject through the real pipeline</h4>
    <div class="bar">
      <label class="dbtn" style="display:inline-flex;align-items:center">Photo…<input type="file" accept="image/*" id="dbg-file" hidden></label>
      <button id="dbg-tick">Grab a frame now</button>
      <button id="dbg-preview">Preview ${getOpts().preview ? 'off' : 'on'}</button>
    </div>
    <input type="text" id="dbg-url" placeholder="Image URL (e.g. a fixture)">
    <div class="bar"><button id="dbg-url-go">Inject URL</button></div>
    <h4>Simulate</h4>
    <div class="bar"><button id="dbg-disc">Device disconnect</button><button id="dbg-reset-cool">Reset cooldowns</button><button id="dbg-clear">Clear today</button></div>
    <h4>Events</h4>
    <pre id="dbg-log"></pre>`;
  renderDebugStats();
  renderDebugLog();
  $('#dbg-close').onclick = () => toggleDebug(false);
  $('#dbg-file').onchange = (e) => e.target.files[0] && injectBlob(e.target.files[0], 'inject-file');
  $('#dbg-tick').onclick = async () => { try { await vela.processFrame(await vela.device.getFrame(), { force: true, source: 'debug-grab' }); } catch (e) { log('debug.error', { message: e.message }); } };
  $('#dbg-preview').onclick = () => { setOpt('preview', !getOpts().preview); attachPreview(); renderDebug(); };
  $('#dbg-url-go').onclick = async () => { const u = $('#dbg-url').value.trim(); if (u) injectBlob(await (await fetch(u)).blob(), 'inject-url'); };
  $('#dbg-disc').onclick = () => vela.device?._setState('error', { code: 'disconnected', message: 'The device disconnected (simulated).' });
  $('#dbg-reset-cool').onclick = () => { vela.ws.last = {}; vela.ws.lastAny = 0; vela.ws.lastLine = {}; };
  $('#dbg-clear').onclick = () => clearToday();
}
function renderDebugStats() {
  const el = $('#dbg-stats');
  if (!el) return;
  const s = vela.stats;
  const cell = (b, l) => `<div><b>${esc(b)}</b><span>${esc(l)}</span></div>`;
  el.innerHTML = [
    cell(`${s.frames}`, 'photos'),
    cell(`${s.skipped}`, 'skipped as unchanged'),
    cell(`${s.facesSeen}`, 'faces seen'),
    cell(`${s.matches}`, 'recognised'),
    cell(s.lastFacesMs != null ? `${s.lastFacesMs} ms` : '—', 'face matching'),
    cell(`${(getSettings().people || []).length}`, 'people enrolled'),
    cell(getTtsProvider(), 'voice'),
    cell(listen.listenMode(), 'listening'),
    cell(`${vela.device?.name || '—'}: ${vela.device?.state || '—'}`, 'device'),
    cell(faces.facesStatus, 'faces on device'),
  ].join('');
}
function renderDebugLog() {
  const el = $('#dbg-log');
  if (!el || $('#debug').hidden) return;
  el.textContent = window.__events.slice(-30).reverse().map((e) => `${e.t.slice(11, 19)} ${e.type} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['t', 'ms', 'type'].includes(k)))).slice(0, 220)}`).join('\n');
  renderDebugStats();
}
async function injectBlob(blob, source) {
  if (!vela.running) { log('inject.note', { message: 'Vela not running: injecting anyway' }); }
  return vela.processFrame(blob, { force: true, source });
}
window.velaInject = injectBlob;
window.velaEnrol = async (personId, url) => {
  const s = getSettings(); const p = s.people.find((x) => x.id === personId);
  await enrol(p, await (await fetch(url)).blob()); saveSettings(s); return p.embeddings.length;
};
vela.addEventListener('stats', renderDebugStats);

// ---------------- onboarding part A0: your glasses (first, before anything else) ----------------
// Reads the shell's live glasses status over window.VelaNative, says it plainly, offers the one
// action that fixes it, and moves on only when the glasses are ready, or when the person chooses
// the phone camera for now. Outside the shell: open the Vela glasses app.
function glassesView() {
  const N = window.VelaNative;
  if (!N) return { line: 'To use your glasses, open Vela from the Vela glasses app.', action: null, ready: false, code: 'nobridge' };
  let st = null; try { st = N.status?.(); } catch {}
  const g = st?.glasses || {};
  const code = g.code || (st?.source === 'phone' ? st?.code : null) || null;
  const ready = st?.source === 'glasses' || st?.source === 'mock' || g.state === 'ready';
  const battery = typeof g.battery === 'number' ? ` Battery ${g.battery}%.` : '';
  const open = { label: 'Open Meta AI', fn: () => N.registerGlasses?.() };
  const retry = { label: 'Try again', fn: () => N.connect?.() };
  if (ready) return { line: `Your glasses are connected.${battery}`, action: { label: 'Continue', fn: null }, ready: true, code: 'ready' };
  const map = {
    not_registered: ['Connect Vela to your glasses in the Meta AI app.', { label: 'Connect', fn: () => N.registerGlasses?.() }],
    glasses_app_update: ['Your glasses need an update in the Meta AI app.', open],
    firmware_update: ['Your glasses need an update in the Meta AI app.', open],
    sdk_update: ['This Vela app is too old for your glasses. Install the new version.', null],
    no_device: ['Vela can’t find your glasses. Switch them on and keep them close.', retry],
    glasses_camera_permission: ['Allow the camera for Vela in the Meta AI app.', open],
    paused: ['Put your glasses on, then try again.', retry],
    too_warm: ['Your glasses are too warm. Let them rest a moment.', retry],
    battery: ['Your glasses’ battery is low. Charge them, then try again.', retry],
    disconnected: ['Your glasses aren’t connected yet.', retry],
    session_timeout: ['Your glasses aren’t answering.', retry],
  };
  if (!st || st.state === 'connecting' || st.state === 'idle') return { line: 'Looking for your glasses…', action: null, ready: false, code: 'connecting' };
  const [line, action] = map[code] || [g.message || st.message || 'Your glasses aren’t connected yet.', retry];
  return { line, action, ready: false, code: code || 'unknown' };
}
let glassesSpeakNext = false, glassesLast = '';
function renderGlasses() {
  const v = glassesView();
  $('#glasses-head').textContent = v.line;
  (window.__glassesLines ||= []).includes(v.line) || window.__glassesLines.push(v.line);
  const b = $('#glasses-action');
  b.hidden = !v.action; if (v.action) b.textContent = v.action.label;
  b.dataset.ready = v.ready ? '1' : '';
  $('#glasses-phone').hidden = v.ready;
  if (v.line !== glassesLast) {
    glassesLast = v.line;
    log('setup.glasses', { code: v.code, ready: v.ready, battery: window.VelaNative?.status?.()?.glasses?.battery ?? null });
    if (glassesSpeakNext) sayLine(vela.device, v.line, { watch: 'setup' }); // spoken once audio is unlocked by a tap
  }
  return v;
}
let glassesUnsub = null;
function enterGlassesStep() {
  const N = window.VelaNative;
  if (N && !glassesUnsub) {
    try { glassesUnsub = N.onState?.(() => renderGlasses()); } catch {}
    N.connect?.().catch?.(() => {});
  }
  renderGlasses();
}
$('#glasses-action').addEventListener('click', async () => {
  await unlockAudio(); glassesSpeakNext = true;
  const v = glassesView();
  if (v.ready) { glassesUnsub?.(); startFaceSetup(); return; }
  try { await v.action?.fn?.(); } catch (e) { log('setup.glasses_action_error', { message: String(e.message).slice(0, 120) }); }
  glassesLast = ''; renderGlasses();
});
$('#glasses-phone').addEventListener('click', async () => {
  await unlockAudio();
  log('setup.glasses', { code: 'phone_for_now' });
  glassesUnsub?.();
  startFaceSetup();
});

// After the glasses step: camera + mic (inside this tap), then Vela's face conversation.
async function startFaceSetup() {
  try { await allowDevices(); }
  catch {
    $('#glasses-head').textContent = vela.device.error?.code === 'denied' ? 'Please allow the camera and microphone, then tap again.' : (vela.device.error?.message || 'The camera could not start.');
    return;
  }
  location.hash = '#/talk';
  startConversation();
}

// ---------------- setup screens: only "Your glasses" is left ----------------
let setupPath = null;
function setupStep(name) {
  document.querySelectorAll('.setup-pane').forEach((p) => { p.hidden = p.dataset.step !== name; });
  $('#setup-step').textContent = '';
  if (name === 'glasses') enterGlassesStep();
  log('setup.step', { step: name });
  window.scrollTo(0, 0);
}
async function allowDevices() {
  await unlockAudio();
  await vela.device.start();
}

// ---------------- onboarding part B: Vela's first conversation ----------------
let dialog = null;
async function startConversation() {
  if (dialog) return;
  prefetch(firstRunLines()); // the next lines are ready before she needs them
  dialog = new Dialog(vela.device);
  window.__dialog = dialog;
  const ff = $('#talk-firefly');
  // Every state readable on screen, big and plain: what Vela is doing, what she said, what she heard.
  const state = (t) => { $('#talk-state').textContent = t; };
  const meter = $('#talk-meter'), bar = $('#talk-meter-bar');
  const buttons = (list) => { $('#talk-buttons').innerHTML = list.map((b) => `<button class="btn ${b === 'yes' ? 'btn-ink' : 'btn-line'}" data-answer="${b}">${({ yes: 'Yes', no: 'No', skip: 'Skip', more: 'Tell me more', retry: 'Try again' })[b] || b}</button>`).join(''); };
  dialog.addEventListener('say', (e) => {
    ff.className = 'firefly talk-firefly speaking';
    state('Vela is speaking');
    meter.hidden = true;
    $('#talk-line').textContent = e.detail.text.replace(/'/g, '\u2019');
    buttons([]);
  });
  dialog.addEventListener('listen', (e) => {
    ff.className = 'firefly talk-firefly listening';
    state('Your turn to talk');
    meter.hidden = false; bar.style.width = '0%';
    $('#talk-heard').textContent = '';
    buttons(e.detail.buttons || []);
  });
  dialog.addEventListener('level', (e) => {
    // live mic level: how far above the room's noise
    const { rms, floor } = e.detail;
    const v = Math.max(0, Math.min(1, (rms / Math.max(floor, 0.002) - 1) / 6));
    bar.style.width = `${Math.round(v * 100)}%`;
  });
  dialog.addEventListener('hearing', () => state('Listening…'));
  dialog.addEventListener('looking', () => { ff.className = 'firefly talk-firefly listening'; state('Looking for a face…'); meter.hidden = true; $('#talk-heard').textContent = ''; });
  dialog.addEventListener('noface', () => { state('I can’t see a face. Point the camera at the person.'); });
  dialog.addEventListener('face', () => { state('I see a face. Your turn: say the name.'); });
  dialog.addEventListener('cap', () => state('Got it. That was a long answer.'));
  dialog.addEventListener('thinking', () => { state('Thinking…'); meter.hidden = true; });
  dialog.addEventListener('heard', (e) => {
    ff.className = 'firefly talk-firefly';
    meter.hidden = true;
    const t = e.detail.text || '';
    if (!t) { state('I didn’t catch that'); $('#talk-heard').textContent = ''; buttons(['retry']); return; }
    if (t.startsWith('#')) { state(''); buttons([]); return; }
    state('Got it');
    $('#talk-heard').innerHTML = `I heard: <b>“${esc(t)}”</b>`;
    buttons([]);
  });
  try {
    let started = false;
    const out = await runOnboarding(dialog, { onReady: async () => { started = true; location.hash = '#/'; try { await vela.start({ quietEars: true }); } catch {} } });
    ff.className = 'firefly talk-firefly';
    location.hash = '#/';
    void started;
    vela.startEars(); // she has finished talking: listen for "Vela, …" (no extra line: it would talk over a recognition)
  } catch (e) {
    log('onboard.error', { message: String(e.message).slice(0, 200) });
  } finally { dialog = null; }
}
$('#talk-buttons').addEventListener('click', (e) => { const b = e.target.closest('[data-answer]'); if (b) listen.answer(b.dataset.answer); });
window.velaStartConversation = startConversation;

// ---------------- voice commands ("Vela, …") ----------------
// A short spoken dialog on request (remember a person): watching pauses meanwhile.
async function miniDialog(fn) {
  const d = new Dialog(vela.device);
  d.chimed = true; // she is already talking: no chime
  const wasRunning = vela.running;
  if (wasRunning) await vela.stop({ keepDevice: true });
  listen.stopEars();
  try { await fn(d); } catch (e) { log('mini_dialog.error', { message: String(e.message).slice(0, 120) }); }
  finally { if (wasRunning) await vela.start(); else vela.startEars(); }
}
const commands = createCommands({
  vela,
  onRememberPerson: () => miniDialog((d) => learnPerson(d)),
  onWhoIsThis: async () => { await commands.speak(await whoIsThis(vela.device)); },
  onSetupAgain: () => { localStorage.removeItem('vela.onboarded'); listen.stopEars(); if (vela.running) vela.stop({ keepDevice: true }); location.hash = '#/talk'; startConversation(); },
});
vela.earsHandler = (t) => commands.route(t);
window.velaCommand = (t) => commands.route(t); // test hook: same path as heard speech

// ---------------- boot ----------------
(async function boot() {
  if (!isOnboarded() && !location.hash) location.hash = '#/setup';
  route();
  await useDevice(await makeDevice());
  showStatus('idle');
  if (!token()) showStatus('error', 'This link is missing its key. Open the link from the email.');
  try {
    config = await api('/api/config', { method: 'GET' });
    setTtsProvider(config.tts?.provider);
    listen.setSttAvailable(!!config.stt);
    log('boot', { config: { vision: config.vision, tts: config.tts?.provider, stt: config.stt?.provider, prompt: config.prompt_version }, device: vela.device.name, listen: listen.listenMode(), standalone: matchMedia('(display-mode: standalone)').matches });
  } catch (e) {
    if (e.status === 401) showStatus('error', 'This link is missing its key. Open the link from the email.');
    else if (!navigator.onLine) showStatus('offline', 'No connection yet.');
    log('boot.error', { status: e.status });
  }
  if (params.get('debug') === '1') toggleDebug(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  flush();
})();
