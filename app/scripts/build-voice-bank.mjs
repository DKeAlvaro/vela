// Pre-generates every fixed line Vela says with ElevenLabs (same voice/model/settings as the server)
// into public/voice/el/ + manifest.json. Existing lines are skipped, so re-running costs nothing.
// Usage: ELEVENLABS_API_KEY=... node scripts/build-voice-bank.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'voice', 'el');
const manifestFile = path.join(dir, 'manifest.json');
const voiceCfg = JSON.parse(fs.readFileSync(path.join(dir, '..', '..', '..', 'server', 'voice.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const VOICE_SPEED = 1.05;

// Keep in sync with the say()/speak()/ask() texts in public/js (voice/*.js, faces-voice.js).
const LINES = [
  "Hello, I'm Vela. I'll keep an eye out for you.", 'What should I call you?', "I'm here whenever you need me. Just say Vela.",
  "I'm already watching.", "I'm watching. When I see someone I know, I'll tell you.",
  "All right, I'll rest. Say: Vela, start, when you want me.", "I'm resting. Say: Vela, start, when you want me.",
  "I haven't said anything yet.", 'I remember the people you meet, and tell you their name when I see them.',
  'Say: Vela, remember this person. Or: Vela, who is this?', "Let's go through it again.", 'I can learn faces soon.',
  "I can't tell yet.", "I can't see anyone's face right now.", "I don't know this person. Say: Vela, remember this person.",
  "I can't see right now.", 'Please say yes or no.', 'Sorry, was that a yes or a no?',
  "Let's leave that for now. Someone in your family can help later.", 'Take your time.', 'All right.',
  'Look at the person and tell me who they are.', 'Who is it?', 'Right?', 'Anyone else?', 'Anyone else? Please say yes or no.',
  "I'm watching now. When I see someone I know, I'll tell you.", 'All right. Say: Vela, remember this person, any time.',
  "I couldn't see a face. Let's try again later.", 'Is that right?', 'Is that right? If not, say no, and tell me again.',
  "If that's wrong, say no.", "Say no if that's wrong.", "Sorry, I didn't catch that.", "Sorry. Let's try again.",
  "I'm back.", 'Where were we?', 'Yes.', 'No.', 'Okay.', 'Done.',
];
// Composed lines are generated in one take so the intonation is natural (pieces glued together sound robotic).
for (const pre of ['Take your time.', "Sorry, I didn't catch that.", "Sorry. Let's try again."]) LINES.push(`${pre} Who is it?`);
LINES.push("I'm back. Who is it?", "I'm back. What should I call you?");

const todo = [...new Set(LINES)].filter((t) => !manifest.lines[t] || !fs.existsSync(path.join(dir, manifest.lines[t])));
const chars = todo.reduce((n, t) => n + t.length, 0);
console.log(`${todo.length} new lines, ${chars} characters`);
if (process.argv.includes('--dry') || !todo.length) process.exit(0);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1); }

for (const text of todo) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${manifest.voice_id}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: manifest.model, voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: VOICE_SPEED } }),
  });
  if (!r.ok) { console.error(`failed (${r.status}): ${text}`); break; }
  const file = `${crypto.createHash('sha1').update(`${manifest.voice_id}|${text}`).digest('hex').slice(0, 16)}.mp3`;
  fs.writeFileSync(path.join(dir, file), Buffer.from(await r.arrayBuffer()));
  manifest.lines[text] = file;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log('ok', text);
}
