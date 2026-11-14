// On-device face matching test with the same library + config as the app (Human 3.3.6, BlazeFace + FaceRes).
// Node uses the WASM backend instead of the browser's WebGL; the models and the similarity function are identical.
// Usage: node facetest.mjs [fixtures/faces dir] [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import jpeg from 'jpeg-js';
import { createRequire } from 'node:module';
const H = createRequire(import.meta.url)(path.resolve('node_modules/@vladmandic/human/dist/human.node-wasm.js'));

const DIR = process.argv[2] || '../fixtures/faces';
const OUT = process.argv[3] || 'out/faces.json';
const modelDir = path.resolve('node_modules/@vladmandic/human/models');
const wasmDir = path.resolve('node_modules/@tensorflow/tfjs-backend-wasm/dist') + '/';

import http from 'node:http';
// Node's fetch has no file:// support: serve the model files on a private local port for this run only.
const srv = http.createServer((req, res) => {
  const f = path.join(modelDir, path.basename(decodeURIComponent(req.url.split('?')[0])));
  fs.readFile(f, (err, data) => { if (err) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } });
}).listen(8411, '127.0.0.1');
const human = new H.Human({
  modelBasePath: 'http://127.0.0.1:8411/', backend: 'wasm', wasmPath: wasmDir, debug: false, cacheSensitivity: 0,
  face: { enabled: true, detector: { rotation: false, maxDetected: 3, minConfidence: 0.5, return: false },
    mesh: { enabled: true }, iris: { enabled: false }, description: { enabled: true }, emotion: { enabled: false },
    antispoof: { enabled: false }, liveness: { enabled: false }, attention: { enabled: false } },
  body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false },
  segmentation: { enabled: false }, filter: { enabled: false },
});

// Normalise to a JPEG at a given long side (like the client frame) with ImageMagick ("magick", or "convert" on
// Linux/macOS). Without ImageMagick the photo is decoded as is, so numbers can differ slightly.
let IM = null;
function resized(file, maxSide) {
  const args = [file, '-auto-orient', '-resize', maxSide + 'x' + maxSide + '>', '-quality', '85', 'jpg:-'];
  for (const bin of IM === false ? [] : IM ? [IM] : ['magick', 'convert']) {
    try { const buf = execFileSync(bin, args, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); if (buf[0] === 0xff) { IM = bin; return buf; } } catch {}
  }
  if (IM === null) { IM = false; console.warn('ImageMagick not found: decoding photos without resizing'); }
  return fs.readFileSync(file);
}
function decode(file, maxSide) {
  const img = jpeg.decode(resized(file, maxSide), { useTArray: true, formatAsRGBA: false });
  return human.tf.tensor3d(img.data, [img.height, img.width, 3], 'int32');
}

async function embed(file, maxSide) {
  const t = decode(file, maxSide);
  const t0 = performance.now();
  const res = await human.detect(t);
  const ms = performance.now() - t0;
  human.tf.dispose(t);
  const faces = (res.face || []).filter((f) => f.embedding?.length);
  faces.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  return { emb: faces[0] ? Array.from(faces[0].embedding) : null, nfaces: faces.length, ms, faceW: faces[0]?.box?.[2] };
}

await human.load();
await human.tf.ready();
const labels = fs.readFileSync(path.join(DIR, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sizes = [1024, 640];
const result = { backend: human.tf.getBackend(), version: human.version, sizes: {} };
for (const size of sizes) {
  const rows = [];
  for (const l of labels) {
    const e = await embed(path.join(DIR, l.file), size);
    rows.push({ id: l.id, person: l.person, ...e });
  }
  const ok = rows.filter((r) => r.emb);
  // Genuine and impostor pair scores.
  const gen = [], imp = [];
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const s = human.match.similarity(ok[i].emb, ok[j].emb);
    const same = ok[i].person === ok[j].person && !ok[i].person.startsWith('stranger');
    (same ? gen : imp).push(s);
  }
  // App scenario: enrol photo 1 of each person, probe with every other photo (strangers included).
  const enrolled = ok.filter((r) => !r.person.startsWith('stranger') && /-1$/.test(r.id));
  const probes = ok.filter((r) => !enrolled.includes(r));
  const scen = probes.map((p) => {
    let best = null;
    for (const e of enrolled) { const s = human.match.similarity(p.emb, e.emb); if (!best || s > best.s) best = { s, who: e.person }; }
    return { id: p.id, truth: enrolled.some((e) => e.person === p.person) ? p.person : null, best: best?.who, score: best?.s };
  });
  const thr = [];
  for (let t = 0.3; t <= 0.81; t += 0.025) {
    const genP = scen.filter((x) => x.truth);
    const tm = genP.filter((x) => x.score >= t && x.best === x.truth).length / Math.max(1, genP.length);
    const fm = scen.filter((x) => x.score >= t && x.best !== x.truth).length / Math.max(1, scen.length);
    const fmStr = scen.filter((x) => !x.truth);
    thr.push({ t: +t.toFixed(3), true_match: +tm.toFixed(3), false_match_any: +fm.toFixed(3),
      false_match_strangers: +(fmStr.filter((x) => x.score >= t).length / Math.max(1, fmStr.length)).toFixed(3),
      pair_tar: +(gen.filter((s) => s >= t).length / Math.max(1, gen.length)).toFixed(3),
      pair_far: +(imp.filter((s) => s >= t).length / Math.max(1, imp.length)).toFixed(3) });
  }
  // Scenario 2: enrol photos 1 and 2 of each person (best-of), probe photo 3 + strangers.
  const enr2 = ok.filter((r) => !r.person.startsWith('stranger') && /-(1|2)$/.test(r.id));
  const probes2 = ok.filter((r) => !enr2.includes(r));
  const scen2 = probes2.map((p) => {
    let best = null;
    for (const e of enr2) { const s = human.match.similarity(p.emb, e.emb); if (!best || s > best.s) best = { s, who: e.person }; }
    return { id: p.id, truth: enr2.some((e) => e.person === p.person) ? p.person : null, best: best?.who, score: best?.s };
  });
  const thr2 = [];
  for (let t = 0.3; t <= 0.71; t += 0.025) {
    const g = scen2.filter((x) => x.truth), st = scen2.filter((x) => !x.truth);
    thr2.push({ t: +t.toFixed(3), true_match: +(g.filter((x) => x.score >= t && x.best === x.truth).length / g.length).toFixed(3),
      false_match_any: +(scen2.filter((x) => x.score >= t && x.best !== x.truth).length / scen2.length).toFixed(3),
      false_match_strangers: +(st.filter((x) => x.score >= t).length / st.length).toFixed(3) });
  }
  for (const r of thr2) console.log(`  [enrol2] t=${r.t} TM=${r.true_match} FM=${r.false_match_any} FMstr=${r.false_match_strangers}`);
  result.sizes[size] = { scenario2: scen2, thresholds_enrol2: thr2,
    images: rows.length, no_face: rows.filter((r) => !r.emb).map((r) => r.id), genuine_pairs: gen.length, impostor_pairs: imp.length,
    genuine: { min: Math.min(...gen), mean: gen.reduce((a, b) => a + b, 0) / gen.length },
    impostor: { max: Math.max(...imp), mean: imp.reduce((a, b) => a + b, 0) / imp.length },
    detect_ms_p50: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    scenario: scen, thresholds: thr,
  };
  console.log(`size ${size}: no_face=${result.sizes[size].no_face.length} gen min/mean=${result.sizes[size].genuine.min.toFixed(3)}/${result.sizes[size].genuine.mean.toFixed(3)} imp max/mean=${result.sizes[size].impostor.max.toFixed(3)}/${result.sizes[size].impostor.mean.toFixed(3)}`);
  for (const r of thr) console.log(`  t=${r.t} TM=${r.true_match} FM=${r.false_match_any} FMstr=${r.false_match_strangers} pairTAR=${r.pair_tar} pairFAR=${r.pair_far}`);
}
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
srv.close();
