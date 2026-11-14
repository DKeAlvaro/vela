// Recognition logic: turns on-device face matches into at most one spoken line.
// Silence is the default: unknown faces say nothing; a known person is named once per 10 minutes.
// Pure functions + a small state object (unit-tested in test/watches.test.mjs).

// Face match threshold (Human FaceRes similarity), measured on eval's faces: see README.
export const THRESHOLDS = { face: 0.52 };

const COOL = {
  global: 4000,          // never two lines closer than this
  perPerson: 10 * 60000, // "That's Marta" at most once per 10 minutes per person
};

export function newWatchState() { return { last: {}, lastAny: 0, lastLine: {}, pending: null }; }

// ctx: { faces: [{id, name, relation, score}] } (other fields are ignored)
export function candidates({ faces = [] } = {}) {
  const f = faces.find((x) => x.score >= THRESHOLDS.face);
  if (!f) return [];
  return [{ watch: 'faces', key: `faces:${f.id}`, line: f.relation ? `That's ${f.name}, ${f.relation}.` : `That's ${f.name}.`, evidence: `match ${f.score.toFixed(2)}` }];
}

// Pick at most one line: cooldowns and one-at-a-time. Call commit() once it is spoken.
export function arbitrate(state, list, t = Date.now(), { busy = false } = {}) {
  const suppressed = [];
  for (const c of list) {
    if (busy) { suppressed.push({ key: c.key, why: 'busy' }); continue; }
    if (t - state.lastAny < COOL.global) { suppressed.push({ key: c.key, why: 'global gap' }); continue; }
    if (state.last[c.key] && t - state.last[c.key] < COOL.perPerson) { suppressed.push({ key: c.key, why: 'cooldown' }); continue; }
    return { chosen: c, suppressed };
  }
  return { chosen: null, suppressed };
}

export function commit(state, c, t = Date.now()) {
  state.last[c.key] = t;
  state.lastAny = t;
  state.lastLine[c.line] = t;
}
