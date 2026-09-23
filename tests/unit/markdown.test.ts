import { describe, expect, it } from 'vitest';
import {
  appendBlock,
  captureLine,
  findAssetRefs,
  findTimestamps,
  timestampToken,
  toPortableMarkdown,
} from '../../src/shared/markdown';

describe('findTimestamps', () => {
  it('finds bare and linked timestamps with their positions', () => {
    const text = 'Intro [00:05] puis [1:02:03](https://x.test#t=3723).';
    const found = findTimestamps(text, 10);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ label: '00:05', seconds: 5, url: null, from: 16, labelTo: 23, to: 23 });
    expect(found[1]).toMatchObject({ label: '1:02:03', seconds: 3723, url: 'https://x.test#t=3723' });
    expect(text.slice(found[1].from - 10, found[1].to - 10)).toBe('[1:02:03](https://x.test#t=3723)');
  });

  it('ignores image alt texts and invalid values', () => {
    expect(findTimestamps('![04:15](assets/a.jpg) [04:75]')).toEqual([]);
  });
});

describe('capture lines and assets', () => {
  it('writes the timestamp then the thumbnail', () => {
    expect(timestampToken(255)).toBe('[04:15]');
    expect(captureLine(255, 'assets/yt-04-15.jpg')).toBe('[04:15] ![Capture 04:15](assets/yt-04-15.jpg)');
  });

  it('lists referenced screenshots once', () => {
    const md = '![a](assets/one.jpg)\n![b](assets/two.png) ![a again](assets/one.jpg) ![web](https://x/y.png)';
    expect(findAssetRefs(md)).toEqual(['assets/one.jpg', 'assets/two.png']);
  });

  it('appends blocks on their own line', () => {
    expect(appendBlock('', 'X')).toBe('X\n');
    expect(appendBlock('a', 'X')).toBe('a\nX\n');
    expect(appendBlock('a\n', 'X')).toBe('a\nX\n');
  });
});

describe('toPortableMarkdown', () => {
  const note = {
    title: 'Cours "React"',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    platform: 'youtube',
    markdown: '[00:10] Hooks\n`[00:20]` code\n```\n[00:30] in fence\n```\n[00:40](https://keep.me) déjà un lien',
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 2),
  };

  it('links bare timestamps outside code and adds a front matter', () => {
    const out = toPortableMarkdown(note);
    expect(out).toContain('title: "Cours \\"React\\""');
    expect(out).toContain('source: https://www.youtube.com/watch?v=abcdefghijk');
    expect(out).toContain('[00:10](https://www.youtube.com/watch?v=abcdefghijk#t=10) Hooks');
    expect(out).toContain('`[00:20]` code');
    expect(out).toContain('\n[00:30] in fence\n');
    expect(out).toContain('[00:40](https://keep.me) déjà un lien');
  });

  it('can skip the front matter', () => {
    expect(toPortableMarkdown(note, { frontMatter: false }).startsWith('[00:10](')).toBe(true);
  });
});

describe('file names', async () => {
  const { asciiFileName, safeFileName } = await import('../../src/shared/encoding');
  it('keeps readable, portable names', () => {
    expect(safeFileName('Cours: React / Hooks?')).toBe('Cours React Hooks');
    expect(safeFileName('...')).toBe('note');
    expect(asciiFileName('Vidéo façon « Été »')).toBe('Video facon Ete');
  });
});
