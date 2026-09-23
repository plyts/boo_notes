import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/format';
import { useApp, type Route } from '../store';
import { DialogHost, Icon, toast, Toasts } from '../ui';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';
import { ExportSheet } from '../views/ExportSheet';
import { UrlSheet } from '../views/UrlSheet';
import { Onboarding } from '../views/Onboarding';
import { TodayView } from '../views/TodayView';
import { NotesView } from '../views/NotesView';
import { CourseView } from '../views/CourseView';
import { NoteView } from '../views/NoteView';
import { ResourcesView } from '../views/ResourcesView';
import { GraphView } from '../views/GraphView';
import { ReviewView } from '../views/ReviewView';
import { SettingsView } from '../views/SettingsView';
import { newNote, openTitle } from '../actions';

function viewFor(route: Route): ReactNode {
  switch (route.name) {
    case 'today':
      return <TodayView />;
    case 'notes':
      return <NotesView filter={route.filter} />;
    case 'course':
      return <CourseView id={route.id} />;
    case 'note':
      return <NoteView id={route.id} resource={route.resource} anchor={route.anchor} />;
    case 'resources':
      return <ResourcesView kind={route.kind} />;
    case 'graph':
      return <GraphView courseId={route.courseId} />;
    case 'review':
      return <ReviewView />;
    case 'settings':
      return <SettingsView section={route.section} />;
  }
}

function routeKey(route: Route): string {
  return route.name === 'note' ? `note:${route.id}` : route.name === 'course' ? `course:${route.id}` : route.name;
}

/** Imports files dropped anywhere on the window, into the course / chapter being viewed. */
function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.boo.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      const { route, courses } = useApp.getState();
      const course = route.name === 'course' ? courses.get(route.id) : undefined;
      const placement = course ? { courseId: course.id, chapterId: course.chapters.at(-1)!.id } : undefined;
      void window.boo.library.importFiles(paths, placement).then(
        ({ notes, errors }) => {
          if (errors.length) toast(errors[0], 'error');
          const last = notes.at(-1);
          if (last) useApp.getState().go({ name: 'note', id: last.id });
        },
        (err: unknown) => toast(errorMessage(err), 'error'),
      );
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return over;
}

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useApp.getState();
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && key === 'k') {
        e.preventDefault();
        s.setPalette(!s.paletteOpen);
      } else if (mod && !e.shiftKey && key === 'n') {
        e.preventDefault();
        void newNote();
      } else if (mod && !e.shiftKey && key === 'o') {
        e.preventDefault();
        void addFiles();
      } else if (mod && e.shiftKey && key === 'o') {
        e.preventDefault();
        s.setUrlOpen(true);
      } else if (mod && e.shiftKey && key === 'e') {
        e.preventDefault();
        s.setExport(true);
      } else if (mod && key === ',') {
        e.preventDefault();
        s.go({ name: 'settings' });
      } else if (mod && key === '\\') {
        e.preventDefault();
        s.toggleSidebar();
      } else if (mod && e.shiftKey && key === 'g') {
        e.preventDefault();
        s.go({ name: 'graph' });
      } else if (e.altKey && !mod && e.key === 'ArrowLeft' && !isEditable(e.target)) {
        e.preventDefault();
        s.goBack();
      } else if (e.altKey && !mod && e.key === 'ArrowRight' && !isEditable(e.target)) {
        e.preventDefault();
        s.goForward();
      }
    };
    // Mouse "back" / "forward" buttons.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) useApp.getState().goBack();
      if (e.button === 4) useApp.getState().goForward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

export async function addFiles(): Promise<void> {
  const { route, courses, go } = useApp.getState();
  const course = route.name === 'course' ? courses.get(route.id) : undefined;
  try {
    const { notes, errors } = await window.boo.library.openFiles(
      course ? { courseId: course.id, chapterId: course.chapters.at(-1)!.id } : undefined,
    );
    if (errors.length) toast(errors[0], 'error');
    const last = notes.at(-1);
    if (last) go({ name: 'note', id: last.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export function App() {
  const route = useApp((s) => s.route);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const loaded = useApp((s) => s.loaded);
  const settings = useApp((s) => s.settings);
  const dropping = useFileDrop();
  useGlobalShortcuts();

  useEffect(() => {
    const s = useApp.getState();
    void s.refresh();
    void s.loadSettings();
    void window.boo.status().then(s.setStatus);
    const offs = [
      window.boo.on('library', () => void useApp.getState().refresh()),
      window.boo.on('status', (st) => {
        useApp.getState().setStatus(st);
        // Settings may change elsewhere (tray, another window): theme and Notion follow.
        void useApp.getState().loadSettings();
      }),
      window.boo.on('open-note', (id) => {
        void useApp
          .getState()
          .refresh()
          .then(() => useApp.getState().go({ name: 'note', id }));
      }),
      window.boo.on('navigate', (view) => useApp.getState().go(view === 'settings' ? { name: 'settings' } : { name: 'today' })),
      window.boo.on('open-title', (title) => void openTitle(title)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  return (
    <MotionConfig reducedMotion="user" transition={{ type: 'spring', stiffness: 420, damping: 36 }}>
      <div className="app" data-sidebar={collapsed ? 'collapsed' : 'open'}>
        <div className="titlebar-drag" aria-hidden="true" />
        <Sidebar />
        <main className="main" id="main">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={routeKey(route)}
              className="view"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
            >
              {loaded ? viewFor(route) : null}
            </motion.div>
          </AnimatePresence>
        </main>
        <CommandPalette />
        <ExportSheet />
        <UrlSheet />
        {settings && !settings.onboarded ? <Onboarding /> : null}
        <DialogHost />
        <Toasts />
        <AnimatePresence>
          {dropping ? (
            <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="drop-card glass-thick">
                <Icon name="plus" size={28} />
                <strong>Déposez vos supports</strong>
                <span>PDF, vidéo, audio, image, texte : chacun reçoit sa note.</span>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
