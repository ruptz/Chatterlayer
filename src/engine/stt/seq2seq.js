'use strict';
/**
 * Greedy decoding for the two encoder-decoder engines.
 *
 * Whisper and Moonshine are different models with different front ends, but
 * their ONNX exports present the identical decoder contract — `input_ids`,
 * `encoder_hidden_states`, a `past_key_values.N.{decoder,encoder}.{key,value}`
 * cache and a `use_cache_branch` switch — so the token loop is written once here
 * and both engines hand it an encoder output and a start sequence.
 *
 * Greedy rather than beam search: a beam costs N times the compute for an
 * accuracy gain nobody watching live captions would notice, and the whole point
 * of the queue in onnx.js is that compute is the scarce resource.
 */

const { tensor, boolTensor, i64, argmax } = require('./onnx');

/**
 * Both models can fall into a repeating tail — Whisper notoriously so on noise
 * or a clipped word. Left alone it burns the entire token budget and emits a
 * caption of the same phrase eight times, so stop as soon as the tail is clearly
 * a cycle.
 */
function looksLooped(tokens) {
  const n = tokens.length;
  if (n < 8) return false;
  for (let period = 1; period <= 6; period++) {
    if (n < period * 3) break;
    let cyclic = true;
    for (let i = 0; i < period * 2 && cyclic; i++) {
      if (tokens[n - 1 - i] !== tokens[n - 1 - i - period]) cyclic = false;
    }
    if (cyclic) return true;
  }
  return false;
}

class Seq2SeqGreedy {
  /**
   * @param {object} spec
   * @param {import('onnxruntime-node').InferenceSession} spec.decoder
   * @param {number} spec.layers decoder layer count
   * @param {number} spec.kvHeads key/value heads per layer
   * @param {number} spec.headDim size of one head
   */
  constructor({ decoder, layers, kvHeads, headDim }) {
    this.decoder = decoder;
    this.layers = layers;
    this.kvHeads = kvHeads;
    this.headDim = headDim;
  }

  /** Zero-length cache entries for the first pass, where nothing is cached yet. */
  emptyCache() {
    const feeds = {};
    const dims = [1, this.kvHeads, 0, this.headDim];
    for (let i = 0; i < this.layers; i++) {
      for (const side of ['decoder', 'encoder']) {
        for (const kind of ['key', 'value']) {
          feeds[`past_key_values.${i}.${side}.${kind}`] = tensor(
            'float32',
            new Float32Array(0),
            dims
          );
        }
      }
    }
    return feeds;
  }

  /**
   * @param {object} opts
   * @param {object} opts.encoderHidden the encoder's output tensor, reused as-is
   * @param {number[]} opts.startIds tokens to prime the decoder with
   * @param {number} opts.eosId
   * @param {number} opts.maxNewTokens
   * @param {Set<number>} [opts.suppress] never emitted, at any position
   * @param {Set<number>} [opts.beginSuppress] never emitted as the first token
   * @returns {Promise<number[]>} generated ids, without the start sequence or EOS
   */
  async generate({
    encoderHidden,
    startIds,
    eosId,
    maxNewTokens,
    suppress = null,
    beginSuppress = null,
  }) {
    let feeds = {
      input_ids: tensor('int64', i64(startIds), [1, startIds.length]),
      encoder_hidden_states: encoderHidden,
      use_cache_branch: boolTensor(false),
      ...this.emptyCache(),
    };

    const generated = [];
    let cache = null;

    for (let step = 0; step < maxNewTokens; step++) {
      const out = await this.decoder.run(feeds);

      const logits = out.logits;
      const vocab = logits.dims[logits.dims.length - 1];
      const positions = logits.data.length / vocab;
      // Only the last position matters: on the priming pass the decoder scores
      // every start token, and all but the final one are already known.
      const from = (positions - 1) * vocab;

      let blocked = suppress;
      if (step === 0 && beginSuppress) {
        blocked = new Set([...(suppress || []), ...beginSuppress]);
      }
      const token = argmax(logits.data, from, from + vocab, blocked);

      if (token === eosId) break;
      generated.push(token);
      if (looksLooped(generated)) {
        generated.length = Math.max(0, generated.length - 2);
        break;
      }

      // The cross-attention cache is a function of the encoder output alone, so
      // it is computed on the first pass and then carried forward unchanged —
      // recomputing it every token would roughly double the decode cost.
      const next = {};
      for (const name of Object.keys(out)) {
        if (!name.startsWith('present')) continue;
        const as = name.replace('present', 'past_key_values');
        next[as] = cache && name.includes('.encoder.') ? cache[as] : out[name];
      }
      cache = next;

      feeds = {
        input_ids: tensor('int64', i64([token]), [1, 1]),
        encoder_hidden_states: encoderHidden,
        use_cache_branch: boolTensor(true),
        ...cache,
      };
    }

    return generated;
  }
}

module.exports = { Seq2SeqGreedy, looksLooped };
