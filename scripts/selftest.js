'use strict';
/**
 * Checks that need no Discord token, no network and no speech model, so they
 * can run on every push. Covers the things that have actually broken: rate
 * conversion, colour collisions, the model catalogue, renderer wiring.
 *
 *   npm run selftest
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

// --- audio ---------------------------------------------------------------

const { Resampler48kStereoTo16kMono } = require('../src/engine/resample');

function makeStereo48k(freq, seconds) {
  const frames = 48000 * seconds;
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * 8000);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

function resampleChunked(input) {
  const r = new Resampler48kStereoTo16kMono();
  const out = [];
  // 3840 bytes = one 20 ms Discord frame of 48 kHz stereo.
  for (let o = 0; o < input.length; o += 3840) {
    out.push(r.process(input.subarray(o, Math.min(o + 3840, input.length))));
  }
  return Buffer.concat(out);
}

function peak(pcm, skipSamples = 0) {
  let max = 0;
  for (let i = skipSamples * 2; i < pcm.length; i += 2) {
    max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  }
  return max;
}

console.log('\naudio');

test('48k stereo -> 16k mono produces exactly 16000 samples/sec (no drift)', () => {
  const out = resampleChunked(makeStereo48k(1000, 1));
  assert.strictEqual(out.length / 2, 16000, `got ${out.length / 2} samples`);
});

test('passband (1 kHz) survives with roughly unity gain', () => {
  const out = resampleChunked(makeStereo48k(1000, 1));
  const gain = peak(out) / 8000;
  assert.ok(gain > 0.9 && gain < 1.1, `gain ${gain.toFixed(3)}`);
});

test('15 kHz is rejected, not aliased into the speech band', () => {
  const out = resampleChunked(makeStereo48k(15000, 1));
  // Skip the filter warm-up before measuring.
  const db = 20 * Math.log10((peak(out, 100) || 1) / 8000);
  assert.ok(db < -40, `alias rejection only ${db.toFixed(1)} dB`);
});

test('resampler handles an empty chunk without throwing', () => {
  const r = new Resampler48kStereoTo16kMono();
  assert.strictEqual(r.process(Buffer.alloc(0)).length, 0);
});

// --- colours -------------------------------------------------------------

const { assignColors, colorForUser, PALETTE } = require('../src/shared/colors');

const randomId = () => String(100000000000000000n + BigInt(Math.floor(Math.random() * 1e15)));

console.log('\nspeaker colours');

test('no two speakers in a call share a colour (up to palette size)', () => {
  for (const size of [2, 4, 7, 12, PALETTE.length]) {
    for (let trial = 0; trial < 400; trial++) {
      const group = Array.from({ length: size }, randomId);
      const assigned = assignColors(group, {});
      assert.strictEqual(
        new Set(assigned.values()).size,
        size,
        `duplicate colour in a call of ${size}`
      );
    }
  }
});

test('assignment is independent of member order', () => {
  const group = Array.from({ length: 7 }, randomId);
  const a = assignColors(group, {});
  const b = assignColors([...group].reverse(), {});
  for (const id of group) assert.strictEqual(a.get(id), b.get(id));
});

test('manual colour overrides win and are not reused', () => {
  const group = Array.from({ length: 5 }, randomId);
  const assigned = assignColors(group, { [group[0]]: '#FF6B6B' });
  assert.strictEqual(assigned.get(group[0]), '#FF6B6B');
  assert.strictEqual([...assigned.values()].filter((c) => c === '#FF6B6B').length, 1);
});

test('more speakers than colours still assigns everyone', () => {
  const group = Array.from({ length: PALETTE.length + 4 }, randomId);
  assert.strictEqual(assignColors(group, {}).size, group.length);
});

test('per-user colour is stable across runs', () => {
  const id = randomId();
  assert.strictEqual(colorForUser(id), colorForUser(id));
});

// --- model catalogue -----------------------------------------------------

const { MODEL_CATALOG, findModel } = require('../src/shared/models');
const { MODEL_RANK, MODEL_LABELS } = require('../src/shared/paths');

console.log('\nspeech models');

test('every catalogue entry is complete and well formed', () => {
  for (const m of MODEL_CATALOG) {
    for (const field of ['key', 'dir', 'url', 'label', 'downloadMB', 'ramMB', 'blurb']) {
      assert.ok(m[field], `${m.key || '?'} is missing "${field}"`);
    }
    assert.ok(m.url.startsWith('https://'), `${m.key} url must be https`);
    assert.ok(m.url.endsWith('.zip'), `${m.key} url must be a .zip`);
    assert.ok(m.dir.startsWith('vosk-model'), `${m.key} dir looks wrong`);
  }
});

test('exactly one model is marked recommended', () => {
  const rec = MODEL_CATALOG.filter((m) => m.recommended);
  assert.strictEqual(rec.length, 1, `found ${rec.length}`);
});

test('the recommended model is the medium one', () => {
  assert.strictEqual(MODEL_CATALOG.find((m) => m.recommended).dir, 'vosk-model-en-us-0.22-lgraph');
});

test('catalogue keys and aliases all resolve', () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(findModel(m.key), `key ${m.key}`);
    for (const alias of m.aliases || []) assert.ok(findModel(alias), `alias ${alias}`);
  }
});

test('every catalogue model appears in the ranking and has a label', () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(MODEL_RANK.includes(m.dir), `${m.dir} missing from MODEL_RANK`);
    assert.ok(MODEL_LABELS[m.dir], `${m.dir} missing a label`);
  }
});

// --- renderer wiring -----------------------------------------------------

console.log('\nrenderer');

test('every element id the renderer looks up exists in the HTML', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !ids.has(id));
  assert.strictEqual(missing.length, 0, `renderer references missing ids: ${missing.join(', ')}`);
});

test('copy buttons point at elements that exist', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8'
  );
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, target] of html.matchAll(/data-copy="([^"]+)"/g)) {
    assert.ok(ids.has(target), `data-copy="${target}" has no matching element`);
  }
});

test('all source files parse', () => {
  const { execFileSync } = require('child_process');
  const roots = ['src', 'scripts'];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) files.push(p);
    }
  };
  for (const r of roots) walk(path.join(__dirname, '..', r));
  for (const f of files) execFileSync(process.execPath, ['--check', f]);
  assert.ok(files.length > 8, `only found ${files.length} source files`);
});

// --- word filter ---------------------------------------------------------

const { buildFilter, maskText } = require('../src/shared/wordfilter');

console.log('\nword filter');

const filter = buildFilter();
const mask = (s) => maskText(s, filter).text;

test('masks a slur mid-sentence', () => {
  const out = mask('what a chink of light');
  assert.ok(!out.includes('chink'), out);
  assert.ok(out.includes('*****'), out);
});

test('preserves surrounding words and spacing', () => {
  assert.strictEqual(mask('you are a wop mate'), 'you are a *** mate');
});

test('masks plurals of listed terms', () => {
  assert.ok(!mask('two spics').includes('spics'));
});

test('masks multi-word slurs across adjacent words', () => {
  const out = mask('called him a porch monkey today');
  assert.ok(!out.includes('porch monkey'), out);
  assert.ok(out.startsWith('called him a ***** ******'), out);
});

test('does NOT mask innocent words containing a slur substring', () => {
  // The Scunthorpe problem. "niggardly" is unrelated in origin; the others
  // simply contain shorter sequences. Substring matching would break all four.
  for (const phrase of [
    'he was niggardly with praise',
    'that is a classic album',
    'the assassin escaped',
    'i need to analyse this',
  ]) {
    assert.strictEqual(mask(phrase), phrase, `wrongly masked: ${phrase}`);
  }
});

test('leaves ordinary speech untouched', () => {
  const line = 'okay so the plan is we push through the second gate first';
  assert.strictEqual(mask(line), line);
});

test('custom terms are masked, including phrases', () => {
  const custom = buildFilter({ custom: ['bannedword', 'two words'] });
  assert.strictEqual(maskText('a bannedword here', custom).text, 'a ********** here');
  assert.strictEqual(maskText('say two words now', custom).text, 'say *** ***** now');
});

test('disabling the filter passes text through unchanged', () => {
  const off = buildFilter({ enabled: false });
  const line = 'this contains a chink';
  assert.strictEqual(maskText(line, off).text, line);
});

test('reports how many words were masked', () => {
  assert.strictEqual(maskText('a chink and a gook', filter).masked, 2);
  assert.strictEqual(maskText('nothing to see', filter).masked, 0);
});

test('handles empty and malformed input', () => {
  assert.strictEqual(maskText('', filter).text, '');
  assert.strictEqual(maskText(null, filter).text, '');
  assert.strictEqual(maskText('   ', filter).text, '   ');
});

test('filter is on by default in the shipped config', () => {
  const { DEFAULTS } = require('../src/main/config');
  assert.strictEqual(DEFAULTS.filter.enabled, true);
});

// --- CI workflows --------------------------------------------------------

console.log('\nworkflows');

// js-yaml arrives via electron-builder rather than directly, so treat it as
// optional — a missing dev dependency shouldn't fail the suite.
let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  /* skipped below */
}

const workflowDir = path.join(__dirname, '..', '.github', 'workflows');

test('workflow and builder YAML parses', () => {
  if (!yaml) {
    console.log('        (skipped — js-yaml not installed)');
    return;
  }
  const files = [
    ...fs.readdirSync(workflowDir).map((f) => path.join(workflowDir, f)),
    path.join(__dirname, '..', 'electron-builder.yml'),
  ];
  for (const file of files) {
    try {
      assert.ok(yaml.load(fs.readFileSync(file, 'utf8')), `${path.basename(file)} is empty`);
    } catch (err) {
      throw new Error(`${path.basename(file)}: ${err.message}`);
    }
  }
});

test('release job passes tag_name explicitly', () => {
  // Without this the action falls back to github.ref, which is a branch ref on
  // a manual run and fails with "Missing tag_name parameter".
  const release = fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8');
  assert.ok(/tag_name:\s*\$\{\{/.test(release), 'release.yml must set tag_name');
});

test('workflows do not pin a deprecated Node version', () => {
  for (const name of fs.readdirSync(workflowDir)) {
    const text = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    for (const [, version] of text.matchAll(/node-version:\s*'?(\d+)/g)) {
      assert.ok(Number(version) >= 22, `${name} pins Node ${version}; use 22 or newer`);
    }
  }
});

// --- result --------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
