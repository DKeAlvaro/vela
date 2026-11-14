// Background mode: inside the Vela Android shell with its foreground service running, the page
// keeps working with the screen locked or another app in front. Then Vela must not pause on
// "hidden". In a plain browser (no shell, or the shell says false) the old pause stays.
// VelaNative.backgroundMode() may return a boolean or a Promise; the last answer is cached.
import { log } from './api.js';

let cached = false;
function ask() {
  try {
    const v = window.VelaNative?.backgroundMode?.();
    if (v && typeof v.then === 'function') v.then((b) => set(!!b)).catch(() => {});
    else set(!!v);
  } catch { set(false); }
}
function set(b) { if (b !== cached) { cached = b; log('background.mode', { on: b }); } }

export function backgroundMode() { ask(); return cached; }

if (window.VelaNative) {
  ask();
  try { window.VelaNative.onState?.(() => ask()); } catch {}
  document.addEventListener('visibilitychange', ask);
}
