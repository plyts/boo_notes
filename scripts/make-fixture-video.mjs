// Generates tests/e2e/fixtures/sample.webm (30 s, 320×180, 4 fps) for the end-to-end tests:
// frames are drawn in Chromium, encoded with Playwright's bundled ffmpeg (MJPEG → VP8).
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests/e2e/fixtures/sample.webm');
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? '', '.cache/ms-playwright');
const ffmpegDir = readdirSync(browsersDir).find((d) => d.startsWith('ffmpeg'));
if (!ffmpegDir) throw new Error(`Playwright ffmpeg not found in ${browsersDir}`);
const ffmpeg = join(browsersDir, ffmpegDir, 'ffmpeg-linux');

const FPS = 4;
const SECONDS = 30;

const browser = await chromium.launch();
const page = await browser.newPage();
const frames = await page.evaluate(
  ({ fps, seconds }) => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const ctx = c.getContext('2d');
    const out = [];
    for (let i = 0; i < fps * seconds; i++) {
      const t = i / fps;
      ctx.fillStyle = `hsl(${(t * 12) % 360} 60% 35%)`;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 48px monospace';
      ctx.textAlign = 'center';
      const s = Math.floor(t);
      ctx.fillText(`00:${String(s).padStart(2, '0')}`, 160, 100);
      ctx.fillRect(10, 160, (300 * t) / seconds, 8);
      out.push(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    }
    return out;
  },
  { fps: FPS, seconds: SECONDS },
);
await browser.close();

const proc = spawn(
  ffmpeg,
  ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libvpx', '-b:v', '150k', '-pix_fmt', 'yuv420p', out],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
for (const f of frames) proc.stdin.write(Buffer.from(f, 'base64'));
proc.stdin.end();
const code = await new Promise((r) => proc.on('close', r));
if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
console.log('Wrote', out);
