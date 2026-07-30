'use strict';
/**
 * Vosk, wrapped in the same shape as the other engines.
 *
 * Vosk is the odd one out and the interface reflects it: it is a genuinely
 * streaming recogniser, so it decides where utterances end and produces partial
 * hypotheses as a side effect of being fed audio, for free. The others are handed
 * a clip and return text. Rather than pretend both are the same thing, engines
 * declare which they are and the worker drives them differently.
 *
 * The other thing this preserves is Vosk's memory shape: one acoustic model is
 * shared by every recogniser, so toggling a speaker on costs a recogniser
 * (~12 MB), not another copy of the model.
 */

const { VoskModel, VoskRecognizer, getLibraryPath } = require('../vosk-binding');

const SAMPLE_RATE = 16000;

class VoskSession {
  constructor(model) {
    this.rec = new VoskRecognizer(model, SAMPLE_RATE);
  }

  /**
   * @param {Buffer} pcm 16 kHz mono 16-bit PCM
   * @returns {boolean} true when an utterance just ended
   */
  accept(pcm) {
    return this.rec.acceptWaveform(pcm);
  }

  /** Text of the utterance that `accept` just reported. */
  result() {
    return this.rec.result().text || '';
  }

  /** Current hypothesis. Cheap; safe to poll. */
  partial() {
    return this.rec.partialResult().partial || '';
  }

  /** Close the utterance early and return whatever was buffered. */
  finalize() {
    return this.rec.finalResult().text || '';
  }

  free() {
    this.rec.free();
  }
}

class VoskEngine {
  static get streaming() {
    return true;
  }

  /** @param {string} dir an installed model directory */
  static async load(dir) {
    return new VoskEngine(new VoskModel(dir));
  }

  constructor(model) {
    this.model = model;
    this.libraryPath = getLibraryPath();
  }

  createSession() {
    return new VoskSession(this.model);
  }

  close() {
    if (this.model) {
      this.model.free();
      this.model = null;
    }
  }
}

module.exports = { VoskEngine, VoskSession };
