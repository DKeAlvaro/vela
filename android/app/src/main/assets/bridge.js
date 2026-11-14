// window.VelaNative — injected by the Vela Android shell at document start, only into the Vela
// app's origin and the shell's own pages. Talks to Kotlin over a WebMessage channel
// (window.VelaNativeChannel). Contract: web/README.md in the glasses repo.
(function () {
  'use strict';
  if (window.VelaNative || !window.VelaNativeChannel) return;
  var ch = window.VelaNativeChannel;
  var seq = 0;
  var pending = new Map();
  var subs = new Set();
  var status = { state: 'idle', source: null };
  var bg = { supported: true, active: false, hidden: false, tick: false };
  var tickSubs = new Set();

  function emit(s) {
    status = s || status;
    subs.forEach(function (cb) { try { cb(status.state, status); } catch (e) { console.error(e); } });
    try { if (typeof window.onVelaNativeState === 'function') window.onVelaNativeState(status.state, status); } catch (e) { console.error(e); }
    try { window.dispatchEvent(new CustomEvent('velanative:state', { detail: status })); } catch (e) {}
  }

  ch.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.event === 'state') { emit(m.status); return; }
    if (m.event === 'background') { bg = m.status || bg; emit(); try { window.dispatchEvent(new CustomEvent('velanative:background', { detail: bg })); } catch (e) {} return; }
    if (m.event === 'tick') { tickSubs.forEach(function (cb) { try { cb(m.status); } catch (e) { console.error(e); } }); return; }
    var p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else {
      var err = new Error((m.error && m.error.message) || 'Native error');
      err.code = (m.error && m.error.code) || 'native_error';
      p.reject(err);
    }
  };

  function call(op, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        var e = new Error(op + ' timed out'); e.code = 'timeout'; reject(e);
      }, timeoutMs || 15000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      ch.postMessage(JSON.stringify({ id: id, op: op, args: args || {} }));
    });
  }

  function remember(s) { if (s && s.state) emit(s); return s; }

  window.VelaNative = Object.freeze({
    version: 1,
    /** One still photo. Resolves to a base64 JPEG string (no data: prefix). */
    getFrame: function (opts) { return call('captureFrame', opts, 20000).then(function (f) { return f.jpeg; }); },
    /** One still photo with metadata: { jpeg, mime, width, height, bytes, source, captureMs, ts }. */
    captureFrame: function (opts) { return call('captureFrame', opts, 20000); },
    /** Start: glasses session (and phone fallback). Resolves to the status object. */
    connect: function () { return call('connect', {}, 45000).then(remember); },
    disconnect: function () { return call('disconnect', {}, 10000).then(remember); },
    /** Last known state, synchronous: 'idle'|'connecting'|'ready'|'disconnected'|'error'. */
    state: function () { return status.state; },
    /** Last known full status object, synchronous. */
    status: function () { return status; },
    refresh: function () { return call('status').then(remember); },
    /** Subscribe to state changes: cb(state, status). Returns an unsubscribe function. */
    onState: function (cb) { subs.add(cb); return function () { subs.delete(cb); }; },
    /**
     * Background mode, synchronous boolean: true while the shell's foreground service runs (it
     * keeps Vela alive with the phone locked: wake lock, WebView never paused), so the app should
     * not pause on visibilitychange. Details: backgroundInfo(). Updates: 'velanative:background'
     * and every onState.
     */
    backgroundMode: function () { return !!bg.active; },
    /** { supported, active, types: 'connectedDevice|camera|microphone', hidden, tick } */
    backgroundInfo: function () { return bg; },
    /** Native 1 s heartbeat while watching: cb({n, hidden}). Drive the watch loop from it when hidden. */
    onTick: function (cb) { tickSubs.add(cb); return function () { tickSubs.delete(cb); }; },
    /** Onboarding: the plain glasses status {status, action, message}, synchronous. See BRIDGE.md. */
    glasses: function () { return status.glassesStatus || { status: 'unknown', action: 'connect', message: '' }; },
    /** Onboarding's one button (call from a tap): Bluetooth permission, Meta AI link, or session start. */
    connectGlasses: function () { return call('connectGlasses', {}, 45000).then(remember); },
    /** Opens the Meta AI app to connect Vela to the glasses (needs a user tap). Resolves to the status
     *  object plus `register: {result: 'ok'|'error', code, message, metaAi, device}`. */
    registerGlasses: function () { return call('registerGlasses', {}, 30000).then(remember); },
    /** Opens Meta AI ('app'), Android's app info for it ('settings'), or its Play Store page ('store'). */
    openMetaAi: function (target) { return call('openMetaAi', { target: target || 'app' }); },
    unregisterGlasses: function () { return call('unregisterGlasses', {}, 10000).then(remember); },
    /** 'auto' (glasses, else phone) | 'glasses' | 'phone' */
    setSource: function (source) { return call('setSource', { source: source }).then(remember); },
    /** 'photo' (default) | 'stream' */
    setCaptureMode: function (mode) { return call('setCaptureMode', { mode: mode }, 30000).then(remember); },
    /** Meta Mock Device Kit: { enabled, image?: base64 JPEG, power?: bool } */
    useMock: function (opts) { return call('useMock', opts || { enabled: true }, 45000).then(remember); },
    /** { output: 'glasses'|'phone', outputName, input: 'glasses'|'phone', glassesMicAvailable, mode } */
    audioRoute: function () { return call('audioRoute'); },
    /** Route the mic to the glasses (Bluetooth HFP; voice output drops to call quality) or the phone. */
    setMicRoute: function (route) { return call('setMicRoute', { route: route }); }
  });

  call('hello').then(remember).catch(function () {});
})();
