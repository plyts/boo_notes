import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockNotion, type MockNotion } from '../../tools/mock-notion.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Minimal valid PDF: one page per entry, each line of text drawn with Helvetica. */
export function makePdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines
      .map((l, i) => `BT /F1 ${i === 0 ? 22 : 13} Tf 72 ${720 - i * 28} Td (${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** `seconds` of a quiet tone, 8 kHz mono 8-bit PCM WAV. */
export function makeWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(8 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}

export interface Ctx {
  dir: string;
  vault: string;
  port: number;
  notion: MockNotion;
  launch(opts?: { onboarded?: boolean }): Promise<{ app: ElectronApplication; page: Page }>;
}

let nextPort = 45200 + Math.floor(Math.random() * 500);

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'boo-ui-'));
    const vault = join(dir, 'Boo Notes');
    const notion = startMockNotion();
    await notion.ready;
    const port = nextPort++;
    const apps: ElectronApplication[] = [];
    await use({
      dir,
      vault,
      port,
      notion,
      async launch({ onboarded = true } = {}) {
        const userData = join(dir, 'user-data');
        if (onboarded) {
          const { mkdir } = await import('node:fs/promises');
          await mkdir(userData, { recursive: true });
          await writeFile(join(userData, 'config.json'), JSON.stringify({ onboarded: true, token: 'TEST-TOKN-ABCD-EFGH' }));
        }
        const app = await electron.launch({
          args: ['--no-sandbox', ROOT],
          env: {
            ...process.env,
            BOO_E2E: '1',
            BOO_USER_DATA: userData,
            BOO_VAULT: vault,
            BOO_PORT: String(port),
            NOTION_API_BASE: notion.url,
            ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
          },
        });
        apps.push(app);
        const page = await app.firstWindow();
        await page.waitForSelector('.nav-item');
        return { app, page };
      },
    });
    for (const app of apps) await app.close().catch(() => undefined);
    await notion.close();
    await rm(dir, { recursive: true, force: true });
  },
});

export { expect };
