'use strict';
/**
 * The engine registry.
 *
 * Everything above this line — the worker, the Discord side, the caption server,
 * the overlay — deals in `{ userId, text, isFinal }` and never learns which
 * engine produced it. This file is the whole of what knows the difference.
 *
 * Adding an engine means: a module here exposing `static streaming` and
 * `static load(dir)`, an entry in ENGINES, and a catalogue entry in
 * src/shared/models.js. Nothing else in the app changes.
 */

/** Loaded on demand: requiring an engine pulls in its runtime. */
const LOADERS = {
  vosk: () => require('./vosk').VoskEngine,
  whisper: () => require('./whisper').WhisperEngine,
  moonshine: () => require('./moonshine').MoonshineEngine,
  parakeet: () => require('./parakeet').ParakeetEngine,
};

/**
 * Per-engine behaviour the worker needs to know about.
 *
 * `partialCost` is what matters most for a call with several speakers. Vosk
 * produces a partial hypothesis as a side effect of decoding, so asking for one
 * is free. The others have to run the model again over the audio so far, which is
 * a real decode — and for Whisper that decode costs the same whether the
 * utterance is one second or twenty, because its encoder input is a fixed
 * 30-second window that gets zero-padded. Moonshine and Parakeet scale with the
 * length of the clip, so an early partial is cheap and a late one is not.
 */
const ENGINES = {
  vosk: {
    label: 'Vosk',
    streaming: true,
    partialCost: 'free',
  },
  whisper: {
    label: 'Whisper',
    streaming: false,
    partialCost: 'fixed-window',
  },
  moonshine: {
    label: 'Moonshine',
    streaming: false,
    partialCost: 'proportional',
  },
  parakeet: {
    label: 'Parakeet',
    streaming: false,
    partialCost: 'proportional',
  },
};

function describeEngine(name) {
  return ENGINES[name] || null;
}

/**
 * @param {{engine: string, path: string}} model as resolved by shared/paths.js
 * @returns {Promise<object>} an engine instance
 */
async function loadEngine(model) {
  const loader = LOADERS[model.engine];
  if (!loader) {
    throw new Error(
      `Unknown speech engine "${model.engine}". Known engines: ${Object.keys(LOADERS).join(', ')}.`
    );
  }
  const Engine = loader();
  return Engine.load(model.path);
}

module.exports = { ENGINES, LOADERS, describeEngine, loadEngine };
