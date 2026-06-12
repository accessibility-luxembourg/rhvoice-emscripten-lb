/* RHVoice-in-the-browser: thin JS layer over the Emscripten module.
 *
 * Responsibilities:
 *   - boot the wasm module,
 *   - fetch the gzipped language + voice data on demand, inflate it client-side
 *     (DecompressionStream) into the Emscripten FS, and cache it in IndexedDB
 *     (IDBFS) so later loads are instant/offline,
 *   - drive synthesis and play the PCM through the Web Audio API.
 *
 * Only the data that is actually needed is fetched: the language set once, plus
 * each voice the first time it is used. Loaded as a classic script after
 * dist/rhvoice.js (which defines the global RHVoiceModule factory). Exposes a
 * global `RHVoiceTTS`.
 */
const RHVoiceTTS = (() => {
  const DATA_ROOT = '/rhvoice';     // mount point inside the Emscripten FS
  const DATA_URL_BASE = 'data';     // where the data files are served from
  const gzipOK = typeof DecompressionStream !== 'undefined';

  let Module = null;
  let manifest = null;
  let audioCtx = null;
  let booted = false;               // module up, FS mounted
  const loaded = new Set();         // resource keys present in the FS ("lang", "voice:mia"…)
  let engineVoices = '';            // which voices the live engine was built with

  const log = (...a) => console.log('[RHVoiceTTS]', ...a);
  const lastError = () => Module.ccall('rhv_last_error', 'string', [], []);

  function syncfs(populate) {
    return new Promise((res, rej) =>
      Module.FS.syncfs(populate, (e) => (e ? rej(e) : res())));
  }
  function exists(p) {
    try { Module.FS.stat(p); return true; } catch (e) { return false; }
  }

  // Fetch one file (gzipped when supported) and inflate it into memory.
  async function fetchFile(rel) {
    if (gzipOK) {
      const resp = await fetch(`${DATA_URL_BASE}/${rel}.gz`);
      if (!resp.ok) throw new Error(`fetch ${rel}.gz -> ${resp.status}`);
      const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const resp = await fetch(`${DATA_URL_BASE}/${rel}`);
    if (!resp.ok) throw new Error(`fetch ${rel} -> ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  // Download the manifest-relative files that aren't already in the FS (e.g.
  // restored from the IndexedDB cache). Progress fires only for real fetches.
  async function fetchInto(files, onProgress) {
    const missing = files.filter((rel) => !exists(`${DATA_ROOT}/${rel}`));
    let done = 0;
    for (const rel of missing) {
      const target = `${DATA_ROOT}/${rel}`;
      Module.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
      Module.FS.writeFile(target, await fetchFile(rel));
      if (onProgress) onProgress(++done, missing.length);
    }
    return missing.length;  // number of files actually downloaded
  }

  async function boot(report) {
    if (booted) return;
    report('Loading WebAssembly module…');
    Module = await RHVoiceModule();
    Module.FS.mkdirTree(DATA_ROOT);
    Module.FS.mount(Module.IDBFS, {}, DATA_ROOT);
    report('Restoring cached voice data…');
    await syncfs(true);
    manifest = await (await fetch(`${DATA_URL_BASE}/manifest.json`)).json();
    booted = true;
  }

  // Ensure the language + the requested voice are in the FS, and (re)build the
  // engine if the available voice set changed. `report(msg, frac?)` is optional.
  async function prepare(voice, report = () => {}) {
    await boot(report);
    if (!manifest.voices[voice]) throw new Error(`unknown voice: ${voice}`);

    let added = 0;
    if (!loaded.has('lang')) {
      added += await fetchInto(manifest.language,
        (d, t) => report(`Downloading language data… ${d}/${t}`, d / t));
      loaded.add('lang');
    }
    const vkey = `voice:${voice}`;
    if (!loaded.has(vkey)) {
      added += await fetchInto(manifest.voices[voice],
        (d, t) => report(`Downloading voice “${voice}”… ${d}/${t}`, d / t));
      loaded.add(vkey);
    }
    if (added > 0) {
      report('Saving to IndexedDB cache…');
      await syncfs(false);
    } else {
      report('Voice data served from cache.');
    }

    // The engine loads voices at construction, so re-init when the set grows.
    const voicesNow = [...loaded].filter((k) => k.startsWith('voice:')).sort().join(',');
    if (voicesNow !== engineVoices) {
      report('Initializing synthesizer…');
      const rc = Module.ccall('rhv_init', 'number', ['string', 'string'], [DATA_ROOT, '']);
      if (rc !== 0) throw new Error('rhv_init failed: ' + lastError());
      engineVoices = voicesNow;
      log('engine voices:', Module.ccall('rhv_voices', 'string', [], []));
    }
  }

  // Boot + load a default voice so the first click is fast.
  async function init(onProgress, defaultVoice = 'mia') {
    const report = (m, f) => { log(m); if (onProgress) onProgress(m, f); };
    await prepare(defaultVoice, report);
    report('Ready.');
  }

  // Synthesize and play. Resolves with {samples, sampleRate, duration} when done.
  async function speak(text, voice, opts = {}) {
    const report = (m, f) => { log(m); if (opts.onProgress) opts.onProgress(m, f); };
    await prepare(voice, report);   // fetches the voice on demand if new
    const { rate = 1.0, pitch = 1.0, volume = 1.0 } = opts;

    const n = Module.ccall('rhv_speak', 'number',
      ['string', 'string', 'number', 'number', 'number'], [text, voice, rate, pitch, volume]);
    if (n < 0) throw new Error('synthesis failed: ' + lastError());

    const ptr = Module.ccall('rhv_samples_ptr', 'number', [], []);
    const count = Module.ccall('rhv_sample_count', 'number', [], []);
    const sr = Module.ccall('rhv_sample_rate', 'number', [], []);
    if (count === 0) return { samples: 0, sampleRate: sr, duration: 0 };

    // Re-grab the heap view (memory may have grown) and copy Int16 -> Float32.
    const pcm = Module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + count);
    const f32 = new Float32Array(count);
    for (let i = 0; i < count; i++) f32[i] = pcm[i] / 32768;

    await play(f32, sr);
    return { samples: count, sampleRate: sr, duration: count / sr };
  }

  // iOS Safari only lets an AudioContext start/resume from within a user-gesture
  // handler. Synthesis is async, so by the time we play() the gesture is gone —
  // therefore the context MUST be created and resumed here, called synchronously
  // from the click/tap before any await. Playing a 1-sample silent buffer is the
  // canonical way to "unlock" audio on iOS. Safe and cheap to call on every tap.
  function unlock() {
    // Tell iOS this is media playback: use the media volume and ignore the
    // silent/mute switch. Without this, iOS Safari plays Web Audio through the
    // "ambient" session — audible to the tab (sound icon shows) but silenced by
    // the mute switch / low ringer volume, i.e. "plays but you hear nothing".
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback')
        navigator.audioSession.type = 'playback';
    } catch (e) { /* not supported — ignore */ }

    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    try {
      const b = audioCtx.createBuffer(1, 1, audioCtx.sampleRate || 22050);
      const s = audioCtx.createBufferSource();
      s.buffer = b;
      s.connect(audioCtx.destination);
      s.start(0);
    } catch (e) { /* already unlocked */ }
    return audioCtx;
  }

  function play(f32, sampleRate) {
    const ctx = unlock();              // context was unlocked on the tap; reuse it
    if (ctx.state === 'suspended') ctx.resume();
    const buffer = ctx.createBuffer(1, f32.length, sampleRate);
    buffer.getChannelData(0).set(f32);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      node.onended = finish;
      // iOS sometimes drops 'ended'; back it up with a timer.
      setTimeout(finish, (f32.length / sampleRate) * 1000 + 250);
      node.start();
    });
  }

  function audioInfo() {
    return {
      audioSession: (navigator.audioSession && navigator.audioSession.type) || 'unsupported',
      ctxState: audioCtx ? audioCtx.state : 'none',
      sampleRate: audioCtx ? audioCtx.sampleRate : 0,
    };
  }

  return { init, speak, unlock, audioInfo, isReady: () => booted && engineVoices !== '' };
})();

// Expose as a window global (a top-level `const` does not attach to window).
if (typeof window !== 'undefined') window.RHVoiceTTS = RHVoiceTTS;
