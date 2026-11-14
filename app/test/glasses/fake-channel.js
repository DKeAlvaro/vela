// Mimics the Kotlin side of the WebMessage protocol (MainActivity.handle + FrameHub).
(function () {
  const st = { glasses: 'disconnected', code: 'not_registered', phone: true, running: false, failNext: false };
  window.__fake = st;
  let jpeg = null;
  fetch('letter.jpg').then(r => r.arrayBuffer()).then(b => { let s = ''; new Uint8Array(b).forEach(c => s += String.fromCharCode(c)); jpeg = btoa(s); });
  function status() {
    let state, source = null, code = null, message = null;
    if (!st.running) state = 'idle';
    else if (st.glasses === 'ready') { state = 'ready'; source = 'glasses'; }
    else if (st.phone) { state = 'ready'; source = 'phone'; code = st.code; message = 'x'; }
    else { state = 'disconnected'; code = st.code; message = 'The glasses are not connected.'; }
    return { state, code, message, source, pref: 'auto', glasses: { state: st.glasses, code: st.code, registration: 'available', captureMode: 'photo', mock: false }, phone: { state: 'idle', cameraPermission: st.phone }, frames: 0 };
  }
  const ch = { onmessage: null, postMessage(raw) {
    const m = JSON.parse(raw); let result, err;
    if (m.op === 'connect') { st.running = true; result = status(); }
    else if (m.op === 'disconnect') { st.running = false; result = status(); }
    else if (m.op === 'captureFrame') {
      const s = status();
      if (st.failNext) { st.failNext = false; err = { code: 'glasses_timeout', message: 'The glasses took too long to send a photo.' }; }
      else if (s.state !== 'ready') err = { code: s.code, message: s.message };
      else result = { jpeg, mime: 'image/jpeg', width: 1280, height: 960, bytes: jpeg.length, source: s.source, captureMs: 640, ts: Date.now() };
    }
    else if (m.op === 'audioRoute') result = { output: st.glasses === 'ready' ? 'glasses' : 'phone', input: 'phone' };
    else result = status();
    setTimeout(() => ch.onmessage({ data: JSON.stringify(err ? { id: m.id, ok: false, error: err } : { id: m.id, ok: true, result }) }), 30);
  } };
  window.__push = () => ch.onmessage({ data: JSON.stringify({ event: 'state', status: status() }) });
  window.VelaNativeChannel = ch;
})();
