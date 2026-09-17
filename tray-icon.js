'use strict';
// tray-icon.js — the tray dot and the window icon, drawn rather than shipped.
//
// The PowerShell panel built this with GDI+: a 16x16 bitmap and one
// antialiased FillEllipse(2, 2, 12, 12). Electron's nativeImage takes a raw
// bitmap instead, so the circle is rasterised here — 4x4 supersampled for the
// same soft edge, premultiplied because that is the format Chromium wants.
//
// The same circle serves as the taskbar icon at 32px, which keeps the app off
// the stock Electron diamond without adding a binary asset to the repo.

const { nativeImage } = require('electron');

const SS = 4;              // supersample factor per axis
const INSET = 2 / 16;      // the old FillEllipse inset, as a fraction

const cache = new Map();

function coverage(px, py, centre, radius) {
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const dx = px + (sx + 0.5) / SS - centre;
      const dy = py + (sy + 0.5) / SS - centre;
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / (SS * SS);
}

// [r, g, b] -> a size x size nativeImage of that dot.
function dot([r, g, b], size = 16) {
  const key = `${r},${g},${b},${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const centre = size / 2;
  const radius = centre - size * INSET;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, centre, radius);
      const i = (y * size + x) * 4;
      // BGRA, premultiplied by coverage
      buf[i] = Math.round(b * a);
      buf[i + 1] = Math.round(g * a);
      buf[i + 2] = Math.round(r * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }

  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  cache.set(key, img);
  return img;
}

module.exports = { dot };
