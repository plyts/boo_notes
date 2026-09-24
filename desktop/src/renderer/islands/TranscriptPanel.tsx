import { useEffect, useRef } from 'react';
import { TranscriptView } from '../../../../src/panel/transcript-view';
import { CueTranslator } from '../../../../src/panel/translator';
import type { Cue, CuePatch, Transcript } from '../../../../src/shared/transcript';
import { errorMessage } from '../lib/format';
import { toast } from '../ui';

export interface TranscriptPanelProps {
  noteId: string;
  /** Browser note: the transcript is annotated in the extension, here it is read and listened to. */
  readOnly: boolean;
  /** Changes when the transcript was saved (reload). */
  version: number;
  visible: boolean;
  /** Stretches whose sound is kept (media/…). */
  coverage: Array<[number, number]>;
  time(): number | null;
  seek(seconds: number): void;
  pin(cue: Cue): void;
  passage(start: number, end: number, record: boolean, firstCue: Cue | null): void;
  pinTranscript(t: Transcript): void;
  listen(seconds: number): void;
  notesIn(start: number, end: number): number;
  onLoaded?(t: Transcript | null): void;
}

/**
 * The « Transcription » of a note in the app: the same view as the browser
 * panel (karaoke follow, translation, comments, passages), fed by the vault
 * (`transcripts/<note>.json`).
 */
export function TranscriptPanel(props: TranscriptPanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const cbs = useRef(props);
  cbs.current = props;
  const viewRef = useRef<TranscriptView | null>(null);
  const tRef = useRef<Transcript | null>(null);
  const translating = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const noteId = props.noteId;
    const set = (t: Transcript | null) => {
      tRef.current = t;
      view.set(t);
      view.setState({ status: t?.cues.length ? 'complete' : 'searching', source: t?.source ?? null, label: t?.label ?? '' });
      translator.update(t, cbs.current.time());
      cbs.current.onLoaded?.(t);
    };
    const annotate = (patches: CuePatch[], lang?: string) => {
      const t = tRef.current;
      if (!t || cbs.current.readOnly) return;
      void window.boo.library.annotateTranscript(noteId, patches, { lang, target: 'fr' }).then(
        (next) => set(next),
        (e: unknown) => toast(`Transcription non enregistrée : ${errorMessage(e)}`, 'error'),
      );
    };
    const translator = new CueTranslator({
      patch: (patches, lang) => annotate(patches, lang),
      status: (s) => view.setTranslate(translating.current, s),
    });
    const view = new TranscriptView({
      seek: (s) => cbs.current.seek(s),
      pin: (cue) => cbs.current.pin(tRef.current?.cues.find((c) => c.id === cue.id) ?? cue),
      annotate: (id, field, value) => annotate([{ id, [field]: value }]),
      passage: (start, end, record) => {
        const first = tRef.current?.cues.find((c) => c.end > start && c.start < end) ?? null;
        cbs.current.passage(start, end, record, first);
      },
      toggleTranslate: (on) => {
        translating.current = on;
        if (on) void translator.enable('fr');
        else translator.disable();
        view.setTranslate(on, translator.state);
      },
      pinTranscript: () => {
        const t = tRef.current;
        if (t?.cues.length) cbs.current.pinTranscript(t);
        else toast('Pas encore de sous-titres à épingler', 'error');
      },
      listen: (s) => cbs.current.listen(s),
      notesIn: (start, end) => cbs.current.notesIn(start, end),
      importSubtitles: () =>
        void window.boo.library.importSubtitles(noteId).then(
          (t) => {
            if (!t) return;
            set(t);
            toast(`Sous-titres ajoutés : ${t.cues.length} répliques`, 'success');
          },
          (e: unknown) => toast(errorMessage(e), 'error'),
        ),
    });
    viewRef.current = view;
    host.current.replaceChildren(view.el);
    view.setReadOnly(props.readOnly);
    view.setEmptyText(
      props.readOnly
        ? 'La transcription de cette vidéo se fait dans l’extension du navigateur : elle apparaîtra ici après la lecture.'
        : 'Pas encore de sous-titres pour ce média. Ajoutez un fichier .vtt ou .srt — ou placez-le à côté de la vidéo, avec le même nom.',
    );
    view.show(true);
    let cancelled = false;
    void window.boo.library.transcript(noteId).then((t) => {
      if (!cancelled) set(t);
    });
    const timer = setInterval(() => {
      if (!view.el.isConnected || !cbs.current.visible) return;
      view.setTime(cbs.current.time());
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
      translator.disable();
      view.el.remove();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.noteId, props.readOnly]);

  // Saved elsewhere (browser sync, subtitles file): reload.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !props.version) return;
    let cancelled = false;
    void window.boo.library.transcript(props.noteId).then((t) => {
      if (cancelled || !t) return;
      tRef.current = t;
      view.set(t);
      view.setState({ status: t.cues.length ? 'complete' : 'searching', source: t.source, label: t.label });
      cbs.current.onLoaded?.(t);
    });
    return () => {
      cancelled = true;
    };
  }, [props.version, props.noteId]);

  useEffect(() => {
    viewRef.current?.setCoverage(props.coverage);
  }, [props.coverage]);

  useEffect(() => {
    if (props.visible) viewRef.current?.show(true);
  }, [props.visible]);

  return <div ref={host} className="transcript-host" hidden={!props.visible} />;
}
