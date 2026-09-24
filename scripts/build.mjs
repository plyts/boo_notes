// Bundles the extension into dist/ (load it with "Load unpacked" in chrome://extensions).
import { build, context } from 'esbuild';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
// Built aside, then swapped in whole: a failed build never leaves a half-built extension in dist/.
const out = watch ? dist : join(root, 'dist.building');
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

export const INTER_FILES = ['inter-latin-opsz-normal.woff2', 'inter-latin-ext-opsz-normal.woff2', 'inter-latin-opsz-italic.woff2'];

const entries = [
  { entryPoints: [join(src, 'background/index.ts')], outfile: join(out, 'background.js'), format: 'esm' },
  { entryPoints: [join(src, 'content/index.ts')], outfile: join(out, 'content.js'), format: 'iife' },
  // Sub-frames (embedded players) and the page's own world (off-DOM `new Audio()` players).
  { entryPoints: [join(src, 'content/frame.ts')], outfile: join(out, 'frame.js'), format: 'iife' },
  { entryPoints: [join(src, 'content/media-bridge.ts')], outfile: join(out, 'media-bridge.js'), format: 'iife' },
  { entryPoints: [join(src, 'panel/index.ts')], outfile: join(out, 'panel/panel.js'), format: 'iife' },
  { entryPoints: [join(src, 'options/index.ts')], outfile: join(out, 'options/options.js'), format: 'iife' },
  { entryPoints: [join(src, 'diagnostic/index.ts')], outfile: join(out, 'diagnostic/diagnostic.js'), format: 'iife' },
  // The PDF layout (and its library), loaded only while a PDF is being made.
  { entryPoints: [join(src, 'offscreen/pdf.ts')], outfile: join(out, 'offscreen/pdf.js'), format: 'iife' },
];

async function copyStatic() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  // Test pages (*.test) and the local Notion API mock (127.0.0.1).
  if (e2e) manifest.host_permissions.push('*://*.test/*', 'http://127.0.0.1/*');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const rel of ['panel/panel.html', 'panel/panel.css', 'panel/editor.css', 'panel/transcript.css', 'options/options.html', 'options/options.css', 'offscreen/pdf.html', 'diagnostic/diagnostic.html', 'diagnostic/diagnostic.css', 'tokens.css']) {
    await mkdir(dirname(join(out, rel)), { recursive: true });
    await cp(join(src, rel), join(out, rel));
  }
  await cp(join(src, 'icons'), join(out, 'icons'), { recursive: true });
  // Inter (OFL), with its optical-size axis: the UI font where SF Pro is not the system font.
  const inter = join(root, 'node_modules', '@fontsource-variable', 'inter', 'files');
  await mkdir(join(out, 'fonts'), { recursive: true });
  for (const f of INTER_FILES) await cp(join(inter, f), join(out, 'fonts', f));
}

// A `git pull` may bring a new dependency: without `npm install` the bundles cannot be made.
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const missing = [];
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  await access(join(root, 'node_modules', dep, 'package.json')).catch(() => missing.push(dep));
}
if (missing.length) {
  console.error(`\n✘ Dépendances manquantes : ${missing.join(', ')}\n  Lancez d’abord « npm install », puis « npm run build ». (dist/ est laissé tel quel.)\n`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(entries.map((e) => context({ ...common, ...e })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching src/ … (static files are copied at start only)');
} else {
  const results = await Promise.allSettled(entries.map((e) => build({ ...common, ...e })));
  if (results.some((r) => r.status === 'rejected')) {
    await rm(out, { recursive: true, force: true });
    console.error('\n✘ Build échoué : dist/ est laissé tel quel (voir les erreurs ci-dessus).\n');
    process.exit(1);
  }
  await rm(dist, { recursive: true, force: true });
  await rename(out, dist);
}
