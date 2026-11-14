// Understanding what the wearer said (onboarding answers, voice commands) with a small free text
// model on Groq (openai/gpt-oss-20b, ~0.2 s).
// The client does the deterministic parsing first (yes/no, digits, times) and only asks here
// when it needs to pull structure out of free speech.

const TASKS = {
  name: {
    prompt: 'An older person was asked "What should I call you?". Extract the name they want to be called (as they said it, capitalised). If no name was said, name is "".',
    schema: '{"name": string}',
  },
  person: {
    prompt: 'Someone was asked who a person is (e.g. "This is Pedro, my neighbour from the second floor", "Pedro, mi vecino"). The answer may be in English or Spanish. Extract the first name, and the relation as a short ENGLISH phrase in second person starting with "your" ("my grandson" / "mi nieto" → "your grandson"; "la vecina del tercero" → "your neighbour from the third floor"; "my doctor" → "your doctor"). Keep the relation under 8 words. Empty string for anything not said.',
    schema: '{"name": string, "relation": string}',
  },
  command: {
    prompt: 'An older person spoke to their companion Vela. Classify the request. Intents: stop (stop watching / be quiet), start (start watching), who_is_this (who is this person in front of me), remember_person (remember this person / learn a face), what_can_you_do (help, what can you do), setup_again (set up again / start over / change my details), repeat (say that again), none (anything else or not addressed to Vela).',
    schema: '{"intent": "stop|start|who_is_this|remember_person|what_can_you_do|setup_again|repeat|none"}',
  },
  answer: {
    prompt: 'An older person answered a yes/no question from their companion. Classify the answer: yes, no, skip (later, not now, skip, I don\'t know), done (that\'s all, no more, nothing else), unclear.',
    schema: '{"answer": "yes|no|skip|done|unclear"}',
  },
};

export function createUnderstander({ groqKey, model = 'openai/gpt-oss-20b' }) {
  if (!groqKey) return null;
  return {
    name: `groq:${model}`,
    async understand(task, text) {
      const t = TASKS[task];
      if (!t) throw Object.assign(new Error('unknown task'), { status: 400 });
      const now = new Date();
      const day = (d) => `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.toISOString().slice(0, 10)}`;
      const calendar = Array.from({ length: 14 }, (_, i) => day(new Date(now.getTime() + (i + 1) * 86400000))).join(', ');
      const prompt = t.prompt.replace('{today}', now.toISOString().slice(0, 10)).replace('{weekday}', now.toLocaleDateString('en-GB', { weekday: 'long' })).replace('{calendar}', calendar);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const t0 = Date.now();
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${groqKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model, temperature: 0, max_tokens: 400, reasoning_effort: 'low',
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: `${prompt}\nAnswer with JSON only, exactly this shape: ${t.schema}` },
              { role: 'user', content: String(text).slice(0, 600) },
            ],
          }),
          signal: ctl.signal,
        });
        if (!r.ok) throw Object.assign(new Error(`groq ${r.status}`), { status: r.status });
        const j = await r.json();
        const parsed = JSON.parse(j.choices[0].message.content);
        return { result: t.post ? t.post(parsed) : parsed, model, latency_ms: Date.now() - t0, cost: 0 };
      } catch (e) {
        if (e.name === 'AbortError') throw Object.assign(new Error('groq timeout'), { status: 504 });
        throw e;
      } finally { clearTimeout(timer); }
    },
  };
}
