'use strict';
/**
 * Caption word filter.
 *
 * Speech recognition output goes straight onto a live stream, so anything the
 * recogniser emits is broadcast before a human can react. This masks slurs on
 * the way out.
 *
 * The default list below is racial and ethnic slurs only — the category that
 * gets channels banned and does real harm. Anything else is left to the
 * streamer's own list, since standards differ per platform and community.
 */

/**
 * Single-word base terms. Common plural and agentive endings are generated in
 * `expand()`, so only the root form is listed.
 * 
 * Streamers can add them via the custom list as well.
 */
const DEFAULT_TERMS = [
  'nigger',
  'nigga',
  'niggah',
  'chink',
  'gook',
  'spic',
  'wetback',
  'beaner',
  'kike',
  'heeb',
  'jigaboo',
  'sambo',
  'darkie',
  'darky',
  'pickaninny',
  'golliwog',
  'towelhead',
  'raghead',
  'paki',
  'zipperhead',
  'slanteye',
  'gyppo',
  'redskin',
  'injun',
  'squaw',
  'abo',
  'boong',
  'coolie',
  'wop',
  'dago',
  'honky',
  'mulatto',
  'quadroon',
  'octoroon',
  'tarbaby',
];

/** Multi-word slurs, matched across adjacent words. */
const DEFAULT_PHRASES = [
  'porch monkey',
  'jungle bunny',
  'sand nigger',
  'camel jockey',
  'curry muncher',
  'cotton picker',
  'half breed',
];

/**
 * Strip everything but letters. Vosk emits lowercase words with no
 * punctuation, so this mainly guards against custom entries and any future
 * recogniser that adds punctuation.
 */
function normalize(token) {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}

/** A base term plus the endings a recogniser realistically emits. */
function expand(term) {
  return [term, `${term}s`, `${term}es`, `${term}z`];
}

/**
 * Build a matcher from the default lists plus the streamer's own entries.
 *
 * @param {{enabled?: boolean, custom?: string[]}} [options]
 */
function buildFilter({ enabled = true, custom = [] } = {}) {
  const words = new Set();
  const phrases = [];

  if (enabled) {
    for (const term of DEFAULT_TERMS) {
      for (const variant of expand(term)) words.add(variant);
    }
    for (const phrase of DEFAULT_PHRASES) {
      phrases.push(phrase.split(/\s+/).map(normalize).filter(Boolean));
    }

    for (const entry of custom) {
      const parts = String(entry).trim().split(/\s+/).map(normalize).filter(Boolean);
      if (parts.length === 0) continue;
      if (parts.length === 1) {
        for (const variant of expand(parts[0])) words.add(variant);
      } else {
        phrases.push(parts);
      }
    }
  }

  return { enabled, words, phrases, size: words.size + phrases.length };
}

/**
 * Mask any filtered term in `text`, preserving spacing and word length.
 *
 * @param {string} text
 * @param {ReturnType<buildFilter>} filter
 * @returns {{text: string, masked: number}}
 */
function maskText(text, filter) {
  if (!text || !filter || !filter.enabled || filter.size === 0) {
    return { text: text || '', masked: 0 };
  }

  // Split into words and the whitespace between them so the original spacing
  // can be rebuilt exactly.
  const parts = String(text).split(/(\s+)/);
  const isWord = (i) => i % 2 === 0 && parts[i].length > 0;
  const normalized = parts.map((p, i) => (isWord(i) ? normalize(p) : ''));
  const maskedIndex = new Set();

  // Phrases first: a phrase can span words that are individually harmless.
  for (const phrase of filter.phrases) {
    for (let i = 0; i < parts.length; i += 2) {
      let hit = true;
      for (let w = 0; w < phrase.length; w++) {
        const at = i + w * 2;
        if (!isWord(at) || normalized[at] !== phrase[w]) {
          hit = false;
          break;
        }
      }
      if (hit) {
        for (let w = 0; w < phrase.length; w++) maskedIndex.add(i + w * 2);
      }
    }
  }

  for (let i = 0; i < parts.length; i += 2) {
    if (isWord(i) && normalized[i] && filter.words.has(normalized[i])) maskedIndex.add(i);
  }

  if (maskedIndex.size === 0) return { text, masked: 0 };

  for (const i of maskedIndex) parts[i] = '*'.repeat(parts[i].length);
  return { text: parts.join(''), masked: maskedIndex.size };
}

module.exports = {
  DEFAULT_TERMS,
  DEFAULT_PHRASES,
  normalize,
  buildFilter,
  maskText,
};
