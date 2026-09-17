#!/usr/bin/env node
'use strict';
// make-icon.js — writes build/icon.ico from the same dot the tray draws.
//
// The runtime dot goes through Electron's nativeImage, which cannot give the
// packaged .exe its icon: that has to be a real .ico on disk at build time.
// Rather than commit a binary, this builds one — pure Node, no Electron and
// no image library, so it runs as a plain prebuild step.
//
//   node scripts/make-icon.js
//
// Green is the app's identity colour, the same `on` tint the tray uses while
// the warmer is running.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const GREEN = [74, 222, 128];
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;                 // supersample factor per axis
const INSET = 2 / 16;         // the tray dot's inset, as a fraction

// ── The circle, as straight RGBA ──
function circle(size, [r, g, b]) {
  const centre = size / 2;
  const radius = centre - size * INSET;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - centre;
          const dy = y + (sy + 0.5) / SS - centre;
          if (dx * dx + dy * dy <= radius * radius) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (y * size + x) * 4;
      // PNG wants straight alpha, not premultiplied
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = Math.round(255 * a);
    }
  }
  return px;
}

// ── Minimal PNG writer ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
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

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  ihdr[10] = 0;       // deflate
  ihdr[11] = 0;       // adaptive filtering
  ihdr[12] = 0;       // no interlace

  // One filter byte (0 = None) in front of each scanline
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO container, PNG-compressed entries (Vista and later) ──
function ico(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);                 // reserved
  dir.writeUInt16LE(1, 2);                 // type: icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = dir.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    dir[at] = size >= 256 ? 0 : size;      // 0 means 256
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0;                       // palette size
    dir[at + 3] = 0;                       // reserved
    dir.writeUInt16LE(1, at + 4);          // colour planes
    dir.writeUInt16LE(32, at + 6);         // bits per pixel
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });

const entries = SIZES.map((size) => ({ size, data: png(size, circle(size, GREEN)) }));
fs.writeFileSync(out, ico(entries));

console.log(`wrote ${path.relative(process.cwd(), out)} — ${SIZES.join(', ')}px, ${fs.statSync(out).size} bytes`);
