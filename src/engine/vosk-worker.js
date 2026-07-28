'use strict';
/**
 * Decoding is CPU-bound and synchronous across the FFI boundary. On the same
 * thread as the voice connection it would block the event loop mid-decode and
 * drop inbound UDP packets, so it lives here instead.
 *
 * One acoustic model is shared by every recognizer: toggling a speaker on costs
 * a recognizer (~12 MB), not another copy of the model.
 */

const { parentPort, workerData } = require('worker_threads');
const { VoskModel, VoskRecognizer, getLibraryPath } = require('./vosk-binding');

const SAMPLE_RATE = 16000;
/** Don't spam the UI/WebSocket with partial updates faster than this. */
const PARTIAL_THROTTLE_MS = 120;

let model = null;
/** userId -> { rec, lastPartial, lastPartialAt } */
const speakers = new Map();

function post(msg, transfer) {
  parentPort.postMessage(msg, transfer);
}

function init(modelPath) {
  try {
    const t0 = Date.now();
    model = new VoskModel(modelPath);
    post({
      type: 'ready',
      modelPath,
      libraryPath: getLibraryPath(),
      loadMs: Date.now() - t0,
      rss: process.memoryUsage().rss,
    });
  } catch (err) {
    post({ type: 'fatal', message: err.message });
  }
}

function addSpeaker(userId) {
  if (!model || speakers.has(userId)) return;
  try {
    const rec = new VoskRecognizer(model, SAMPLE_RATE);
    speakers.set(userId, { rec, lastPartial: '', lastPartialAt: 0 });
    post({ type: 'speakerAdded', userId, rss: process.memoryUsage().rss });
  } catch (err) {
    post({ type: 'error', userId, message: `recognizer init failed: ${err.message}` });
  }
}

function removeSpeaker(userId) {
  const s = speakers.get(userId);
  if (!s) return;
  // Emit anything still buffered so the last words aren't lost on toggle-off.
  try {
    const tail = s.rec.finalResult();
    if (tail.text) post({ type: 'final', userId, text: tail.text });
  } catch {
    /* recognizer may already be in a bad state; nothing useful to do */
  }
  s.rec.free();
  speakers.delete(userId);
  post({ type: 'speakerRemoved', userId, rss: process.memoryUsage().rss });
}

/** @param {string} userId @param {ArrayBuffer} arrayBuf 16k mono 16-bit PCM */
function pushAudio(userId, arrayBuf) {
  const s = speakers.get(userId);
  if (!s) return; // speaker was toggled off mid-flight; drop it
  const pcm = Buffer.from(arrayBuf);
  try {
    if (s.rec.acceptWaveform(pcm)) {
      const { text } = s.rec.result();
      s.lastPartial = '';
      if (text) post({ type: 'final', userId, text });
    } else {
      const now = Date.now();
      if (now - s.lastPartialAt >= PARTIAL_THROTTLE_MS) {
        const { partial } = s.rec.partialResult();
        s.lastPartialAt = now;
        if (partial && partial !== s.lastPartial) {
          s.lastPartial = partial;
          post({ type: 'partial', userId, text: partial });
        }
      }
    }
  } catch (err) {
    post({ type: 'error', userId, message: `decode failed: ${err.message}` });
  }
}

/** Called when Discord reports the speaker went quiet — closes the utterance. */
function flush(userId) {
  const s = speakers.get(userId);
  if (!s) return;
  try {
    const { text } = s.rec.finalResult();
    s.lastPartial = '';
    if (text) post({ type: 'final', userId, text });
    else post({ type: 'partialCleared', userId });
  } catch (err) {
    post({ type: 'error', userId, message: `flush failed: ${err.message}` });
  }
}

function shutdown() {
  for (const userId of [...speakers.keys()]) {
    const s = speakers.get(userId);
    try {
      s.rec.free();
    } catch {
      /* shutting down anyway */
    }
    speakers.delete(userId);
  }
  if (model) {
    model.free();
    model = null;
  }
  post({ type: 'closed' });
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'add':
      return addSpeaker(msg.userId);
    case 'remove':
      return removeSpeaker(msg.userId);
    case 'audio':
      return pushAudio(msg.userId, msg.buf);
    case 'flush':
      return flush(msg.userId);
    case 'stats':
      return post({
        type: 'stats',
        rss: process.memoryUsage().rss,
        speakers: speakers.size,
      });
    case 'shutdown':
      return shutdown();
    default:
      return undefined;
  }
});

init(workerData.modelPath);
