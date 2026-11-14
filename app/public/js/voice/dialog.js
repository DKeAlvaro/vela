// The dialog engine for Vela's spoken conversations: she asks one thing, listens, understands,
// reads it back and asks "Is that right?". The wearer can correct ("No, it's …"), skip, or stay
// silent (she asks again, gently, then moves on). Every line and every answer is logged.
import { log } from '../api.js';
import { backgroundMode } from '../background.js';
import { say } from '../voice.js';
import { listenOnce, watchForSpeech, answer as listenAnswer } from '../listen.js';
import { playListenCue, stopSpeaking } from '../devices/VelaDevice.js';
import { answerOf, correctionOf, spelledOf, understand } from './understand.js';

// The glasses shell can send the page to the background (e.g. while the glasses app connects);
// a conversation must wait for the page to be visible again rather than talk into the void.
async function whenVisible() {
  if (document.visibilityState === 'visible' || backgroundMode()) return false; // background mode: keep going
  log('dialog.wait_visible');
  await new Promise((r) => { const f = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', f); r(); } }; document.addEventListener('visibilitychange', f); });
  await new Promise((r) => setTimeout(r, 800));
  return true;
}

const BARGE_IN = false;

export class Dialog extends EventTarget {
  constructor(device) { super(); this.device = device; this.transcript = []; this.cancelled = false; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // bargeIn: if the wearer starts answering while she asks, she stops and listens at once.
  async say(text, { bargeIn = false } = {}) {
    if (this.cancelled) throw new Error('cancelled');
    await whenVisible();
    this.transcript.push({ who: 'vela', text });
    this.emit('say', { text });
    log('dialog.say', { text });
    let cut = false;
    // Barge-in is off: without the platform's echo cancellation (glasses shell) the mic hears Vela
    // herself and cut her off. The mic is gated while she speaks; she listens right after.
    const stop = bargeIn && BARGE_IN ? watchForSpeech(this.device.audio?.(), { onSpeech: () => { cut = true; stopSpeaking(); } }) : () => {};
    if (bargeIn) this.lastQuestion = text;
    try { await say(this.device, text, { watch: 'dialog', chime: this.chimed ? false : undefined }); }
    finally { stop(); }
    // Sent to the background while speaking: say it again once the page is back.
    if (document.visibilityState !== 'visible' && !backgroundMode()) { await whenVisible(); await say(this.device, text, { watch: 'dialog', chime: false }); }
    if (cut) log('dialog.barge_in', { text: text.slice(0, 60) });
    this.chimed = true;
    this.bargedIn = cut;
  }

  async listen({ timeoutMs = 9000, buttons = [], hint = '' } = {}) {
    if (this.cancelled) throw new Error('cancelled');
    await whenVisible();
    this.emit('listen', { buttons });
    if (!this.bargedIn) playListenCue();
    this.bargedIn = false;
    log('dialog.listen', { buttons });
    let hiddenOff = null;
    const hidden = new Promise((r) => { const f = () => { if (document.visibilityState === 'hidden' && !backgroundMode()) r('#hidden'); }; document.addEventListener('visibilitychange', f); hiddenOff = () => document.removeEventListener('visibilitychange', f); });
    // Short answers end early: a name within ~3.5 s, yes/no within ~2.5 s.
    const capMs = { name: 3500, yesno: 2500 }[hint] || 6000;
    // "This is Pedro, … my neighbour": people pause mid-answer; give those answers a longer end.
    const endMs = hint === 'person' || hint === 'relation' ? 900 : 600;
    let heard = await Promise.race([listenOnce(this.device.audio?.(), {
      timeoutMs, hint, silenceMs: endMs, maxMs: capMs,
      onSpeech: () => this.emit('hearing', {}),
      onLevel: (rms, floor, rec) => this.emit('level', { rms, floor, rec }),
      onCap: () => this.emit('cap', {}),
      onSent: () => this.emit('thinking', {}),
    }), hidden]);
    hiddenOff();
    if (heard === '#hidden') {
      // The page went to the background while listening: never stay deaf silently.
      listenAnswer('skip-hidden');
      log('dialog.hidden_while_listening');
      await whenVisible();
      await this.say(`I'm back. ${this.lastQuestion || 'Where were we?'}`);
      return this.listen({ timeoutMs, buttons, hint });
    }
    this.emit('heard', { text: heard });
    if (heard && !heard.startsWith('#')) this.transcript.push({ who: 'wearer', text: heard });
    log('dialog.heard', { text: heard ? heard.slice(0, 200) : '', silent: !heard });
    return heard;
  }

  // yes / no (or skip) with reprompts. Returns 'yes' | 'no' | 'skip' | null, plus the raw text.
  async confirm({ allowSkip = false, again = null } = {}) {
    for (let i = 0; i < 3; i++) {
      const heard = await this.listen({ timeoutMs: 8000, hint: 'yesno', buttons: allowSkip ? ['yes', 'no', 'skip'] : ['yes', 'no'] });
      let a = answerOf(heard);
      if (a === 'repeat') { await this.say(again || 'Please say yes or no.'); i--; continue; }
      // "Well, it's Bence" or spelled letters: a correction, i.e. a no with the right answer.
      if (!a && heard && (spelledOf(heard) || correctionOf(heard))) a = 'no';
      if (!a && heard) a = (await understand('answer', heard))?.answer;
      if (!allowSkip && (a === 'skip' || a === 'done')) a = 'no'; // "not now" to a yes/no question means no
      if (a === 'yes' || a === 'no' || (allowSkip && (a === 'skip' || a === 'done'))) return { answer: a === 'done' ? 'skip' : a, heard };
      await this.say(heard ? 'Sorry, was that a yes or a no?' : (again || 'Please say yes or no.'), { bargeIn: true });
    }
    return { answer: null, heard: '' };
  }

  // Ask → listen → parse → read back → confirm. parse(text) returns a value or null.
  // readBack(value) returns the sentence before "Is that right?" (or null to skip confirmation).
  // isClean(value, heard): true when the answer is clearly right → no read-back at all.
  // implicit: read back without asking; only a quick "no" within 3 s corrects it.
  async ask(question, { parse, readBack, allowSkip = false, retries = 3, reprompt = 'Take your time.', hint = '', isClean = null, implicit = false, quietFirst = false, suffix = null } = {}) {
    let line = question;
    this.lastQuestion = question;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (!(quietFirst && attempt === 0)) await this.say(line, { bargeIn: true });
      const heard = await this.listen({ hint, buttons: allowSkip ? ['skip'] : [] });
      if (!heard || heard === '#retry') { line = heard ? question : `${reprompt} ${question}`; continue; }
      const a = answerOf(heard);
      if (a === 'repeat') { line = question; attempt--; continue; }
      if (allowSkip && (a === 'skip' || a === 'done' || a === 'no')) return { skipped: true, done: a === 'done' };
      // A bare yes/no is never the answer to an open question ("Who is this?").
      if (a === 'yes' || a === 'no' || a === 'skip' || a === 'done') { line = `Sorry, I didn't catch that. ${question}`; continue; }
      let value = await parse(heard);
      if (!value) { line = `Sorry, I didn't catch that. ${question}`; continue; }
      if (isClean && isClean(value, heard)) return { value };
      // Read back and confirm; a "No, it's …" correction is parsed straight away.
      for (let c = 0; c < 3; c++) {
        const rb = readBack ? readBack(value) : null;
        if (!rb) return { value };
        if (implicit) {
          await this.say(`${rb} If that's wrong, say no.`, { bargeIn: true });
          const h = await this.listen({ timeoutMs: 2500, hint: 'yesno', buttons: ['no'] });
          const an = answerOf(h);
          if (an !== 'no' && !(h && (spelledOf(h) || correctionOf(h)))) return { value };
          const fx = spelledOf(h) || correctionOf(h);
          const fixed2 = fx ? await parse(fx) : null;
          if (fixed2) { value = fixed2; continue; }
          break;
        }
        await this.say(suffix !== null ? `${rb}${suffix}` : `${rb} Is that right?${this.taughtFix ? '' : ' If not, say no, and tell me again.'}`, { bargeIn: true });
        this.taughtFix = true;
        const { answer, heard: h2 } = await this.confirm({ again: suffix !== null ? `${rb}${suffix}` : `${rb} Is that right?` });
        if (answer === 'yes') return { value };
        const fix = answer === 'no' && (spelledOf(h2) || correctionOf(h2));
        const fixed = fix ? await parse(fix) : null;
        if (fixed) { value = fixed; continue; }
        break; // a plain no, or still unclear: ask the question again rather than guess
      }
      line = `Sorry. Let's try again. ${question}`;
    }
    await this.say("Let's leave that for now. Someone in your family can help later.");
    return { failed: true };
  }

  cancel() { this.cancelled = true; }
}
