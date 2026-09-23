// Sandboxed preload: exposes a narrow, typed API (window.boo) instead of Node / Electron.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS as C, type BooApi } from '../ipc';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: BooApi = {
  platform: process.platform,
  library: {
    list: () => invoke(C.libraryList),
    get: (id) => invoke(C.libraryGet, id),
    openFiles: () => invoke(C.libraryOpenFiles),
    addFiles: (paths) => invoke(C.libraryAddFiles, paths),
    readNote: (id) => invoke(C.libraryReadNote, id),
    saveNote: (id, markdown) => invoke(C.librarySaveNote, id, markdown),
    setProgress: (id, position, duration) => invoke(C.librarySetProgress, id, position, duration),
    addStudyTime: (id, ms) => invoke(C.libraryAddStudyTime, id, ms),
    setHighlights: (id, highlights) => invoke(C.librarySetHighlights, id, highlights),
    update: (id, patch) => invoke(C.libraryUpdate, id, patch),
    remove: (id, deleteNote) => invoke(C.libraryRemove, id, deleteNote),
    readFile: (id) => invoke(C.libraryReadFile, id),
    saveCapture: (id, dataUrl, seconds) => invoke(C.librarySaveCapture, id, dataUrl, seconds),
    reveal: (id) => invoke(C.libraryReveal, id),
    openSource: (id, seconds) => invoke(C.libraryOpenSource, id, seconds),
  },
  notion: {
    connect: (token, target) => invoke(C.notionConnect, token, target),
    disconnect: () => invoke(C.notionDisconnect),
    syncItem: (id) => invoke(C.notionSyncItem, id),
    syncAll: () => invoke(C.notionSyncAll),
    open: (id) => invoke(C.notionOpen, id),
  },
  settings: {
    get: () => invoke(C.settingsGet),
    set: (patch) => invoke(C.settingsSet, patch),
    regenerateToken: () => invoke(C.settingsRegenerateToken),
    chooseVault: () => invoke(C.settingsChooseVault),
    openVault: () => invoke(C.settingsOpenVault),
    copy: (text) => invoke(C.settingsCopy, text),
    openExternal: (url) => invoke(C.settingsOpenExternal, url),
  },
  status: () => invoke(C.status),
  on: ((event: string, cb: (...args: unknown[]) => void) => {
    const listener = (_e: unknown, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(`event:${event}`, listener);
    return () => ipcRenderer.off(`event:${event}`, listener);
  }) as BooApi['on'],
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('boo', api);
