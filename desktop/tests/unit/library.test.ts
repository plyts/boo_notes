import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontMatter, serializeFrontMatter } from '../../src/core/frontmatter';
import {
  countNotes,
  isDue,
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

  it('creates revision sheets, links them and lists backlinks', async () => {
    const newton = await lib.createNote('Lois de Newton', '# Trois lois\nVoir [[Forces]] et [[énergie|l’énergie]].');
    expect(newton).toMatchObject({ kind: 'note', platform: 'local', source: '', links: ['Forces', 'énergie'] });
    expect(await lib.createNote('lois de  newton')).toMatchObject({ id: newton.id });
    const forces = await lib.createNote('Forces');
    const energie = await lib.createNote('Énergie');
    expect(lib.findByTitle('ENERGIE')?.id).toBe(energie.id);
    expect(lib.backlinks(forces.id).map((i) => i.id)).toEqual([newton.id]);
    expect(lib.backlinks(energie.id).map((i) => i.id)).toEqual([newton.id]);
    expect(lib.titles()).toEqual(expect.arrayContaining(['Lois de Newton', 'Forces', 'Énergie']));

    // Renaming a sheet rewrites the links pointing to it (aliases kept).
    await lib.update(energie.id, { title: 'Énergie mécanique' });
    expect(await lib.readNote(newton.id)).toBe('# Trois lois\nVoir [[Forces]] et [[Énergie mécanique|l’énergie]].');
    expect(lib.backlinks(energie.id).map((i) => i.id)).toEqual([newton.id]);
    const file = await readFile(join(lib.path, newton.noteFile), 'utf8');
    expect(file).toMatch(/^---\ntitle: "Lois de Newton"\nkind: note\n/);
  });

  it('schedules reviews with growing intervals', async () => {
    const sheet = await lib.createNote('Dérivées', 'f′(x) = lim …');
    const day = 86_400_000;
    const t0 = new Date(2026, 0, 10, 9).getTime();
    expect((await lib.review(sheet.id, 'start', t0)).review).toEqual({ next: t0, interval: 0, count: 0 });
    expect(isDue(lib.get(sheet.id)!, t0)).toBe(true);
    let r = (await lib.review(sheet.id, 'good', t0)).review!;
    expect(r).toMatchObject({ next: t0 + day, interval: 1, count: 1 });
    expect(isDue(lib.get(sheet.id)!, t0)).toBe(false);
    r = (await lib.review(sheet.id, 'good', t0)).review!;
    expect(r.interval).toBe(3);
    r = (await lib.review(sheet.id, 'easy', t0)).review!;
    expect(r.interval).toBe(14);
    expect(studyStatus(lib.get(sheet.id)!)).toBe('done');
    r = (await lib.review(sheet.id, 'again', t0)).review!;
    expect(r).toMatchObject({ interval: 1, count: 0 });
    expect((await lib.review(sheet.id, 'stop')).review).toBeUndefined();
  });

  it('opens images and texts, with pins and paragraphs', async () => {
    const png = join(dir, 'Courbe de demande.png');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const txt = join(dir, 'Résumé.md');
    await writeFile(txt, '# Chapitre 1\n\nPremier paragraphe.\n\nSecond.');
    const image = await lib.addLocalFile(png);
    const text = await lib.addLocalFile(txt);
    expect([image.kind, text.kind]).toEqual(['image', 'text']);
    expect(await lib.readText(text.id)).toContain('Premier paragraphe.');
    await expect(lib.readText(image.id)).rejects.toThrow();

    await lib.setPins(image.id, [{ n: 1, x: 0.2, y: 0.3, createdAt: 1 }]);
    await lib.saveNote(image.id, '[pin 1] Point d’équilibre');
    expect(positionLabel(lib.get(image.id)!)).toBe('1 repère');
    expect(lib.get(image.id)?.noteCount).toBe(1);

    await lib.setProgress(text.id, 2, 3);
    expect(positionLabel(lib.get(text.id)!)).toBe('§ 2 / 3');
  });
});

