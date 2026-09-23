// Bundles the extension into dist/ (load it with "Load unpacked" in chrome://extensions).
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
// End-to-end builds may inject the content script on test hosts without a permission prompt.
const e2e = process.argv.includes('--e2e');

const common = {
  bundle: true,
  target: 'chrome116',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
};

const entries = [
  { entryPoints: [join(src, 'background/index.ts')], outfile: join(out, 'background.js'), format: 'esm' },
  { entryPoints: [join(src, 'content/index.ts')], outfile: join(out, 'content.js'), format: 'iife' },
  { entryPoints: [join(src, 'panel/index.ts')], outfile: join(out, 'panel/panel.js'), format: 'iife' },
  { entryPoints: [join(src, 'options/index.ts')], outfile: join(out, 'options/options.js'), format: 'iife' },
];

async function copyStatic() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) manifest.host_permissions.push('*://*.test/*');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const rel of ['panel/panel.html', 'panel/panel.css', 'options/options.html', 'options/options.css', 'tokens.css']) {
    await mkdir(dirname(join(out, rel)), { recursive: true });
    await cp(join(src, rel), join(out, rel));
  }
  await cp(join(src, 'icons'), join(out, 'icons'), { recursive: true });
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
