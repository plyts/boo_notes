import { create } from 'zustand';
import type { AppStatus, CourseView, LibrarySnapshot, NoteView, ResourceKind, ResourceView, SettingsView } from '../ipc';

/** Where the user is. Views are addressed like pages, with back / forward history. */
export type Route =
  | { name: 'today' }
  | { name: 'notes'; filter: 'all' | 'inbox' | 'due' }
  | { name: 'course'; id: string }
  | { name: 'note'; id: string; resource?: string; anchor?: { kind: 'time' | 'page' | 'section' | 'pin'; value: number } }
  | { name: 'resources'; kind: ResourceKind | 'all' }
  | { name: 'graph'; courseId?: string }
  | { name: 'review' }
  | { name: 'settings'; section?: string };

export interface Data {
  snap: LibrarySnapshot;
  notes: Map<string, NoteView>;
  resources: Map<string, ResourceView>;
  courses: Map<string, CourseView>;
}

const EMPTY: Data = {
  snap: { notes: [], resources: [], courses: [], inbox: [] },
  notes: new Map(),
  resources: new Map(),
  courses: new Map(),
};

function index(snap: LibrarySnapshot): Data {
  return {
    snap,
    notes: new Map(snap.notes.map((n) => [n.id, n])),
    resources: new Map(snap.resources.map((r) => [r.id, r])),
    courses: new Map(snap.courses.map((c) => [c.id, c])),
  };
}

const PREFS_KEY = 'boo:ui';

interface Prefs {
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  expanded: string[];
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { sidebarCollapsed: Boolean(p.sidebarCollapsed), inspectorOpen: p.inspectorOpen ?? true, expanded: p.expanded ?? [] };
  } catch {
    return { sidebarCollapsed: false, inspectorOpen: true, expanded: [] };
  }
}

interface State extends Data, Prefs {
  loaded: boolean;
  status: AppStatus | null;
  settings: SettingsView | null;
  route: Route;
  back: Route[];
  forward: Route[];
  paletteOpen: boolean;
  exportOpen: boolean;
  urlOpen: boolean;
  refresh(): Promise<void>;
  loadSettings(): Promise<void>;
  setStatus(status: AppStatus): void;
  setSettings(settings: SettingsView): void;
  go(route: Route, opts?: { replace?: boolean }): void;
  goBack(): void;
  goForward(): void;
  toggleSidebar(): void;
  toggleInspector(): void;
  setExpanded(ids: string[]): void;
  setPalette(open: boolean): void;
  setExport(open: boolean): void;
  setUrlOpen(open: boolean): void;
}

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

export const useApp = create<State>((set, get) => {
  const prefs = loadPrefs();
  const savePrefs = () => {
    const { sidebarCollapsed, inspectorOpen, expanded } = get();
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ sidebarCollapsed, inspectorOpen, expanded }));
    } catch {
      // Private storage unavailable: preferences last for the session.
    }
  };
  let refreshing: Promise<void> | null = null;
  let again = false;
  return {
    ...EMPTY,
    ...prefs,
    loaded: false,
    status: null,
    settings: null,
    route: { name: 'today' },
    back: [],
    forward: [],
    paletteOpen: false,
    exportOpen: false,
    urlOpen: false,

    refresh: async () => {
      // Coalesces bursts of change events into one fetch (plus one trailing).
      if (refreshing) {
        again = true;
        return refreshing;
      }
      refreshing = (async () => {
        do {
          again = false;
          const snap = await window.boo.library.snapshot();
          set({ ...index(snap), loaded: true });
        } while (again);
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    loadSettings: async () => set({ settings: await window.boo.settings.get() }),
    setStatus: (status) => set({ status }),
    setSettings: (settings) => set({ settings }),

    go: (route, opts = {}) => {
      const { route: current, back } = get();
      if (sameRoute(route, current)) return;
      if (opts.replace) set({ route });
      else set({ route, back: [...back.slice(-49), current], forward: [] });
    },
    goBack: () => {
      const { back, route, forward } = get();
      const prev = back.at(-1);
      if (!prev) return;
      set({ route: prev, back: back.slice(0, -1), forward: [route, ...forward] });
    },
    goForward: () => {
      const { back, route, forward } = get();
      const next = forward[0];
      if (!next) return;
      set({ route: next, back: [...back, route], forward: forward.slice(1) });
    },

    toggleSidebar: () => {
      set({ sidebarCollapsed: !get().sidebarCollapsed });
      savePrefs();
    },
    toggleInspector: () => {
      set({ inspectorOpen: !get().inspectorOpen });
      savePrefs();
    },
    setExpanded: (expanded) => {
      set({ expanded });
      savePrefs();
    },
    setPalette: (paletteOpen) => set({ paletteOpen }),
    setExport: (exportOpen) => set({ exportOpen }),
    setUrlOpen: (urlOpen) => set({ urlOpen }),
  };
});

// --- Selectors -------------------------------------------------------------------------------

export const useNote = (id: string | undefined) => useApp((s) => (id ? s.notes.get(id) : undefined));
export const useResource = (id: string | undefined) => useApp((s) => (id ? s.resources.get(id) : undefined));
export const useCourse = (id: string | undefined) => useApp((s) => (id ? s.courses.get(id) : undefined));

/** Notes linking to `note` with `[[Titre]]`. */
export function backlinksOf(notes: Iterable<NoteView>, note: NoteView): NoteView[] {
  const key = normalize(note.title);
  return [...notes].filter((n) => n.id !== note.id && (n.links ?? []).some((t) => normalize(t) === key));
}

/** The note a `[[Titre]]` points to, if it exists. */
export function noteByTitle(notes: Iterable<NoteView>, title: string): NoteView | undefined {
  const key = normalize(title);
  let found: NoteView | undefined;
  for (const n of notes) {
    if (normalize(n.title) !== key) continue;
    if (n.resources.length === 0) return n;
    found ??= n;
  }
  return found;
}

function normalize(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chapter and course of a note, for breadcrumbs. */
export function placementOf(data: Pick<Data, 'courses'>, note: NoteView): { course: CourseView; chapter: CourseView['chapters'][number] } | null {
  if (!note.courseId) return null;
  const course = data.courses.get(note.courseId);
  const chapter = course?.chapters.find((c) => c.id === note.chapterId);
  return course && chapter ? { course, chapter } : null;
}
