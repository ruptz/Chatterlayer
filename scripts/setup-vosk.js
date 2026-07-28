'use strict';
/**
 * Downloads the libvosk runtime into vendor/ and a speech model into models/.
 *
 * For source checkouts and CI only — installed builds ship the runtime and
 * download models from inside the app. CI uses `--runtime-only` to fetch just
 * the library before packaging.
 *
 *   node scripts/setup-vosk.js                  # runtime + recommended model
 *   node scripts/setup-vosk.js --model=small    # a specific model
 *   node scripts/setup-vosk.js --runtime-only   # libvosk only (used by CI)
 *   node scripts/setup-vosk.js --list           # show what's available
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const extract = require('extract-zip');

const { MODEL_CATALOG, findModel, installModel, download } = require('../src/shared/models');
const { modelsDir, vendorDir } = require('../src/shared/paths');

/** Official prebuilt libvosk runtimes, keyed by platform+arch. */
const RUNTIMES = {
  'win32-x64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip',
    lib: 'libvosk.dll',
  },
  'win32-ia32': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win32-0.3.45.zip',
    lib: 'libvosk.dll',
  },
  'linux-x64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-linux-x86_64-0.3.45.zip',
    lib: 'libvosk.so',
  },
  'linux-arm64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-linux-aarch64-0.3.45.zip',
    lib: 'libvosk.so',
  },
  'darwin-x64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.42/vosk-osx-0.3.42.zip',
    lib: 'libvosk.dylib',
  },
  'darwin-arm64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.42/vosk-osx-0.3.42.zip',
    lib: 'libvosk.dylib',
  },
};

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One-line progress that overwrites itself. */
function progress({ phase, received, total }) {
  if (phase === 'extract') {
    process.stdout.write('\r      Extracting (this can take a minute)…            ');
    return;
  }
  if (phase === 'done') {
    process.stdout.write('\r      Done.                                          \n');
    return;
  }
  const pct = total ? `${((received / total) * 100).toFixed(0)}%` : '';
  process.stdout.write(`\r      ${mb(received)}${total ? ` / ${mb(total)}` : ''} ${pct}   `);
}

/** Does this directory already contain the platform's libvosk? */
function findLib(dir, libName) {
  if (!fs.existsSync(dir)) return null;
  if (fs.existsSync(path.join(dir, libName))) return path.join(dir, libName);
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry, libName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function listModels() {
  console.log('Available speech models:\n');
  for (const m of MODEL_CATALOG) {
    const tag = m.recommended ? '  (recommended)' : '';
    console.log(`  --model=${m.key.padEnd(7)} ${m.label}${tag}`);
    console.log(`      ~${m.downloadMB} MB download, ~${m.ramMB} MB RAM`);
    console.log(`      ${m.blurb}\n`);
  }
}

async function installRuntime() {
  const key = `${process.platform}-${process.arch}`;
  const runtime = RUNTIMES[key];
  if (!runtime) {
    throw new Error(
      `No prebuilt Vosk runtime for ${key}. Build libvosk yourself and set ` +
        `CHATTERLAYER_VOSK_LIB to its location.`
    );
  }

  const vendor = vendorDir();
  const existing = findLib(vendor, runtime.lib);
  if (existing) {
    console.log(`[runtime] Already present:\n      ${existing}\n`);
    return;
  }

  console.log('[runtime] Downloading libvosk…');
  fs.mkdirSync(vendor, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-'));
  const zip = path.join(tmp, 'runtime.zip');
  try {
    await download(runtime.url, zip, progress);
    progress({ phase: 'extract' });
    await extract(zip, { dir: vendor });
    const found = findLib(vendor, runtime.lib);
    if (!found) throw new Error(`Unpacked archive but ${runtime.lib} was not found in vendor/.`);
    progress({ phase: 'done' });
    console.log(`      ${found}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (flag('list')) return listModels();

  console.log('Chatterlayer setup');
  console.log('==================');
  console.log(`platform : ${process.platform}-${process.arch}`);
  console.log(`vendor   : ${vendorDir()}`);
  console.log(`models   : ${modelsDir()}\n`);

  await installRuntime();

  if (flag('runtime-only')) {
    console.log('Runtime only — skipping model download.');
    return;
  }

  const key = arg('model') || MODEL_CATALOG.find((m) => m.recommended).key;
  const model = findModel(key);
  if (!model) {
    console.error(`Unknown model "${key}". Run with --list to see the options.`);
    process.exit(1);
  }

  const target = path.join(modelsDir(), model.dir);
  if (fs.existsSync(target)) {
    console.log(`[model]   Already present:\n      ${target}\n`);
  } else {
    console.log(
      `[model]   Downloading ${model.label} (~${model.downloadMB} MB, ~${model.ramMB} MB RAM)…`
    );
    await installModel(model.key, modelsDir(), progress);
    console.log(`      ${target}\n`);
  }

  console.log('Setup complete. Start Chatterlayer with:  npm start');
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
