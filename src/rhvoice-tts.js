/* RHVoice in the browser — an ES module wrapping the Emscripten build.
 *
 * Usage:
 *   import * as RHVoiceTTS from './rhvoice-tts.js';
 *   await RHVoiceTTS.init();                 // boot + load default voice
 *   button.onclick = () => {                 // inside a user gesture (iOS):
 *     RHVoiceTTS.unlock();                   //   unlock audio synchronously
 *     RHVoiceTTS.speak('Moien!', 'mia');     //   then synthesize + play
 *   };
 *
 * What it does:
 *   - boots the wasm module,
 *   - fetches the gzipped language + voice data on demand, inflates it
 *     client-side (DecompressionStream) into the Emscripten FS, and caches it in
 *     IndexedDB (IDBFS) so later loads are instant/offline,
 *   - drives synthesis and plays the PCM through the Web Audio API.
 *
 * Only what's needed is fetched: the language set once, plus each voice the
 * first time it is used.
 */
import RHVoiceModule from '../dist/rhvoice.js';

const DATA_ROOT = '/rhvoice';     // mount point inside the Emscripten FS
const DATA_URL_BASE = new URL('../data/', import.meta.url).href;  // resolve relative to this module
const gzipOK = typeof DecompressionStream !== 'undefined';

let Module = null;
let manifest = null;
let audioCtx = null;
let booted = false;               // module up, FS mounted
const loaded = new Set();         // resource keys present in the FS ("lang", "voice:mia"…)
let engineVoices = '';            // which voices the live engine was built with

const TARGET_RATE = 24000;        // the voices' sample rate; we run the context at it

// AudioWorklet processor: a simple PCM queue. Chunks (Float32, at the context
// rate) are posted in via the port; process() drains them sample-by-sample so
// playback starts as soon as the first chunk arrives and continues gaplessly
// while later chunks are still being synthesized. Posted as a Blob (no extra
// file to deploy, no path issues). Assumes context rate === source rate.
const WORKLET_SRC = `
class PCMStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; this.cur = null; this.pos = 0;
    this.ended = false; this.done = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'pcm') this.queue.push(d.samples);
      else if (d.type === 'end') this.ended = true;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (!this.cur || this.pos >= this.cur.length) {
        if (this.queue.length === 0) {
          while (i < out.length) out[i++] = 0;            // silence on underrun/end
          if (this.ended && !this.done) { this.done = true; this.port.postMessage('drained'); return false; }
          return true;
        }
        this.cur = this.queue.shift(); this.pos = 0;
      }
      out[i++] = this.cur[this.pos++];
    }
    return true;
  }
}
registerProcessor('pcm-stream', PCMStreamProcessor);
`;
let workletURL = null;
let workletAdded = false;

// Split text into synthesis chunks at phrase endings (. ! ? ; : … and newlines),
// accumulating up to ~maxChars so each chunk is a sensible unit. A boundary-free
// run longer than maxChars is split on whitespace as a last resort. Lets long
// texts start playing after the first phrase instead of after the whole thing.
export function chunkText(text, maxChars = 250) {
  const parts = String(text).match(/\s*[^.!?;:\n…]+[.!?;:\n…]*/g) || [];
  const out = [];
  let cur = '';
  const flush = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  for (const part of parts) {
    if (cur && (cur.length + part.length) > maxChars) flush();
    if (part.length > maxChars) {
      for (const w of part.split(/(\s+)/)) {
        if (cur && (cur.length + w.length) > maxChars) flush();
        cur += w;
      }
    } else {
      cur += part;
    }
  }
  flush();
  if (out.length === 0) { const t = String(text).trim(); if (t) out.push(t); }
  return out;
}

const log = (...a) => console.log('[RHVoiceTTS]', ...a);
const lastError = () => Module.ccall('rhv_last_error', 'string', [], []);

function syncfs(populate) {
  return new Promise((res, rej) =>
    Module.FS.syncfs(populate, (e) => (e ? rej(e) : res())));
}
function fsExists(p) {
  try { Module.FS.stat(p); return true; } catch (e) { return false; }
}

// Fetch one file (gzipped when supported) and inflate it into memory.
async function fetchFile(rel) {
  if (gzipOK) {
    const resp = await fetch(`${DATA_URL_BASE}${rel}.gz`);
    if (!resp.ok) throw new Error(`fetch ${rel}.gz -> ${resp.status}`);
    const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const resp = await fetch(`${DATA_URL_BASE}${rel}`);
  if (!resp.ok) throw new Error(`fetch ${rel} -> ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Download the manifest-relative files that aren't already in the FS (e.g.
// restored from the IndexedDB cache). Progress fires only for real fetches.
async function fetchInto(files, onProgress) {
  const missing = files.filter((rel) => !fsExists(`${DATA_ROOT}/${rel}`));
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
  manifest = await (await fetch(`${DATA_URL_BASE}manifest.json`)).json();
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
export async function init(onProgress, defaultVoice = 'mia') {
  const report = (m, f) => { log(m); if (onProgress) onProgress(m, f); };
  await prepare(defaultVoice, report);
  report('Ready.');
}

const i16ToF32 = (pcm) => {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return f;
};

// Synthesize one chunk (single wasm call). Internal — returns Int16 PCM.
async function synthChunk(text, voice, opts, report) {
  await prepare(voice, report);   // fetches the voice on demand if new
  const { rate = 1.0, pitch = 1.0, volume = 1.0, ssml = false } = opts;
  const n = Module.ccall('rhv_speak', 'number',
    ['string', 'string', 'number', 'number', 'number', 'number'],
    [text, voice, rate, pitch, volume, ssml ? 1 : 0]);
  if (n < 0) throw new Error('synthesis failed: ' + lastError());
  const ptr = Module.ccall('rhv_samples_ptr', 'number', [], []);
  const count = Module.ccall('rhv_sample_count', 'number', [], []);
  const sr = Module.ccall('rhv_sample_rate', 'number', [], []);
  // .slice() copies out of the wasm heap so the data survives the next call.
  return { pcm: Module.HEAP16.slice(ptr >> 1, (ptr >> 1) + count), sampleRate: sr, samples: count };
}

// Synthesize to one 16-bit PCM buffer WITHOUT playing — long text is chunked at
// phrase endings and concatenated. Resolves {pcm: Int16Array, sampleRate,
// samples, duration}. Used for downloads and the buffered playback fallback.
// opts: { rate, pitch, volume } multipliers, ssml (bool), onProgress(msg, frac?).
export async function synthesize(text, voice, opts = {}) {
  const report = (m, f) => { log(m); if (opts.onProgress) opts.onProgress(m, f); };
  const chunks = opts.ssml ? [text] : chunkText(text);
  const parts = [];
  let sampleRate = TARGET_RATE, total = 0;
  for (const c of chunks) {
    const r = await synthChunk(c, voice, opts, report);
    sampleRate = r.sampleRate;
    if (r.samples) { parts.push(r.pcm); total += r.samples; }
    await Promise.resolve();      // yield to keep the UI responsive on long texts
  }
  const pcm = new Int16Array(total);
  let off = 0;
  for (const p of parts) { pcm.set(p, off); off += p.length; }
  return { pcm, sampleRate, samples: total, duration: total / sampleRate };
}

// Synthesize and play. For long texts this streams: each phrase chunk is fed to
// an AudioWorklet as soon as it's synthesized, so audio starts after the first
// phrase and plays gaplessly while the rest is synthesized. Falls back to
// buffered playback when AudioWorklet isn't available or the context rate can't
// match the voice. Resolves {samples, sampleRate, duration}.
export async function speak(text, voice, opts = {}) {
  const ctx = unlock();           // create/resume context (must run in the gesture on iOS)
  const canStream = ctx && ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined'
                    && ctx.sampleRate === TARGET_RATE;
  if (canStream) return speakStream(ctx, text, voice, opts);

  // Buffered fallback: synthesize everything, then play one resampled buffer.
  const { pcm, sampleRate, samples, duration } = await synthesize(text, voice, opts);
  if (samples === 0) return { samples: 0, sampleRate, duration: 0 };
  await play(i16ToF32(pcm), sampleRate);
  return { samples, sampleRate, duration };
}

async function ensureWorklet(ctx) {
  if (workletAdded) return;
  if (!workletURL)
    workletURL = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(workletURL);
  workletAdded = true;
}

async function speakStream(ctx, text, voice, opts) {
  const report = (m, f) => { log(m); if (opts.onProgress) opts.onProgress(m, f); };
  await ensureWorklet(ctx);
  const chunks = opts.ssml ? [text] : chunkText(text);

  const node = new AudioWorkletNode(ctx, 'pcm-stream',
    { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(ctx.destination);

  let total = 0;
  for (const c of chunks) {
    const r = await synthChunk(c, voice, opts, report);
    if (r.samples) {
      const f32 = i16ToF32(r.pcm);
      node.port.postMessage({ type: 'pcm', samples: f32 }, [f32.buffer]);  // transfer, no copy
      total += r.samples;
    }
    await Promise.resolve();      // let the synthesized chunk start playing
  }
  node.port.postMessage({ type: 'end' });

  // Resolve when the worklet drains; back it up with a timer (headless/no-device
  // contexts may not pump the audio thread).
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    node.port.onmessage = (e) => { if (e.data === 'drained') finish(); };
    setTimeout(finish, (total / TARGET_RATE) * 1000 + 500);
  });
  node.disconnect();
  return { samples: total, sampleRate: TARGET_RATE, duration: total / TARGET_RATE };
}

// Wrap PCM (as returned by synthesize) in a 16-bit mono WAV Blob (audio/wav),
// ready for a download link or an <audio> src.
export function toWav({ pcm, sampleRate }) {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);   // PCM
  dv.setUint16(22, 1, true);                                                // mono
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);  // little-endian
  return new Blob([buf], { type: 'audio/wav' });
}

// iOS Safari only lets an AudioContext start/resume from within a user-gesture
// handler. Synthesis is async, so by the time we play() the gesture is gone —
// therefore the context MUST be created and resumed here, called synchronously
// from the click/tap before any await. Playing a 1-sample silent buffer is the
// canonical way to "unlock" audio on iOS. Safe and cheap to call on every tap.
export function unlock() {
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
    // Run the context at the voices' rate so streamed chunks need no resampling
    // and buffered playback matches too. Fall back if the option isn't honored.
    try { audioCtx = new Ctx({ sampleRate: TARGET_RATE }); }
    catch (e) { audioCtx = new Ctx(); }
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

export function audioInfo() {
  return {
    audioSession: (navigator.audioSession && navigator.audioSession.type) || 'unsupported',
    ctxState: audioCtx ? audioCtx.state : 'none',
    sampleRate: audioCtx ? audioCtx.sampleRate : 0,
  };
}

export const isReady = () => booted && engineVoices !== '';

export default { init, synthesize, speak, toWav, chunkText, unlock, audioInfo, isReady };
