// Measure the streaming win on long text: time-to-first-audio and peak PCM
// memory, buffered (synthesize everything, then play) vs streaming (play each
// phrase chunk as it's synthesized). Total synthesis work is the same either
// way — the difference is *when* audio can start and how much PCM is held.
const path = require('path');
const { pathToFileURL } = require('url');

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

(async () => {
  const RHVoiceModule = (await import(
    pathToFileURL(path.resolve(__dirname, '..', 'dist', 'rhvoice.js')).href)).default;
  const { chunkText } = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'src', 'rhvoice-tts.js')).href);

  const Module = await RHVoiceModule();
  Module.FS.mkdirTree('/rhvoice');
  Module.FS.mount(Module.FS.filesystems.NODEFS, { root: path.resolve(__dirname, '..', 'data') }, '/rhvoice');
  if (Module.ccall('rhv_init', 'number', ['string', 'string'], ['/rhvoice', '']) !== 0)
    throw new Error(Module.ccall('rhv_last_error', 'string', [], []));

  // Synthesize one string; return {samples, ms}.
  const synth = (text) => {
    const t = now();
    const n = Module.ccall('rhv_speak', 'number',
      ['string', 'string', 'number', 'number', 'number', 'number'], [text, 'mia', 1, 1, 1, 0]);
    if (n < 0) throw new Error(Module.ccall('rhv_last_error', 'string', [], []));
    return { samples: Module.ccall('rhv_sample_count', 'number', [], []), ms: now() - t };
  };

  const sentence = 'Lëtzebuerg ass e klengt Land am Häerz vun Europa. ';
  synth(sentence);  // warm up (first call pays JIT/codegen) so timings are fair

  for (const reps of [1, 10, 40]) {
    const text = sentence.repeat(reps);
    const chunks = chunkText(text);

    // Buffered: audio can only start after the WHOLE text is synthesized.
    const whole = synth(text);

    // Streaming: audio starts after the first chunk; rest synthesizes meanwhile.
    let first = null, total = 0, maxChunkSamples = 0;
    const tStart = now();
    for (const c of chunks) {
      const r = synth(c);
      if (first === null) first = now() - tStart;   // time-to-first-audio (streaming)
      total += r.samples;
      maxChunkSamples = Math.max(maxChunkSamples, r.samples);
    }
    const allMs = now() - tStart;

    const audioSec = (total / 24000).toFixed(1);
    console.log(`\n${text.length} chars, ${chunks.length} chunk(s), ~${audioSec}s of audio:`);
    console.log(`  time-to-first-audio:  buffered ${whole.ms.toFixed(0)} ms  ->  streaming ${first.toFixed(0)} ms` +
      `  (${(whole.ms / first).toFixed(1)}x sooner)`);
    console.log(`  total synth time:     buffered ${whole.ms.toFixed(0)} ms  vs  streaming ${allMs.toFixed(0)} ms  (~equal: same work)`);
    console.log(`  peak PCM held:        buffered ${(whole.samples * 2 / 1048576).toFixed(2)} MB  vs  streaming ${(maxChunkSamples * 2 / 1048576).toFixed(2)} MB (one chunk)`);
  }
  console.log('\nOK');
})().catch((e) => { console.error(e); process.exit(1); });
