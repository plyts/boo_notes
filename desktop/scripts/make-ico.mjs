// Windows / tray icons of the desktop app, from the shared artwork (no image dependency):
// build/icon.ico (installer, .exe), build/icon.png, and src/assets/icons (window, tray).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../../scripts/icon-art.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ICO container with PNG-compressed images (supported since Windows Vista). */
export function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: render(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

export async function makeIcons() {
  await mkdir(join(root, 'build'), { recursive: true });
  await mkdir(join(root, 'src', 'assets', 'icons'), { recursive: true });
  await writeFile(join(root, 'build', 'icon.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
  await writeFile(join(root, 'build', 'icon.png'), render(512));
  for (const [name, size] of [
    ['icon-256.png', 256],
    ['tray-16.png', 16],
    ['tray-16@2x.png', 32],
    ['tray-22.png', 22],
    ['tray-22@2x.png', 44],
  ]) {
    await writeFile(join(root, 'src', 'assets', 'icons', name), render(size));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await makeIcons();
  console.log('Icônes écrites dans build/ et src/assets/icons/');
}
