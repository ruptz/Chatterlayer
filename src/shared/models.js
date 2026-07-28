'use strict';
/**
 * Speech model catalogue and downloader.
 *
 * Models aren't shipped with the app — they run 40 MB to 2.3 GB and each user
 * needs exactly one, so the app fetches the chosen one on first run. Shared by
 * the in-app picker and `npm run setup` so both offer identical choices.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const extract = require('extract-zip');

const BASE = 'https://alphacephei.com/vosk/models';

/**
 * Ordered lightest-first, which is also the order shown in the UI.
 * `ramMB` figures are measured, not estimates — see scripts/bench.js.
 */
const MODEL_CATALOG = [
  {
    key: 'small',
    dir: 'vosk-model-small-en-us-0.15',
    url: `${BASE}/vosk-model-small-en-us-0.15.zip`,
    label: 'Small',
    downloadMB: 40,
    ramMB: 150,
    blurb: 'Lightest and fastest. Fine with 7 speakers. Lowest accuracy.',
  },
  {
    key: 'medium',
    aliases: ['lgraph'],
    dir: 'vosk-model-en-us-0.22-lgraph',
    url: `${BASE}/vosk-model-en-us-0.22-lgraph.zip`,
    label: 'Medium',
    downloadMB: 128,
    ramMB: 250,
    blurb: 'Noticeably better accuracy, still light. Best balance for streaming.',
    recommended: true,
  },
  {
    key: 'large',
    dir: 'vosk-model-en-us-0.22',
    url: `${BASE}/vosk-model-en-us-0.22.zip`,
    label: 'Large',
    downloadMB: 1800,
    ramMB: 5000,
    blurb: 'High accuracy, trained mostly on read speech. Slow to load.',
  },
  {
    key: 'best',
    aliases: ['gigaspeech'],
    dir: 'vosk-model-en-us-0.42-gigaspeech',
    url: `${BASE}/vosk-model-en-us-0.42-gigaspeech.zip`,
    label: 'Gigaspeech',
    downloadMB: 2300,
    ramMB: 6800,
    blurb:
      'Best accuracy, trained on conversational audio. Needs ~7 GB RAM and ' +
      'about 16x the CPU of Small — good for a few speakers, not seven.',
  },
];

function findModel(key) {
  return MODEL_CATALOG.find((m) => m.key === key || (m.aliases || []).includes(key)) || null;
}

/** Catalogue annotated with whether each model is already on disk. */
function catalogWithStatus(modelsDirPath) {
  return MODEL_CATALOG.map((m) => {
    const target = path.join(modelsDirPath, m.dir);
    return { ...m, installed: fs.existsSync(target), path: target };
  });
}

/**
 * Download a URL to disk, following redirects and reporting progress.
 * Resolves once the file is fully written and closed.
 */
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));

    const request = https.get(url, { headers: { 'User-Agent': 'Chatterlayer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastTick = 0;

      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        // Throttle: this drives a progress bar over IPC, not a log.
        if (onProgress && now - lastTick > 200) {
          lastTick = now;
          onProgress({ phase: 'download', received, total });
        }
      });
      res.on('error', reject);
      res.pipe(file);
      file.on('error', reject);
      file.on('finish', () => file.close(() => resolve()));
    });

    request.on('error', reject);
    // A stalled connection should fail, not hang the installer forever.
    request.setTimeout(60_000, () => request.destroy(new Error('Download timed out')));
  });
}

/**
 * Fetch and unpack a model into `modelsDirPath`.
 *
 * Extraction is pure JS (extract-zip) rather than shelling out to PowerShell
 * or `unzip` — a packaged app cannot rely on either being present.
 *
 * @param {string} key catalogue key ('small' | 'medium' | 'large' | 'best')
 * @param {string} modelsDirPath destination directory (created if missing)
 * @param {(p: {phase: string, received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{name: string, path: string}>}
 */
async function installModel(key, modelsDirPath, onProgress) {
  const model = findModel(key);
  if (!model) throw new Error(`Unknown model "${key}".`);

  const target = path.join(modelsDirPath, model.dir);
  if (fs.existsSync(target)) return { name: model.dir, path: target };

  fs.mkdirSync(modelsDirPath, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-'));
  const zipPath = path.join(tmpDir, `${model.dir}.zip`);

  try {
    await download(model.url, zipPath, onProgress);

    if (onProgress) onProgress({ phase: 'extract' });
    // The archives contain a single top-level folder matching model.dir, so
    // extracting into modelsDir lands it in exactly the right place.
    await extract(zipPath, { dir: modelsDirPath });

    if (!fs.existsSync(target)) {
      throw new Error(`Archive unpacked but "${model.dir}" was not found inside it.`);
    }
    if (onProgress) onProgress({ phase: 'done' });
    return { name: model.dir, path: target };
  } catch (err) {
    // Never leave a half-extracted model behind — it would look installed and
    // then fail to load.
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Remove an installed model. */
function removeModel(key, modelsDirPath) {
  const model = findModel(key);
  if (!model) throw new Error(`Unknown model "${key}".`);
  const target = path.join(modelsDirPath, model.dir);
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

module.exports = {
  MODEL_CATALOG,
  findModel,
  catalogWithStatus,
  installModel,
  removeModel,
  download,
};
