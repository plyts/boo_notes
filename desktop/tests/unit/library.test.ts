import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontMatter, serializeFrontMatter } from '../../src/core/frontmatter';
import { extractCards, plainText, writeExport } from '../../src/core/export';
import { countNotes, isDue, kindForFile, kindForUrl, Library, safeFileName } from '../../src/core/library';
import type { ExtensionNote } from '../../src/core/types';
import { noteView, resourceView, snapshot } from '../../src/core/views';

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

  it('recognises the supported formats and addresses', () => {
    expect(kindForUrl('https://radio.test/live/stream.mp3')).toBe('audio');
    expect(kindForUrl('https://cdn.test/cours/master.m3u8?token=1')).toBe('video');
    expect(kindForUrl('https://cours.test/poly.pdf')).toBe('pdf');
    expect(kindForUrl('https://www.coursera.org/learn/ml')).toBe('page');
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
  it('stores extension notes as readable Markdown, with their media as a resource', async () => {
    await lib.upsertFromExtension(note(2, '[00:05] Intro\n[00:09] Suite'));
    const stale = await lib.upsertFromExtension(note(1, '[00:05] Ancien'));
    expect(stale.rev).toBe(2);
    const n = lib.getNote('youtube:abcdefghijk')!;
    expect(n).toMatchObject({ origin: 'extension', noteFile: 'Cours React Hooks.md', noteCount: 2, resources: ['youtube:abcdefghijk'] });
    expect(lib.getResource('youtube:abcdefghijk')).toMatchObject({
      kind: 'video',
      origin: 'extension',
      source: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
    const file = await readFile(join(lib.path, n.noteFile), 'utf8');
    expect(file).toContain('title: "Cours : React / Hooks ?"');
    expect(file).toContain('[00:09](https://www.youtube.com/watch?v=abcdefghijk#t=9) Suite');

    // Persisted across restarts.
    const again = new Library(lib.path);
    await again.open();
    expect(again.getNote(n.id)?.rev).toBe(2);
    expect(again.getResource(n.id)?.kind).toBe('video');
  });

  it('keeps a position received before its note', async () => {
    expect(await lib.setExtensionProgress('youtube:abcdefghijk', 120, 600, 5)).toBeNull();
    const n = await lib.upsertFromExtension(note(1));
    const view = noteView(lib, n);
    expect(lib.getResource(n.id)?.progress).toEqual({ position: 120, duration: 600, updatedAt: 5 });
    expect(view.ratio).toBeCloseTo(0.2);
    expect(view.positionLabel).toBe('02:00 / 10:00');
    expect(view.studyStatus).toBe('doing');
  });

  it('imports a file as a resource with its note, once', async () => {
    const pdf = join(dir, 'Algèbre linéaire.pdf');
    await writeFile(pdf, '%PDF-1.4');
    const first = await lib.importFiles([pdf]);
    const second = await lib.importFiles([pdf, join(dir, 'notes.docx')]);
    expect(second.notes[0].id).toBe(first.notes[0].id);
    expect(second.errors[0]).toMatch(/Format non pris en charge/);
    const n = first.notes[0];
    const res = lib.getResource(n.resources[0])!;
    expect(res).toMatchObject({ kind: 'pdf', platform: 'local', title: 'Algèbre linéaire', origin: 'file' });
    expect(n).toMatchObject({ title: 'Algèbre linéaire', origin: 'desktop' });

    const saved = await lib.saveNote(n.id, '[p. 3] Définition\n[p. 7] Théorème');
    expect(saved).toMatchObject({ rev: 1, noteCount: 2 });
    expect(parseFrontMatter(await readFile(join(lib.path, n.noteFile), 'utf8'))).toMatchObject({
      data: { title: 'Algèbre linéaire', kind: 'pdf', source: pdf },
      body: '[p. 3] Définition\n[p. 7] Théorème',
    });

    await lib.setProgress(res.id, 12, 40);
    await lib.setProgress(res.id, 5, 40);
    expect(lib.getResource(res.id)?.furthest).toBe(12);
    expect(noteView(lib, lib.getNote(n.id)!)).toMatchObject({ positionLabel: 'p. 5 / 40' });
    expect(resourceView(lib, lib.getResource(res.id)!).ratio).toBeCloseTo(0.3);
    await lib.setProgress(res.id, 40, 40);
    expect(noteView(lib, lib.getNote(n.id)!).studyStatus).toBe('done');
    await lib.updateNote(n.id, { status: 'todo' });
    expect(noteView(lib, lib.getNote(n.id)!).studyStatus).toBe('todo');
  });

  it('refuses to edit extension notes and paths outside the vault', async () => {
    await lib.upsertFromExtension(note(1));
    await expect(lib.saveNote('youtube:abcdefghijk', 'x')).rejects.toThrow(/extension/);
    await expect(lib.unlinkResource('youtube:abcdefghijk', 'youtube:abcdefghijk')).rejects.toThrow();
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
    lib.on('changed', (id, reason) => reasons.push(`${id === null ? '-' : 'note'}:${reason}`));
    await lib.upsertFromExtension(note(1));
    await lib.setExtensionProgress('youtube:abcdefghijk', 1, 10);
    await lib.setNotion('youtube:abcdefghijk', { pageId: 'p', blocks: [], syncedAt: 1, syncedRev: 1 });
    await lib.updateNote('youtube:abcdefghijk', { status: 'done' });
    await lib.removeNote('youtube:abcdefghijk');
    expect(reasons).toEqual(['note:content', 'note:progress', 'note:notion', 'note:meta', 'note:removed']);
  });

  it('creates revision sheets, links them and lists backlinks', async () => {
    const newton = await lib.createNote({ title: 'Lois de Newton', body: '# Trois lois\nVoir [[Forces]] et [[énergie|l’énergie]].' });
    expect(noteView(lib, newton)).toMatchObject({ kind: 'note', source: '', links: ['Forces', 'énergie'] });
    expect((await lib.ensureNote('lois de  newton')).id).toBe(newton.id);
    expect((await lib.createNote({ title: 'Lois de Newton' })).title).toBe('Lois de Newton (2)');
    const forces = await lib.ensureNote('Forces');
    const energie = await lib.createNote({ title: 'Énergie' });
    expect(lib.findByTitle('ENERGIE')?.id).toBe(energie.id);
    expect(lib.backlinks(forces.id).map((i) => i.id)).toEqual([newton.id]);
    expect(lib.titles()).toEqual(expect.arrayContaining(['Lois de Newton', 'Forces', 'Énergie']));

    // Renaming a note rewrites the links pointing to it (aliases kept).
    await lib.updateNote(energie.id, { title: 'Énergie mécanique' });
    expect(await lib.readNote(newton.id)).toBe('# Trois lois\nVoir [[Forces]] et [[Énergie mécanique|l’énergie]].');
    expect(lib.backlinks(energie.id).map((i) => i.id)).toEqual([newton.id]);
    const file = await readFile(join(lib.path, newton.noteFile), 'utf8');
    expect(file).toMatch(/^---\ntitle: "Lois de Newton"\nkind: note\n/);
  });

  it('schedules reviews with growing intervals', async () => {
    const sheet = await lib.createNote({ title: 'Dérivées', body: 'f′(x) = lim …' });
    const day = 86_400_000;
    const t0 = new Date(2026, 0, 10, 9).getTime();
    expect((await lib.review(sheet.id, 'start', t0)).review).toEqual({ next: t0, interval: 0, count: 0 });
    expect(isDue(lib.getNote(sheet.id)!, t0)).toBe(true);
    let r = (await lib.review(sheet.id, 'good', t0)).review!;
    expect(r).toMatchObject({ next: t0 + day, interval: 1, count: 1 });
    expect(isDue(lib.getNote(sheet.id)!, t0)).toBe(false);
    r = (await lib.review(sheet.id, 'good', t0)).review!;
    expect(r.interval).toBe(3);
    r = (await lib.review(sheet.id, 'easy', t0)).review!;
    expect(r.interval).toBe(14);
    expect(noteView(lib, lib.getNote(sheet.id)!).studyStatus).toBe('done');
    r = (await lib.review(sheet.id, 'again', t0)).review!;
    expect(r).toMatchObject({ interval: 1, count: 0 });
    expect((await lib.review(sheet.id, 'stop')).review).toBeUndefined();
  });

  it('opens images and texts, with pins and paragraphs', async () => {
    const png = join(dir, 'Courbe de demande.png');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const txt = join(dir, 'Résumé.md');
    await writeFile(txt, '# Chapitre 1\n\nPremier paragraphe.\n\nSecond.');
    const [imageNote, textNote] = (await lib.importFiles([png, txt])).notes;
    const image = lib.getResource(imageNote.resources[0])!;
    const text = lib.getResource(textNote.resources[0])!;
    expect([image.kind, text.kind]).toEqual(['image', 'text']);
    expect(await lib.readText(text.id)).toContain('Premier paragraphe.');
    await expect(lib.readText(image.id)).rejects.toThrow();

    await lib.setPins(image.id, [{ n: 1, x: 0.2, y: 0.3, createdAt: 1 }]);
    await lib.saveNote(imageNote.id, '[pin 1] Point d’équilibre');
    expect(noteView(lib, lib.getNote(imageNote.id)!).positionLabel).toBe('1 repère');
    expect(lib.getNote(imageNote.id)?.noteCount).toBe(1);

    await lib.setProgress(text.id, 2, 3);
    expect(noteView(lib, lib.getNote(textNote.id)!).positionLabel).toBe('§ 2 / 3');
  });
});

describe('Courses, chapters and notes linked to several resources', () => {
  it('files notes in chapters of courses, in order', async () => {
    const course = await lib.createCourse({ title: 'Physique' });
    expect(course.chapters).toHaveLength(1);
    const ch2 = await lib.addChapter(course.id, 'Électricité');
    const ch1 = course.chapters[0];
    const a = await lib.createNote({ title: 'Loi d’Ohm', placement: { courseId: course.id, chapterId: ch2.id } });
    const b = await lib.createNote({ title: 'Tension', placement: { courseId: course.id, chapterId: ch2.id, index: 0 } });
    const c = await lib.createNote({ title: 'Inbox' });
    expect(lib.getCourse(course.id)!.chapters[1].notes).toEqual([b.id, a.id]);
    expect(lib.placement(a.id)).toEqual({ courseId: course.id, chapterId: ch2.id });

    await lib.placeNote(a.id, { courseId: course.id, chapterId: ch1.id });
    await lib.moveChapter(course.id, ch2.id, 0);
    const snap = snapshot(lib);
    const cv = snap.courses[0];
    expect(cv.chapters.map((ch) => [ch.title, ch.notes])).toEqual([
      ['Électricité', [b.id]],
      ['Chapitre 1', [a.id]],
    ]);
    expect(cv.noteCount).toBe(2);
    expect(snap.inbox).toEqual([c.id]);
    expect(snap.notes.find((n) => n.id === a.id)).toMatchObject({ courseId: course.id, chapterId: ch1.id });

    // A course keeps at least one chapter; a removed chapter hands its notes to the previous one.
    await lib.removeChapter(course.id, ch1.id);
    expect(lib.placement(a.id)?.chapterId).toBe(ch2.id);
    await expect(lib.removeChapter(course.id, ch2.id)).rejects.toThrow(/au moins un chapitre/);
    await lib.removeCourse(course.id);
    expect(lib.placement(a.id)).toBeNull();
    expect(snapshot(lib).inbox).toHaveLength(3);
  });

  it('links a note to several resources and keeps each anchor on its resource', async () => {
    const pdf = join(dir, 'Poly.pdf');
    const mp3 = join(dir, 'Cours 1.mp3');
    await writeFile(pdf, '%PDF-1.4');
    await writeFile(mp3, 'ID3');
    const poly = await lib.addFile(pdf);
    const audio = await lib.addFile(mp3);
    const stream = await lib.addUrl('https://radio.test/cours/live.m3u8', { title: 'Direct' });
    expect(stream).toMatchObject({ kind: 'video', origin: 'url', title: 'Direct' });

    const n = await lib.createNote({ title: 'Synthèse', resources: [poly.id] });
    await lib.linkResource(n.id, audio.id);
    await lib.saveNote(n.id, `[p. 3] définition\n[04:15](res:${audio.id}) exemple`);
    expect(lib.notesOf(audio.id).map((x) => x.id)).toEqual([n.id]);

    // The audio becomes the main resource: each anchor still points where it did.
    await lib.setPrimaryResource(n.id, audio.id);
    expect(lib.getNote(n.id)!.resources).toEqual([audio.id, poly.id]);
    expect(await lib.readNote(n.id)).toBe(`[p. 3](res:${poly.id}) définition\n[04:15] exemple`);

    await lib.unlinkResource(n.id, audio.id);
    expect(await lib.readNote(n.id)).toBe(`[p. 3] définition\n[04:15](res:${audio.id}) exemple`);
    await lib.removeResource(poly.id);
    expect(lib.getNote(n.id)!.resources).toEqual([]);
  });

  it('files a browser note in the course and chapter chosen in the extension', async () => {
    await lib.upsertFromExtension({ ...note(1), course: 'React', chapter: 'Hooks', placedAt: 10 });
    const course = lib.listCourses()[0];
    expect(course).toMatchObject({ title: 'React' });
    expect(course.chapters.map((c) => c.title)).toEqual(['Chapitre 1', 'Hooks']);
    expect(lib.placement('youtube:abcdefghijk')?.chapterId).toBe(course.chapters[1].id);

    // Moved in the app afterwards: an older filing from the browser does not undo it.
    await lib.placeNote('youtube:abcdefghijk', { courseId: course.id, chapterId: course.chapters[0].id });
    await lib.upsertFromExtension({ ...note(2), course: 'React', chapter: 'Hooks', placedAt: 10 });
    expect(lib.placement('youtube:abcdefghijk')?.chapterId).toBe(course.chapters[0].id);
  });

  it('migrates a v1 library: each item becomes a note and a resource', async () => {
    const vault = join(dir, 'old');
    await mkdir(join(vault, '.boo'), { recursive: true });
    await writeFile(join(vault, 'A.md'), '---\ntitle: "A"\n---\n\n[p. 2] x');
    await writeFile(
      join(vault, '.boo', 'library.json'),
      JSON.stringify({
        version: 1,
        items: {
          'file:1': { id: 'file:1', origin: 'desktop', kind: 'pdf', platform: 'local', title: 'A', source: '/x/A.pdf', noteFile: 'A.md', rev: 3, createdAt: 1, updatedAt: 2, progress: { position: 2, duration: 9, updatedAt: 2 }, highlights: [] },
          'note:1': { id: 'note:1', origin: 'desktop', kind: 'note', platform: 'local', title: 'Fiche', source: '', noteFile: 'Fiche.md', rev: 1, createdAt: 1, updatedAt: 1, review: { next: 5, interval: 1, count: 1 } },
        },
      }),
    );
    const old = new Library(vault);
    await old.open();
    expect(old.getNote('file:1')).toMatchObject({ resources: ['file:1'], rev: 3 });
    expect(old.getResource('file:1')).toMatchObject({ kind: 'pdf', origin: 'file', progress: { position: 2 } });
    expect(old.getNote('note:1')).toMatchObject({ resources: [], review: { interval: 1 } });
    expect(JSON.parse(await readFile(join(vault, '.boo', 'library.json'), 'utf8')).version).toBe(2);
    expect(JSON.parse(await readFile(join(vault, '.boo', 'library.v1.json'), 'utf8')).version).toBe(1);
  });
});

describe('Export', () => {
  it('finds flashcards in notes', () => {
    const md = [
      'Loi d’Ohm :: U = R × I',
      '- Unité de R :: l’ohm (Ω)',
      'Qu’est-ce qu’un conducteur ohmique',
      '?',
      'Un dipôle qui suit la loi d’Ohm',
      '',
      '## Pourquoi R dépend-elle de la température ?',
      'Agitation thermique des atomes.',
      '',
      'La tension se mesure en ==volts== avec un ==voltmètre==.',
      '```',
      'a :: b',
      '```',
    ].join('\n');
    const cards = extractCards('n', md);
    expect(cards.map((c) => [c.type, c.front, c.back])).toEqual([
      ['basic', 'Loi d’Ohm', 'U = R × I'],
      ['basic', 'Unité de R', 'l’ohm (Ω)'],
      ['basic', 'Qu’est-ce qu’un conducteur ohmique', 'Un dipôle qui suit la loi d’Ohm'],
      ['basic', 'Pourquoi R dépend-elle de la température ?', 'Agitation thermique des atomes.'],
      ['cloze', 'La tension se mesure en {{c1::volts}} avec un {{c2::voltmètre}}.', ''],
    ]);
    expect(plainText('[04:15](res:x) voir [[Ohm|la loi]] et [p. 3](res:y) **fort**')).toBe('04:15 voir la loi et p. 3 fort');
  });

  it('writes courses as folders, revision sheets, Anki cards and JSON', async () => {
    const course = await lib.createCourse({ title: 'Physique', emoji: '⚡' });
    const ch = course.chapters[0];
    await lib.updateChapter(course.id, ch.id, { title: 'Électricité' });
    const mp3 = join(dir, 'Cours 1.mp3');
    await writeFile(mp3, 'ID3');
    const { notes } = await lib.importFiles([mp3], { courseId: course.id, chapterId: ch.id });
    await lib.saveNote(notes[0].id, '[04:15] loi\nLoi d’Ohm :: U = R × I\n![Capture](assets/a.jpg)');
    await lib.putAsset('assets/a.jpg', Buffer.from('jpeg'));
    await lib.createNote({ title: 'Brouillon' });

    const out = join(dir, 'export');
    const res = await writeExport(lib, out, { formats: ['markdown', 'sheets', 'cards', 'json'] });
    expect(res).toMatchObject({ notes: 2, cards: 1, warnings: [] });
    const md = await readFile(join(out, 'Cours', 'Physique', '01 - Électricité', 'Cours 1.md'), 'utf8');
    expect(md).toContain('course: "Physique"');
    expect(md).toContain('chapter: "Électricité"');
    expect(md).toContain('](../../../assets/a.jpg)');
    expect(await readFile(join(out, 'assets', 'a.jpg'), 'utf8')).toBe('jpeg');
    expect(await readFile(join(out, 'Non classées', 'Brouillon.md'), 'utf8')).toContain('title: "Brouillon"');
    const html = await readFile(join(out, 'Fiches de révision.html'), 'utf8');
    expect(html).toContain('⚡ Physique');
    expect(html).toContain('Loi d’Ohm');
    const anki = await readFile(join(out, 'Cartes - questions (Anki).txt'), 'utf8');
    expect(anki).toContain('#notetype:Basic');
    expect(anki).toMatch(/Loi d’Ohm\tU = R × I\tBoo Notes::Physique\tboo cours::physique chapitre::electricite/);
    const json = JSON.parse(await readFile(join(out, 'boo-notes.json'), 'utf8'));
    expect(json).toMatchObject({ format: 'boo-notes-export', version: 1 });
    expect(json.courses[0].chapters[0].notes).toHaveLength(1);
    expect(json.cards[0]).toMatchObject({ front: 'Loi d’Ohm', back: 'U = R × I', course: 'Physique', chapter: 'Électricité' });
    expect(res.sheetsHtml).toBe(join(out, 'Fiches de révision.html'));
  });
});
