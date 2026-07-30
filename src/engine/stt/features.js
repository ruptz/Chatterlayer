'use strict';
/**
 * Whisper's log-mel front end, in plain JS.
 *
 * Whisper is the only engine here that needs features computed on our side:
 * Moonshine consumes raw samples, and the Parakeet package ships its own
 * feature extractor as an ONNX graph (nemo128.onnx). Whisper's ONNX export
 * starts at `input_features`, so this has to match what the model was trained
 * on exactly — the reference is `whisper.audio.log_mel_spectrogram`, whose
 * filterbank comes from `librosa.filters.mel(sr, n_fft, n_mels)`.
 */

const { Dft } = require('./fft');

/**
 * Hz to mel on the Slaney scale (librosa's default, htk=False): linear below
 * 1 kHz, logarithmic above it.
 */
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;

function hzToMel(hz) {
  return hz < MIN_LOG_HZ ? hz / F_SP : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
}

function melToHz(mel) {
  return mel < MIN_LOG_MEL ? F_SP * mel : MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL));
}

/**
 * Triangular mel filterbank with Slaney area normalisation.
 *
 * @returns {{filters: Float32Array, bins: number}} filters is nMels x bins,
 *   row-major, so filter m covers filters[m * bins .. m * bins + bins).
 */
function melFilterbank({ sampleRate = 16000, nFft = 400, nMels = 80, fMin = 0, fMax = null } = {}) {
  const top = fMax === null ? sampleRate / 2 : fMax;
  const bins = (nFft >> 1) + 1;

  const fftFreqs = new Float64Array(bins);
  for (let i = 0; i < bins; i++) fftFreqs[i] = (i * sampleRate) / nFft;

  // nMels + 2 band edges: each filter spans edge[m] .. edge[m+2], peaking at m+1.
  const edges = new Float64Array(nMels + 2);
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(top);
  for (let i = 0; i < nMels + 2; i++) {
    edges[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }

  const filters = new Float32Array(nMels * bins);
  for (let m = 0; m < nMels; m++) {
    const lo = edges[m];
    const mid = edges[m + 1];
    const hi = edges[m + 2];
    // Slaney normalisation: equal area per filter rather than equal peak, so
    // wide high-frequency filters don't dominate the output.
    const enorm = 2 / (hi - lo);
    for (let b = 0; b < bins; b++) {
      const f = fftFreqs[b];
      const rising = (f - lo) / (mid - lo);
      const falling = (hi - f) / (hi - mid);
      const w = Math.min(rising, falling);
      if (w > 0) filters[m * bins + b] = w * enorm;
    }
  }

  return { filters, bins };
}

class WhisperFeatures {
  /**
   * @param {object} [cfg] straight from the model's preprocessor_config.json
   */
  constructor({ sampleRate = 16000, nFft = 400, hopLength = 160, nMels = 80 } = {}) {
    this.sampleRate = sampleRate;
    this.nFft = nFft;
    this.hop = hopLength;
    this.nMels = nMels;

    // torch.hann_window defaults to periodic, not symmetric.
    this.window = new Float64Array(nFft);
    for (let i = 0; i < nFft; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
    }

    const { filters, bins } = melFilterbank({ sampleRate, nFft, nMels });
    this.filters = filters;
    this.bins = bins;

    this.dft = new Dft(nFft);
    this.frame = new Float64Array(nFft);
    this.power = new Float64Array(bins);
  }

  /**
   * @param {Float32Array} audio mono, nominally [-1, 1]
   * @param {number} nFrames how many frames the model wants (3000 for a
   *   30-second Whisper window). Frames past the end of `audio` are filled in
   *   rather than computed — see below.
   * @returns {Float32Array} nMels x nFrames, mel-major, ready for a
   *   [1, nMels, nFrames] `input_features` tensor.
   */
  compute(audio, nFrames) {
    const { nFft, hop, nMels, bins } = this;
    const half = nFft >> 1;
    const n = audio.length;
    const out = new Float32Array(nMels * nFrames);

    // Whisper zero-pads the audio to a full 30 s before the STFT, so every frame
    // whose window starts at or after the end of the real audio is a window of
    // pure zeros — an identical column we can fill in afterwards instead of
    // running thousands of redundant transforms. For a 4-second utterance that
    // is 400 frames of work instead of 3000.
    const real = Math.max(0, Math.min(nFrames, Math.ceil((n + half) / hop)));

    let gmax = -Infinity;
    for (let t = 0; t < real; t++) {
      const start = t * hop - half;
      for (let i = 0; i < nFft; i++) {
        let idx = start + i;
        if (idx < 0) idx = -idx; // torch.stft(center=True) reflects at the edges
        this.frame[i] = (idx < n ? audio[idx] : 0) * this.window[i];
      }
      this.dft.powerSpectrum(this.frame, this.power);

      for (let m = 0; m < nMels; m++) {
        const row = m * bins;
        let acc = 0;
        for (let b = 0; b < bins; b++) acc += this.filters[row + b] * this.power[b];
        const v = Math.log10(acc > 1e-10 ? acc : 1e-10);
        out[m * nFrames + t] = v;
        if (v > gmax) gmax = v;
      }
    }

    // Whisper clamps the dynamic range to 80 dB below the loudest bin in the
    // whole window, then maps roughly onto [-1, 1]. A zero frame sits at
    // log10(1e-10) = -10, so the floor is what the padding columns end up as.
    if (gmax === -Infinity) gmax = -10;
    const floor = Math.max(-10, gmax - 8);
    const pad = (floor + 4) / 4;

    for (let m = 0; m < nMels; m++) {
      const base = m * nFrames;
      for (let t = 0; t < real; t++) {
        const v = out[base + t];
        out[base + t] = ((v > floor ? v : floor) + 4) / 4;
      }
      for (let t = real; t < nFrames; t++) out[base + t] = pad;
    }

    return out;
  }
}

module.exports = { WhisperFeatures, melFilterbank, hzToMel, melToHz };
