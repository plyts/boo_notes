import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
  markdownLanguage,
} from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Tree } from '@lezer/common';
import { shouldAutoStamp } from '../shared/autostamp';
import { findTimestamps, timestampToken, type TimestampMatch } from '../shared/markdown';
import { parseTimecode } from '../shared/time';

export interface EditorHooks {
  /** Current video position, `null` when no video is attached. */
  now(): number | null;
  autoTimestamp(): boolean;
  /** Hovering a timestamp previews it on the player's progress bar. */
  onTimestampHover(seconds: number | null): void;
  onTimestampClick(seconds: number): void;
  /** Any typed character / deletion (drives auto-pause). */
  onKeystroke(): void;
  onChange(): void;
  onSaveShortcut(): void;
  loadAsset(path: string): Promise<string>;
}

/** Marks programmatic content changes, which must not trigger a save. */
const external = Annotation.define<boolean>();

const CODE_NODES = new Set(['InlineCode', 'CodeText', 'FencedCode', 'CodeBlock']);

function inCode(tree: Tree, pos: number): boolean {
  for (let node: ReturnType<Tree['resolveInner']> | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

// --- Screenshot thumbnails --------------------------------------------------------

class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly alt: string,
    private readonly load: (path: string) => Promise<string>,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.path === this.path && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-boo-img';
    const tc = /(?:\d+:)?\d{1,2}:\d{2}/.exec(this.alt);
    const seconds = tc ? parseTimecode(tc[0]) : null;
    if (seconds !== null) {
      wrap.dataset.t = String(seconds);
      wrap.title = `Capture à ${tc?.[0]} — clic : revoir ce moment`;
    }
    const img = document.createElement('img');
    img.alt = this.alt || 'Capture';
    img.draggable = false;
    img.decoding = 'async';
    wrap.append(img);
    this.load(this.path).then(
      (url) => {
        img.src = url;
      },
      () => {
        wrap.classList.add('missing');
        wrap.textContent = 'Capture introuvable';
      },
    );
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- Live preview (Markdown rendered on inactive lines) -----------------------------

const hide = Decoration.replace({});

function buildPreview(view: EditorView, load: (path: string) => Promise<string>): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const active = new Set<number>();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      const a = state.doc.lineAt(r.from).number;
      const b = state.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) active.add(n);
    }
  }
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (name === 'FencedCode' || name === 'CodeBlock') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            out.push(Decoration.line({ class: 'cm-boo-codeblock' }).range(line.from));
            pos = line.to + 1;
          }
          return false;
        }
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(Decoration.line({ class: `cm-boo-h cm-boo-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
          return;
        }
        if (name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            out.push(Decoration.line({ class: 'cm-boo-quote' }).range(line.from));
            pos = line.to + 1;
          }
          return;
        }
        if (name === 'HeaderMark' && !isActive(node.from)) {
          const next = state.sliceDoc(node.to, node.to + 1);
          out.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
          return;
        }
        if ((name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') && !isActive(node.from)) {
          out.push(hide.range(node.from, node.to));
          return;
        }
        if (name === 'Image') {
          const m = /^!\[([^\]\n]*)\]\((assets\/[^)\s]+)\)$/.exec(state.sliceDoc(node.from, node.to));
          if (!m) return;
          const widget = new ImageWidget(m[2], m[1], load);
          if (isActive(node.from)) out.push(Decoration.widget({ widget, side: 1 }).range(node.to));
          else out.push(Decoration.replace({ widget }).range(node.from, node.to));
          return false;
        }
        return;
      },
    });

    // Timestamps become clickable chips; brackets and link targets are hidden off the cursor line.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      const lineActive = active.has(line.number);
      for (const m of findTimestamps(line.text, line.from)) {
        if (inCode(tree, m.from)) continue;
        out.push(
          Decoration.mark({
            class: 'cm-boo-ts',
            attributes: { 'data-t': String(m.seconds), title: `Aller à ${m.label} (Alt+clic pour éditer)` },
          }).range(m.from, m.labelTo),
        );
        if (!lineActive) {
          out.push(hide.range(m.from, m.from + 1), hide.range(m.labelTo - 1, m.labelTo));
          if (m.url !== null) out.push(hide.range(m.labelTo, m.to));
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

function livePreview(load: (path: string) => Promise<string>): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildPreview(view, load);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = buildPreview(u.view, load);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// --- "Now playing" line (video → note direction of the bidirectional highlight) ----

const setNowLine = StateEffect.define<number | null>();

const nowLine = StateField.define<{ pos: number | null; deco: DecorationSet }>({
  create: () => ({ pos: null, deco: Decoration.none }),
  update(value, tr) {
    let pos = value.pos !== null && tr.docChanged ? tr.changes.mapPos(value.pos) : value.pos;
    for (const e of tr.effects) if (e.is(setNowLine)) pos = e.value;
    if (pos === value.pos && !tr.docChanged) return value;
    const deco =
      pos === null || pos > tr.state.doc.length
        ? Decoration.none
        : Decoration.set([Decoration.line({ class: 'cm-boo-now' }).range(tr.state.doc.lineAt(pos).from)]);
    return { pos, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// --- Look ---------------------------------------------------------------------------

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.32em' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.16em' },
  { tag: t.heading3, fontWeight: '650', fontSize: '1.05em' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--faint)' },
  { tag: t.monospace, fontFamily: MONO, fontSize: '0.92em' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.processingInstruction, color: 'var(--faint)' },
  { tag: t.atom, color: 'var(--accent)' },
  { tag: t.contentSeparator, color: 'var(--faint)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', color: 'var(--text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.6', overflowX: 'hidden' },
  '.cm-content': { padding: '12px 16px 48px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 2px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-placeholder': { color: 'var(--faint)', fontStyle: 'italic' },
});

// --- Public API -----------------------------------------------------------------------

export class NotesEditor {
  readonly view: EditorView;
  private readonly editable = new Compartment();
  private readonly extensions: Extension[];
  private tsCache: { doc: EditorState['doc']; matches: TimestampMatch[] } | null = null;

  constructor(parent: HTMLElement, private readonly hooks: EditorHooks) {
    this.extensions = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, addKeymap: false }),
      syntaxHighlighting(highlight),
      theme,
      livePreview(hooks.loadAsset),
      nowLine,
      this.editable.of(EditorView.editable.of(true)),
      placeholder('Prenez vos notes… Chaque nouvelle ligne reçoit l’horodatage de la vidéo.'),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (hooks.onSaveShortcut(), true) },
        // Continue lists / quotes; Enter on an empty item ends the list.
        { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
        { key: 'Backspace', run: deleteMarkupBackward },
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.inputHandler.of((view, from, to, text) => this.autoStamp(view, from, to, text)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.every((tr) => tr.annotation(external))) return;
        if (u.transactions.some((tr) => tr.isUserEvent('input.type') || tr.isUserEvent('delete'))) {
          hooks.onKeystroke();
        }
        hooks.onChange();
      }),
      EditorView.domEventHandlers({
        mousedown: (e) => {
          const target = (e.target as Element | null)?.closest?.('.cm-boo-ts, .cm-boo-img[data-t]');
          if (!target || e.altKey || e.button !== 0) return false;
          e.preventDefault();
          hooks.onTimestampClick(Number(target.getAttribute('data-t')));
          return true;
        },
        mouseover: (e) => {
          const target = (e.target as Element | null)?.closest?.('.cm-boo-ts, .cm-boo-img[data-t]');
          if (target) hooks.onTimestampHover(Number(target.getAttribute('data-t')));
          return false;
        },
        mouseout: (e) => {
          const from = (e.target as Element | null)?.closest?.('.cm-boo-ts, .cm-boo-img[data-t]');
          const to = (e.relatedTarget as Element | null)?.closest?.('.cm-boo-ts, .cm-boo-img[data-t]');
          if (from && from !== to) hooks.onTimestampHover(null);
          return false;
        },
      }),
    ];
    this.view = new EditorView({ parent, state: this.createState('') });
  }

  get content(): string {
    return this.view.state.doc.toString();
  }

  get hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** Loads another note (fresh undo history), cursor at the end. */
  load(markdownText: string): void {
    this.view.setState(this.createState(markdownText));
    this.tsCache = null;
  }

  /** Content changed elsewhere (other window, background append): keep undo history and cursor. */
  replaceContent(markdownText: string): void {
    const { state } = this.view;
    const head = Math.min(state.selection.main.head, markdownText.length);
    this.view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: markdownText },
      selection: { anchor: head },
      annotations: [external.of(true)],
    });
  }

  setEditable(editable: boolean): void {
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(editable)) });
  }

  focus(where: 'keep' | 'end' = 'keep'): void {
    if (where === 'end') {
      const { doc } = this.view.state;
      const last = doc.line(doc.lines);
      if (last.length > 0) {
        this.view.dispatch({
          changes: { from: doc.length, insert: '\n' },
          selection: { anchor: doc.length + 1 },
          scrollIntoView: true,
        });
      } else {
        this.view.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true });
      }
    }
    this.view.focus();
  }

  /** `[MM:SS] ` at the cursor (or on a new last line when the editor is not focused). */
  insertTimestamp(seconds: number, focus: boolean): void {
    const token = `${timestampToken(seconds)} `;
    const { state } = this.view;
    if (this.view.hasFocus) {
      const sel = state.selection.main;
      const before = state.sliceDoc(Math.max(0, sel.from - 1), sel.from);
      const insert = (before && !/\s/.test(before) ? ' ' : '') + token;
      this.view.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: sel.from + insert.length },
        scrollIntoView: true,
        userEvent: 'input.timestamp',
      });
    } else {
      const end = state.doc.length;
      const prefix = state.doc.line(state.doc.lines).length > 0 ? '\n' : '';
      this.view.dispatch({
        changes: { from: end, insert: prefix + token },
        selection: { anchor: end + prefix.length + token.length },
        scrollIntoView: true,
        userEvent: 'input.timestamp',
      });
    }
    if (focus) this.view.focus();
  }

  /** A whole line (screenshot): under the cursor line when editing, appended otherwise. */
  insertBlock(text: string): void {
    const { state } = this.view;
    if (this.view.hasFocus) {
      const line = state.doc.lineAt(state.selection.main.head);
      const at = line.length === 0 ? line.from : line.to;
      let insert = (line.length === 0 ? '' : '\n') + text;
      if (line.number === state.doc.lines) insert += '\n';
      this.view.dispatch({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length },
        scrollIntoView: true,
        userEvent: 'input.capture',
      });
      return;
    }
    const doc = state.doc.toString();
    const blank = doc.trim() === '';
    const from = blank ? 0 : doc.length;
    const insert = blank ? `${text}\n` : `${doc.endsWith('\n') ? '' : '\n'}${text}\n`;
    this.view.dispatch({
      changes: { from, to: doc.length, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.capture',
    });
  }

  /** Highlights the note line whose timestamp was most recently reached by the video. */
  setPlaybackTime(seconds: number | null): void {
    const { state } = this.view;
    let pos: number | null = null;
    if (seconds !== null) {
      if (!this.tsCache || this.tsCache.doc !== state.doc) {
        this.tsCache = { doc: state.doc, matches: findTimestamps(state.doc.toString()) };
      }
      let best: TimestampMatch | null = null;
      for (const m of this.tsCache.matches) {
        if (m.seconds <= seconds + 0.25 && (!best || m.seconds >= best.seconds)) best = m;
      }
      pos = best?.from ?? null;
    }
    if (pos !== state.field(nowLine).pos) this.view.dispatch({ effects: setNowLine.of(pos) });
  }

  private createState(doc: string): EditorState {
    return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: this.extensions });
  }

  /** Flow 1: the first character typed on an empty line prefixes it with the video time. */
  private autoStamp(view: EditorView, from: number, to: number, text: string): boolean {
    if (from !== to || !this.hooks.autoTimestamp()) return false;
    const seconds = this.hooks.now();
    if (seconds === null) return false;
    const line = view.state.doc.lineAt(from);
    if (from !== line.to || !shouldAutoStamp(line.text, text)) return false;
    if (inCode(syntaxTree(view.state), Math.max(line.from, from - 1))) return false;
    const stamp = `${timestampToken(seconds)} `;
    view.dispatch({
      changes: { from, to, insert: stamp + text },
      selection: { anchor: from + stamp.length + text.length },
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
}
