// "Vela, who is this?": one photo from the device, matched on the device.
// (Enrolment by voice lives in onboarding.js: learnPerson.)
import { log } from '../api.js';
import { getSettings } from '../store.js';
import * as faces from '../faces.js';
import { THRESHOLDS } from '../watches.js';

export async function whoIsThis(device) {
  try {
    const blob = await device.getFrame();
    const found = await faces.detect(await createImageBitmap(blob));
    if (!found.length) return "I can't see anyone's face right now.";
    const m = faces.match(found, getSettings().people || [])[0];
    log('faces.who', { score: m ? +m.score.toFixed(3) : null });
    if (m && m.score >= THRESHOLDS.face) return m.relation ? `That's ${m.name}, ${m.relation}.` : `That's ${m.name}.`;
    return "I don't know this person. Say: Vela, remember this person.";
  } catch (e) {
    log('faces.who_error', { message: String(e.message).slice(0, 120) });
    return "I can't see right now.";
  }
}
