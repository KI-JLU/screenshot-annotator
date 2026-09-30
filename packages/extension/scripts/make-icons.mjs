// Generates the toolbar icons (public/icons/icon-<size>.png) without external dependencies:
// a dark rounded square with a red marker ring, drawn with 4x4 supersampling.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(import.meta.dirname, "../public/icons");
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function sample(u, v) {
  // u, v in [0,1]. Returns [r,g,b,a].
  const r = 0.2;
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  const d = Math.hypot(u - 0.5, v - 0.5);
  if (d > 0.22 && d < 0.34) return [225, 29, 46, 255];
  if (d <= 0.08) return [255, 255, 255, 255];
  return [31, 41, 55, 255];
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          const a = c[3] / 255;
          acc[0] += c[0] * a;
          acc[1] += c[1] * a;
          acc[2] += c[2] * a;
          acc[3] += c[3];
        }
      const n = ss * ss;
      const alpha = acc[3] / n;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const div = alpha > 0 ? (alpha / 255) * n : 1;
      raw[o] = Math.round(acc[0] / div);
      raw[o + 1] = Math.round(acc[1] / div);
      raw[o + 2] = Math.round(acc[2] / div);
      raw[o + 3] = Math.round(alpha);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(resolve(out, `icon-${size}.png`), png(size));
console.log("icons written to", out);
