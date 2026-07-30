'use strict';
/**
 * Moonshine, on the ONNX Runtime.
 *
 * Moonshine has no separate feature extractor: its encoder takes raw 16 kHz
 * samples and does the downsampling with convolutions, so there is no mel
 * spectrogram to compute here. More importantly for live captioning, it has no
 * fixed input window either — cost is proportional to the length of the
 * utterance rather than padded out to a constant 30 seconds the way Whisper's
 * is. That is what makes it the best of these three for frequent partials.
 *
 * The float32 exports are used as-is: at ~247 MB the whole model is smaller than
 * a quantised Whisper small, so there is nothing to gain by degrading it.
 */

const fs = require('fs');
const path = require('path');

const { createSession, tensor, pickName, countLayers } = require('./onnx');
const { Seq2SeqGreedy } = require('./seq2seq');
const { loadDetokenizer } = require('./tokenizer');

/**
 * The encoder's convolution stack strides by 384 in total, so a very short clip
 * reduces to zero frames and the graph fails rather than returning nothing.
 * Half a second is comfortably clear of that.
 */
const MIN_SAMPLES = 8000;

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class MoonshineEngine {
  static get streaming() {
    return false;
  }

  static async load(dir) {
    const config = readJson(path.join(dir, 'config.json'));
    const gen = readJson(path.join(dir, 'generation_config.json'));
    const pre = readJson(path.join(dir, 'preprocessor_config.json'));

    const encoder = await createSession(path.join(dir, 'encoder_model.onnx'));
    const decoder = await createSession(path.join(dir, 'decoder_model_merged.onnx'));

    return new MoonshineEngine({ dir, config, gen, pre, encoder, decoder });
  }

  constructor({ dir, config, gen, pre, encoder, decoder }) {
    this.dir = dir;
    this.encoder = encoder;
    this.decoder = decoder;
    this.detok = loadDetokenizer(dir);
    this.sampleRate = pre.sampling_rate || 16000;

    this.inputName = pickName(
      encoder.inputNames,
      ['input_values', 'input_features', 'audio'],
      'encoder input'
    );
    this.hiddenName = pickName(
      encoder.outputNames,
      ['last_hidden_state', 'encoder_hidden_states', 'output'],
      'encoder output'
    );

    const heads =
      config.decoder_num_key_value_heads || config.num_key_value_heads || 8;
    const attnHeads =
      config.decoder_num_attention_heads || config.num_attention_heads || heads;
    const hidden = config.hidden_size || 416;
    this.greedy = new Seq2SeqGreedy({
      decoder,
      layers: countLayers(decoder.inputNames) || config.decoder_num_hidden_layers || 8,
      kvHeads: heads,
      headDim: Math.round(hidden / attnHeads),
    });

    this.startIds = [gen.decoder_start_token_id ?? config.decoder_start_token_id ?? 1];
    this.eosId = gen.eos_token_id ?? config.eos_token_id ?? 2;
    // Upstream's own guidance is that Moonshine produces on the order of six
    // tokens per second of speech; the ceiling stops a loop from running away.
    this.tokensPerSecond = 6;
    this.maxTokens = Math.min(config.max_position_embeddings || 512, 256);
  }

  /**
   * @param {Float32Array} audio 16 kHz mono, nominally [-1, 1]
   * @returns {Promise<string>}
   */
  async transcribe(audio) {
    let clip = audio;
    if (clip.length < MIN_SAMPLES) {
      const padded = new Float32Array(MIN_SAMPLES);
      padded.set(clip);
      clip = padded;
    }

    const encoded = await this.encoder.run({
      [this.inputName]: tensor('float32', clip, [1, clip.length]),
    });

    const seconds = clip.length / this.sampleRate;
    const budget = Math.min(
      this.maxTokens,
      Math.ceil(seconds * this.tokensPerSecond) + 8
    );

    const ids = await this.greedy.generate({
      encoderHidden: encoded[this.hiddenName],
      startIds: this.startIds,
      eosId: this.eosId,
      maxNewTokens: Math.max(1, budget),
    });

    return this.detok.decode(ids).trim();
  }

  close() {
    this.encoder = null;
    this.decoder = null;
    this.greedy = null;
  }
}

module.exports = { MoonshineEngine };
