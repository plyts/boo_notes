// Bundles the desktop app into dist/: main process, preload, UI (+ pdf.js assets).
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
const pdfjs = join(root, 'node_modules', 'pdfjs-dist');

const common = {
  bundle: true,
  sourcemap: watch ? 'inline' : 'linked',
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
};

const entries = [
  {
    entryPoints: [join(src, 'main/index.ts')],
    outfile: join(out, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'bufferutil', 'utf-8-validate'],
  },
  {
    entryPoints: [join(src, 'preload/index.ts')],
    outfile: join(out, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    entryPoints: { app: join(src, 'renderer/app.ts') },
    outdir: join(out, 'renderer'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
  },
  {
    entryPoints: { app: join(src, 'renderer/styles.css') },
    outdir: join(out, 'renderer'),
    target: 'chrome140',
  },
];

async function copyStatic() {
  await mkdir(join(out, 'renderer', 'pdfjs'), { recursive: true });
  await cp(join(src, 'renderer/index.html'), join(out, 'renderer/index.html'));
  await cp(join(src, 'assets/icons'), join(out, 'icons'), { recursive: true });
  await cp(join(pdfjs, 'build/pdf.worker.min.mjs'), join(out, 'renderer/pdfjs/pdf.worker.mjs'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    await cp(join(pdfjs, dir), join(out, 'renderer/pdfjs', dir), { recursive: true });
  }
}

await rm(out, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(entries.map((e) => context({ ...common, ...e })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching src/ … (static files are copied at start only)');
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}
