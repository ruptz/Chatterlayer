'use strict';
/**
 * Parakeet TDT 0.6B, on the ONNX Runtime.
 *
 * This is a transducer, not an encoder-decoder, so nothing in seq2seq.js applies.
 * A TDT ("token and duration transducer") joint network emits two things per
 * step: a token, and how many encoder frames to advance afterwards. Predicting
 * the skip is what makes it fast for its size — a typical utterance needs a
 * fraction of the joint evaluations an ordinary RNN-T would.
 *
 * The upstream package ships NeMo's own feature extractor as a small ONNX graph
 * (nemo128.onnx), which is used rather than reimplementing it: NeMo's mel front
 * end has per-feature normalisation, pre-emphasis and a log guard that all have
 * to match the training recipe exactly, and getting one of them subtly wrong
 * degrades accuracy in a way that is very hard to notice.
 *
 * The encoder is ~2.5 GB of float32 weights. It is loaded once and shared by
 * every speaker, so a second speaker costs an audio buffer rather than another
 * copy of the model — but see MAX_SPEAKERS in index.js for the CPU side of it.
 */

const fs = require('fs');
const path = require('path');

const { createSession, tensor, pickName, argmax } = require('./onnx');
const { loadDetokenizer } = require('./tokenizer');

/**
 * NeMo's cap on how many tokens may come out of a single encoder frame. Without
 * it a duration-0 prediction that keeps emitting would never advance.
 */
const MAX_SYMBOLS_PER_FRAME = 10;

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Declared element type of a graph input, e.g. 'int64'. */
function inputType(session, name, fallback) {
  const meta = (session.inputMetadata || []).find((m) => m.name === name);
  return (meta && meta.type) || fallback;
}

/** Declared shape of a graph input, with symbolic axes replaced by `sub`. */
function inputShape(session, name, fallback, sub = 1) {
  const meta = (session.inputMetadata || []).find((m) => m.name === name);
  if (!meta || !Array.isArray(meta.shape)) return fallback;
  return meta.shape.map((d) => (typeof d === 'number' && d > 0 ? d : sub));
}

class ParakeetEngine {
  static get streaming() {
    return false;
  }

  static async load(dir) {
    const config = readJson(path.join(dir, 'config.json'));

    // The features graph is named for its output width (128 mel bins). Accept
    // either spelling so an 80-bin package would work too.
    const featuresFile = ['nemo128.onnx', 'nemo80.onnx', 'preprocessor.onnx']
      .map((f) => path.join(dir, f))
      .find((f) => fs.existsSync(f));
    if (!featuresFile) {
      throw new Error(
        `No feature extractor found in "${dir}" (expected nemo128.onnx). ` +
          `Remove the model in the Speech model panel and download it again.`
      );
    }

    const pre = await createSession(featuresFile);
    const encoder = await createSession(path.join(dir, 'encoder-model.onnx'));
    const joint = await createSession(path.join(dir, 'decoder_joint-model.onnx'));

    return new ParakeetEngine({ dir, config, pre, encoder, joint });
  }

  constructor({ dir, config, pre, encoder, joint }) {
    this.dir = dir;
    this.pre = pre;
    this.encoder = encoder;
    this.joint = joint;
    this.detok = loadDetokenizer(dir);
    this.sampleRate = 16000;

    this.wavName = pickName(pre.inputNames, ['waveforms', 'audio_signal', 'input'], 'features input');
    this.wavLenName = pickName(
      pre.inputNames,
      ['waveforms_lens', 'length', 'input_length'],
      'features length input'
    );
    this.featName = pickName(pre.outputNames, ['features', 'outputs'], 'features output');
    this.featLenName = pickName(
      pre.outputNames,
      ['features_lens', 'encoded_lengths', 'length'],
      'features length output'
    );

    this.encInName = pickName(encoder.inputNames, ['audio_signal', 'features'], 'encoder input');
    this.encLenName = pickName(encoder.inputNames, ['length', 'audio_signal_length'], 'encoder length input');
    this.encOutName = pickName(encoder.outputNames, ['outputs', 'last_hidden_state'], 'encoder output');
    this.encLenOutName = pickName(
      encoder.outputNames,
      ['encoded_lengths', 'output_lengths'],
      'encoder length output'
    );
    this.encLenType = inputType(encoder, this.encLenName, 'int64');

    this.jointEncName = pickName(joint.inputNames, ['encoder_outputs'], 'joint encoder input');
    this.targetsName = pickName(joint.inputNames, ['targets'], 'joint target input');
    this.targetLenName = pickName(joint.inputNames, ['target_length'], 'joint target length input');
    this.targetsType = inputType(joint, this.targetsName, 'int32');
    this.stateNames = joint.inputNames.filter((n) => /^input_states_/.test(n)).sort();
    this.stateOutNames = joint.outputNames.filter((n) => /^output_states_/.test(n)).sort();
    this.jointOutName = pickName(joint.outputNames, ['outputs', 'logits'], 'joint output');
    if (!this.stateNames.length) {
      throw new Error('This Parakeet package has no prediction-network state inputs.');
    }
    this.stateShapes = this.stateNames.map((n) => inputShape(joint, n, [2, 1, 640]));

    // vocab.txt ends with <blk>; everything before it is a real token.
    this.vocabSize = this.detok.pieces.length;
    this.blankId = this.vocabSize - 1;
    this.featuresSize = config.features_size || 128;
    /** Filled in on the first decode from the joint's actual output width. */
    this.durations = null;
  }

  freshStates() {
    return this.stateNames.map((name, i) => {
      const dims = this.stateShapes[i];
      const count = dims.reduce((a, b) => a * b, 1);
      return { name, tensor: tensor('float32', new Float32Array(count), dims) };
    });
  }

  /**
   * @param {Float32Array} audio 16 kHz mono, nominally [-1, 1]
   * @returns {Promise<string>}
   */
  async transcribe(audio) {
    const features = await this.pre.run({
      [this.wavName]: tensor('float32', audio, [1, audio.length]),
      [this.wavLenName]: tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]),
    });

    const featLen = features[this.featLenName];
    const encoded = await this.encoder.run({
      [this.encInName]: features[this.featName],
      [this.encLenName]:
        this.encLenType === 'int32'
          ? tensor('int32', Int32Array.from([Number(featLen.data[0])]), [1])
          : featLen,
    });

    const enc = encoded[this.encOutName];
    // [1, dim, frames] — channel-major, so one frame is a stride apart.
    const dim = enc.dims[1];
    const frames = enc.dims[2];
    const total = Number(encoded[this.encLenOutName].data[0]) || frames;
    const usable = Math.min(total, frames);

    const tokens = await this.decode(enc.data, dim, frames, usable);
    return this.detok.decode(tokens).trim();
  }

  /**
   * Greedy TDT search.
   *
   * The prediction network is stateful, and its state may only advance when a
   * real token is emitted — a blank leaves it where it was. That is why the new
   * states are held aside and only committed on emission.
   */
  async decode(encData, dim, frames, usable) {
    const tokens = [];
    let states = this.freshStates();
    // NeMo's label embedding uses the blank id as its padding index, so feeding
    // the blank with zeroed states is exactly the start-of-sequence input.
    let previous = this.blankId;

    const frame = new Float32Array(dim);
    let t = 0;
    let emittedHere = 0;
    // Every iteration either advances t or increments emittedHere, and both are
    // bounded, but a belt-and-braces cap keeps a malformed graph from hanging
    // the worker thread.
    const ceiling = usable * MAX_SYMBOLS_PER_FRAME + 64;

    for (let iterations = 0; t < usable && iterations < ceiling; iterations++) {
      for (let c = 0; c < dim; c++) frame[c] = encData[c * frames + t];

      const feeds = {
        [this.jointEncName]: tensor('float32', frame, [1, dim, 1]),
        [this.targetsName]:
          this.targetsType === 'int64'
            ? tensor('int64', BigInt64Array.from([BigInt(previous)]), [1, 1])
            : tensor('int32', Int32Array.from([previous]), [1, 1]),
        [this.targetLenName]:
          this.targetsType === 'int64'
            ? tensor('int64', BigInt64Array.from([1n]), [1])
            : tensor('int32', Int32Array.from([1]), [1]),
      };
      for (const s of states) feeds[s.name] = s.tensor;

      const out = await this.joint.run(feeds);
      const logits = out[this.jointOutName].data;

      if (this.durations === null) {
        // The joint emits vocabulary logits followed by one logit per duration
        // the model was trained with — [0, 1, 2, ...] frames.
        const count = Math.max(1, logits.length - this.vocabSize);
        this.durations = Array.from({ length: count }, (_, i) => i);
      }

      const token = argmax(logits, 0, this.vocabSize);
      const durIndex = argmax(logits, this.vocabSize, logits.length);
      const skip = this.durations[durIndex] ?? 1;

      if (token !== this.blankId) {
        tokens.push(token);
        previous = token;
        states = this.stateOutNames.map((name, i) => ({
          name: this.stateNames[i],
          tensor: out[name],
        }));
        emittedHere++;
      }

      if (skip > 0) {
        t += skip;
        emittedHere = 0;
      } else if (token === this.blankId || emittedHere >= MAX_SYMBOLS_PER_FRAME) {
        // A blank with nowhere to go, or too many tokens off one frame.
        t += 1;
        emittedHere = 0;
      }
    }

    return tokens;
  }

  close() {
    this.pre = null;
    this.encoder = null;
    this.joint = null;
  }
}

module.exports = { ParakeetEngine };
