'use strict';
/**
 * Shared by the main process, the engine child process and the setup script,
 * so nothing here may assume Electron's `app` module exists.
 *
 * Installed builds put vendor/ in the app's read-only resources and models/ in
 * the user's data directory, since Program Files isn't writable and models are
 * downloaded after install. The main process pins both into the environment
 * (CHATTERLAYER_MODELS_DIR / CHATTERLAYER_VENDOR_DIR) for the engine.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');

/** Where downloaded speech models live. Writable. */
function modelsDir() {
  if (process.env.CHATTERLAYER_MODELS_DIR) return process.env.CHATTERLAYER_MODELS_DIR;
  return path.join(PROJECT_ROOT, 'models');
}

/** Where libvosk lives. Read-only in an installed build. */
function vendorDir() {
  if (process.env.CHATTERLAYER_VENDOR_DIR) return process.env.CHATTERLAYER_VENDOR_DIR;
  // In a packaged build electron-builder copies vendor/ into resources/,
  // outside the asar archive so the shared library is a real file on disk.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'vendor');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(PROJECT_ROOT, 'vendor');
}

/**
 * Known models, most accurate first. Used to auto-pick a default and to order
 * the picker, so installing a better model actually starts being used.
 */
const MODEL_RANK = [
  'vosk-model-en-us-0.42-gigaspeech',
  'vosk-model-en-us-0.22',
  'vosk-model-en-us-0.22-lgraph',
  'vosk-model-small-en-us-0.15',
];

const MODEL_LABELS = {
  'vosk-model-en-us-0.42-gigaspeech': 'Gigaspeech — best accuracy, very heavy',
  'vosk-model-en-us-0.22': 'Large — high accuracy, heavy',
  'vosk-model-en-us-0.22-lgraph': 'Medium — recommended',
  'vosk-model-small-en-us-0.15': 'Small — fastest, lowest accuracy',
};

function rankOf(name) {
  const i = MODEL_RANK.indexOf(name);
  return i === -1 ? MODEL_RANK.length : i;
}

/** A directory is a usable model only if it has the Kaldi layout inside. */
function looksLikeModel(dir) {
  return fs.existsSync(path.join(dir, 'conf')) || fs.existsSync(path.join(dir, 'am'));
}

/** Every installed model, best-first. */
function listModels() {
  const dir = modelsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('vosk-model'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .filter((m) => looksLikeModel(m.path))
    .map((m) => ({ ...m, label: MODEL_LABELS[m.name] || m.name }))
    .sort((a, b) => rankOf(a.name) - rankOf(b.name) || a.name.localeCompare(b.name));
}

/**
 * Find the Vosk model directory.
 *   1. CHATTERLAYER_MODEL env var
 *   2. explicit override (chosen in the app)
 *   3. the most accurate installed model
 */
function resolveModelPath(override) {
  const candidates = [process.env.CHATTERLAYER_MODEL, override].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  const installed = listModels();
  if (installed.length) return installed[0].path;

  throw new Error(
    'Chatterlayer: no speech model installed yet. Open Chatterlayer and download ' +
      'one from the Speech model panel (or run "npm run setup" from source).'
  );
}

/** Non-throwing variant for UI status checks. */
function tryResolveModelPath(override) {
  try {
    return resolveModelPath(override);
  } catch {
    return null;
  }
}

module.exports = {
  PROJECT_ROOT,
  WEB_DIR,
  MODEL_LABELS,
  MODEL_RANK,
  modelsDir,
  vendorDir,
  listModels,
  looksLikeModel,
  resolveModelPath,
  tryResolveModelPath,
};
