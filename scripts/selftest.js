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

/** Same, for a test that has to await. Results print after the sync ones. */
const pending = [];
function testAsync(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          console.log(`  PASS  ${name}`);
          passed++;
        },
        (err) => {
          console.error(`  FAIL  ${name}\n        ${err.message}`);
          failed++;
        }
      )
  );
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

// --- channel picker ------------------------------------------------------

const { ChannelType, PermissionsBitField } = require('discord.js');
const { ChatterlayerEngine } = require('../src/engine/engine');

console.log('\nchannel picker');

const F = PermissionsBitField.Flags;
const BOT = { id: 'bot-1', tag: 'Chatterlayer#0001' };

/** `granted: null` stands in for "the bot's own member isn't cached". */
function fakeChannel({ name = 'general', granted = [F.ViewChannel, F.Connect], ...rest } = {}) {
  return {
    id: `c-${name}`,
    name,
    type: ChannelType.GuildVoice,
    rawPosition: 0,
    userLimit: 0,
    members: { size: 0 },
    permissionsFor: () =>
      granted === null ? null : { has: (flag) => granted.includes(flag) },
    ...rest,
  };
}

const picker = new ChatterlayerEngine(() => {});
const describe = (ch) => picker.describeChannel(ch, BOT);

test('a channel the bot can see and connect to is joinable', () => {
  const c = describe(fakeChannel());
  assert.strictEqual(c.canJoin, true);
  assert.strictEqual(c.reason, '');
});

test('missing Connect is reported, and names the permission', () => {
  const c = describe(fakeChannel({ granted: [F.ViewChannel] }));
  assert.strictEqual(c.canJoin, false);
  assert.ok(/Connect/.test(c.reason), c.reason);
  assert.ok(!/View Channel/.test(c.reason), c.reason);
});

test('missing both permissions names both', () => {
  const c = describe(fakeChannel({ granted: [] }));
  assert.strictEqual(c.canJoin, false);
  assert.ok(/View Channel/.test(c.reason) && /Connect/.test(c.reason), c.reason);
});

test('uncached bot member reads as unknown, never as "cannot join"', () => {
  // A false negative here would grey out a channel that actually works, which
  // is worse than showing no verdict at all.
  const c = describe(fakeChannel({ granted: null }));
  assert.strictEqual(c.canJoin, null);
  assert.strictEqual(c.reason, '');
});

test('stage channels are flagged so the audience trap is visible', () => {
  const c = describe(fakeChannel({ type: ChannelType.GuildStageVoice }));
  assert.strictEqual(c.stage, true);
  // Still joinable — it just will not hear anything until promoted.
  assert.strictEqual(c.canJoin, true);
});

test('a channel at its user limit is flagged as full', () => {
  const c = describe(fakeChannel({ userLimit: 2, members: { size: 2 } }));
  assert.strictEqual(c.full, true);
});

test('user limit does not apply to a bot that can move members', () => {
  const c = describe(
    fakeChannel({
      userLimit: 2,
      members: { size: 2 },
      granted: [F.ViewChannel, F.Connect, F.MoveMembers],
    })
  );
  assert.strictEqual(c.full, false);
});

test('the guild tree lists voice channels only, and drops empty servers', () => {
  const guild = (name, channels) => [name, { id: `g-${name}`, name, channels: { cache: new Map(channels.map((c, i) => [i, c])) } }];
  const engine = new ChatterlayerEngine(() => {});
  engine.client = {
    isReady: () => true,
    user: BOT,
    guilds: {
      cache: new Map([
        guild('Zebra', [fakeChannel({ name: 'voice' })]),
        guild('Alpha', [
          fakeChannel({ name: 'talk' }),
          fakeChannel({ name: 'rules', type: ChannelType.GuildText }),
        ]),
        guild('Textonly', [fakeChannel({ name: 'chat', type: ChannelType.GuildText })]),
      ].map(([, g]) => [g.id, g])),
    },
  };

  let payload = null;
  engine.emit = (msg) => {
    if (msg.type === 'guilds') payload = msg;
  };
  engine.emitGuilds();

  assert.ok(payload, 'no guilds event emitted');
  assert.deepStrictEqual(
    payload.guilds.map((g) => g.name),
    ['Alpha', 'Zebra'],
    'servers should be sorted by name, with text-only servers dropped'
  );
  assert.deepStrictEqual(payload.guilds[0].channels.map((c) => c.name), ['talk']);
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

test('masks a term the recogniser split into separate words', () => {
  // Vosk decides where the word boundaries go, and it is not consistent about
  // it. Every one of these is a single entry in DEFAULT_TERMS.
  for (const [line, expected] of [
    ['called him a zipper head', 'called him a ****** ****'],
    ['what a towel head', 'what a ***** ****'],
    ['he is a pick a ninny', 'he is a **** * *****'],
    ['a rag head remark', 'a *** **** remark'],
  ]) {
    assert.strictEqual(mask(line), expected);
  }
});

test('masks a phrase the recogniser ran together, and its plural', () => {
  assert.strictEqual(mask('a porchmonkey'), 'a ***********');
  assert.strictEqual(mask('two porch monkeys'), 'two ***** *******');
});

test('does not crash when text ends on the start of a longer term', () => {
  // Partial results arrive a word at a time, so "porch" is emitted on its own
  // before "porch monkey" is ever complete. This used to read past the end of
  // the word list and take down the main process.
  assert.strictEqual(mask('porch'), 'porch');
  assert.strictEqual(mask('i sat on the porch'), 'i sat on the porch');
  assert.strictEqual(mask('cotton'), 'cotton');
});

test('does NOT join short words into an accidental match', () => {
  // The flip side of joining: without a length floor these read as slurs.
  for (const line of [
    'yeah we can go ok',
    'i was there in june',
    'put it on the top of the pile',
  ]) {
    assert.strictEqual(mask(line), line, `wrongly masked: ${line}`);
  }
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

// --- version check -------------------------------------------------------

const { compareVersions, checkForUpdate, CHECK_INTERVAL_MS } = require('../src/main/updates');

console.log('\nversion check');

const newer = (a, b) => compareVersions(a, b) < 0;

test('a bump in any position reads as newer', () => {
  assert.ok(newer('0.0.5', '0.0.6'));
  assert.ok(newer('0.0.5', '0.1.0'));
  assert.ok(newer('0.9.9', '1.0.0'));
  // Not string comparison: 10 > 9.
  assert.ok(newer('1.9.0', '1.10.0'));
});

test('the same or an older tag is never offered as an update', () => {
  for (const [running, tag] of [
    ['1.2.3', '1.2.3'],
    ['1.2.3', 'v1.2.3'],
    ['1.2.3', '1.2.2'],
    ['1.2.3', '0.9.9'],
  ]) {
    assert.ok(!newer(running, tag), `${running} -> ${tag}`);
  }
});

test('the leading v is optional on either side', () => {
  assert.ok(newer('v0.0.5', '0.0.6'));
  assert.ok(newer('0.0.5', 'v0.0.6'));
});

test('a prerelease is older than its release, and newer than what came before', () => {
  assert.ok(newer('1.0.0-rc.1', '1.0.0'));
  assert.ok(!newer('1.0.0', '1.0.0-rc.1'));
  assert.ok(newer('0.9.0', '1.0.0-rc.1'));
});

test('a tag we cannot parse never announces itself as an update', () => {
  // Better to say nothing than to nag about a release that may not exist.
  for (const tag of ['', 'latest', 'nightly', 'v1.2', 'release-2024']) {
    assert.ok(!newer('1.2.3', tag), `tag ${JSON.stringify(tag)}`);
  }
});

test('update checks are on by default, and the app knows its own version', () => {
  const { DEFAULTS } = require('../src/main/config');
  assert.strictEqual(DEFAULTS.updates.check, true);
  const pkg = require('../package.json');
  assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version), `package version ${pkg.version}`);
});

testAsync('switching the check off makes no request at all', async () => {
  // The privacy promise, so it gets a test: with the setting off, an
  // unreachable timeout would be the only sign a request had gone out.
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cache: { check: false, lastCheck: 0, latest: '' },
  });
  assert.strictEqual(result.state, 'off');
  assert.ok(result.url.startsWith('https://github.com/'), result.url);
});

testAsync('a recent check is answered from cache, not from GitHub', async () => {
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cache: { check: true, lastCheck: Date.now() - 60_000, latest: 'v1.1.0' },
  });
  assert.strictEqual(result.state, 'available');
  assert.strictEqual(result.latest, 'v1.1.0');
});

testAsync('a cached tag the user has since installed stops being an update', async () => {
  // The verdict is re-derived on read, so installing 1.1.0 clears the badge
  // without waiting for the next check to come round.
  const result = await checkForUpdate({
    currentVersion: '1.1.0',
    cache: { check: true, lastCheck: Date.now() - 60_000, latest: 'v1.1.0' },
  });
  assert.strictEqual(result.state, 'current');
});

test('the check interval is a day, not a launch', () => {
  assert.strictEqual(CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
});

// --- result --------------------------------------------------------------

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
});
