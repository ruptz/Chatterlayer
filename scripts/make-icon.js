'use strict';
/**
 * Writes build/icon.png (512x512) from the same three-bar mark used in the app
 * header, so installer, taskbar and window agree. Generated rather than drawn
 * so it stays in sync and needs no design tools.
 *
 *   node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 3; // supersampling factor per axis, for smooth edges

// --- PNG encoding ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- shape maths ----------------------------------------------------------

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// --- draw -----------------------------------------------------------------

const BG = [0x14, 0x16, 0x19];
const BAR = [0xff, 0xff, 0xff];

// Three bars: differing widths read as stacked caption lines even at 16px.
const BARS = [
  { w: 0.62, alpha: 1.0 },
  { w: 0.4, alpha: 0.6 },
  { w: 0.52, alpha: 0.82 },
];

const BAR_H = 0.088; // of icon size
const BAR_GAP = 0.062;

function sample(x, y) {
  // Returns [r,g,b,a] at a point in 0..SIZE space.
  const outerR = SIZE * 0.22;
  const dOuter = roundedRectSdf(x, y, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, outerR);
  if (dOuter > 0) return [0, 0, 0, 0]; // outside the squircle

  let r = BG[0];
  let g = BG[1];
  let b = BG[2];

  const barH = SIZE * BAR_H;
  const gap = SIZE * BAR_GAP;
  const totalH = BARS.length * barH + (BARS.length - 1) * gap;
  let top = (SIZE - totalH) / 2;

  for (const bar of BARS) {
    const cy = top + barH / 2;
    const halfW = (SIZE * bar.w) / 2;
    const d = roundedRectSdf(x, y, SIZE / 2, cy, halfW, barH / 2, barH / 2);
    if (d <= 0) {
      r = mix(r, BAR[0], bar.alpha);
      g = mix(g, BAR[1], bar.alpha);
      b = mix(b, BAR[2], bar.alpha);
    }
    top += barH + gap;
  }

  return [r, g, b, 255];
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SS;
  const offset = step / 2;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + sx * step + offset, y + sy * step + offset);
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      // Un-premultiply so edge pixels keep their colour.
      const wsum = a / 255 || 1;
      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.round(r / wsum);
      rgba[i + 1] = Math.round(g / wsum);
      rgba[i + 2] = Math.round(b / wsum);
      rgba[i + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, encodePng(SIZE, SIZE, render()));
console.log(`Wrote ${outFile} (${SIZE}x${SIZE}, ${fs.statSync(outFile).size} bytes)`);
