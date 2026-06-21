import * as RHVoiceTTS from './src/rhvoice-tts.js';

const translations = {
    'en': {
        'play': 'Play',
        'pause': 'Pause',
        'download': 'Download', 
        'text': 'Text to read',
        'voice': 'Voice', 
        'rate': 'Rate',
        'resume': 'Resume'
    },
    'fr': {
        'play': 'Lecture',
        'pause': 'Pause',
        'download': 'Téléchargement', 
        'text': 'Texte à lire',
        'voice': 'Voix',
        'rate': 'Vitesse',
        'resume': 'Reprendre'
    }
}

function embed() {
    const lang = document.querySelector('html').getAttribute('lang') ?? 'en'
    function tr (str) { return (translations[lang][str] ?? str) }
    const tpl = `
    <style>
#srlb-text-sample {
    width: 100%;
    min-height: 5rem;
    padding: .5rem;
    box-sizing: border-box;
}
div.srlb-controls {
display: flex;
flex-wrap: wrap;
gap: .75rem;
align-items: center;
margin: 1rem 0;
}

    </style>
    <div class="srlb-demo-content">
        <label for="srlb-text-sample">${tr('text')}</label>
        <textarea id="srlb-text-sample" lang="lb">Schwätzt mat mir op Lëtzebuergesch!</textarea>
        <div class="srlb-controls">
            <label for="srlb-voice">${tr('voice')}:</label>
            <select id="srlb-voice">
                <option value="mil">Mil</option>
                <option value="mia">Mia</option>
            </select>
            <label for="srlb-rate">${tr('rate')}:</label>
            <input type="range" id="srlb-rate" min="0.5" max="2" step="0.1" value="1">
            <output id="srlb-rate-val">1.0×</output>
        </div>
        <div class="srlb-controls">
            <button id="srlb-play" data-status="idle">▶︎ ${tr('play')}</button>
            <button id="srlb-download">💾 ${tr('download')}</button>
        </div>
            <progress id="srlb-bar" value="0" max="1" hidden></progress>
    </div>
    `
    document.getElementById('srlb-demo').innerHTML = tpl;
    document.addEventListener('DOMContentLoaded', () => {
        window.RHVoiceTTS = RHVoiceTTS;  // expose for the console / automated tests

        const barEl = document.getElementById('srlb-bar');
        const playBtn = document.getElementById('srlb-play');
        const dlBtn = document.getElementById('srlb-download');
        const voiceSel = document.getElementById('srlb-voice');
        const rateEl = document.getElementById('srlb-rate');
        const rateVal = document.getElementById('srlb-rate-val');
        const rate = () => parseFloat(rateEl.value);
        rateEl.addEventListener('input', () => { rateVal.value = rate().toFixed(1) + '×'; });

        const setStatus = (msg, frac) => {
        console.log(msg);
        if (typeof frac === 'number') { barEl.hidden = false; barEl.value = frac; }
        else { barEl.hidden = true; }
        };

        let booted = false;
        async function ensureReady() {
        if (booted) return;
        try {
            await RHVoiceTTS.init(setStatus);
            booted = true;
            setStatus('Ready — pick a voice and press a button.');
        } catch (e) {
            setStatus('Error: ' + e.message);
            throw e;
        }
        }

        async function say(text, opts = {}) {
        try {
            await ensureReady();      // first click downloads data, inits engine
            setStatus(`Synthesizing with “${voiceSel.value}”…`);
            const r = await RHVoiceTTS.speak(text, voiceSel.value, opts);
            const a = RHVoiceTTS.audioInfo();
            setStatus(`Done — ${r.duration.toFixed(1)}s. ` +
            `audio: session=${a.audioSession}, ctx=${a.ctxState}, ${a.sampleRate}Hz`);
        } catch (e) {
            setStatus('Error: ' + e.message);
            playBtn.dataset.status = 'idle'
            playBtn.innerText = '▶︎ ' + tr('play')
        } finally {
            playBtn.dataset.status = 'idle'
            playBtn.innerText = '▶︎ ' + tr('play')
        }
        }

        async function downloadWav() {
        const text = document.getElementById('srlb-text-sample').value;
        dlBtn.disabled = true;
        try {
            await ensureReady();
            setStatus('Synthesizing for download…');
            const res = await RHVoiceTTS.synthesize(text, voiceSel.value,
            { ssml: false, rate: rate() });
            if (!res.samples) { setStatus('Nothing to synthesize.'); return; }
            const url = URL.createObjectURL(RHVoiceTTS.toWav(res));
            const a = document.createElement('a');
            a.href = url;
            a.download = `test-${voiceSel.value}.wav`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            setStatus(`Downloaded ${a.download} — ${res.duration.toFixed(1)}s.`);
        } catch (e) {
            setStatus('Error: ' + e.message);
        } finally {
            dlBtn.disabled = false;
        }
        }

        // Unlock audio synchronously on the tap (required by iOS Safari) BEFORE the
        // async download/synthesis work, then speak.
        playBtn.addEventListener('click', () => {
            if (playBtn.dataset.status === 'idle') {
                playBtn.dataset.status = 'playing'
                playBtn.innerText = '⏸ ' + tr('pause')
                console.log('playing')
                RHVoiceTTS.unlock();
                say(document.getElementById('srlb-text-sample').value, { ssml: false, rate: rate() });
            } else if (playBtn.dataset.status === 'playing' || playBtn.dataset.status === 'paused') {
                
                const state = RHVoiceTTS.togglePause(); 
                console.log(state, playBtn.dataset.status)
                playBtn.dataset.status = (state === 'paused' ? 'paused' : 'playing')
                playBtn.textContent = state === 'paused' ? '▶︎ '+tr('resume') : '⏸ '+tr('pause');
            } 
        });
        dlBtn.addEventListener('click', downloadWav);  // download needs no audio unlock

        // Pre-warm the module (download + init) so the first click is fast. Audio
        // playback still waits for the user gesture, satisfying autoplay rules.
        setStatus('Loading synthesizer… (first load downloads ~6 MB; cached afterwards)');
        ensureReady().catch(() => {});

    });
}

embed();