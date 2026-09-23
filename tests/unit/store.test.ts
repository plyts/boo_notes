import { describe, expect, it } from 'vitest';
import { NoteStore } from '../../src/shared/store';
import { MemoryArea } from './helpers';

const meta = { platform: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Vidéo' };

describe('NoteStore', () => {
  it('drafts unknown notes without persisting them', async () => {
    const area = new MemoryArea();
    const store = new NoteStore(area);
    const draft = await store.getOrDraft('youtube:abcdefghijk', meta);
    expect(draft).toMatchObject({ id: 'youtube:abcdefghijk', rev: 0, markdown: '' });
    expect(area.data.size).toBe(0);
  });

  it('bumps the revision, indexes the note and queues it for sync', async () => {
    const store = new NoteStore(new MemoryArea());
    await store.saveNote('youtube:abcdefghijk', meta, 'a', 'w1');
    const note = await store.saveNote('youtube:abcdefghijk', { ...meta, title: '' }, 'ab', 'w1');
    expect(note).toMatchObject({ rev: 2, markdown: 'ab', title: 'Vidéo', lastWriter: 'w1' });
    expect(await store.getOutbox()).toEqual({ 'youtube:abcdefghijk': 2 });
    expect(Object.keys(await store.listNotes())).toEqual(['youtube:abcdefghijk']);
  });

  it('serialises concurrent appends', async () => {
    const store = new NoteStore(new MemoryArea());
    await Promise.all([1, 2, 3].map((i) => store.appendToNote('n', meta, `line ${i}`)));
    const note = await store.getNote('n');
    expect(note?.markdown).toBe('line 1\nline 2\nline 3\n');
    expect(note?.rev).toBe(3);
  });

  it('keeps newer revisions in the outbox', async () => {
    const store = new NoteStore(new MemoryArea());
    await store.saveNote('n', meta, 'v1');
    await store.saveNote('n', meta, 'v2');
    await store.markSynced('n', 1);
    expect(await store.getOutbox()).toEqual({ n: 2 });
    await store.markSynced('n', 2);
    expect(await store.getOutbox()).toEqual({});
  });

  it('stores screenshots under assets/ with a readable name', async () => {
    const store = new NoteStore(new MemoryArea());
    const asset = await store.saveAsset({
      noteId: 'youtube:abcdefghijk',
      dataUrl: 'data:image/jpeg;base64,AAAA',
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      time: 255,
    });
    expect(asset.path).toMatch(/^assets\/youtube-abcdefghijk-04-15-[a-z0-9]{1,4}\.jpg$/);
    expect(await store.getAsset(asset.path)).toMatchObject({ width: 1920, time: 255 });
    expect(await store.isAssetSynced(asset.path)).toBe(false);
    await store.markAssetSynced(asset.path);
    expect(await store.isAssetSynced(asset.path)).toBe(true);
  });

  it('clears notes but not settings-like keys', async () => {
    const area = new MemoryArea();
    await area.set({ unrelated: 1 });
    const store = new NoteStore(area);
    await store.saveNote('n', meta, 'x');
    await store.clearAll();
    expect([...area.data.keys()]).toEqual(['unrelated']);
  });
});
