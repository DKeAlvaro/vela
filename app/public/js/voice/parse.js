// Deterministic parsing of spoken answers (pure functions, unit-tested in Node).
const strip = (t) => String(t || '').toLowerCase().replace(/[.,!?;:"“”]/g, ' ').replace(/\s+/g, ' ').trim();

// yes / no / skip / done, or null when unsure.
export function answerOf(text) {
  if (!text) return null;
  if (text.startsWith('#')) return text === '#retry' ? 'repeat' : text.slice(1);
  const t = ` ${strip(text)} `;
  if (/ (repeat|say that again|say it again|pardon|sorry what|what did you say|come again|again please) /.test(t) || /^ (what|sorry|pardon)\??\s*$/.test(t)) return 'repeat';
  if (/ (tell me more|more please|explain|what does that mean|how does (it|that) work|what's that|what is that) /.test(t) || /^ more /.test(t)) return 'more';
  if (/ (skip|later|not now|i don't know|no idea|pass) /.test(t)) return 'skip';
  if (/ (that's all|that is all|nothing else|no more|i'm done|finished|done) /.test(t)) return 'done';
  if (/^ (no|nope|no no|not really|that's wrong|wrong|incorrect)\b/.test(t) || / (no it's|no it is|that's not right|not right) /.test(t)) return 'no';
  if (/^ (yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|exactly|please|go ahead|sí|si|vale)\b/.test(t) || / (that's right|that is right|it is|correct) /.test(t)) return 'yes';
  return null;
}

// "No, it's 612…", "Well, it's Bence", "Actually, Bence" → the corrected part.
export function correctionOf(text) {
  const t = String(text || '');
  const m = t.match(/^\s*(?:no|well|actually|sorry)[,.!]?\s+(?:no[,.!]?\s+)?(?:it'?s|it is|my name is|her name is|his name is|i said|actually)?\s*(.+)$/i)
    || t.match(/^\s*(?:it'?s|it is)\s+(.+)$/i);
  return m && m[1].trim() ? m[1].trim() : null;
}

// Spelled names: "B-E-N-C-E" or "B E N C E" anywhere in the text → "Bence".
export function spelledOf(text) {
  const m = String(text || '').match(/\b([A-Za-z])(?:[\s.-]+([A-Za-z])){2,}\b/);
  if (!m) return null;
  const letters = m[0].replace(/[^A-Za-z]/g, '');
  // A Whisper stutter ("T-T-T-T-T") is not a spelled name: 3–12 letters, not all the same.
  if (letters.length < 3 || letters.length > 12 || new Set(letters.toLowerCase()).size < 2) return null;
  return letters[0].toUpperCase() + letters.slice(1).toLowerCase();
}

const NUM = { zero: '0', oh: '0', o: '0', nought: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9' };
// Spoken or written phone number → digits ('+' kept). "double six" → "66".
export function phoneOf(text) {
  const words = strip(text).replace(/(\d)\s*-\s*(\d)/g, '$1$2').split(' ');
  let out = '', dbl = 0;
  for (const w of words) {
    if (w === 'plus') { if (!out) out = '+'; continue; }
    if (w === 'double') { dbl = 2; continue; }
    if (w === 'triple') { dbl = 3; continue; }
    const d = /^\+?\d+$/.test(w) ? w.replace('+', out ? '' : '+') : NUM[w];
    if (d == null) continue;
    out += dbl && d.length === 1 ? d.repeat(dbl) : d;
    dbl = 0;
  }
  const digits = out.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? out : null;
}

// "612345678" → "6 1 2, 3 4 5, 6 7 8" (Vela reads numbers back in small groups).
export function spellPhone(p) {
  const plus = p.startsWith('+') ? 'plus ' : '';
  const d = p.replace(/\D/g, '');
  const groups = d.match(/.{1,3}/g) || [];
  return plus + groups.map((g) => g.split('').join(' ')).join(', ');
}

// Short answers to "What should I call you?" without a model: "Carmen", "I'm Carmen", "call me Carmen".
// Strict on purpose: 1–2 words, each written with a capital by the speech-to-text (it capitalises
// names), none of them a common word. Anything else goes to the model and gets read back.
const COMMON = /^(yes|no|okay|ok|um|uh|hello|hi|what|sorry|she|he|it|they|we|i|you|the|a|an|is|are|was|my|your|her|his|this|that|well|so|and|but|not|just|please|thanks|thank|publicist|good|fine|here|there)$/i;
export function simpleName(text) {
  let t = String(text || '').trim().replace(/[.!?,]+$/g, '');
  t = t.replace(/^(my name is|my name's|i'm|i am|it's|it is|call me|you can call me|just)\s+/i, '');
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2) return null;
  if (words.some((w) => COMMON.test(w.replace(/'s$/i, '')) || !/^[A-ZÁÉÍÓÚÑÜ]/.test(w) || /\d/.test(w))) return null;
  return words.join(' ');
}

export function spokenTimeOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const NUMS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
  const part = h < 12 ? 'in the morning' : h < 18 ? 'in the afternoon' : 'in the evening';
  const hw = NUMS[h % 12];
  const mw = m === 0 ? '' : m === 30 ? 'half past ' : m === 15 ? 'quarter past ' : m === 45 ? 'quarter to ' : `${m} past `;
  return m === 45 ? `quarter to ${NUMS[(h + 1) % 12]} ${part}` : `${mw}${hw} ${part}`;
}

// "2026-11-17" → "Tuesday the 17th" (how Vela reads a date back).
export function spokenDateOf(iso, now = new Date()) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = Math.round((date - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const ord = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const wd = date.toLocaleDateString('en-GB', { weekday: 'long' });
  return days < 7 ? `${wd} the ${ord(d)}` : `${wd} the ${ord(d)} of ${date.toLocaleDateString('en-GB', { month: 'long' })}`;
}
