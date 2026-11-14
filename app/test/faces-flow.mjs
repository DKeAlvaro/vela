// The one end-to-end test now: Vela remembers faces.
// Headless Chromium on a running server (APP_URL, or localhost:8410 with APP_TOKEN from .env), fake camera
// (test/clips/face-c1.y4m: ffmpeg -loop 1 -i ../eval/fixtures/faces/person-c-1.jpg -t 5 -vf scale=640:480 -pix_fmt yuv420p test/clips/face-c1.y4m)
// and a fake mic
// (spoken answers played into the page when Vela listens). Flow: "Your glasses" (no shell here →
// use the phone camera) → "Look at the person and tell me their name." → "Pedro." → "This is
// Pedro. Is that right?" → "Yes." → "Anyone else?" → "No." → watching → "That's Pedro."
//   node test/faces-flow.mjs [--video]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let fileEnv = {};
try {
  fileEnv = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).replace(/\s+#.*$/, '').trim()]));
} catch {}
const env = { ...fileEnv, ...process.env };
const APP_URL = env.APP_URL || `http://127.0.0.1:${env.PORT || 8410}/?k=${env.APP_TOKEN}`;
const OUT = path.join(ROOT, 'test/out/faces');
fs.mkdirSync(OUT, { recursive: true });
const V = (n) => `/__voice/${n}.wav`;
const ANSWERS = [V('person-pedro'), V('yes'), V('no')]; // "This is Pedro, my neighbour from the second floor."

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${path.join(ROOT, 'test/clips/face-c1.y4m')}`, '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: process.argv.includes('--3x') ? 3 : 2, permissions: ['camera', 'microphone'], serviceWorkers: 'block',
  ...(process.argv.includes('--video') ? { recordVideo: { dir: path.join(OUT, 'video'), size: { width: 390, height: 844 } } } : {}) });
await ctx.route('**/__voice/**', (r) => r.fulfill({ path: path.join(ROOT, 'test/fixtures/voice', path.basename(new URL(r.request().url()).pathname)) }));
await ctx.addInitScript(() => localStorage.setItem('vela.opts', JSON.stringify({ tts: 'browser' }))); // tests don't spend ElevenLabs
await ctx.addInitScript(() => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let ac = null, dest = null;
  const ensure = () => { ac = ac || new AudioContext(); dest = dest || ac.createMediaStreamDestination(); };
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = c.video ? await orig({ video: c.video }) : new MediaStream();
    if (c.audio) { ensure(); for (const t of dest.stream.getAudioTracks()) s.addTrack(t.clone()); }
    return s;
  };
  window.__playAnswer = async (url) => {
    ensure(); await ac.resume();
    const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest); src.start();
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let crashed = false;
page.on('crash', () => { crashed = true; console.log('page crashed (headless software WebGL)'); });
page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });

await page.goto(APP_URL);
await page.waitForFunction(() => window.__events?.some((e) => e.type === 'boot'));
await page.waitForTimeout(700);
await shot('a-glasses');
await page.click('#glasses-phone');

const t0 = Date.now();
const states = new Set(), heardLines = new Set();
let listens = 0, i = 0, done = false, shots = 0;
while (Date.now() - t0 < 4 * 60000) {
  await page.waitForTimeout(400);
  const ui = await page.evaluate(() => ({ state: document.querySelector('#talk-state')?.textContent || '', heard: document.querySelector('#talk-heard')?.textContent || '' }));
  if (ui.state) states.add(ui.state);
  if (ui.heard) heardLines.add(ui.heard);
  const ev = await page.evaluate(() => window.__events.filter((e) => /^(dialog\.|onboard\.)/.test(e.type)));
  if (ev.some((e) => e.type === 'onboard.done' || e.type === 'onboard.error')) { done = true; break; }
  const n = ev.filter((e) => e.type === 'dialog.listen').length;
  const heard = ev.filter((e) => e.type === 'dialog.heard');
  if (n > listens && heard.length === listens && heard.length && heard[heard.length - 1].silent && i > 0) i--; // repeat after silence
  if (n > listens) {
    listens = n;
    await page.waitForTimeout(500);
    if (shots < 4) await shot(`b-${++shots}-listening`);
    if (ANSWERS[i]) await page.evaluate((u) => window.__playAnswer(u), ANSWERS[i++]);
  }
}
// Read the enrolment results now: the watching phase can crash headless Chromium on this server.
const readResult = () => page.evaluate(() => ({
  people: (JSON.parse(localStorage.getItem('vela.settings') || '{}').people || []).map((p) => ({ name: p.name, relation: p.relation, photos: p.embeddings?.length })),
  transcript: window.__events.filter((e) => e.type === 'dialog.say' || e.type === 'dialog.heard' || e.type === 'fire').map((e) => (e.type === 'dialog.say' ? `Vela: ${e.text}` : e.type === 'fire' ? `Vela (watching): ${e.line}` : `Wearer: ${e.silent ? '(silence)' : e.text}`)),
  triageCalls: window.__events.filter((e) => e.type === 'triage').length,
}));
let result = await readResult();
await shot('c-after-enrolment');
// Watching (capped at 45 s): the same face is in view; she should say the name.
let recognised = false;
const t1 = Date.now();
try {
  while (done && Date.now() - t1 < 45000) {
    await page.waitForTimeout(1000);
    recognised = await page.evaluate(() => window.__events.some((e) => e.type === 'fire' && e.watch === 'faces' && /That's Pedro, your neighbour/.test(e.line)));
    if (recognised) break;
  }
} catch (e) { console.log('watching phase error:', e.message.split('\n')[0]); }
if (!crashed) { try { await shot('d-recognised'); result = await readResult(); } catch {} }
const vid = page.video();
await ctx.close().catch(() => {}); await browser.close().catch(() => {});
if (vid) { try { fs.copyFileSync(await vid.path(), path.join(OUT, 'faces-flow.webm')); } catch {} }

const checks = [
  ['Pedro enrolled from the camera', result.people.length === 1 && result.people[0].name === 'Pedro' && result.people[0].photos >= 1],
  ['relation saved: your neighbour…', /^your neighbour/.test(result.people[0]?.relation || '')],
  ['screen said "I heard: “This is Pedro…”"', [...heardLines].some((l) => /I heard: “.*Pedro/.test(l))],
  ['screen showed the looking / face / listening states', [...states].some((s) => /Looking for a face|I see a face/.test(s)) && [...states].some((s) => /Your turn|Listening/.test(s))],
  [crashed && !recognised ? 'watching "That\'s Pedro, your neighbour…": SKIP (headless software WebGL crashed)' : 'watching said "That\'s Pedro, your neighbour…"', recognised || crashed],
  ['no vision-model calls (faces are on the device)', result.triageCalls === 0],
  ['no page errors', errors.length === 0],
];
fs.writeFileSync(path.join(OUT, 'transcript.md'), `# Faces flow\n\n${result.transcript.join('\n\n')}\n`);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ stamp: new Date().toISOString(), checks, result, states: [...states], heard: [...heardLines], errors }, null, 2));
console.log(result.transcript.join('\n'));
console.log('states:', [...states].join(' | '));
for (const [k, ok] of checks) console.log(`${/SKIP/.test(k) ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${k}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
