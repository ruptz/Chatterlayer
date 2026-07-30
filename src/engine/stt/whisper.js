'use strict';
/**
 * Whisper, on the ONNX Runtime.
 *
 * The catalogue installs the int8-quantised exports rather than float32. That is
 * a deliberate trade for this app: on a CPU shared with a game and OBS the
 * quantised graphs decode roughly two to three times faster for a fraction of a
 * percent of word error rate, and they download at a third of the size. The
 * float32 exports are in the same upstream repositories if anyone wants to swap
 * them in by hand — nothing here depends on which one is on disk.
 *
 * Worth knowing about Whisper specifically: its encoder input is a fixed
 * 30-second window, zero-padded. A one-second utterance therefore costs exactly
 * as much to encode as a twenty-second one, which is why the segmenter treats
 * Whisper's partial results as more expensive than Moonshine's.
 */

const fs = require('fs');
const path = require('path');

const { createSession, tensor, pickName, countLayers } = require('./onnx');
const { WhisperFeatures } = require('./features');
const { Seq2SeqGreedy } = require('./seq2seq');
const { loadDetokenizer } = require('./tokenizer');

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class WhisperEngine {
  static get streaming() {
    return false;
  }

  /** @param {string} dir an installed model directory */
  static async load(dir) {
    const config = readJson(path.join(dir, 'config.json'));
    const gen = readJson(path.join(dir, 'generation_config.json'));
    const pre = readJson(path.join(dir, 'preprocessor_config.json'));

    // No memory arena. Whisper's fixed 30-second window makes its activations
    // large enough that the arena roughly doubles resident memory — 3.6 GB rather
    // than 1.8 GB for Whisper Small — to save about a third of the decode time.
    // At those absolute numbers the memory matters more: a machine that starts
    // swapping loses the whole stream, not just the captions. See onnx.js.
    const options = { arena: false };
    const encoder = await createSession(path.join(dir, 'encoder_model.onnx'), options);
    const decoder = await createSession(path.join(dir, 'decoder_model_merged.onnx'), options);

    return new WhisperEngine({ dir, config, gen, pre, encoder, decoder });
  }

  constructor({ dir, config, gen, pre, encoder, decoder }) {
    this.dir = dir;
    this.encoder = encoder;
    this.decoder = decoder;
    this.detok = loadDetokenizer(dir);

    this.inputName = pickName(encoder.inputNames, ['input_features'], 'encoder input');
    this.hiddenName = pickName(
      encoder.outputNames,
      ['last_hidden_state', 'encoder_hidden_states', 'output'],
      'encoder output'
    );

    this.nMels = pre.feature_size || config.num_mel_bins || 80;
    this.frames = pre.nb_max_frames || (config.max_source_positions || 1500) * 2;
    this.samples = pre.n_samples || 480000;
    this.sampleRate = pre.sampling_rate || 16000;
    this.windowSeconds = this.samples / this.sampleRate;

    this.features = new WhisperFeatures({
      sampleRate: this.sampleRate,
      nFft: pre.n_fft || 400,
      hopLength: pre.hop_length || 160,
      nMels: this.nMels,
    });

    const heads =
      config.decoder_num_key_value_heads || config.decoder_attention_heads || 6;
    const attnHeads = config.decoder_attention_heads || heads;
    const hidden = config.d_model || config.hidden_size || 384;
    this.greedy = new Seq2SeqGreedy({
      decoder,
      layers: countLayers(decoder.inputNames) || config.decoder_layers || 4,
      kvHeads: heads,
      headDim: Math.round(hidden / attnHeads),
    });

    this.eosId = gen.eos_token_id ?? config.eos_token_id ?? 50256;
    this.maxLength = gen.max_length || config.max_length || 448;

    // decoder_start_token_id, then whatever generation_config pins to which
    // position: for an English-only model that is <|notimestamps|> at index 1,
    // for a multilingual one it is the language and task tokens as well.
    const start = [gen.decoder_start_token_id ?? config.decoder_start_token_id ?? 50257];
    const forced = gen.forced_decoder_ids || config.forced_decoder_ids || [];
    for (const [position, id] of [...forced].sort((a, b) => a[0] - b[0])) {
      start[position] = id;
    }
    this.startIds = start.filter((id) => id !== undefined);

    this.suppress = new Set([
      ...(gen.suppress_tokens || config.suppress_tokens || []),
    ]);
    // Timestamps are forced off, so the timestamp block is dead vocabulary. If
    // the model emitted one anyway it would land in the caption as raw text.
    const noTimestamps = gen.no_timestamps_token_id;
    if (Number.isInteger(noTimestamps)) {
      const vocab = config.vocab_size || 51864;
      for (let id = noTimestamps + 1; id < vocab; id++) this.suppress.add(id);
    }
    this.beginSuppress = new Set(
      gen.begin_suppress_tokens || config.begin_suppress_tokens || []
    );
  }

  /**
   * @param {Float32Array} audio 16 kHz mono, nominally [-1, 1]
   * @returns {Promise<string>}
   */
  async transcribe(audio) {
    // The window is fixed; anything past 30 s is not encodable in one pass and
    // the segmenter is configured never to hand us that much.
    const clip = audio.length > this.samples ? audio.subarray(0, this.samples) : audio;

    const mel = this.features.compute(clip, this.frames);
    const encoded = await this.encoder.run({
      [this.inputName]: tensor('float32', mel, [1, this.nMels, this.frames]),
    });

    const seconds = clip.length / this.sampleRate;
    const budget = Math.min(
      this.maxLength - this.startIds.length,
      Math.ceil(seconds * 8) + 8
    );

    const ids = await this.greedy.generate({
      encoderHidden: encoded[this.hiddenName],
      startIds: this.startIds,
      eosId: this.eosId,
      maxNewTokens: Math.max(1, budget),
      suppress: this.suppress,
      beginSuppress: this.beginSuppress,
    });

    return this.detok.decode(ids).trim();
  }

  close() {
    // onnxruntime-node frees the native session when the JS handle goes; there is
    // no explicit release in the API. Dropping the references is the release.
    this.encoder = null;
    this.decoder = null;
    this.greedy = null;
  }
}

module.exports = { WhisperEngine };
