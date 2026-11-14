// Understanding the wearer's answers: deterministic parsing (parse.js) first, then a small free
// text model on the server (Groq) for free speech. Never Gemini.
import { api, log } from '../api.js';

export async function understand(task, text) {
  try {
    const r = await api('/api/understand', { json: { task, text }, timeout: 8000 });
    return r.result || null;
  } catch (e) { log('understand.error', { task, status: e.status }); return null; }
}

export * from './parse.js';
