// Sandboxed preload: exposes a narrow, typed API (window.boo) instead of Node / Electron.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS as C, type BooApi } from '../ipc';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: BooApi = {
  platform: process.platform,
  material: process.argv.includes('--boo-material'),
  library: {
    snapshot: () => invoke(C.snapshot),
    readNote: (id) => invoke(C.readNote, id),
    saveNote: (id, markdown) => invoke(C.saveNote, id, markdown),
    createNote: (input) => invoke(C.createNote, input),
    ensureNote: (title) => invoke(C.ensureNote, title),
    updateNote: (id, patch) => invoke(C.updateNote, id, patch),
    removeNote: (id, deleteFile) => invoke(C.removeNote, id, deleteFile),
    linkResource: (noteId, resourceId, index) => invoke(C.linkResource, noteId, resourceId, index),
    unlinkResource: (noteId, resourceId) => invoke(C.unlinkResource, noteId, resourceId),
    setPrimaryResource: (noteId, resourceId) => invoke(C.setPrimaryResource, noteId, resourceId),
    review: (id, action) => invoke(C.review, id, action),
    placeNote: (id, dest) => invoke(C.placeNote, id, dest),
    revealNote: (id) => invoke(C.revealNote, id),
    openFiles: (placement) => invoke(C.openFiles, placement),
    importFiles: (paths, placement) => invoke(C.importFiles, paths, placement),
    pickResources: () => invoke(C.pickResources),
    addUrl: (url, opts) => invoke(C.addUrl, url, opts),
    updateResource: (id, patch) => invoke(C.updateResource, id, patch),
    removeResource: (id) => invoke(C.removeResource, id),
    readFile: (id) => invoke(C.readFile, id),
    readText: (id) => invoke(C.readText, id),
    setProgress: (id, position, duration) => invoke(C.setProgress, id, position, duration),
    addStudyTime: (id, ms) => invoke(C.addStudyTime, id, ms),
    setHighlights: (id, highlights) => invoke(C.setHighlights, id, highlights),
    setPins: (id, pins) => invoke(C.setPins, id, pins),
    saveCapture: (id, dataUrl, seconds) => invoke(C.saveCapture, id, dataUrl, seconds),
    openSource: (id, seconds) => invoke(C.openSource, id, seconds),
    createCourse: (input) => invoke(C.createCourse, input),
    updateCourse: (id, patch) => invoke(C.updateCourse, id, patch),
    removeCourse: (id) => invoke(C.removeCourse, id),
    moveCourse: (id, index) => invoke(C.moveCourse, id, index),
    addChapter: (courseId, title, index) => invoke(C.addChapter, courseId, title, index),
    updateChapter: (courseId, chapterId, patch) => invoke(C.updateChapter, courseId, chapterId, patch),
    removeChapter: (courseId, chapterId) => invoke(C.removeChapter, courseId, chapterId),
    moveChapter: (courseId, chapterId, index) => invoke(C.moveChapter, courseId, chapterId, index),
  },
  export: {
    run: (options) => invoke(C.exportRun, options),
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
