// Headless verification: synthesize Luxembourgish with Mil and Mia in Node,
// using the real ./data directory mounted via NODEFS. Writes WAV files so the
// output can be inspected. Proves the wasm pipeline works end to end.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

function writeWav(file, int16, sampleRate) {
  const dataLen = int16.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}

(async () => {
  // dist/rhvoice.js is now an ES module — load it via dynamic import.
  const RHVoiceModule = (await import(
    pathToFileURL(path.resolve(__dirname, '..', 'dist', 'rhvoice.js')).href
  )).default;
  const Module = await RHVoiceModule();
  const dataDir = path.resolve(__dirname, '..', 'data');

  Module.FS.mkdirTree('/rhvoice');
  Module.FS.mount(Module.FS.filesystems.NODEFS, { root: dataDir }, '/rhvoice');

  const rc = Module.ccall('rhv_init', 'number', ['string', 'string'], ['/rhvoice', '']);
  if (rc !== 0) throw new Error('rhv_init failed: ' + Module.ccall('rhv_last_error', 'string', [], []));

  console.log('Available voices:', Module.ccall('rhv_voices', 'string', [], []));

  const text = 'Moien! Dëst ass en Test vun der Lëtzebuerger Sprooch mat RHVoice.';
  for (const voice of ['mia', 'mil']) {
    const n = Module.ccall('rhv_speak', 'number',
      ['string', 'string', 'number', 'number', 'number'], [text, voice, 1, 1, 1]);
    if (n < 0) throw new Error(`rhv_speak(${voice}) failed: ` + Module.ccall('rhv_last_error', 'string', [], []));
    const ptr = Module.ccall('rhv_samples_ptr', 'number', [], []);
    const count = Module.ccall('rhv_sample_count', 'number', [], []);
    const sr = Module.ccall('rhv_sample_rate', 'number', [], []);
    const pcm = Module.HEAP16.slice(ptr >> 1, (ptr >> 1) + count);
    const out = path.resolve(__dirname, `out-${voice}.wav`);
    writeWav(out, pcm, sr);
    console.log(`${voice}: ${count} samples @ ${sr} Hz -> ${out} (${(count / sr).toFixed(2)}s)`);
  }
  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
