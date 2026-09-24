import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button as AriaButton, Tab, TabList, Tabs } from 'react-aria-components';
import type { AnchorKind } from '../../../../src/panel/editor';
import { extractCards, plainText } from '../../../../src/shared/cards';
import { captureLine, normalizeTitle, pageRefToken, pinToken, sectionToken, timestampToken } from '../../../../src/shared/markdown';
import { nextInterval, type ReviewGrade } from '../../../../src/shared/study';
import {
  cueIndexAt,
  cueQuote,
  notesInRange,
  passageLine,
  pinTranscriptLine,
  rangeLabel,
  transcriptLine,
  type Cue,
  type Transcript,
} from '../../../../src/shared/transcript';
import type { NoteView as Note, ResourceView } from '../../ipc';
import { openTitle, removeNote, syncNotion } from '../actions';
import { NoteEditor, SAVE_LABELS, type NoteEditorHandle, type SaveState } from '../islands/NoteEditor';
import { isLocal, ResourceViewer, type Position, type ViewerHandle } from '../islands/ResourceViewer';
import { TranscriptPanel } from '../islands/TranscriptPanel';
import { copyImage, copySelection, pasteInto, preloadAssets, type ClipNote } from '../lib/clipboard';
import { frameOf, passageCard, recordBlocker, Recording, recordRange, seekTo } from '../lib/passages';
import { dueLabel, errorMessage, formatTimecode, plural } from '../lib/format';
import { KIND_ICON } from '../lib/kinds';
import { PageHeader } from '../shell/PageHeader';
import { placementOf, useApp, useNote } from '../store';
import { Button, Icon, IconButton, MenuButton, toast, type MenuEntry } from '../ui';
import { EditableTitle } from './EditableTitle';
import { Inspector } from './Inspector';
import { LinkResourceSheet } from './LinkResourceSheet';
import { WikiPreview } from './WikiPreview';

/** Hues of the badges telling resources apart in a note (1, 2, 3…). */
const BADGE_HUES = [262, 28, 187, 335, 120, 45, 211, 4];

function token(position: Position, resource: string | null): string {
  switch (position.kind) {
    case 'time':
      return timestampToken(position.value, resource);
    case 'page':
      return pageRefToken(position.value, resource);
    case 'section':
      return sectionToken(position.value, resource);
    case 'pin':
      return pinToken(position.value, resource);
  }
}

const DAY = 86_400_000;

export function ReviewMenu({ note }: { note: Note }) {
  const review = note.review;
  const grade = (action: ReviewGrade | 'start' | 'stop') =>
    void window.boo.library.review(note.id, action).then(
      () => {
        if (action !== 'start' && action !== 'stop') {
          const days = nextInterval(review?.interval, action);
          toast(`Note révisée : prochaine révision ${dueLabel(Date.now() + days * DAY)}`, 'success');
        }
      },
      (e: unknown) => toast(errorMessage(e), 'error'),
    );
  const label = !review ? 'Réviser' : note.due ? 'À réviser' : `Révision ${dueLabel(review.next)}`;
  const entries: MenuEntry[] = review
    ? [
        {
          section: note.due ? 'Comment s’est passée la révision ?' : 'Réviser maintenant',
          items: [
            { id: 'again', label: `À revoir — demain`, icon: 'replay', onAction: () => grade('again') },
            { id: 'good', label: `Je sais — dans ${nextInterval(review.interval, 'good')} j`, icon: 'check', onAction: () => grade('good') },
            { id: 'easy', label: `Facile — dans ${nextInterval(review.interval, 'easy')} j`, icon: 'star', onAction: () => grade('easy') },
          ],
        },
        'separator',
        { id: 'stop', label: 'Retirer des révisions', icon: 'close', onAction: () => grade('stop') },
      ]
    : [{ id: 'start', label: 'Ajouter aux révisions', icon: 'cards', onAction: () => grade('start') }];
  return (
    <MenuButton label={label} icon="cards" entries={entries} className={`btn btn-${note.due ? 'tinted' : 'glass'} btn-m review-btn`}>
      {label}
    </MenuButton>
  );
}

/** A recorded extract (or the kept sound of the course) played over the notes. */
function MediaPop({
  path,
  offset,
  title,
  video,
  range,
  onClose,
  onTranscript,
}: {
  path: string;
  offset: number;
  title: string;
  video: boolean;
  /** Passage the extract comes from: its transcript can be read. */
  range?: { start: number; end: number };
  onClose(): void;
  onTranscript?(start: number, end: number): void;
}) {
  const src = `boo://app/__vault/${path.split('/').map(encodeURIComponent).join('/')}`;
  const start = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const m = e.currentTarget;
    if (offset > 0) m.currentTime = offset;
    void m.play().catch(() => undefined);
  };
  return (
    <div className="media-pop glass-thick" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="mp-head">
        <Icon name={video ? 'video' : 'volume'} size={15} />
        <span className="mp-title">{title}</span>
        {range && onTranscript ? (
          <IconButton icon="subtitles" size="s" className="mp-transcript" label="Lire la transcription du passage" onPress={() => onTranscript(range.start, range.end)} />
        ) : null}
        <IconButton icon="close" size="s" label="Fermer l’extrait" onPress={onClose} />
      </div>
      {video ? <video src={src} controls playsInline onLoadedMetadata={start} /> : <audio src={src} controls onLoadedMetadata={start} />}
    </div>
  );
}

/** Title of a passage: the first note taken during it, else its first subtitle. */
function passageTitle(markdown: string, start: number, end: number, cue: Cue | null): string {
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59).replace(/\s+\S*$/, '')}…` : s);
  // Pinned subtitles (quotes) are not the user's words: the first personal note, else the first line said.
  const line = notesInRange(markdown, start, end).find((l) => !/^\s*>/.test(l));
  const fromNote = line ? plainText(line.replace(/^(?:\s*(?:[-*+]|\d+[.)]|>)\s+)?\[[^\]\n]*\](?:\([^)\s]*\))?\s*/, '')).trim() : '';
  if (fromNote) return clip(fromNote);
  return cue ? clip(cue.tr?.trim() || cue.text) : '';
}

export function NoteView({ id, resource: initialResource, anchor }: { id: string; resource?: string; anchor?: Position }) {
  const note = useNote(id);
  const resources = useApp((s) => s.resources);
  const notes = useApp((s) => s.notes);
  const courses = useApp((s) => s.courses);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const toggleInspector = useApp((s) => s.toggleInspector);
  const go = useApp((s) => s.go);
  const status = useApp((s) => s.status);

  const [active, setActive] = useState<string | null>(initialResource ?? note?.resources[0] ?? null);
  const [pending, setPending] = useState<Position | null>(anchor ?? null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [markdown, setMarkdown] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [preview, setPreview] = useState<{ title: string; el: HTMLElement } | null>(null);
  const editorRef = useRef<NoteEditorHandle>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const [viewer, setViewer] = useState<ViewerHandle | null>(null);
  const [notesWidth, setNotesWidth] = useState(() => Number(localStorage.getItem('boo.notesWidth')) || 460);
  // Transcript (subtitles) next to the notes, passages, recorded extracts.
  const [pane, setPane] = useState<'notes' | 'transcript'>('notes');
  const [mediaPop, setMediaPop] = useState<{ path: string; offset: number; title: string; video: boolean; range?: { start: number; end: number } } | null>(null);
  /** Passage read in the transcript (from its card or its extract). */
  const [focusRange, setFocusRange] = useState<{ start: number; end: number; at: number } | null>(null);
  const [passageStart, setPassageStart] = useState<number | null>(null);
  const passageIn = useRef<{ start: number; poster: string | null; recording: Recording | null; off(): void } | null>(null);
  const cuesRef = useRef<Cue[]>([]);
  /** The line being spoken: the live subtitle strip under the notes. */
  const [liveCue, setLiveCue] = useState<Cue | null>(null);
  const markdownRef = useRef('');
  markdownRef.current = markdown;

  const linked: ResourceView[] = useMemo(
    () => (note ? note.resources.flatMap((r) => (resources.get(r) ? [resources.get(r)!] : [])) : []),
    [note, resources],
  );
  const primary = note?.resources[0] ?? null;
  const readOnly = note?.origin !== 'desktop';

  // The active resource disappeared (unlinked): fall back to the main one.
  useEffect(() => {
    if (!note) return;
    if (active && !note.resources.includes(active)) setActive(note.resources[0] ?? null);
    if (!active && note.resources.length) setActive(note.resources[0]);
  }, [note, active]);

  // Anchors without a target (`[04:15]`) belong to the main resource.
  useEffect(() => {
    const ed = editorRef.current?.editor;
    if (!ed) return;
    ed.setPrimaryResource(primary);
    ed.refreshBadges();
    viewerRef.current?.syncMarkers();
  }, [primary, note?.resources.length]);

  const onViewerReady = useCallback((h: ViewerHandle | null) => {
    viewerRef.current = h;
    setViewer(h);
    if (h) setPending(null);
  }, []);

  const qualifier = (res: string | null) => (res && res !== primary ? res : null);

  const timed = (kind?: string) => kind === 'video' || kind === 'audio';

  /** Card picture, recorded extract (when given), and the passage line in the note. */
  const savePassage = async (
    start: number,
    end: number,
    opts: { poster?: string | null; recorded?: { blob: Blob; mime: string } | null; record?: boolean; cue?: Cue | null },
  ) => {
    const v = viewerRef.current;
    if (!v || !note || readOnly) return;
    const res = v.resource;
    const media = v.mediaElement?.();
    let poster = opts.poster ?? null;
    let recorded = opts.recorded ?? null;
    try {
      if (opts.record && media) {
        toast(`● Enregistrement du passage ${rangeLabel(start, end)}… continuez d’écrire`);
        const r = await recordRange(media, start, end);
        recorded = r;
        poster ??= r.poster;
      } else if (!poster && media instanceof HTMLVideoElement) {
        const back = media.currentTime;
        await seekTo(media, start);
        poster = frameOf(media);
        await seekTo(media, back);
      }
      const title = passageTitle(markdownRef.current, start, end, opts.cue ?? null);
      const image = await window.boo.library.saveCapture(res.id, poster ?? (await passageCard(start, end, res.kind === 'audio' ? 'audio' : 'video', title)).dataUrl, start);
      let mediaPath: string | null = null;
      if (recorded?.blob.size) {
        mediaPath = await window.boo.library.saveMedia(note.id, { kind: 'passage', mime: recorded.mime, start, end }, new Uint8Array(await recorded.blob.arrayBuffer()));
      }
      editorRef.current?.insertBlock(passageLine({ start, end, title, image, media: mediaPath }));
      toast(`Passage ${rangeLabel(start, end)} ajouté à la note${mediaPath ? ' avec son extrait' : ''}`, 'success');
    } catch (e) {
      toast(`Passage non enregistré : ${errorMessage(e)}`, 'error');
    }
  };

  /** Alt+I then Alt+O: a passage of the media being played, recorded as it plays. */
  const togglePassage = () => {
    const v = viewerRef.current;
    const media = v?.mediaElement?.();
    if (!v || !media || readOnly) {
      toast('Les passages découpent une vidéo ou un audio ouvert dans l’app', 'error');
      return;
    }
    const open = passageIn.current;
    if (!open) {
      const start = media.currentTime;
      let recording: Recording | null = null;
      let why = '';
      try {
        recording = recordBlocker(media) ? null : new Recording(media, v.resource.kind === 'audio' ? 'audio' : 'video');
        if (recording && media.paused) recording.pause();
      } catch (e) {
        why = ` (extrait non enregistré : ${errorMessage(e)})`;
      }
      // The recording follows the playback: no frozen picture while paused.
      const pause = () => recording?.pause();
      const play = () => recording?.resume();
      media.addEventListener('pause', pause);
      media.addEventListener('play', play);
      const off = () => {
        media.removeEventListener('pause', pause);
        media.removeEventListener('play', play);
      };
      passageIn.current = { start, poster: frameOf(media), recording, off };
      setPassageStart(start);
      toast(`${recording ? '● ' : ''}Début du passage ${formatTimecode(start)} — Alt+O pour le terminer${why}`);
      return;
    }
    const end = media.currentTime;
    if (end - open.start < 1) {
      toast('Passage trop court : laissez la lecture avancer, puis Alt+O', 'error');
      return;
    }
    passageIn.current = null;
    setPassageStart(null);
    open.off();
    const done = open.recording ? open.recording.stop().then((blob) => ({ blob, mime: open.recording!.mime })) : Promise.resolve(null);
    void done.then(
      (recorded) => savePassage(open.start, end, { poster: open.poster, recorded, cue: cuesRef.current.find((c) => c.end > open.start && c.start < end) ?? null }),
      (e: unknown) => toast(`Extrait non enregistré : ${errorMessage(e)}`, 'error'),
    );
  };

  /** The line being spoken, quoted in the note. */
  const pinCue = (cue: Cue | null) => {
    if (readOnly) return;
    if (!cue) {
      toast('Aucune réplique à cet instant', 'error');
      return;
    }
    editorRef.current?.insertBlock(cueQuote(cue));
    toast(`Réplique ${formatTimecode(cue.start)} épinglée dans la note`, 'success');
  };

  /** The note « tout compris » in the clipboard: pictures, timestamps, passages, transcript. */
  const copyNote = async () => {
    if (!note) return;
    await editorRef.current?.flush();
    try {
      const { images, missing } = await window.boo.library.copyNote(note.id);
      const pics = images ? ` avec ${plural(images, 'image')}` : '';
      toast(`Note copiée${pics}${missing ? ` (${missing} introuvable${missing > 1 ? 's' : ''})` : ''} — collez-la dans Obsidian, Notion, Docs…`, 'success');
    } catch (e) {
      toast(`Copie impossible : ${errorMessage(e)}`, 'error');
    }
  };

  /** The note, for a copy or a paste: its main media's page and whether its timestamps are moments. */
  const clipNote = (): ClipNote => {
    const main = primary ? resources.get(primary) : undefined;
    return { id: note?.id ?? '', source: main?.source ?? null, timed: timed(main?.kind) || timed(note?.kind) };
  };
  /** Moment of the media playing, for what is pasted (null: not a video or audio). */
  const timedNow = (): number | null => {
    const v = viewerRef.current;
    return v && timed(v.resource.kind) ? v.time() : null;
  };

  /** A passage (its card, its extract): its lines, read in the transcript. */
  const showPassageTranscript = (start: number, end: number) => {
    setMediaPop(null);
    setPane('transcript');
    setFocusRange({ start, end, at: Date.now() });
  };

  const listen = (seconds: number) => {
    const seg = note?.media.find((m) => m.kind === 'audio' && seconds >= m.start && seconds < m.end);
    if (seg) setMediaPop({ path: seg.path, offset: seconds - seg.start, title: `Son du cours · ${formatTimecode(seconds)}`, video: false });
  };

  /** Note → resource: an anchor chip shows its place, switching resource if needed. */
  const showAnchor = (kind: AnchorKind | 'time', value: number, res: string | null) => {
    const target = res ?? primary;
    if (!target) return;
    const r = resources.get(target);
    if (r && !isLocal(r)) {
      void window.boo.library.openSource(target, kind === 'time' ? value : undefined);
      return;
    }
    if (target === active && viewerRef.current) viewerRef.current.goTo(kind, value);
    else {
      setPending({ kind, value });
      setActive(target);
    }
  };

  const stampNow = () => {
    const v = viewerRef.current;
    const pos = v?.position();
    if (!v || !pos) {
      if (v?.togglePlacing) v.togglePlacing();
      return;
    }
    editorRef.current?.stampLine(token(pos, qualifier(v.resource.id)));
  };

  const quoteSelection = () => {
    const v = viewerRef.current;
    const sel = v?.selection?.();
    if (!v || !sel) {
      toast('Sélectionnez un passage à citer');
      return;
    }
    quote(sel.text, sel.position, v.resource.id);
  };

  const quote = (text: string, position: Position, res: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    // Quotes follow the reading order: always at the end of the note.
    editorRef.current?.insertBlock(`> ${clean} ${token(position, qualifier(res))}`, 'end');
    toast(position.kind === 'page' ? `Citation de la page ${position.value} ajoutée` : `Citation du paragraphe ${position.value} ajoutée`, 'success');
  };

  const capture = async () => {
    const v = viewerRef.current;
    const t = v?.time();
    const frame = v?.captureFrame?.();
    if (!v || t === null || t === undefined || !frame) {
      toast('Capture possible sur une vidéo', 'error');
      return;
    }
    try {
      const path = await window.boo.library.saveCapture(v.resource.id, frame, t);
      editorRef.current?.insertBlock(captureLine(t, path).replace(/^\[([^\]]+)\]/, (all) => (qualifier(v.resource.id) ? `${all}(res:${v.resource.id})` : all)));
      toast(`${formatTimecode(t)} — capture ajoutée`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  // Study shortcuts, same keys as the browser extension.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = viewerRef.current;
      const altShift = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
      const mod = e.ctrlKey || e.metaKey;
      const code = e.code;
      let handled = true;
      // On an image the shortcut places a new pin (click where), like the « Repère » button.
      if (altShift && code === 'KeyT') v?.togglePlacing ? v.togglePlacing() : stampNow();
      else if (altShift && code === 'KeyN') editorRef.current?.focus();
      else if (altShift && code === 'KeyS') void capture();
      else if (altShift && code === 'Space') v?.toggle?.();
      else if (altShift && code === 'KeyQ') quoteSelection();
      else if (e.altKey && !e.shiftKey && !mod && (code === 'KeyI' || code === 'KeyO') && timed(v?.resource.kind)) {
        if ((code === 'KeyI') === !passageIn.current) togglePassage();
        else if (code === 'KeyI') toast('Un passage est déjà commencé : Alt+O pour le terminer', 'error');
        else toast('Commencez par « Début du passage » (Alt+I)', 'error');
      } else if (e.altKey && !e.shiftKey && !mod && code === 'KeyT' && (note?.transcript || timed(v?.resource.kind))) {
        setPane((p) => (p === 'notes' ? 'transcript' : 'notes'));
      } else if (mod && e.shiftKey && !e.altKey && code === 'KeyK') {
        const t = v?.time();
        const i = t === null || t === undefined ? -1 : cueIndexAt(cuesRef.current, t);
        pinCue(i === -1 ? null : cuesRef.current[i]);
      } else if (e.key === 'Escape' && mediaPop) setMediaPop(null);
      else if (altShift && code === 'KeyH') {
        if (!v?.highlight?.()) toast('Sélectionnez un passage du PDF à surligner');
      } else if (e.altKey && !e.shiftKey && !mod && e.key === 'ArrowLeft' && v?.skip) v.skip(-5);
      else if (mod && v?.zoom && (e.key === '=' || e.key === '+')) v.zoom(1.15);
      else if (mod && v?.zoom && e.key === '-') v.zoom(1 / 1.15);
      else if (mod && v?.zoom && e.key === '0') v.zoom('fit');
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Leaving the note: pending writes first.
  // Live subtitle strip: the line spoken at the player's time.
  useEffect(() => {
    const timer = setInterval(() => {
      const t = viewerRef.current?.time();
      const i = t === null || t === undefined ? -1 : cueIndexAt(cuesRef.current, t);
      const cue = i === -1 ? null : cuesRef.current[i];
      setLiveCue((prev) => (prev?.id === cue?.id && prev?.tr === cue?.tr ? prev : cue));
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // End of the media: the transcript is pinned at the end of the note, as in the browser.
  useEffect(() => {
    const media = viewer?.mediaElement?.();
    if (!media || readOnly) return;
    const onEnded = () => {
      const cues = cuesRef.current;
      if (!cues.length || !note?.transcript) return;
      void window.boo.library.transcript(note.id).then((t) => {
        if (t?.cues.length && editorRef.current?.editor.transform((md) => pinTranscriptLine(md, transcriptLine(t)))) {
          toast('Transcription épinglée à la note', 'success');
        }
      });
    };
    media.addEventListener('ended', onEnded);
    return () => media.removeEventListener('ended', onEnded);
  }, [viewer, readOnly, note?.id, note?.transcript]);

  useEffect(
    () => () => {
      void editorRef.current?.flush();
      // A passage left open: its recording is dropped.
      passageIn.current?.off();
      void passageIn.current?.recording?.stop().catch(() => undefined);
      passageIn.current = null;
    },
    [],
  );

  if (!note) {
    return (
      <div className="page">
        <PageHeader />
        <div className="page-content">
          <p className="rows-empty">Cette note n’existe plus.</p>
        </div>
      </div>
    );
  }

  const place = placementOf({ courses }, note);
  const titles = [...notes.values()].map((n) => n.title).filter((t) => normalizeTitle(t) !== normalizeTitle(note.title));
  const activeRes = active ? resources.get(active) : undefined;
  const cards = extractCards(note.id, markdown);
  const passages = (markdown.match(/(?:^|\n)\s*\[(?:\d+:)?\d{1,3}:\d{2}\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2}\]/g) ?? []).length;
  const notionOk = status?.notion.connected;

  const actions = (): Array<{ id: string; label: string; icon: Parameters<typeof Icon>[0]['name']; run(): void; title: string }> => {
    if (readOnly || !activeRes) return [];
    switch (activeRes.kind) {
      case 'pdf':
        return [
          { id: 'stamp', label: 'Page', icon: 'file', run: stampNow, title: 'Nouvelle note sur la page (Alt+Shift+T)' },
          { id: 'quote', label: 'Citer', icon: 'quote', run: quoteSelection, title: 'Citer la sélection (Alt+Shift+Q)' },
          {
            id: 'hl',
            label: 'Surligner',
            icon: 'highlight',
            run: () => {
              if (!viewerRef.current?.highlight?.()) toast('Sélectionnez un passage du PDF à surligner');
            },
            title: 'Surligner la sélection (Alt+Shift+H)',
          },
        ];
      case 'text':
        return [
          { id: 'stamp', label: 'Paragraphe', icon: 'text', run: stampNow, title: 'Nouvelle note sur le paragraphe (Alt+Shift+T)' },
          { id: 'quote', label: 'Citer', icon: 'quote', run: quoteSelection, title: 'Citer la sélection (Alt+Shift+Q)' },
        ];
      case 'image':
        return [{ id: 'pin', label: 'Repère', icon: 'target', run: () => viewerRef.current?.togglePlacing?.(), title: 'Placer un repère (Alt+Shift+T)' }];
      case 'video':
      case 'audio':
        if (!isLocal(activeRes)) return [];
        return [
          { id: 'stamp', label: 'Horodater', icon: 'clock', run: stampNow, title: 'Nouvelle note horodatée (Alt+Shift+T)' },
          ...(activeRes.kind === 'video'
            ? [{ id: 'capture', label: 'Capturer', icon: 'camera' as const, run: () => void capture(), title: 'Capturer l’image (Alt+Shift+S)' }]
            : []),
          {
            id: 'passage',
            label: passageStart !== null ? `Fin ${formatTimecode(passageStart)}` : 'Passage',
            icon: 'passage' as const,
            run: togglePassage,
            title:
              passageStart !== null
                ? `Terminer le passage commencé à ${formatTimecode(passageStart)} (Alt+O)`
                : 'Début d’un passage : extrait avec ses sous-titres et vos notes (Alt+I)',
          },
          { id: 'replay', label: '5 s', icon: 'replay', run: () => viewerRef.current?.skip?.(-5), title: 'Revoir les 5 dernières secondes (Alt+←)' },
        ];
      default:
        return [];
    }
  };

  const hasStage = linked.length > 0;
  const showTranscript = Boolean(note.transcript) || timed(activeRes?.kind) || timed(note.kind);
  const coverage = note.media.filter((m) => m.kind === 'audio').map((m) => [m.start, m.end] as [number, number]);
  const crumbs = [
    ...(place
      ? [
          { label: `${place.course.emoji} ${place.course.title}`, route: { name: 'course' as const, id: place.course.id } },
          { label: place.chapter.title, route: { name: 'course' as const, id: place.course.id } },
        ]
      : [{ label: 'Non classées', route: { name: 'notes' as const, filter: 'inbox' as const } }]),
    { label: note.title },
  ];

  return (
    <div className="page note-page" data-inspector={inspectorOpen || undefined}>
      <PageHeader
        crumbs={crumbs}
        actions={
          <>
            <ReviewMenu note={note} />
            {notionOk ? (
              <IconButton
                icon="notion"
                variant="glass"
                label={note.notion?.url ? 'Synchroniser avec Notion (clic droit : ouvrir)' : 'Envoyer vers Notion'}
                onPress={() => void syncNotion(note.id)}
              />
            ) : null}
            <IconButton
              icon="copy"
              variant="glass"
              label="Copier la note — images, horodatages, passages et transcription compris (Obsidian, Notion, Docs…)"
              onPress={() => void copyNote()}
            />
            <IconButton icon="sidebar" variant="glass" label={inspectorOpen ? 'Masquer l’inspecteur' : 'Afficher l’inspecteur'} onPress={toggleInspector} />
            <MenuButton
              label="Actions de la note"
              className="icon-btn icon-btn-m icon-btn-glass"
              entries={[
                ...(note.notion?.url ? [{ id: 'notion', label: 'Ouvrir dans Notion', icon: 'popout' as const, onAction: () => void window.boo.notion.open(note.id) }] : []),
                { id: 'graph', label: 'Voir dans la carte mentale', icon: 'mindmap', onAction: () => go({ name: 'graph', courseId: note.courseId ?? undefined }) },
                { id: 'copy', label: 'Copier la note (images comprises)', icon: 'copy', onAction: () => void copyNote() },
                { id: 'reveal', label: 'Afficher le fichier (.md)', icon: 'folder', onAction: () => void window.boo.library.revealNote(note.id) },
                'separator',
                { id: 'delete', label: 'Supprimer la note…', icon: 'trash', danger: true, onAction: () => void removeNote(note.id) },
              ]}
            />
          </>
        }
      />
      <div className="note-layout">
        <div className="note-main">
          <div className="note-title-row">
            <h1 className="note-title">
              <EditableTitle value={note.title} label="Titre de la note" readOnly={readOnly} onSave={(title) => window.boo.library.updateNote(note.id, { title })} />
            </h1>
            {readOnly ? (
              <span className="chip chip-accent" title="Cette note s’écrit dans l’extension du navigateur">
                <Icon name="globe" size={12} /> Navigateur
              </span>
            ) : null}
          </div>

          <div className={`workspace${hasStage ? ' has-stage' : ''}`} style={{ ['--notes-width' as string]: `${notesWidth}px` }}>
            {hasStage ? (
              <section className="stage glass-thick" aria-label="Supports de la note">
                <div className="stage-tabs">
                  <Tabs selectedKey={active ?? undefined} onSelectionChange={(k) => setActive(String(k))}>
                    <TabList aria-label="Supports" className="tablist" items={linked}>
                      {(r) => (
                        <Tab id={r.id} className="tab">
                          {linked.length > 1 ? (
                            <span className="tab-badge" style={{ ['--res-hue' as string]: BADGE_HUES[linked.indexOf(r) % BADGE_HUES.length] }}>
                              {linked.indexOf(r) + 1}
                            </span>
                          ) : null}
                          <Icon name={KIND_ICON[r.kind]} size={14} />
                          <span className="tab-title">{r.title}</span>
                        </Tab>
                      )}
                    </TabList>
                  </Tabs>
                  {!readOnly || note.origin === 'extension' ? (
                    <IconButton icon="plus" size="s" label="Lier un support (vidéo, audio, PDF, image, adresse…)" onPress={() => setLinkOpen(true)} />
                  ) : null}
                </div>
                <div className="stage-body">
                  {activeRes ? (
                    <ResourceViewer
                      key={activeRes.id}
                      resource={activeRes}
                      editor={() => editorRef.current?.editor ?? null}
                      pending={pending}
                      onReady={onViewerReady}
                      onStamp={(pos) => editorRef.current?.stampLine(token(pos, qualifier(activeRes.id)))}
                      onQuote={(text, pos) => quote(text, pos, activeRes.id)}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}
            {hasStage ? (
              <div
                className="resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Largeur des notes"
                aria-valuenow={notesWidth}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setNotesWidth((w) => Math.min(900, w + 24));
                  if (e.key === 'ArrowRight') setNotesWidth((w) => Math.max(320, w - 24));
                }}
                onPointerDown={(e) => {
                  const el = e.currentTarget;
                  el.setPointerCapture(e.pointerId);
                  const right = (el.parentElement as HTMLElement).getBoundingClientRect().right;
                  const move = (ev: PointerEvent) => setNotesWidth(Math.round(Math.min(900, Math.max(320, right - ev.clientX))));
                  const up = () => {
                    el.removeEventListener('pointermove', move);
                    el.removeEventListener('pointerup', up);
                    setNotesWidth((w) => {
                      localStorage.setItem('boo.notesWidth', String(w));
                      return w;
                    });
                  };
                  el.addEventListener('pointermove', move);
                  el.addEventListener('pointerup', up);
                }}
              />
            ) : null}
            <section className={`notes-pane${hasStage ? '' : ' sheet'}`} aria-label="Notes" data-pane={showTranscript ? pane : 'notes'}>
              <header className="notes-head">
                {showTranscript ? (
                  <div className="segmented pane-switch" role="tablist" aria-label="Vue">
                    {(['notes', 'transcript'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        role="tab"
                        className="segment"
                        aria-selected={pane === p}
                        data-selected={pane === p || undefined}
                        title={p === 'transcript' ? 'Sous-titres horodatés, traduits et commentés (Alt+T)' : 'Vos notes (Alt+T)'}
                        onClick={() => setPane(p)}
                      >
                        {p === 'notes' ? 'Notes' : 'Transcription'}
                        {p === 'transcript' && note.transcript?.cues ? <span className="tab-count">{note.transcript.cues}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="notes-stats">
                  {[
                    plural(note.noteCount ?? 0, 'ancre'),
                    passages ? plural(passages, 'passage') : '',
                    cards.length ? plural(cards.length, 'carte') : '',
                    note.links?.length ? plural(note.links.length, 'lien') : '',
                  ]
                    .filter((x) => x && !x.startsWith('0 '))
                    .join(' · ')}
                </span>
                <span className="toolbar-spacer" />
                {readOnly ? null : (
                  <span className="save-state" data-state={saveState} role="status" aria-live="polite">
                    {saveState === 'saved' || saveState === 'idle' ? <Icon name="check" size={12} /> : null}
                    {SAVE_LABELS[saveState]}
                  </span>
                )}
              </header>
              <NoteEditor
                ref={editorRef}
                noteId={note.id}
                rev={note.rev}
                readOnly={readOnly}
                onState={setSaveState}
                hooks={{
                  now: () => viewerRef.current?.time() ?? null,
                  stampToken: () => {
                    const v = viewerRef.current;
                    const pos = v?.position();
                    return v && pos ? token(pos, qualifier(v.resource.id)) : null;
                  },
                  onTimestampHover: () => undefined,
                  onTimestampClick: (s, r, end, url) => {
                    // A moment of another media (pasted from another note): opened where it lives.
                    const main = primary ? resources.get(primary) : undefined;
                    if (url && url.split('#')[0] !== main?.source.split('#')[0]) {
                      void window.boo.settings.openExternal(url);
                      return;
                    }
                    const target = r ?? primary;
                    // A range `[02:05–06:07]`: the passage is replayed and stops at its end.
                    if (end !== null && end !== undefined && target === active && viewerRef.current?.playRange) viewerRef.current.playRange(s, end);
                    else showAnchor('time', s, r ?? null);
                  },
                  onMediaClick: (path) => {
                    const entry = note.media.find((m) => m.path === path);
                    const pasted = entry?.kind === 'file' || /^media\/[\w.-]*-file-/.test(path);
                    setMediaPop({
                      path,
                      offset: 0,
                      title: pasted ? (entry?.name ?? path.split('/').pop() ?? 'Média') : entry ? `Extrait ${rangeLabel(entry.start, entry.end)}` : 'Extrait',
                      video: entry ? entry.mime.startsWith('video/') : !/-audio-/.test(path) && !/\.(mp3|m4a|wav|ogg|opus|flac|aac)$/.test(path),
                      ...(entry && entry.kind === 'passage' ? { range: { start: entry.start, end: entry.end } } : {}),
                    });
                  },
                  onPaste: (data) => {
                    const ed = editorRef.current?.editor;
                    if (!ed || readOnly) return false;
                    return pasteInto(ed, data, clipNote(), timedNow(), toast);
                  },
                  onCopy: (md, data) => copySelection(md, data, clipNote()),
                  onCopyImage: (path) =>
                    void copyImage(path).then(
                      () => toast('Image copiée : collez-la où vous voulez', 'success'),
                      (e: unknown) => toast(`Copie de l’image impossible : ${errorMessage(e)}`, 'error'),
                    ),
                  onTranscriptClick: () => setPane('transcript'),
                  onPassageTranscript: (start, end) => showPassageTranscript(start, end),
                  onAnchorClick: (k, n, r) => showAnchor(k, n, r),
                  resourceBadge: (r) => {
                    if (linked.length < 2) return null;
                    const i = note.resources.indexOf(r ?? primary ?? '');
                    const res = resources.get(r ?? primary ?? '');
                    if (i === -1 || !res) return { text: '?', title: 'Support retiré de la note', hue: 0 };
                    return { text: String(i + 1), title: res.title, hue: BADGE_HUES[i % BADGE_HUES.length] };
                  },
                  onWikiLinkClick: (title) => {
                    setPreview(null);
                    void openTitle(title);
                  },
                  onWikiLinkHover: (title, el) => setPreview(title && el ? { title, el } : null),
                  wikiTitles: () => titles,
                  onFragmentClick: (url) => void window.boo.settings.openExternal(url),
                  onKeystroke: () => viewerRef.current?.keystroke?.(),
                  onContentChanged: (md) => {
                    setMarkdown(md);
                    preloadAssets(md);
                    queueMicrotask(() => viewerRef.current?.syncMarkers());
                  },
                  placeholderText: hasStage
                    ? 'Écrivez ici… chaque ligne est rattachée à l’endroit étudié. [[ relie une autre note.'
                    : 'Écrivez votre note… [[ relie une autre note. « Question :: Réponse » crée une carte de révision.',
                }}
              />
              {showTranscript ? (
                <TranscriptPanel
                  noteId={note.id}
                  readOnly={readOnly}
                  version={note.transcript?.updatedAt ?? 0}
                  visible={pane === 'transcript'}
                  coverage={coverage}
                  time={() => viewerRef.current?.time() ?? null}
                  seek={(s) => showAnchor('time', s, null)}
                  pin={pinCue}
                  passage={(start, end, record, cue) => void savePassage(start, end, { record, cue })}
                  pinTranscript={(t: Transcript) => {
                    const changed = editorRef.current?.editor.transform((md) => pinTranscriptLine(md, transcriptLine(t)));
                    toast(changed === undefined ? 'Note en lecture seule' : 'Transcription épinglée à la note', changed === undefined ? 'error' : 'success');
                  }}
                  listen={listen}
                  notesIn={(start, end) => notesInRange(markdownRef.current, start, end).length}
                  onLoaded={(t) => {
                    cuesRef.current = t?.cues ?? [];
                  }}
                  focus={focusRange}
                  playRange={(start, end) => {
                    if (viewerRef.current?.playRange) viewerRef.current.playRange(start, end);
                    else showAnchor('time', start, null);
                  }}
                />
              ) : null}
              {liveCue && pane === 'notes' ? (
                <div className="live-caption" aria-label="Sous-titre en cours">
                  <button type="button" className="lc-time" title="Aller à ce moment" onClick={() => showAnchor('time', liveCue.start, null)}>
                    {formatTimecode(liveCue.start)}
                  </button>
                  <button type="button" className="lc-body" title="Ouvrir la transcription (Alt+T)" onClick={() => setPane('transcript')}>
                    <span className="lc-text">{liveCue.text}</span>
                    {liveCue.tr ? <span className="lc-tr">{liveCue.tr}</span> : null}
                  </button>
                  {!readOnly ? (
                    <IconButton icon="plus" size="s" className="lc-pin" label="Épingler la réplique dans la note (Ctrl+Maj+K)" onPress={() => pinCue(liveCue)} />
                  ) : null}
                </div>
              ) : null}
              {mediaPop ? <MediaPop {...mediaPop} onClose={() => setMediaPop(null)} onTranscript={showTranscript ? showPassageTranscript : undefined} /> : null}
              {!readOnly ? (
                <footer className="notes-actions">
                  {actions().map((a) => (
                    <Button key={a.id} size="s" variant="glass" icon={a.icon} onPress={a.run} aria-label={a.title} isDisabled={!viewer}>
                      {a.label}
                    </Button>
                  ))}
                  <span className="toolbar-spacer" />
                  <Button size="s" variant="plain" icon="link" onPress={() => editorRef.current?.editor.insertWikiLink()} aria-label="Lier une autre note ([[…]])">
                    Lier une note
                  </Button>
                  <Button size="s" variant="plain" icon="plus" onPress={() => setLinkOpen(true)} aria-label="Lier un support : vidéo, audio, PDF, image, adresse">
                    Support
                  </Button>
                </footer>
              ) : null}
            </section>
          </div>
          {!hasStage && !readOnly ? (
            <AriaButton className="stage-empty glass" onPress={() => setLinkOpen(true)}>
              <Icon name="plus" size={18} />
              <span>
                <strong>Lier un support</strong>
                <small>Vidéo, audio, PDF, image, texte ou adresse d’un flux : la note y renvoie, et inversement.</small>
              </span>
            </AriaButton>
          ) : null}
        </div>
        <AnimatePresence initial={false}>
          {inspectorOpen ? (
            <motion.aside
              className="inspector glass"
              aria-label="Inspecteur"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
            >
              <Inspector
                note={note}
                cards={cards}
                activeResource={active}
                onSelectResource={(r) => setActive(r)}
                onLink={() => setLinkOpen(true)}
              />
            </motion.aside>
          ) : null}
        </AnimatePresence>
      </div>
      <LinkResourceSheet note={note} isOpen={linkOpen} onOpenChange={setLinkOpen} onLinked={(r) => setActive(r)} />
      {preview ? <WikiPreview title={preview.title} anchor={preview.el} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
