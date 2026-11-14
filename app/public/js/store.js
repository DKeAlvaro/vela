// Settings (the people Vela knows), options and today's moments, all in localStorage.
// Faces stay on this device: a person is { id, name, relation, embeddings[], photo (96 px thumb) }.

export const WATCHES = [{ id: 'faces', label: 'Faces' }];

const K = { settings: 'vela.settings', log: 'vela.log', opts: 'vela.opts' };
const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getWatches() { return { faces: true }; }

// v3 (faces only). Older profiles are migrated, keeping the people already enrolled.
export function getSettings() {
  const s = read(K.settings, null);
  if (s && s.profileVersion === 3) return s;
  const people = (s?.people || []).filter((p) => p.embeddings?.length);
  const fresh = { profileVersion: 3, wearer: s?.wearer || '', contact: s?.contact || { name: '', phone: '' }, people };
  write(K.settings, fresh);
  return fresh;
}
export function saveSettings(s) { write(K.settings, s); }

export function getOpts() {
  const o = { rate: 1.05, preview: false, ...read(K.opts, {}) };
  if (o.rate < 1) o.rate = 1.05; // the old slow default
  return o;
}
export function setOpt(k, v) { const o = getOpts(); o[k] = v; write(K.opts, o); }

// ---- today's moments: what Vela said (for the family view) ----
function allLogs() { return read(K.log, {}); }
export function getToday() {
  const all = allLogs();
  const k = todayKey();
  if (!all[k]) {
    all[k] = { moments: [] };
    for (const old of Object.keys(all).sort().slice(0, -7)) delete all[old]; // keep a week
    write(K.log, all);
  }
  return all[k];
}
function saveToday(day) { const all = allLogs(); all[todayKey()] = day; write(K.log, all); }
export function addMoment(m) { const d = getToday(); d.moments.push({ t: new Date().toISOString(), ...m }); saveToday(d); }
export function clearToday() { const all = allLogs(); delete all[todayKey()]; write(K.log, all); }
