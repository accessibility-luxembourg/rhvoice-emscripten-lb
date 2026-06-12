# RHVoice in the browser — Luxembourgish (Mil & Mia)

Proof of concept: the [RHVoice](https://github.com/RHVoice/RHVoice) speech
synthesizer compiled to **WebAssembly** with Emscripten, driving the
Luxembourgish voices **Mil** (male) and **Mia** (female), reading text from an
HTML page and playing it back through the **Web Audio API** — no server.

## How it works

- The C++ core is compiled with `emcc`. RHVoice's native audio backends are not
  built; instead `src/wrapper.cpp` subclasses RHVoice's `client` to capture the
  16-bit PCM the engine produces.
- `src/rhvoice-tts.js` is an **ES module** that imports the Emscripten factory,
  boots the module, fetches the language + voice data into the Emscripten
  filesystem **on demand** and caches it in **IndexedDB** (IDBFS), then converts
  the captured PCM to `Float32` and plays it via an `AudioBufferSourceNode` at
  24 kHz. (`dist/rhvoice.js` is itself built as an ES module via `EXPORT_ES6`.)
- **Download size:** data files are gzipped and inflated in the browser with the
  native `DecompressionStream` (works with any static host — no server config).
  Only what's needed is fetched: the language set once, plus each voice the first
  time it's used. A first run with one voice is **~6 MB** (vs ~47 MB raw); the
  language FSTs compress from ~29 MB to ~3 MB, each voice model is ~3–4 MB.
- `index.html` is the demo: pick Mil/Mia, then "Read this page" (reads the
  article text) or speak your own text — plain or **SSML** (e.g. `<break>`,
  prosody), via the "Treat as SSML" toggle.

## Use as a library

`src/rhvoice-tts.js` is an ES module with a small API. Serve `dist/`, `src/` and
`data/` (the layout this repo produces), then:

```js
import * as RHVoiceTTS from './src/rhvoice-tts.js';

await RHVoiceTTS.init();                      // boot + preload the default voice (mia)

button.addEventListener('click', () => {
  RHVoiceTTS.unlock();                        // MUST run synchronously in the gesture (iOS)
  RHVoiceTTS.speak('Moien!', 'mil', { rate: 1, pitch: 1, volume: 1 });
  // SSML is supported too:
  RHVoiceTTS.speak('<speak>Moien. <break time="1s"/> Äddi.</speak>', 'mia', { ssml: true });
});
```

API: `init(onProgress?, defaultVoice?)`, `speak(text, voice, opts?)` where `opts`
is `{ rate, pitch, volume, ssml, onProgress }` (resolves
`{samples, sampleRate, duration}`), `unlock()`, `audioInfo()`, `isReady()`. The
module imports `../dist/rhvoice.js` and resolves `../data/` relative to itself
(`import.meta.url`), so it works from any base path.

## Layout

| Path | What |
|------|------|
| `build.sh` | Emscripten build → `dist/rhvoice.js` + `dist/rhvoice.wasm` |
| `make-data.sh` | Stage + gzip the data tree and write `data/manifest.json` |
| `src/wrapper.cpp` | C ABI over the RHVoice C++ core (init / speak / read PCM) |
| `src/rhvoice-tts.js` | Module boot, on-demand data fetch+decompress+cache, `speak()`, Web Audio |
| `index.html` | Demo page |
| `data/` | Staged language + Mil/Mia voice packs (raw + `.gz`) and `manifest.json` (language + per-voice file lists) |
| `vendor/` | Cloned RHVoice + voice sources (git submodules of upstream) |
| `test/` | `node-synth.js` (headless synth → WAV), `browser-check.js` (Puppeteer) |

## Build from scratch

```sh
# 1. Fetch upstream sources (RHVoice + the two voices + Luxembourgish data +
#    RHVoice's bundled header-only Boost + sonic submodules)
bash vendor.sh

# 2. Stage + gzip the data tree and write data/manifest.json
bash make-data.sh

# 3. Build the wasm (needs emscripten / emcc on PATH)
bash build.sh
```

`build.sh` applies one small patch to the vendored core: RHVoice defines
`HTS_Audio_initialize()` with 3 args while the bundled hts_engine declares/calls
it with 1. C linkage tolerates this natively, but wasm's strict function
signatures trap — the patch makes the definition match the declaration.

## Run the demo

```sh
python3 -m http.server 8080
# open http://localhost:8080/
```

First load downloads ~6 MB (language + one voice, gzipped; cached in IndexedDB
afterwards). Click a voice and a button to hear it.

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds everything on a clean Ubuntu runner
(`vendor.sh` → `make-data.sh` → `build.sh`), assembles a `_site/` containing the
demo plus only the gzipped data files, and publishes it to GitHub Pages on every
push to `main`.

One-time setup: in the repository, **Settings → Pages → Build and deployment →
Source = GitHub Actions**. The site is then served at
`https://<user>.github.io/<repo>/`. All asset paths in the demo are relative, so
it works under that subpath unchanged.

The `vendor/` clones, `build/`, `dist/` and the raw `data/` files are
`.gitignore`d and rebuilt by CI, so the repository itself stays small.

## Verify without a browser

```sh
node test/node-synth.js      # writes test/out-mia.wav and test/out-mil.wav (24 kHz)
node test/browser-check.js   # Puppeteer: synth in-browser + IndexedDB cache check
```
