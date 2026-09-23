import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontMatter, serializeFrontMatter } from '../../src/core/frontmatter';
import {
  countNotes,
  kindForFile,
  Library,
  positionLabel,
  progressRatio,
  safeFileName,
  studyStatus,
} from '../../src/core/library';
import type { ExtensionNote } from '../../src/core/types';

let dir: string;
let lib: Library;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'boo-vault-'));
  lib = new Library(join(dir, 'vault'));
  await lib.open();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const note = (rev: number, markdown = '[00:05] Intro'): ExtensionNote => ({
  id: 'youtube:abcdefghijk',
  platform: 'youtube',
  kind: 'video',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  title: 'Cours : React / Hooks ?',
  markdown,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000 + rev,
  rev,
});

describe('front matter', () => {
  it('round-trips values, quoting what needs it', () => {
    const text = serializeFrontMatter({ title: 'Cours: "React"', source: 'C:\\Cours\\a.pdf', kind: 'pdf' }, '# Corps\n');
    expect(text).toContain('kind: pdf\n');
    expect(parseFrontMatter(text)).toEqual({
      data: { title: 'Cours: "React"', source: 'C:\\Cours\\a.pdf', kind: 'pdf' },
      body: '# Corps\n',
    });
  });

  it('reads the extension portable Markdown', () => {
    const parsed = parseFrontMatter('---\r\ntitle: "Vidéo"\r\nsource: https://x.test/a\r\n---\r\n\r\n[00:01] a\r\n');
    expect(parsed).toEqual({ data: { title: 'Vidéo', source: 'https://x.test/a' }, body: '[00:01] a\n' });
    expect(parseFrontMatter('pas de front matter').body).toBe('pas de front matter');
  });
});

describe('helpers', () => {
  it('makes file names valid on Windows', () => {
    expect(safeFileName('Cours : React / Hooks ?')).toBe('Cours React Hooks');
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('fin...  ')).toBe('fin');
  });

  it('recognises the supported formats', () => {
    expect(kindForFile('C:\\Cours\\Chapitre 1.PDF')).toBe('pdf');
    expect(kindForFile('/x/podcast.m4a')).toBe('audio');
    expect(kindForFile('/x/cours.mkv')).toBe('video');
    expect(kindForFile('/x/notes.docx')).toBeNull();
  });

  it('counts timestamps and page references', () => {
    expect(countNotes('[00:01] a\n[p. 3] b\n![04:15](x) pas une note\n[01:02:03](https://x.test#t=1) c')).toBe(3);
  });
});

describe('Library', () => {
  it('stores extension notes as readable Markdown, newest revision wins', async () => {
    await lib.upsertFromExtension(note(2, '[00:05] Intro\n[00:09] Suite'));
    const stale = await lib.upsertFromExtension(note(1, '[00:05] Ancien'));
    expect(stale.rev).toBe(2);
    const item = lib.get('youtube:abcdefghijk')!;
    expect(item).toMatchObject({
      origin: 'extension',
      kind: 'video',
      noteFile: 'Cours React Hooks.md',
      noteCount: 2,
      source: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
    const file = await readFile(join(lib.path, item.noteFile), 'utf8');
    expect(file).toContain('title: "Cours : React / Hooks ?"');
    expect(file).toContain('[00:09](https://www.youtube.com/watch?v=abcdefghijk#t=9) Suite');
    expect(await lib.readNote(item.id)).toContain('[00:05](https://www.youtube.com/watch?v=abcdefghijk#t=5) Intro');

    // Persisted across restarts.
    const again = new Library(lib.path);
    await again.open();
    expect(again.get(item.id)?.rev).toBe(2);
  });

  it('keeps a position received before its note', async () => {
    expect(await lib.setProgress('youtube:abcdefghijk', 120, 600, 5)).toBeNull();
    const item = await lib.upsertFromExtension(note(1));
    expect(item.progress).toEqual({ position: 120, duration: 600, updatedAt: 5 });
    expect(progressRatio(item)).toBeCloseTo(0.2);
    expect(positionLabel(item)).toBe('02:00 / 10:00');
    expect(studyStatus(item)).toBe('doing');
  });

  it('adds local files once, with an editable note', async () => {
    const pdf = join(dir, 'Algèbre linéaire.pdf');
    await writeFile(pdf, '%PDF-1.4');
    const a = await lib.addLocalFile(pdf);
    const b = await lib.addLocalFile(pdf);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ kind: 'pdf', platform: 'local', title: 'Algèbre linéaire', origin: 'desktop' });

    const saved = await lib.saveNote(a.id, '[p. 3] Définition\n[p. 7] Théorème');
    expect(saved).toMatchObject({ rev: 1, noteCount: 2 });
    const file = await readFile(join(lib.path, a.noteFile), 'utf8');
    expect(parseFrontMatter(file)).toMatchObject({
      data: { title: 'Algèbre linéaire', kind: 'pdf', source: pdf },
      body: '[p. 3] Définition\n[p. 7] Théorème',
    });
    expect(await lib.readNote(a.id)).toBe('[p. 3] Définition\n[p. 7] Théorème');

    await lib.setProgress(a.id, 12, 40);
    await lib.setProgress(a.id, 5, 40);
    const item = lib.get(a.id)!;
    expect(item.furthest).toBe(12);
    expect(progressRatio(item)).toBeCloseTo(0.3);
    expect(positionLabel(item)).toBe('p. 5 / 40');
    await lib.setProgress(a.id, 40, 40);
    expect(studyStatus(lib.get(a.id)!)).toBe('done');
    expect(studyStatus((await lib.update(a.id, { status: 'todo' })))).toBe('todo');

    await expect(lib.addLocalFile(join(dir, 'notes.docx'))).rejects.toThrow(/Format non pris en charge/);
    await expect(lib.saveNote('youtube:x', 'x')).rejects.toThrow();
  });

  it('refuses to edit extension notes and paths outside the vault', async () => {
    await lib.upsertFromExtension(note(1));
    await expect(lib.saveNote('youtube:abcdefghijk', 'x')).rejects.toThrow(/extension/);
    expect(() => lib.assetPath('assets/../../evil.jpg')).toThrow();
    expect(() => lib.assetPath('../x.jpg')).toThrow();
    await lib.putAsset('assets/youtube-abc-04-15-k3j2.jpg', Buffer.from('jpeg'));
    expect(await readFile(join(lib.path, 'assets/youtube-abc-04-15-k3j2.jpg'), 'utf8')).toBe('jpeg');
  });

  it('gives unique file names to homonyms', async () => {
    await lib.upsertFromExtension(note(1));
    const other = await lib.upsertFromExtension({ ...note(1), id: 'udemy:react/1', platform: 'udemy' });
    expect(other.noteFile).toBe('Cours React Hooks (2).md');
  });

  it('reports why things changed', async () => {
    const reasons: string[] = [];
    lib.on('changed', (_id, reason) => reasons.push(reason));
    await lib.upsertFromExtension(note(1));
    await lib.setProgress('youtube:abcdefghijk', 1, 10);
    await lib.setNotion('youtube:abcdefghijk', { pageId: 'p', blocks: [], syncedAt: 1, syncedRev: 1 });
    await lib.update('youtube:abcdefghijk', { status: 'done' });
    await lib.remove('youtube:abcdefghijk');
    expect(reasons).toEqual(['content', 'progress', 'notion', 'meta', 'removed']);
  });
});
