#!/usr/bin/env node
/**
 * Generates placeholder PNG icons for every image the manifest references,
 * at the sizes Elgato requires, plus the @2x variants (PRD §7.7).
 *
 * Dependency-free (uses only node:zlib) so it runs anywhere:
 *
 *   node scripts/make-placeholder-icons.mjs
 *
 * Final artwork (Epic E4) replaces these files; the paths and sizes stay.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "com.johnmschoonover.decksync.sdPlugin");

/** Manifest image path (without extension) → 1x size in px. @2x is always double. */
const ICONS = [
  { file: "imgs/plugin/category-icon", size: 28, style: "glyph" },
  { file: "imgs/plugin/marketplace", size: 288, style: "tile" },
  { file: "imgs/actions/anchor/icon", size: 20, style: "glyph" },
  { file: "imgs/actions/anchor/key", size: 72, style: "tile" },
];

const BG = [0x20, 0x26, 0x34];
const ACCENT = [0x58, 0xc4, 0xf6];
const WHITE = [0xff, 0xff, 0xff];

/* ---- minimal PNG encoder (RGBA, no filtering) ---- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, no filter, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- drawing: a ring with a centre dot (a "page pin"), anti-aliased ---- */

/** Coverage 0..1 of a pixel centre at distance `d` from an edge at 0 (inside when d < 0). */
const edge = (d) => Math.min(1, Math.max(0, 0.5 - d));

function roundedSquare(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.max(Math.abs(x + 0.5 - half) - (half - radius), 0);
  const dy = Math.max(Math.abs(y + 0.5 - half) - (half - radius), 0);
  return edge(Math.hypot(dx, dy) - radius);
}

function ring(x, y, size, radius, thickness) {
  const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
  return edge(Math.abs(d - radius) - thickness / 2);
}

function dot(x, y, size, radius) {
  const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
  return edge(d - radius);
}

function blend(base, color, coverage) {
  return base.map((c, i) => Math.round(c + (color[i] - c) * coverage));
}

function pixel(style, size) {
  return (x, y) => {
    let rgb = [0, 0, 0];
    let alpha = 0;
    if (style === "tile") {
      const cov = roundedSquare(x, y, size, size * 0.18);
      rgb = BG;
      alpha = cov;
    }
    const glyphColor = style === "tile" ? ACCENT : WHITE;
    const ringCov = ring(x, y, size, size * 0.3, size * 0.1);
    const dotCov = dot(x, y, size, size * 0.09);
    const cov = Math.max(ringCov, dotCov);
    rgb = blend(rgb, glyphColor, alpha ? cov : 1);
    alpha = Math.max(alpha, cov);
    return [...rgb, Math.round(alpha * 255)];
  };
}

for (const { file, size, style } of ICONS) {
  for (const [suffix, px] of [["", size], ["@2x", size * 2]]) {
    const out = join(PLUGIN_DIR, `${file}${suffix}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, encodePng(px, pixel(style, px)));
    console.log(`${out} (${px}×${px})`);
  }
}
