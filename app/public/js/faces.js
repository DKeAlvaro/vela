// Faces: on-device only (Human: BlazeFace detector + FaceRes embeddings, WebGL).
// Faces are never sent to a model. The library and models load lazily, only when the
// Faces watch is on, so a disabled watch costs nothing.
import { log } from './api.js';

let human = null;
let loading = null;
export let facesStatus = 'off'; // off | loading | ready | unavailable

const CONFIG = {
  modelBasePath: '/vendor/human/models/',
  backend: 'webgl',
  debug: false,
  cacheSensitivity: 0,
  face: {
    enabled: true,
    detector: { rotation: false, maxDetected: 3, minConfidence: 0.5, return: false },
    mesh: { enabled: true }, iris: { enabled: false }, description: { enabled: true },
    emotion: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false },
    attention: { enabled: false },
  },
  body: { enabled: false }, hand: { enabled: false }, object: { enabled: false },
  gesture: { enabled: false }, segmentation: { enabled: false }, filter: { enabled: false },
};

export async function loadFaces() {
  if (human) return human;
  if (loading) return loading;
  facesStatus = 'loading';
  loading = (async () => {
    const t0 = performance.now();
    try {
      const { Human } = await import('/vendor/human/dist/human.esm.js');
      const h = new Human(CONFIG);
      await h.load();
      await h.warmup?.({ warmup: 'none' }).catch?.(() => {});
      human = h; facesStatus = 'ready';
      log('faces.ready', { ms: Math.round(performance.now() - t0), backend: h.tf?.getBackend?.() });
      return h;
    } catch (e) {
      facesStatus = 'unavailable';
      log('faces.error', { message: String(e.message || e).slice(0, 200) });
      loading = null;
      throw e;
    }
  })();
  return loading;
}

// Detect faces in an image source. Returns [{box:[x,y,w,h], embedding, score}] in source pixels.
export async function detect(src) {
  const h = await loadFaces();
  const res = await h.detect(src);
  return (res.face || []).filter((f) => f.embedding?.length).map((f) => ({ box: f.box, embedding: Array.from(f.embedding), score: f.boxScore ?? f.score }));
}

// Enrollment from a photo: exactly one clear face required.
export async function embedFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const faces = await detect(bmp);
  if (faces.length === 0) throw new Error('No face found in this photo.');
  faces.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  return faces[0].embedding;
}

export function similarity(a, b) {
  if (human?.match?.similarity) return human.match.similarity(a, b);
  // fallback: same normalisation as Human (euclidean, multiplier 20, range 0.2..0.8)
  let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  const d = Math.sqrt(s) * 20 / 100; const sim = 1 - d;
  return Math.max(0, Math.min(1, (sim - 0.2) / 0.6));
}

// Match detected faces against enrolled people (consent required). Returns best matches.
export function match(found, people) {
  const out = [];
  for (const f of found) {
    let best = null;
    for (const p of people) {
      if (!p.consent || !p.embeddings?.length) continue;
      for (const e of p.embeddings) {
        const s = similarity(f.embedding, e);
        if (!best || s > best.score) best = { id: p.id, name: p.name, relation: p.relation, score: s };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}
