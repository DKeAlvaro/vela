// Vela's first conversation, by voice: she learns the faces of the people around the wearer.
// "Look at the person and tell me their name." → a photo from the glasses (or phone) camera, one
// face found on the device, the name heard, "This is Marta. Is that right?", saved. "Anyone else?"
// Faces stay on this device: only the embedding (numbers) is kept.
import { log } from '../api.js';
import { getSettings, saveSettings } from '../store.js';
import * as faces from '../faces.js';
import { understand, simpleName, spelledOf } from './understand.js';

export const ONBOARD_KEY = 'vela.onboarded';
export const isOnboarded = () => !!localStorage.getItem(ONBOARD_KEY);

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// "my grandson" / "grandson" / "your grandson" → "your grandson"; '' when nothing usable.
export function relationOf(r) {
  const t = String(r || '').trim().replace(/[.!?]+$/, '');
  if (!t) return '';
  return /^your\s/i.test(t) ? t.replace(/^Your/, 'your') : `your ${t.replace(/^(my|the|a|an)\s+/i, '')}`;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// One face from the camera: up to `tries` photos, the largest face wins.
async function grabFace(d, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const blob = await d.device.getFrame();
      const found = await faces.detect(await createImageBitmap(blob));
      if (found.length) {
        found.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
        return { embedding: found[0].embedding, blob, box: found[0].box };
      }
    } catch (e) { log('faces.grab_error', { message: String(e.message).slice(0, 120) }); }
    await pause(500);
  }
  return null;
}

async function thumb(blob, box) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const [x, y, w, h] = box;
  const side = Math.max(w, h) * 1.3, cx = x + w / 2, cy = y + h / 2;
  c.getContext('2d').drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
  return c.toDataURL('image/jpeg', 0.7);
}

// Faces collected in the background while Vela listens for the name (up to 3, best first).
function collectFaces(d, { want = 3, maxMs = 12000 } = {}) {
  const got = [];
  let stop = false;
  const done = (async () => {
    const t0 = performance.now();
    while (!stop && got.length < want && performance.now() - t0 < maxMs) {
      const f = await grabFace(d, 1);
      if (f) { got.push(f); if (got.length === 1) d.emit('face', {}); await pause(400); } // the shell's live stream: ~400 ms apart gives different frames
    }
    return got;
  })();
  return { done, got, stop: () => { stop = true; } };
}

// Learn one person. The photos are taken WHILE she listens for the name; after "yes" she only saves.
export async function learnPerson(d) {
  faces.loadFaces().catch(() => {});
  const t0 = performance.now();
  await d.say('Look at the person and tell me who they are.');
  d.emit('looking', {});
  let shots = collectFaces(d);
  // Name and relation in one answer ("This is Pedro, my neighbour" / "Pedro, mi vecino").
  const parsePerson = async (t) => {
    const u = await understand('person', t);
    const name = spelledOf(t) || cap(u?.name || '') || simpleName(t);
    return name ? { name, relation: relationOf(u?.relation) } : null;
  };
  let r = await d.ask('Who is it?', {
    hint: 'person', quietFirst: true, suffix: '', // she already asked: listen at once
    parse: parsePerson,
    readBack: (p) => (p.relation ? `${p.name}, ${p.relation}. Right?` : null), // a name only: one follow-up first
  });
  if (r.value && !r.value.relation) {
    const who = r.value;
    const rel = await d.ask(`Who is ${who.name} to you?`, {
      hint: 'relation', allowSkip: true, suffix: '',
      parse: async (t) => relationOf((await understand('person', `${who.name}, ${t}`))?.relation) || null,
      readBack: (rl) => `${who.name}, ${rl}. Right?`,
    });
    if (rel.value) who.relation = rel.value;
    else { await d.say(`${who.name}. Right?`); const c = await d.confirm({ again: `${who.name}. Right?` }); if (c.answer !== 'yes') r = {}; }
  }
  const tYes = performance.now();
  if (!r.value) { shots.stop(); return null; }
  const person = r.value;
  // Usually the photos are already there; if not, give the camera a little longer.
  let got = shots.got.length ? shots.got : await Promise.race([shots.done, new Promise((res) => setTimeout(() => res(shots.got), 2500))]);
  for (let retry = 0; !got.length && retry < 2; retry++) {
    shots.stop();
    d.emit('noface', {});
    await d.say(`I can't see a face. Look at ${person.name}.`);
    d.emit('looking', {});
    shots = collectFaces(d, { want: 2, maxMs: 6000 });
    got = await shots.done;
  }
  shots.stop();
  if (!got.length) { log('faces.noface', { name: true }); await d.say("I couldn't see a face. Let's try again later."); return null; }
  const s = getSettings();
  s.people = s.people || [];
  const existing = s.people.find((p) => p.name.toLowerCase() === person.name.toLowerCase());
  const rec = existing || { id: `f${Date.now()}`, name: person.name, relation: '' };
  if (person.relation) rec.relation = person.relation;
  Object.assign(rec, {
    consent: true, consentAt: new Date().toISOString(), consentHow: 'enrolled by the wearer',
    embeddings: [...(existing?.embeddings || []), ...got.map((f) => f.embedding)].slice(-5),
    photo: await thumb(got[0].blob, got[0].box).catch(() => null),
  });
  if (!existing) s.people.push(rec);
  saveSettings(s);
  log('faces.enrolled', { ok: true, n: rec.embeddings.length, relation: !!rec.relation, ms_yes_to_saved: Math.round(performance.now() - tYes), ms_total: Math.round(performance.now() - t0) });
  await d.say(`Saved ${rec.name}.`);
  return rec;
}

export async function runOnboarding(dialog, { onReady } = {}) {
  const t0 = performance.now();
  const s = getSettings(); s.people = []; saveSettings(s);
  log('onboard.start', { path: 'faces' });
  faces.loadFaces().catch(() => {}); // the face model loads while she says hello
  await dialog.say("Hello, I'm Vela. I'll keep an eye out for you."); // exact text of a pre-generated ElevenLabs line
  let n = 0;
  for (let round = 0; round < 8; round++) {
    if (await learnPerson(dialog)) n++;
    await dialog.say('Anyone else?');
    const { answer } = await dialog.confirm({ again: 'Anyone else? Please say yes or no.' });
    if (answer !== 'yes') break;
  }
  localStorage.setItem(ONBOARD_KEY, new Date().toISOString());
  const msToWatching = Math.round(performance.now() - t0);
  await onReady?.();
  log('onboard.watching', { ms_to_watching: msToWatching, people: n });
  await dialog.say(n ? "I'm watching now. When I see someone I know, I'll tell you." : 'All right. Say: Vela, remember this person, any time.');
  log('onboard.done', { start: true, people: n, ms_to_watching: msToWatching, ms_total: Math.round(performance.now() - t0) });
  return { start: true, people: n };
}

// Fixed lines, fetched before they are needed.
export function firstRunLines() {
  return ["Hello, I'm Vela. I'll keep an eye out for you.", 'Look at the person and tell me who they are.', 'Right?',
    'Anyone else?', "I'm watching now. When I see someone I know, I'll tell you."];
}
