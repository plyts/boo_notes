import { useEffect, useRef, useState } from 'react';
import type { AnchorKind, NotesEditor } from '../../../../src/panel/editor';
import { isTimeKind } from '../../../../src/shared/platforms';
import type { ResourceView } from '../../ipc';
import { ImageViewer } from '../image-viewer';
import { errorMessage, formatTimecode, percent } from '../lib/format';
import { KIND_ICON, KIND_LABELS, PLATFORM_LABELS } from '../lib/kinds';
import { MediaViewer } from '../media-viewer';
import { PdfViewer } from '../pdf-viewer';
import { TextViewer } from '../text-viewer';
import { Bar, Button, Icon, toast } from '../ui';

export type Position = { kind: AnchorKind | 'time'; value: number };

/** What the note workspace can ask the viewer of the active resource. */
export interface ViewerHandle {
  resource: ResourceView;
  /** Where the reader is: an instant, a page, a paragraph, the selected pin. */
  position(): Position | null;
  goTo(kind: AnchorKind | 'time', value: number): void;
  /** Note markers of the viewer follow the note. */
  syncMarkers(): void;
  time(): number | null;
  toggle?(): void;
  skip?(delta: number): void;
  keystroke?(): void;
  /** Current frame (JPEG data URL), video only. */
  captureFrame?(): string | null;
  /** Plays a passage and stops at its end. */
  playRange?(start: number, end: number): void;
  /** The playing element (recording of passage extracts). */
  mediaElement?(): HTMLMediaElement;
  selection?(): { text: string; position: Position } | null;
  highlight?(): boolean;
  togglePlacing?(): void;
  zoom?(factor: number | 'fit'): void;
  flush(): Promise<void>;
}

/** Played / shown in the app; the others open in the browser (where the extension notes them). */
export function isLocal(res: ResourceView): boolean {
  if (res.origin === 'file') return true;
  if (res.origin === 'url') return res.platform === 'web' && res.kind !== 'page';
  return false;
}

function Problem({ title, text }: { title: string; text: string }) {
  return (
    <div className="viewer-problem">
      <Icon name="alert" size={28} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

/** A course / page studied in the browser: summary and a way back to it. */
function WebSource({ res }: { res: ResourceView }) {
  const yt = /[?&]v=([\w-]{6,20})/.exec(res.source)?.[1];
  const timed = isTimeKind(res.kind);
  const resumeAt = timed ? res.progress?.position : undefined;
  return (
    <section className="web-source" aria-label="Support du navigateur">
      <div className="web-art">
        <Icon name={KIND_ICON[res.kind]} size={40} />
        {yt ? <img src={`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} /> : null}
      </div>
      <div className="web-body">
        <p className="eyebrow">
          {PLATFORM_LABELS[res.platform]} · {KIND_LABELS[res.kind]}
        </p>
        <h2>{res.title}</h2>
        <div className="web-progress">
          <Bar value={res.ratio} />
          <span>{res.progress ? `${percent(res.ratio)} · ${res.positionLabel}` : 'Pas encore commencé'}</span>
        </div>
        <Button variant="primary" icon={timed ? 'play' : 'globe'} onPress={() => void window.boo.library.openSource(res.id, resumeAt)}>
          {resumeAt ? `Reprendre à ${formatTimecode(resumeAt)}` : res.kind === 'page' ? 'Ouvrir la page' : 'Ouvrir dans le navigateur'}
        </Button>
        <p className="hint">
          <Icon name="globe" size={14} />
          {res.origin === 'extension'
            ? 'Cette note s’écrit dans l’extension Boo Notes du navigateur : les horodatages et citations y renvoient.'
            : 'Ouvrez-le dans le navigateur : l’extension Boo Notes y prend des notes sur toute vidéo ou tout audio.'}
        </p>
      </div>
    </section>
  );
}

export function ResourceViewer({
  resource,
  editor,
  onStamp,
  onQuote,
  onReady,
  pending,
}: {
  resource: ResourceView;
  editor(): NotesEditor | null;
  /** A new note line at this position (paragraph stamp, pin placed). */
  onStamp(position: Position): void;
  onQuote(text: string, position: Position): void;
  onReady(handle: ViewerHandle | null): void;
  /** Anchor to show once the viewer is open. */
  pending?: Position | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<{ title: string; text: string } | null>(null);
  const local = isLocal(resource);
  const cbs = useRef({ editor, onStamp, onQuote, onReady });
  cbs.current = { editor, onStamp, onQuote, onReady };

  useEffect(() => {
    if (!local || !host.current) {
      const handle: ViewerHandle = {
        resource,
        position: () => null,
        goTo: (kind, value) => {
          if (kind === 'time') void window.boo.library.openSource(resource.id, value);
          else void window.boo.library.openSource(resource.id);
        },
        syncMarkers: () => undefined,
        time: () => null,
        flush: async () => undefined,
      };
      cbs.current.onReady(handle);
      return () => cbs.current.onReady(null);
    }
    const el = host.current;
    const res = resource;
    let disposed = false;
    let lastActivity = Date.now();
    const activity = () => {
      lastActivity = Date.now();
    };
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingProgress: [number, number] | null = null;
    const saveProgress = (n: number, total: number) => {
      pendingProgress = [n, total];
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        progressTimer = null;
        pendingProgress = null;
        void window.boo.library.setProgress(res.id, n, total);
      }, 700);
    };
    const flush = async () => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = null;
      if (pendingProgress) await window.boo.library.setProgress(res.id, ...pendingProgress).catch(() => undefined);
      pendingProgress = null;
    };
    const ed = () => cbs.current.editor();
    const reveal = (kind: AnchorKind, n: number) => {
      if (!ed()?.revealAnchor(kind, n, res.id)) toast('Aucune note à cet endroit : écrivez la première');
    };
    const study = setInterval(() => {
      if (document.hasFocus() && Date.now() - lastActivity < 60_000) void window.boo.library.addStudyTime(res.id, 15_000);
    }, 15_000);

    let handle: ViewerHandle;
    let destroy: () => void = () => undefined;
    setProblem(null);

    const ready = (h: ViewerHandle) => {
      if (disposed) return;
      handle = h;
      cbs.current.onReady(h);
      h.syncMarkers();
      if (pending) h.goTo(pending.kind, pending.value);
    };

    if (res.kind === 'pdf') {
      void window.boo.library.readFile(res.id).then(
        async (data) => {
          if (disposed) return;
          const pdf = new PdfViewer({
            data,
            startPage: Math.max(1, Math.round(res.progress?.position ?? 1)),
            highlights: res.highlights ?? [],
            onPageChange: (page, pages) => {
              activity();
              ed()?.setCurrentAnchor('page', page, res.id);
              saveProgress(page, pages);
            },
            onHighlightsChange: (list) => void window.boo.library.setHighlights(res.id, list).catch((e: unknown) => toast(errorMessage(e), 'error')),
            onQuote: (text, page) => cbs.current.onQuote(text, { kind: 'page', value: page }),
            onActivity: activity,
            onMarkerClick: (page) => reveal('page', page),
          });
          el.replaceChildren(pdf.el);
          destroy = () => pdf.destroy();
          try {
            await pdf.open();
          } catch (e) {
            setProblem({ title: 'Impossible d’ouvrir ce PDF', text: errorMessage(e) });
            return;
          }
          ready({
            resource: res,
            position: () => ({ kind: 'page', value: pdf.page }),
            goTo: (kind, value) => kind === 'page' && pdf.goTo(value),
            syncMarkers: () => {
              const e = ed();
              if (!e) return;
              pdf.setNoteCounts(e.anchorCounts('page', res.id));
              e.setCurrentAnchor('page', pdf.page, res.id);
            },
            time: () => null,
            selection: () => {
              const sel = pdf.currentSelection();
              return sel ? { text: sel.text, position: { kind: 'page', value: sel.page } } : null;
            },
            highlight: () => pdf.highlightSelection('yellow'),
            zoom: (f) => (f === 'fit' ? pdf.setFitWidth() : pdf.zoom(f)),
            flush,
          });
        },
        (e: unknown) => setProblem({ title: 'Fichier introuvable', text: `${errorMessage(e)} — ${res.source}` }),
      );
    } else if (res.kind === 'text') {
      void window.boo.library.readText(res.id).then(
        (text) => {
          if (disposed) return;
          const tv = new TextViewer({
            text,
            markdown: /\.(md|markdown)$/i.test(res.source),
            startParagraph: Math.max(1, Math.round(res.progress?.position ?? 1)),
            onParagraphChange: (n, total) => {
              activity();
              ed()?.setCurrentAnchor('section', n, res.id);
              saveProgress(n, total);
            },
            onStamp: (n) => cbs.current.onStamp({ kind: 'section', value: n }),
            onMarkerClick: (n) => reveal('section', n),
            onQuote: (quote, n) => cbs.current.onQuote(quote, { kind: 'section', value: n }),
            onActivity: activity,
          });
          el.replaceChildren(tv.el);
          tv.start();
          ready({
            resource: res,
            position: () => ({ kind: 'section', value: tv.paragraph }),
            goTo: (kind, value) => kind === 'section' && tv.goTo(value),
            syncMarkers: () => {
              const e = ed();
              if (!e) return;
              tv.setCounts(e.anchorCounts('section', res.id));
              e.setCurrentAnchor('section', tv.paragraph, res.id);
            },
            time: () => null,
            selection: () => {
              const sel = tv.currentSelection();
              return sel ? { text: sel.text, position: { kind: 'section', value: sel.n } } : null;
            },
            flush,
          });
        },
        (e: unknown) => setProblem({ title: 'Fichier introuvable', text: `${errorMessage(e)} — ${res.source}` }),
      );
    } else if (res.kind === 'image') {
      let activePin: number | null = null;
      const iv = new ImageViewer({
        item: res,
        pins: res.pins ?? [],
        onPinsChange: (pins) => void window.boo.library.setPins(res.id, pins).catch((e: unknown) => toast(errorMessage(e), 'error')),
        onPinCreated: (n) => {
          activePin = n;
          cbs.current.onStamp({ kind: 'pin', value: n });
        },
        onPinClick: (n) => {
          activePin = n;
          reveal('pin', n);
        },
        onActivity: activity,
      });
      iv.el.querySelector('img')?.addEventListener('error', () =>
        setProblem({ title: 'Image introuvable', text: `Format non lu ou fichier déplacé : ${res.source}` }),
      );
      el.replaceChildren(iv.el);
      destroy = () => iv.destroy();
      ready({
        resource: res,
        position: () => (activePin !== null ? { kind: 'pin', value: activePin } : null),
        goTo: (kind, value) => {
          if (kind !== 'pin') return;
          activePin = value;
          iv.showPin(value);
        },
        syncMarkers: () => {
          const e = ed();
          if (e) iv.setCounts(e.anchorCounts('pin', res.id));
        },
        time: () => null,
        togglePlacing: () => iv.togglePlacing(),
        flush,
      });
    } else {
      const mv = new MediaViewer({
        item: res,
        onTime: (t) => ed()?.setPlaybackTime(t, res.id),
        onProgress: (position, d) => void window.boo.library.setProgress(res.id, position, d),
        onActivity: activity,
        onMarkerClick: (s) => ed()?.revealAnchor('time', s, res.id),
      });
      mv.media.addEventListener('error', () =>
        setProblem({
          title: 'Lecture impossible',
          text: res.origin === 'url' ? `Flux injoignable ou format non lu : ${res.source}` : `Format non lu ou fichier déplacé : ${res.source}`,
        }),
      );
      el.replaceChildren(mv.el);
      destroy = () => mv.destroy();
      ready({
        resource: res,
        position: () => ({ kind: 'time', value: mv.time }),
        goTo: (kind, value) => {
          if (kind !== 'time') return;
          mv.seek(value);
          void mv.media.play().catch(() => undefined);
        },
        syncMarkers: () => {
          const e = ed();
          if (!e) return;
          mv.setMarkers(e.timesOf(res.id));
          mv.setRanges(e.rangesOf(res.id));
        },
        time: () => mv.time,
        toggle: () => mv.toggle(),
        skip: (d) => mv.skip(d),
        keystroke: () => mv.autoPause.keystroke(),
        captureFrame: () => (mv.isVideo ? mv.capture() : null),
        playRange: (start, end) => mv.playRange(start, end),
        mediaElement: () => mv.media,
        flush,
      });
    }

    return () => {
      disposed = true;
      clearInterval(study);
      void flush();
      destroy();
      el.replaceChildren();
      cbs.current.onReady(null);
      void handle;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id, local]);

  if (!local) return <WebSource res={resource} />;
  return (
    <div className="viewer-host">
      <div ref={host} className="viewer-island" hidden={problem !== null} />
      {problem ? <Problem title={problem.title} text={problem.text} /> : null}
    </div>
  );
}
