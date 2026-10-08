import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionNotion, noteToSyncItem, pickVaultParent } from '../../src/background/notion';
import type { NotionPlace, NotionStatus } from '../../src/shared/messages';
import { NoteStore } from '../../src/shared/store';
import { TranscriptStore } from '../../src/shared/transcript-store';
import { PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../tools/mock-notion/server.mjs';
import { MemoryArea } from './helpers';

const page = { platform: 'web' as const, url: 'https://cours.test/ohm', title: 'La loi d’Ohm', kind: 'page' as const };
const video = { platform: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Électricité — vidéo', kind: 'video' as const };

let mock: MockNotion;
let area: MemoryArea;
let store: NoteStore;
let notion: ExtensionNotion;
let desktopOnline: boolean;
let linked: string[];
let statuses: NotionStatus[];

beforeEach(async () => {
  mock = startMockNotion();
  await mock.ready;
  mock.seedPage(PARENT_PAGE_ID, 'Mes cours');
  area = new MemoryArea();
  store = new NoteStore(area);
  desktopOnline = false;
  linked = [];
  statuses = [];
  notion = new ExtensionNotion({
    area,
    store,
    desktopHandlesNotion: () => desktopOnline,
    onLinked: (id) => linked.push(id),
    onStatus: (s) => statuses.push(s),
    debounceMs: 60_000,
    clientOptions: { minIntervalMs: 0, sleep: async () => undefined },
  });
  notion.apiBase = mock.url;
});

afterEach(async () => {
  await mock.close();
});

describe('noteToSyncItem', () => {
  it('describes a web page read at 62 %, with its quotes and links', () => {
    const item = noteToSyncItem(
      {
        id: 'web:cours.test/ohm',
        ...page,
        markdown: '> U = R × I [↗](https://cours.test/ohm#:~:text=U%20%3D%20R) voir [[Résistances]]',
        createdAt: 1,
        updatedAt: 2,
        rev: 3,
      },
      { position: 62, duration: 100, updatedAt: 2 },
    );
    expect(item).toMatchObject({ kind: 'page', ratio: 0.62, position: '62 % lu', status: 'doing', noteCount: 1, links: ['Résistances'] });
  });
});

describe('ExtensionNotion (direct sync, desktop app closed)', () => {
  it('connects to a page: it becomes the vault, its table « Toutes les notes » made there — once, whatever the reconnections', async () => {
    const status = await notion.connect('secret_test', `https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
    expect(status).toMatchObject({ configured: true, origin: 'extension', vault: 'Mes cours' });
    const [db] = [...mock.state.databases.values()];
    expect(db.is_inline).toBe(false);
    expect(db.title[0].text.content).toBe('Toutes les notes');
    expect(db.parent).toMatchObject({ page_id: PARENT_PAGE_ID });
    // The table lists what reads at a glance.
    expect(Object.keys(db.properties)).toEqual(expect.arrayContaining(['Nom', 'Cours', 'Chapitre', 'Statut', 'Progression', 'Type', 'Plateforme', 'Source', 'Boo ID', 'Liens']));
    expect(Object.keys(db.properties)).not.toContain('Position');
    // Connected again (another time, another device): the same table, not a second one.
    await notion.disconnect();
    await notion.connect('secret_test', PARENT_PAGE_ID);
    expect(mock.state.databases.size).toBe(1);
  });

  it('writes a note with its [[links]] as mentions and relations', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote('youtube:abcdefghijk', video, 'Intro');
    await store.saveNote('web:cours.test/ohm', page, '> U = R × I [↗](https://cours.test/ohm#:~:text=U) — voir [[Électricité — vidéo]]');

    const { url } = await notion.syncNow('web:cours.test/ohm');
    expect(url).toBeTruthy();
    const link = await notion.link('web:cours.test/ohm');
    const other = await notion.link('youtube:abcdefghijk');
    expect(link?.syncedRev).toBe(1);
    // The linked video got its page (content written by the follow-up sync).
    expect(other?.pageId).toBeTruthy();
    const props = mock.state.pages.get(link!.pageId.replace(/-/g, ''))!.properties;
    expect(props.Liens.relation).toEqual([{ id: other!.pageId }]);
    expect(props.Type.select.name).toBe('Page web');
    expect(linked).toContain('web:cours.test/ohm');
    const content = JSON.stringify(mock.pageContent(link!.pageId));
    expect(content).toContain('U = R × I');
  });

  it('writes a course lesson: link to the lesson, capture, passage, timestamps, transcript', async () => {
    // A lesson of a course platform (SCORM module): the page's URL is a bookmark, not a video block.
    const lesson = {
      platform: 'web' as const,
      url: 'https://customer-academy.databricks.com/learn/courses/2971/pipelines/lessons/63328:4384/course-project-and-dataset-types-overview',
      title: 'Course Project and Dataset Types Overview',
      kind: 'video' as const,
    };
    const id = 'web:customer-academy.databricks.com/learn/courses/2971/pipelines/lessons/63328:4384/course-project-and-dataset-types-overview';
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M9QzwAEjDAGNzYAAB0VAwFyX4bOAAAAAElFTkSuQmCC';
    const shot = await store.saveAsset({ noteId: id, dataUrl: png, mime: 'image/png', width: 2, height: 2, time: 12 });
    const card = await store.saveAsset({ noteId: id, dataUrl: png, mime: 'image/png', width: 2, height: 2, time: 125 });
    await new TranscriptStore(area).put(id, { lang: 'en', label: 'Sous-titres du lecteur · anglais', source: 'track', complete: true, duration: 300 }, [
      { id: 'c5', start: 5, end: 8, text: 'Welcome to the course project.' },
    ], true);
    await store.saveNote(
      id,
      lesson,
      [
        '[00:05] Le projet du cours',
        `[00:12] ![Capture 00:12](${shot.path})`,
        `[02:05–06:07] ![Passage 02:05–06:07 · Streaming tables](${card.path}) [Extrait](media/lesson-passage-02-05-ab12.webm)`,
        '📄 [Transcription — anglais · 1 réplique](transcripts/lesson.md)',
      ].join('\n'),
    );
    await notion.connect('secret_test', PARENT_PAGE_ID);
    const { url } = await notion.syncNow(id);
    expect(url).toBeTruthy();
    const pageId = (await notion.link(id))!.pageId;
    const blocks = [...mock.state.blocks.values()].filter((b) => b.parentId?.replace(/-/g, '') === pageId.replace(/-/g, ''));
    expect(blocks[0]).toMatchObject({ type: 'bookmark', bookmark: { url: lesson.url } });
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2);
    const content = JSON.stringify(mock.pageContent(pageId));
    expect(content).toContain('Le projet du cours');
    expect(content).toContain('Welcome to the course project.');
  });

  it('queues changes and leaves them to the desktop app when it is connected', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote('web:cours.test/ohm', page, 'a');
    await notion.enqueue('web:cours.test/ohm');
    expect((await notion.status()).pending).toBe(1);

    desktopOnline = true;
    await notion.flush();
    expect((await notion.status()).pending).toBe(0);
    expect(await notion.link('web:cours.test/ohm')).toBeUndefined();

    desktopOnline = false;
    await notion.enqueue('web:cours.test/ohm');
    await notion.flush();
    expect((await notion.status()).pending).toBe(0);
    expect((await notion.link('web:cours.test/ohm'))?.syncedRev).toBe(1);
  });

  it('keeps a change made during a sync for the next one', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote('web:cours.test/ohm', page, 'v1');
    await notion.enqueue('web:cours.test/ohm');
    const flushing = notion.flush();
    await notion.enqueue('web:cours.test/ohm'); // Edited again while writing.
    await flushing;
    expect((await notion.status()).pending).toBe(1);
  });

  it('follows the connection shared by the desktop app', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    const databaseId = [...mock.state.databases.keys()][0];
    await notion.applyDesktopConfig({ token: 'secret_test', databaseId, databaseUrl: 'https://notion.so/db', workspace: 'Perso', apiBase: mock.url });
    expect(await notion.status()).toMatchObject({ configured: true, origin: 'desktop', workspace: 'Perso' });
    // Sharing turned off in the app: the shared connection goes away.
    await notion.applyDesktopConfig(null);
    expect((await notion.status()).configured).toBe(false);
  });

  it('keeps its own connection when the app shares none', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await notion.applyDesktopConfig(null);
    expect(await notion.status()).toMatchObject({ configured: true, origin: 'extension' });
  });

  it('adopts the newest page mapping sent by the app', async () => {
    const older = { pageId: 'p1', blocks: [], syncedAt: 10, syncedRev: 1 };
    const newer = { pageId: 'p1', blocks: [{ id: 'b', hash: 'h' }], syncedAt: 20, syncedRev: 2 };
    await notion.applyDesktopLink('n', newer);
    await notion.applyDesktopLink('n', older);
    expect(await notion.link('n')).toEqual(newer);
  });

  it('finds the Notion page of a revision sheet known only by its title', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote('web:cours.test/ohm', page, 'x');
    await notion.syncNow('web:cours.test/ohm');
    expect(await notion.pageUrlByTitle('La loi d’Ohm')).toBeTruthy();
    expect(await notion.pageUrlByTitle('Inconnue')).toBeNull();
  });

  it('reports a bad secret without losing the queue', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote('web:cours.test/ohm', page, 'x');
    await area.set({ 'notion:config': { ...(await area.get('notion:config'))['notion:config'] as object, token: 'wrong' } });
    const fresh = new ExtensionNotion({
      area,
      store,
      desktopHandlesNotion: () => false,
      clientOptions: { minIntervalMs: 0, sleep: async () => undefined },
    });
    await fresh.enqueue('web:cours.test/ohm');
    await fresh.flush();
    const status = await fresh.status();
    expect(status.pending).toBe(1);
    expect(status.lastError).toBeTruthy();
  });
});

describe('Le coffre Notion : une page par cours, ses leçons par chapitre, rien en double', () => {
  const lesson = (n: number) => ({ platform: 'web' as const, url: `https://academy.test/airflow/${n}`, title: `Leçon ${n}`, kind: 'video' as const });
  const idOf = (n: number) => `web:academy.test/airflow/${n}`;
  const childPages = (pageId: string) => mock.pageContent(pageId)!.filter((b) => b.type === 'child_page' || b.type === 'child_database').map((b) => b.text);

  it('range les leçons dans la page de leur cours, par chapitre, cochées une fois finies ; la note pointe vers son cours', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    for (const n of [1, 2, 3]) await store.saveNote(idOf(n), lesson(n), `[00:0${n}] idée ${n}`);
    await store.placeNote(idOf(1), lesson(1), { course: 'AI Orchestration', chapter: 'Les bases' });
    await store.placeNote(idOf(2), lesson(2), { course: 'AI Orchestration', chapter: 'Hooks' });
    await store.placeNote(idOf(3), lesson(3), { course: 'AI Orchestration', chapter: 'Les bases' });
    await store.saveProgress(idOf(1), 100, 100);
    for (const n of [1, 2, 3]) await notion.syncNow(idOf(n));

    expect(childPages(PARENT_PAGE_ID)).toEqual(['Toutes les notes', 'AI Orchestration']);
    const course = [...mock.state.pages.values()].find((p) => mock.titleOf(p.id) === 'AI Orchestration')!;
    const content = mock.pageContent(course.id)!;
    expect(content[0]).toMatchObject({ type: 'callout', text: '3 leçons · 2 chapitres · 1 terminée · 30 % du cours' });
    expect(content.slice(1).map((b) => (b.type === 'heading_2' ? `# ${b.text}` : `${b.checked ? '☑' : '☐'} ${b.text}`))).toEqual([
      '# Les bases',
      '☑ @Leçon 1  Terminé',
      '☐ @Leçon 3  En cours · 0 %',
      '# Hooks',
      '☐ @Leçon 2  En cours · 0 %',
    ]);
    // The note's page starts with where it is filed: its course's page, its chapter.
    const note = (await notion.link(idOf(2)))!.pageId;
    expect(mock.pageContent(note)![0]).toMatchObject({ type: 'callout', text: '@AI Orchestration  ›  Hooks' });
  });

  it('une leçon qui change de cours quitte la page de l’ancien ; les notes rangées nulle part ont la leur', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote(idOf(1), lesson(1), 'a');
    await store.saveNote(idOf(2), lesson(2), 'b');
    await store.placeNote(idOf(1), lesson(1), { course: 'Cours A', chapter: 'Ch 1' });
    await notion.syncNow(idOf(1));
    await notion.syncNow(idOf(2));
    expect(childPages(PARENT_PAGE_ID)).toEqual(['Toutes les notes', 'Cours A', 'Notes à ranger']);
    const page = (title: string) => [...mock.state.pages.values()].find((p) => mock.titleOf(p.id) === title && !p.archived)!;
    expect(JSON.stringify(mock.pageContent(page('Notes à ranger').id))).toContain('@Leçon 2');

    await store.placeNote(idOf(1), lesson(1), { course: 'Cours B', chapter: 'Ch 1' });
    await notion.syncNow(idOf(1));
    expect(JSON.stringify(mock.pageContent(page('Cours A').id))).toContain('Aucune leçon rangée ici');
    expect(JSON.stringify(mock.pageContent(page('Cours B').id))).toContain('@Leçon 1');
    // Synced again: nothing rewritten, nothing made twice.
    const writes = mock.state.requests.length;
    await notion.syncNow(idOf(1));
    expect(mock.state.requests.slice(writes).filter((r) => r.method === 'POST' && r.path === '/v1/pages')).toHaveLength(0);
    expect(childPages(PARENT_PAGE_ID).filter((t) => t === 'Cours B')).toHaveLength(1);
  });

  it('« Tout synchroniser » : la table vérifiée d’abord, les notes déjà à jour laissées telles quelles, les autres écrites', async () => {
    await notion.connect('secret_test', PARENT_PAGE_ID);
    await store.saveNote(idOf(1), lesson(1), 'a');
    await store.saveNote(idOf(2), lesson(2), 'b');
    await notion.syncNow(idOf(1));
    expect(await notion.syncAll()).toEqual({ ok: 1, failed: 0, unchanged: 1 });
    expect(await notion.syncAll()).toEqual({ ok: 0, failed: 0, unchanged: 2 });
    // Its page deleted in Notion: written again (found missing, made once).
    const gone = (await notion.link(idOf(1)))!.pageId;
    mock.state.pages.get(gone.replace(/-/g, ''))!.archived = true;
    const other = new ExtensionNotion({ area, store, desktopHandlesNotion: () => false, debounceMs: 60_000, clientOptions: { minIntervalMs: 0, sleep: async () => undefined } });
    other.apiBase = mock.url;
    expect(await other.syncAll()).toEqual({ ok: 1, failed: 0, unchanged: 1 });
    expect([...mock.state.pages.values()].filter((p) => p.parent?.database_id && !p.archived)).toHaveLength(2);
  });

  it('le coffre choisi ou nommé : retrouvé s’il existe (la copie du modèle mise à la corbeille), sinon fait — sans doublon', async () => {
    // First connection: Notion copied the template; named « Coursera notes ».
    mock.seedPage('33333333-3333-4333-8333-333333333333', 'Boo Notes');
    await notion.connectVault({ token: 'secret_test', templatePageId: '33333333-3333-4333-8333-333333333333' }, { name: 'Coursera notes' });
    const vault = mock.state.pages.get('33333333333343338333333333333333')!;
    expect(mock.titleOf(vault.id)).toBe('Coursera notes');
    expect(vault.icon).toEqual({ type: 'emoji', emoji: '👻' });
    expect(mock.pageContent(vault.id)!.map((b) => b.type)).toEqual(['callout', 'child_database', 'heading_2']);
    expect(await notion.vaults('secret_test')).toEqual([expect.objectContaining({ name: 'Coursera notes' })]);
    expect((await notion.status()).vault).toBe('Coursera notes');

    // Again, Notion copying its template again: the same vault, the copy to the trash.
    await notion.disconnect();
    mock.seedPage('44444444-4444-4444-8444-444444444444', 'Boo Notes');
    await notion.connectVault({ token: 'secret_test', templatePageId: '44444444-4444-4444-8444-444444444444' }, { name: 'coursera notes' });
    expect(mock.state.pages.get('44444444444444448444444444444444')!.archived).toBe(true);
    expect(mock.state.databases.size).toBe(1);
    expect((await notion.status()).vault).toBe('Coursera notes');

    // A new name, no template: a new vault, made in a page shared (the one about courses).
    await notion.disconnect();
    await notion.connectVault({ token: 'secret_test' }, { name: 'Sample notes' });
    const sample = [...mock.state.pages.values()].find((p) => mock.titleOf(p.id) === 'Sample notes')!;
    expect(sample.parent).toMatchObject({ page_id: PARENT_PAGE_ID });
    expect(mock.state.databases.size).toBe(2);
    expect((await notion.vaults('secret_test')).map((v) => v.name).sort()).toEqual(['Coursera notes', 'Sample notes']);
  });
});

describe('« Connecter Notion » : où faire le coffre, sans rien demander', () => {
  const page = (id: string, title: string): NotionPlace => ({ id, kind: 'page', title });

  it('la page partagée qui parle de cours ou de notes, sinon la première ; jamais un tableau', () => {
    expect(pickVaultParent([page('a', 'Journal'), page('b', 'Mes cours de maths')])?.id).toBe('b');
    expect(pickVaultParent([page('a', 'Journal'), page('b', 'Recettes')])?.id).toBe('a');
    expect(pickVaultParent([{ id: 'db', kind: 'database', title: 'Boo Notes — Mes notes' }])).toBeNull();
    expect(pickVaultParent([])).toBeNull();
  });
});
