// Frame preparation: downscale, cheap change detection, optional face blur before upload.

export const FRAME = { longSide: 768, quality: 0.85, diffThreshold: 0.045 };

export async function decode(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.src = url; await img.decode(); return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

// 32x24 grayscale signature for the "barely changed" test.
export function signature(src) {
  const c = document.createElement('canvas'); c.width = 32; c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, 32, 24);
  const d = g.getImageData(0, 0, 32, 24).data;
  const out = new Float32Array(32 * 24);
  let sum = 0;
  for (let i = 0; i < out.length; i++) { out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255; sum += out[i]; }
  return { px: out, mean: sum / out.length };
}

// Mean absolute difference (0..1), brightness-normalised so auto-exposure drift doesn't count.
export function diff(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.px.length; i++) s += Math.abs((a.px[i] - a.mean) - (b.px[i] - b.mean));
  return s / a.px.length + Math.abs(a.mean - b.mean) * 0.5;
}

// Downscale to longSide and encode JPEG base64. blurBoxes are in source pixel coords.
export function encode(src, { longSide = FRAME.longSide, quality = FRAME.quality, blurBoxes = [] } = {}) {
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const scale = Math.min(1, longSide / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, w, h);
  for (const [x, y, bw, bh] of blurBoxes) {
    // Privacy: faces are matched on the device and never sent to a model. Pixelate them hard.
    const bx = Math.max(0, x * scale - 8), by = Math.max(0, y * scale - 8);
    const ww = Math.min(w - bx, bw * scale + 16), hh = Math.min(h - by, bh * scale + 16);
    if (ww <= 0 || hh <= 0) continue;
    const t = document.createElement('canvas'); t.width = 6; t.height = 6;
    t.getContext('2d').drawImage(c, bx, by, ww, hh, 0, 0, 6, 6);
    g.imageSmoothingEnabled = false;
    g.drawImage(t, 0, 0, 6, 6, bx, by, ww, hh);
    g.imageSmoothingEnabled = true;
  }
  const dataUrl = c.toDataURL('image/jpeg', quality);
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width: w, height: h, bytes: Math.round((dataUrl.length - 23) * 0.75) };
}
