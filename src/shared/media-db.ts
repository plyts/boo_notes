import type { MediaMeta } from './messages';

/**
 * Recorded media of the extension (passage extracts, audio trace of a
 * course), in IndexedDB: too large for chrome.storage. Shared by the service
 * worker (writes, desktop sync) and the notes panel (playback), which live in
 * the same extension origin.
 */
export interface MediaRecord extends MediaMeta {
  blob: Blob;
  size: number;
  createdAt: number;
  /** Sent to the desktop app. */
  synced?: boolean;
}

const DB = 'boo-notes-media';
const STORE = 'media';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'path' });
      store.createIndex('noteId', 'noteId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponible'));
  }).catch((e: unknown) => {
    opening = null;
    throw e;
  });
  return opening;
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB : transaction annulée'));
      }),
  );
}

export function putMedia(record: MediaRecord): Promise<IDBValidKey> {
  return request('readwrite', (s) => s.put(record));
}

export async function getMedia(path: string): Promise<MediaRecord | null> {
  return ((await request('readonly', (s) => s.get(path))) as MediaRecord | undefined) ?? null;
}

/** Media of a note (passages and audio trace), in time order. */
export async function listMedia(noteId: string): Promise<MediaRecord[]> {
  const all = (await request('readonly', (s) => s.index('noteId').getAll(noteId))) as MediaRecord[];
  return all.sort((a, b) => a.start - b.start);
}

/** Media not yet sent to the desktop app. */
export async function unsyncedMedia(): Promise<MediaMeta[]> {
  const all = (await request('readonly', (s) => s.getAll())) as MediaRecord[];
  return all.filter((r) => !r.synced).map(({ path, noteId, kind, mime, start, end, name }) => ({ path, noteId, kind, mime, start, end, ...(name ? { name } : {}) }));
}

export async function markMediaSynced(path: string, synced = true): Promise<void> {
  const r = await getMedia(path);
  if (r && Boolean(r.synced) !== synced) await putMedia({ ...r, synced });
}

export async function markAllMediaUnsynced(): Promise<void> {
  const all = (await request('readonly', (s) => s.getAll())) as MediaRecord[];
  for (const r of all) if (r.synced) await putMedia({ ...r, synced: false });
}

export function deleteMedia(path: string): Promise<undefined> {
  return request('readwrite', (s) => s.delete(path));
}

export function clearMedia(): Promise<undefined> {
  return request('readwrite', (s) => s.clear());
}
