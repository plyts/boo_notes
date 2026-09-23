// Renders the "ghost" toolbar icons (PNG) without any image dependency.
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1).
function roundedSquare(x, y, r) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function ghost(x, y) {
  const cx = 0.5, headY = 0.43, r = 0.25, bottom = 0.74;
  const inHead = (x - cx) ** 2 + (y - headY) ** 2 <= r * r;
  const inBody = x >= cx - r && x <= cx + r && y >= headY && y <= bottom;
  // Scalloped hem: three bumps under the body.
  const bump = (2 * r) / 3;
  let inHem = false;
  for (let i = 0; i < 3; i++) {
    const bx = cx - r + bump * (i + 0.5);
    if ((x - bx) ** 2 + (y - bottom) ** 2 <= (bump / 2) ** 2 && y >= bottom) inHem = true;
  }
  return inHead || inBody || inHem;
}
function eye(x, y) {
  const e = (ex) => ((x - ex) / 0.042) ** 2 + ((y - 0.44) / 0.06) ** 2 <= 1;
  return e(0.415) || e(0.585);
}

function render(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!roundedSquare(x, y, 0.22)) continue;
          let c;
          if (eye(x, y) && ghost(x, y)) c = [43, 35, 96];
          else if (ghost(x, y)) c = [255, 255, 255];
          else {
            // Violet vertical gradient background.
            const t = y;
            c = [Math.round(139 - 40 * t), Math.round(124 - 45 * t), Math.round(246 - 30 * t)];
          }
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = ss * ss;
      const cov = a / n;
      const i = (py * size + px) * 4;
      if (cov > 0) {
        buf[i] = Math.round(r / (a / 255));
        buf[i + 1] = Math.round(g / (a / 255));
        buf[i + 2] = Math.round(b / (a / 255));
      }
      buf[i + 3] = Math.round(cov);
    }
  }
  return png(size, buf);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(join(outDir, `icon-${size}.png`), render(size));
}
console.log('Icons written to', outDir);
