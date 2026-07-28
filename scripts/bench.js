'use strict';
/**
 * Measures the two numbers that decide how many speakers a machine can carry:
 * RAM per recognizer, and CPU needed to keep up with real time.
 *
 *   node scripts/bench.js [speakerCount]
 *
 * IMPORTANT — how to read the realtime factor:
 * The audio here is band-limited noise with speech-like modulation, NOT real
 * speech. The MEMORY numbers are exact (allocation doesn't care what the audio
 * says), but the SPEED number is optimistic: Vosk's silence detection prunes
 * low-energy noise aggressively, so it does less work than on real speech.
 * Treat the reported RTF as a floor. Real conversation on the small model
 * typically runs ~0.1-0.3x of a core per stream on a modern desktop CPU.
 */

const { VoskModel, VoskRecognizer } = require('../src/engine/vosk-binding');
const { resolveModelPath } = require('../src/shared/paths');

const SR = 16000;
const SECONDS = 8;
const speakerCount = Number(process.argv[2] || 7);

function rssMB() {
  // Encourage a collection so deltas reflect native allocations, not JS garbage.
  if (global.gc) global.gc();
  return process.memoryUsage().rss / 1048576;
}

/** Speech-like test signal: modulated, band-limited noise. */
function makeAudio(seconds) {
  const n = SR * seconds;
  const buf = Buffer.alloc(n * 2);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const noise = Math.random() * 2 - 1;
    lp = lp * 0.86 + noise * 0.14; // ~1.2 kHz low-pass, roughly voice-band
    // syllable-rate envelope (~4 Hz) with pauses, like connected speech
    const env = Math.max(0, Math.sin((2 * Math.PI * 4 * i) / SR)) *
      (0.6 + 0.4 * Math.sin((2 * Math.PI * 0.4 * i) / SR));
    let v = lp * env * 11000;
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    buf.writeInt16LE(v | 0, i * 2);
  }
  return buf;
}

function main() {
  const modelPath = resolveModelPath();
  console.log('Chatterlayer benchmark');
  console.log('======================');
  console.log(`model    : ${modelPath}`);
  console.log(`node     : ${process.version}  platform: ${process.platform}-${process.arch}\n`);

  const baseline = rssMB();

  const t0 = Date.now();
  const model = new VoskModel(modelPath);
  const modelLoadMs = Date.now() - t0;
  const afterModel = rssMB();

  console.log(`model load time      : ${modelLoadMs} ms`);
  console.log(`RSS baseline         : ${baseline.toFixed(0)} MB`);
  console.log(`RSS after model      : ${afterModel.toFixed(0)} MB  ` +
    `(model cost ~${(afterModel - baseline).toFixed(0)} MB, shared by all speakers)\n`);

  // ---- per-recognizer memory ------------------------------------------
  console.log('Per-speaker recognizer cost');
  console.log('---------------------------');
  const recs = [];
  const audio = makeAudio(SECONDS);
  let prev = afterModel;

  for (let i = 1; i <= speakerCount; i++) {
    const rec = new VoskRecognizer(model, SR);
    // A recognizer allocates its decoding lattice lazily, so push a little
    // audio through before measuring or the cost reads as ~0.
    for (let o = 0; o < SR * 2 * 2; o += 640) {
      rec.acceptWaveform(audio.subarray(o, o + 640));
    }
    recs.push(rec);
    const now = rssMB();
    console.log(
      `  ${String(i).padStart(2)} speaker(s): RSS ${now.toFixed(0).padStart(4)} MB ` +
        `(+${(now - prev).toFixed(1)} MB for this one)`
    );
    prev = now;
  }

  const totalPerSpeaker = (prev - afterModel) / speakerCount;
  console.log(`\n  average per speaker : ~${totalPerSpeaker.toFixed(1)} MB`);
  console.log(`  total for ${speakerCount} speakers: ~${prev.toFixed(0)} MB RSS\n`);

  // ---- decode throughput ----------------------------------------------
  console.log('Decode speed (single stream, conservative/noise input)');
  console.log('-----------------------------------------------------');
  const rec = recs[0];
  const start = Date.now();
  for (let o = 0; o < audio.length; o += 640) {
    rec.acceptWaveform(audio.subarray(o, Math.min(o + 640, audio.length)));
  }
  rec.finalResult();
  const elapsed = Date.now() - start;
  const rtf = elapsed / (SECONDS * 1000);

  console.log(`  ${SECONDS}s of audio decoded in ${elapsed} ms`);
  console.log(`  realtime factor      : ${rtf.toFixed(3)}x of one CPU core`);
  console.log(
    `  est. cores for ${speakerCount} simultaneous talkers: ${(rtf * speakerCount).toFixed(2)}\n`
  );
  // Real speech costs several times more than this synthetic signal, so scale
  // the estimate off the MEASURED figure rather than a fixed range — a range
  // calibrated on the small model badly understates the large ones.
  const lo = rtf * 3;
  const hi = rtf * 10;
  console.log(
    '  NOTE: synthetic audio understates real cost (see header comment).\n' +
      `  Real speech typically lands 3-10x higher: ~${lo.toFixed(2)}-${hi.toFixed(2)}x per stream,\n` +
      `  i.e. roughly ${(lo * speakerCount).toFixed(1)}-${(hi * speakerCount).toFixed(1)} cores if all ` +
      `${speakerCount} talk at once.\n` +
      '  Discord sends no packets during silence, so that peak is rare.\n' +
      `  This machine has ${require('os').cpus().length} logical cores.`
  );

  for (const r of recs) r.free();
  model.free();
}

main();
