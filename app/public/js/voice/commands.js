// Voice commands: anything the wearer says to "Vela, …" while the app is open.
// One listening loop (listen.startEars) feeds route(): speech addressed to Vela is a command,
// other speech is ignored. Understanding is Groq.
import { log } from '../api.js';
import { say } from '../voice.js';
import { understand } from './understand.js';

// Whisper sometimes writes the name as Bella / Vella / Vila / Villa.
const WAKE = /\b(vela|vella|bella|bela|fela|vera|velah|vila|villa|vala|bila|wela)\b[,.!]?/i;

export function createCommands({ vela, onSetupAgain, onRememberPerson, onWhoIsThis }) {
  let lastLine = '';
  let busy = false;
  let lastReplyAt = 0;
  const speak = async (text) => { lastLine = text; vela.emit('spoke', { watch: 'command', line: text, reply: true }); await say(vela.device, text, { watch: 'command' }); lastReplyAt = Date.now(); };

  async function handle(text) {
    const u = await understand('command', text);
    const intent = u?.intent || 'none';
    log('command', { intent, chars: text.length });
    switch (intent) {
      case 'start':
        if (!vela.running) { await vela.start(); await speak("I'm watching. When I see someone I know, I'll tell you."); }
        else await speak("I'm already watching.");
        break;
      case 'stop':
        if (vela.running) { await vela.stop({ keepDevice: true }); await speak("All right, I'll rest. Say: Vela, start, when you want me."); }
        else await speak("I'm resting. Say: Vela, start, when you want me.");
        break;
      case 'repeat': await speak(lastLine || vela.lastLine || "I haven't said anything yet."); break;
      case 'what_can_you_do':
        await speak('I remember the people you meet, and tell you their name when I see them.');
        await speak('Say: Vela, remember this person. Or: Vela, who is this?');
        break;
      case 'setup_again': await speak("Let's go through it again."); onSetupAgain?.(); break;
      case 'remember_person': onRememberPerson ? await onRememberPerson() : await speak('I can learn faces soon.'); break;
      case 'who_is_this': onWhoIsThis ? await onWhoIsThis() : await speak("I can't tell yet."); break;
      default: return false; // not for Vela: stay quiet
    }
    return true;
  }

  // Called with every utterance the ears hear. Returns true if it was a command.
  // A follow-up within 10 s of her reply doesn't need "Vela" (like a conversation).
  async function route(text) {
    const followUp = Date.now() - lastReplyAt < 10000;
    if (!WAKE.test(text) && !followUp) return false;
    if (busy) return true;
    busy = true;
    try { const handled = await handle(text.replace(WAKE, '').trim() || text); return handled || WAKE.test(text); } finally { busy = false; }
  }
  return { route, speak };
}
