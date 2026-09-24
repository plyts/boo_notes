import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { NotesEditor, type EditorHooks } from '../../../../src/panel/editor';
import { errorMessage } from '../lib/format';
import { toast } from '../ui';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface NoteEditorHandle {
  editor: NotesEditor;
  /** A new line starting with `token` (focused, at the end of the note). */
  stampLine(token: string): void;
  insertBlock(text: string, at?: 'cursor' | 'end'): void;
  focus(): void;
  flush(): Promise<void>;
}

export type NoteEditorHooks = Omit<EditorHooks, 'onChange' | 'onContentChanged' | 'onSaveShortcut' | 'onHelp' | 'loadAsset' | 'autoTimestamp'> & {
  onContentChanged?(markdown: string): void;
};

/**
 * The note: live-preview Markdown (the extension's editor) with autosave.
 * Browser notes are read-only here (they are written in the extension).
 */
export const NoteEditor = forwardRef<NoteEditorHandle, { noteId: string; rev: number; readOnly: boolean; hooks: NoteEditorHooks; onState?(state: SaveState): void }>(
  function NoteEditor({ noteId, rev, readOnly, hooks, onState }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const editorRef = useRef<NotesEditor | null>(null);
    // Latest hooks, read at call time: the editor is created once per note.
    const hooksRef = useRef(hooks);
    hooksRef.current = hooks;
    const stateRef = useRef<SaveState>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saving = useRef<Promise<void>>(Promise.resolve());
    const [, force] = useState(0);

    const setState = (s: SaveState) => {
      stateRef.current = s;
      onState?.(s);
      force((n) => n + 1);
    };

    const save = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const markdown = editor.content;
      setState('saving');
      saving.current = saving.current
        .then(() => window.boo.library.saveNote(noteId, markdown))
        .then(
          () => {
            if (stateRef.current === 'saving') setState('saved');
          },
          (e: unknown) => {
            setState('error');
            toast(`Note non enregistrée : ${errorMessage(e)}`, 'error');
          },
        );
    };

    const flush = async () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        save();
      }
      await saving.current;
    };

    useEffect(() => {
      if (!host.current) return;
      const h = () => hooksRef.current;
      const editor = new NotesEditor(host.current, {
        now: () => h().now(),
        autoTimestamp: () => !readOnly,
        stampToken: () => h().stampToken?.() ?? null,
        onTimestampHover: (s) => h().onTimestampHover(s),
        onTimestampClick: (s, r, end) => h().onTimestampClick(s, r, end),
        onMediaClick: (path, start) => h().onMediaClick?.(path, start),
        onTranscriptClick: (path) => h().onTranscriptClick?.(path),
        onPassageTranscript: (start, end) => h().onPassageTranscript?.(start, end),
        onPaste: (data, kind) => h().onPaste?.(data, kind) ?? false,
        onCopy: (markdown, data) => h().onCopy?.(markdown, data) ?? false,
        onCopyImage: (path) => h().onCopyImage?.(path),
        onAnchorClick: (k, n, r) => h().onAnchorClick?.(k, n, r),
        resourceBadge: (r) => h().resourceBadge?.(r) ?? null,
        onWikiLinkClick: (t) => h().onWikiLinkClick?.(t),
        onWikiLinkHover: (t, el) => h().onWikiLinkHover?.(t, el),
        wikiTitles: () => h().wikiTitles?.() ?? [],
        onFragmentClick: (url) => h().onFragmentClick?.(url),
        placeholderText: h().placeholderText,
        onKeystroke: () => h().onKeystroke(),
        onChange: () => {
          if (readOnly) return;
          setState('dirty');
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            save();
          }, 600);
        },
        onContentChanged: () => h().onContentChanged?.(editor.content),
        onSaveShortcut: () => void flush(),
        onHelp: () => undefined,
        loadAsset: async (path) => `boo://app/__vault/${path.split('/').map(encodeURIComponent).join('/')}`,
      });
      editorRef.current = editor;
      if (readOnly) editor.setEditable(false);
      let cancelled = false;
      void window.boo.library.readNote(noteId).then((md) => {
        if (cancelled) return;
        editor.load(md);
        setState('idle');
      });
      return () => {
        cancelled = true;
        void flush();
        editor.view.destroy();
        editorRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId, readOnly]);

    // A browser note changed in the extension: show the new revision.
    useEffect(() => {
      if (!readOnly || !editorRef.current) return;
      void window.boo.library.readNote(noteId).then((md) => editorRef.current?.replaceContent(md));
    }, [rev, readOnly, noteId]);

    useImperativeHandle(
      ref,
      () => ({
        get editor() {
          return editorRef.current!;
        },
        stampLine: (token) => {
          const e = editorRef.current;
          if (!e || readOnly) return;
          e.focus('end');
          e.insertToken(token, true);
        },
        insertBlock: (text, at = 'cursor') => {
          if (!readOnly) editorRef.current?.insertBlock(text, at);
        },
        focus: () => editorRef.current?.focus('keep'),
        flush,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [readOnly, noteId],
    );

    return <div ref={host} className="note-editor" aria-label="Note (Markdown)" />;
  },
);

export const SAVE_LABELS: Record<SaveState, string> = {
  idle: 'Enregistré',
  dirty: 'Modifié',
  saving: 'Enregistrement…',
  saved: 'Enregistré',
  error: 'Non enregistré',
};

export type { SaveState };
