// Renders the "ghost" toolbar icons (PNG) without any image dependency.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './icon-art.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(join(outDir, `icon-${size}.png`), render(size));
}
console.log('Icons written to', outDir);
