'use strict';
/**
 * Verifies libvosk loads through the koffi binding and actually transcribes.
 * Feeds a WAV through in small chunks, the way live Discord audio arrives.
 *
 *   node scripts/test-vosk.js [path/to/16k-mono.wav]
 *
 * Vosk-specific by design — it exercises the FFI binding directly rather than
 * going through the worker. For any engine, use `npm run test:stt` instead.
 */

const fs = require('fs');
const path = require('path');
const { VoskModel, VoskRecognizer, getLibraryPath } = require('../src/engine/vosk-binding');
const { listModels } = require('../src/shared/paths');

/**
 * The best installed *Vosk* model. Not `resolveModelPath()`, which now answers
 * with the best model of any engine — and handing a Parakeet directory to
 * libvosk is not a useful error message.
 */
function resolveVoskModel() {
  const vosk = listModels().filter((m) => m.engine === 'vosk');
  if (!vosk.length) {
    console.error(
      'No Vosk model installed. Run "npm run setup" for one, or use ' +
        '"npm run test:stt" to test whatever engine you do have.'
    );
    process.exit(1);
  }
  return vosk[0].path;
}

/** Minimal RIFF/WAVE parser: returns { sampleRate, channels, bits, data }. */
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('WAV missing fmt or data chunk');
  return { ...fmt, data };
}

async function main() {
  const wavPath = process.argv[2] || path.join(__dirname, '..', 'test-audio.wav');
  if (!fs.existsSync(wavPath)) {
    console.error(`No test WAV at ${wavPath}. Pass one as an argument.`);
    process.exit(1);
  }

  const modelPath = resolveVoskModel();
  console.log('model   :', modelPath);

  const t0 = Date.now();
  const model = new VoskModel(modelPath);
  console.log(`model loaded in ${Date.now() - t0} ms`);
  console.log('library :', getLibraryPath());

  const wav = parseWav(fs.readFileSync(wavPath));
  console.log(`wav     : ${wav.sampleRate} Hz, ${wav.channels} ch, ${wav.bits}-bit, ` +
    `${(wav.data.length / (wav.sampleRate * wav.channels * (wav.bits / 8))).toFixed(2)} s`);

  if (wav.sampleRate !== 16000 || wav.channels !== 1 || wav.bits !== 16) {
    console.error('Test expects 16 kHz mono 16-bit PCM.');
    process.exit(1);
  }

  const rec = new VoskRecognizer(model, 16000);

  // Feed in 20 ms chunks (640 bytes) to mimic live streaming.
  const CHUNK = 640;
  const finals = [];
  const decodeStart = Date.now();
  for (let i = 0; i < wav.data.length; i += CHUNK) {
    const chunk = wav.data.subarray(i, Math.min(i + CHUNK, wav.data.length));
    if (rec.acceptWaveform(chunk)) {
      const r = rec.result();
      if (r.text) finals.push(r.text);
    }
  }
  const tail = rec.finalResult();
  if (tail.text) finals.push(tail.text);
  const decodeMs = Date.now() - decodeStart;

  const audioMs = (wav.data.length / 2 / 16000) * 1000;
  console.log(`decoded in ${decodeMs} ms for ${audioMs.toFixed(0)} ms of audio ` +
    `(realtime factor ${(decodeMs / audioMs).toFixed(3)}x)`);
  console.log('\nTRANSCRIPT:', finals.join(' ') || '(empty)');

  rec.free();
  model.free();

  if (!finals.join(' ').trim()) {
    console.error('\nFAIL: recognizer produced no text.');
    process.exit(1);
  }
  console.log('\nPASS: Vosk binding works.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
