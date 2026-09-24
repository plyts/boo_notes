import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionNotion, noteToSyncItem } from '../../src/background/notion';
import type { NotionStatus } from '../../src/shared/messages';
import { NoteStore } from '../../src/shared/store';
import { TranscriptStore } from '../../src/shared/transcript-store';
import { PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../desktop/tools/mock-notion.mjs';
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
  it('connects to a page: creates the inline notes table there', async () => {
    const status = await notion.connect('secret_test', `https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
    expect(status).toMatchObject({ configured: true, origin: 'extension' });
    const [db] = [...mock.state.databases.values()];
    expect(db.is_inline).toBe(true);
    expect(db.parent).toMatchObject({ page_id: PARENT_PAGE_ID });
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
