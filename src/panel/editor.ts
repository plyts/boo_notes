import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
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
import {
  findFragmentLinks,
  findPageRefs,
  findPins,
  findSectionRefs,
  findTimestamps,
  findWikiLinks,
  normalizeTitle,
  timestampToken,
  type AnchorMatch,
  type TimestampMatch,
} from '../shared/markdown';
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
  /** Any content change, including loads and external updates (stats, timeline). */
  onContentChanged(): void;
  onSaveShortcut(): void;
  /** Ctrl/⌘ + / : keyboard shortcuts sheet. */
  onHelp(): void;
  loadAsset(path: string): Promise<string>;
  /**
   * Token prefixed to a new line (Flow 1). Defaults to the timestamp of `now()`;
   * documents return their own anchor (`[p. 12]`, `[§ 4]`…).
   */
  stampToken?(): string | null;
  /** Click on a page (`[p. 12]`), paragraph (`[§ 4]`) or pin (`[pin 3]`) chip. */
  onAnchorClick?(kind: AnchorKind, n: number): void;
  /** Click on a `[[Titre]]` link to another note. */
  onWikiLinkClick?(title: string): void;
  /** Hovering a `[[Titre]]` link (preview), `null` when leaving it. */
  onWikiLinkHover?(title: string | null, target: HTMLElement | null): void;
  /** Note titles offered after `[[` (autocompletion); no completion when absent. */
  wikiTitles?(): string[];
  /** Click on a link to a passage of a web page (`[↗](URL#:~:text=…)`). */
  onFragmentClick?(url: string): void;
  /** Text of an empty note. */
  placeholderText?: string;
}

export type AnchorKind = 'page' | 'section' | 'pin';

const ANCHOR_TITLES: Record<AnchorKind, (n: number) => string> = {
  page: (n) => `Aller à la page ${n}`,
  section: (n) => `Aller au paragraphe ${n}`,
  pin: (n) => `Montrer le repère ${n} sur l’image`,
};

/** Page, paragraph and pin anchors of a line. */
function documentAnchors(text: string, offset: number): AnchorMatch[] {
  return [
    ...findPageRefs(text, offset).map((m) => ({ from: m.from, to: m.to, kind: 'page' as const, value: m.page, labelFrom: m.from + 1 })),
    ...findSectionRefs(text, offset),
    ...findPins(text, offset),
  ].sort((a, b) => a.from - b.from);
}

export interface NoteMarker {
  seconds: number;
  kind: 'note' | 'capture';
}

/** A line made only of a timestamp and a screenshot: rendered as a capture card. */
const CAPTURE_LINE = /^\[((?:\d+:)?\d{1,3}:\d{2})\]\s+(?=!\[[^\]\n]*\]\(assets\/[^)\s]+\)\s*$)/;

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
    const img = document.createElement('img');
    img.alt = this.alt || 'Capture';
    img.draggable = false;
    img.decoding = 'async';
    wrap.append(img);
    if (seconds !== null && tc) {
      wrap.dataset.t = String(seconds);
      wrap.title = `Capture à ${tc[0]} — cliquer pour revoir ce moment`;
      // Timecode badge + "replay" affordance shown on hover.
      const badge = document.createElement('span');
      badge.className = 'cm-boo-img-tc';
      badge.textContent = tc[0];
      const replay = document.createElement('span');
      replay.className = 'cm-boo-img-replay';
      replay.textContent = 'Revoir';
      wrap.append(badge, replay);
    }
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
      const capture = CAPTURE_LINE.exec(line.text);
      if (capture && !inCode(tree, line.from)) {
        out.push(Decoration.line({ class: 'cm-boo-capture-line' }).range(line.from));
        if (!lineActive) {
          // The card carries the timecode: hide the leading "[MM:SS] ".
          out.push(hide.range(line.from, line.from + capture[0].length));
          pos = line.to + 1;
          continue;
        }
      }
      const stamps = findTimestamps(line.text, line.from);
      const touches = (from: number, to: number) =>
        view.hasFocus && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
      const anchors = documentAnchors(line.text, line.from);
      if (!capture && anchors[0]?.from === line.from && !inCode(tree, line.from)) {
        out.push(Decoration.line({ class: 'cm-boo-stamped' }).range(line.from));
      }
      for (const a of anchors) {
        if (inCode(tree, a.from)) continue;
        const kind = a.kind as AnchorKind;
        out.push(
          Decoration.mark({
            class: `cm-boo-ts cm-boo-${kind}`,
            attributes: { 'data-anchor': `${kind}:${a.value}`, title: `${ANCHOR_TITLES[kind](a.value)} (Alt+clic pour éditer)` },
          }).range(a.from, a.to),
        );
        if (!touches(a.from, a.to)) {
          // `[pin 3]` shows as « ◉ 3 » (prefix drawn in CSS), `[p. 3]` as « p. 3 », `[§ 3]` as « § 3 ».
          out.push(hide.range(a.from, kind === 'pin' ? a.labelFrom : a.from + 1), hide.range(a.to - 1, a.to));
        }
      }
      for (const w of findWikiLinks(line.text, line.from)) {
        if (inCode(tree, w.from)) continue;
        out.push(
          Decoration.mark({
            class: 'cm-boo-wiki',
            attributes: { 'data-wiki': w.title, title: `Ouvrir « ${w.title} » (Alt+clic pour éditer)` },
          }).range(w.from, w.to),
        );
        if (!touches(w.from, w.to)) out.push(hide.range(w.from, w.labelFrom), hide.range(w.labelTo, w.to));
      }
      for (const f of findFragmentLinks(line.text, line.from)) {
        if (inCode(tree, f.from)) continue;
        out.push(
          Decoration.mark({
            class: 'cm-boo-ts cm-boo-frag',
            attributes: { 'data-frag': f.url, title: 'Revoir ce passage dans la page (Alt+clic pour éditer)' },
          }).range(f.from, f.to),
        );
        if (!touches(f.from, f.to)) out.push(hide.range(f.from, f.labelFrom), hide.range(f.labelTo, f.to));
      }
      if (!capture && stamps[0]?.from === line.from && !inCode(tree, line.from)) {
        // Transcript layout: wrapped text aligns after the leading timestamp.
        const cls = stamps[0].label.length > 5 ? 'cm-boo-stamped cm-boo-long' : 'cm-boo-stamped';
        out.push(Decoration.line({ class: cls }).range(line.from));
      }
      for (const m of stamps) {
        if (inCode(tree, m.from)) continue;
        out.push(
          Decoration.mark({
            class: 'cm-boo-ts',
            attributes: { 'data-t': String(m.seconds), title: `Aller à ${m.label} (Alt+clic pour éditer)` },
          }).range(m.from, m.labelTo),
        );
        // Reveal the raw `[MM:SS](url)` only when the cursor touches it (Typora-style),
        // so typing after a timestamp never makes the line jump.
        const touched = view.hasFocus && state.selection.ranges.some((r) => r.from <= m.to && r.to >= m.from);
        if (!touched) {
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
      placeholder(hooks.placeholderText ?? 'Écrivez ici…'),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (hooks.onSaveShortcut(), true) },
        { key: 'Mod-/', preventDefault: true, run: () => (hooks.onHelp(), true) },
        // Continue lists / quotes; Enter on an empty item ends the list.
        { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
        { key: 'Backspace', run: deleteMarkupBackward },
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.inputHandler.of((view, from, to, text) => this.autoStamp(view, from, to, text)),
      hooks.wikiTitles
        ? autocompletion({ override: [(ctx) => this.wikiCompletions(ctx)], icons: false, closeOnBlur: true })
        : [],
      EditorView.updateListener.of((u) => {
        if (u.docChanged) hooks.onContentChanged();
        if (!u.docChanged || u.transactions.every((tr) => tr.annotation(external))) return;
        if (u.transactions.some((tr) => tr.isUserEvent('input.type') || tr.isUserEvent('delete'))) {
          hooks.onKeystroke();
        }
        hooks.onChange();
      }),
      EditorView.domEventHandlers({
        mousedown: (e) => {
          const target = (e.target as Element | null)?.closest?.('.cm-boo-ts, .cm-boo-img[data-t], .cm-boo-wiki');
          if (!target || e.altKey || e.button !== 0) return false;
          e.preventDefault();
          const anchor = target.getAttribute('data-anchor');
          const wiki = target.getAttribute('data-wiki');
          const frag = target.getAttribute('data-frag');
          if (anchor !== null) {
            const [kind, n] = anchor.split(':');
            hooks.onAnchorClick?.(kind as AnchorKind, Number(n));
          } else if (wiki !== null) hooks.onWikiLinkClick?.(wiki);
          else if (frag !== null) hooks.onFragmentClick?.(frag);
          else hooks.onTimestampClick(Number(target.getAttribute('data-t')));
          return true;
        },
        mouseover: (e) => {
          const target = (e.target as Element | null)?.closest?.('.cm-boo-ts[data-t], .cm-boo-img[data-t]');
          if (target) hooks.onTimestampHover(Number(target.getAttribute('data-t')));
          const wiki = (e.target as Element | null)?.closest?.('.cm-boo-wiki') as HTMLElement | null;
          if (wiki) hooks.onWikiLinkHover?.(wiki.getAttribute('data-wiki'), wiki);
          return false;
        },
        mouseout: (e) => {
          const from = (e.target as Element | null)?.closest?.('.cm-boo-ts[data-t], .cm-boo-img[data-t]');
          const to = (e.relatedTarget as Element | null)?.closest?.('.cm-boo-ts[data-t], .cm-boo-img[data-t]');
          if (from && from !== to) hooks.onTimestampHover(null);
          const wikiFrom = (e.target as Element | null)?.closest?.('.cm-boo-wiki');
          const wikiTo = (e.relatedTarget as Element | null)?.closest?.('.cm-boo-wiki');
          if (wikiFrom && wikiFrom !== wikiTo) hooks.onWikiLinkHover?.(null, null);
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
    this.hooks.onContentChanged();
  }

  get isEmpty(): boolean {
    return this.view.state.doc.length === 0 || this.content.trim() === '';
  }

  /** Every timestamp of the note, for the timeline and the note statistics. */
  markers(): NoteMarker[] {
    const out: NoteMarker[] = [];
    const { doc } = this.view.state;
    for (let n = 1; n <= doc.lines; n++) {
      const text = doc.line(n).text;
      const capture = CAPTURE_LINE.exec(text);
      if (capture) {
        const seconds = parseTimecode(capture[1]);
        if (seconds !== null) out.push({ seconds, kind: 'capture' });
        continue;
      }
      for (const m of findTimestamps(text)) out.push({ seconds: m.seconds, kind: 'note' });
    }
    return out;
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
    this.insertToken(timestampToken(seconds), focus);
  }

  /** A stamp token (`[MM:SS]`, `[p. 12]`) followed by a space, at the cursor or on a new last line. */
  insertToken(stamp: string, focus: boolean): void {
    const token = `${stamp} `;
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

  /**
   * A whole line (screenshot, quote): under the cursor line when editing,
   * appended otherwise (or always, with `at: 'end'`).
   */
  insertBlock(text: string, at: 'cursor' | 'end' = 'cursor'): void {
    const { state } = this.view;
    // A quote needs a blank line after it: the next line would otherwise continue the quote.
    const quote = text.startsWith('>');
    if (at === 'cursor' && this.view.hasFocus) {
      const line = state.doc.lineAt(state.selection.main.head);
      const at = line.length === 0 ? line.from : line.to;
      let insert = (line.length === 0 ? '' : '\n') + text;
      if (quote) insert += '\n\n';
      else if (line.number === state.doc.lines) insert += '\n';
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
    const tail = quote ? '\n\n' : '\n';
    const insert = blank ? `${text}${tail}` : `${doc.endsWith('\n') ? '' : '\n'}${text}${tail}`;
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

  /** Document equivalent of `setPlaybackTime`: highlights the last note about `page` or before. */
  setCurrentPage(page: number | null): void {
    this.setCurrentAnchor('page', page);
  }

  /**
   * Highlights the note line of the anchor being looked at: the last one at or
   * before `value` (pages, paragraphs), or exactly `value` (pins).
   */
  setCurrentAnchor(kind: AnchorKind, value: number | null): void {
    const { state } = this.view;
    let pos: number | null = null;
    if (value !== null) {
      let best: AnchorMatch | null = null;
      for (const m of documentAnchors(state.doc.toString(), 0)) {
        if (m.kind !== kind) continue;
        const ok = kind === 'pin' ? m.value === value : m.value <= value;
        if (ok && (!best || m.value >= best.value)) best = m;
      }
      pos = best?.from ?? null;
    }
    if (pos !== state.field(nowLine).pos) this.view.dispatch({ effects: setNowLine.of(pos) });
  }

  /** Reading mode: highlights the note line quoting the passage being read (`url`: its text fragment link). */
  setCurrentFragment(url: string | null): void {
    const { state } = this.view;
    let pos: number | null = null;
    if (url !== null) pos = findFragmentLinks(state.doc.toString()).find((f) => f.url === url)?.from ?? null;
    if (pos !== state.field(nowLine).pos) this.view.dispatch({ effects: setNowLine.of(pos) });
  }

  /** Types `[[` at the cursor and opens the list of notes to link. */
  insertWikiLink(): void {
    this.view.focus();
    const at = this.view.state.selection.main.head;
    this.view.dispatch({ changes: { from: at, insert: '[[' }, selection: { anchor: at + 2 }, userEvent: 'input.type' });
    startCompletion(this.view);
  }

  /** Scrolls to (and highlights) the first line with this anchor (or timestamp); false when there is none. */
  revealAnchor(kind: AnchorKind | 'time', value: number): boolean {
    const doc = this.view.state.doc.toString();
    const from =
      kind === 'time'
        ? findTimestamps(doc).find((m) => m.seconds === value)?.from
        : documentAnchors(doc, 0).find((a) => a.kind === kind && a.value === value)?.from;
    if (from === undefined) return false;
    this.view.dispatch({ effects: [setNowLine.of(from), EditorView.scrollIntoView(from, { y: 'center' })] });
    return true;
  }

  /** Number of notes per anchor value (pages, paragraphs, pins): markers in the viewer. */
  anchorCounts(kind: AnchorKind): Map<number, number> {
    const counts = new Map<number, number>();
    for (const a of documentAnchors(this.view.state.doc.toString(), 0)) {
      if (a.kind === kind) counts.set(a.value, (counts.get(a.value) ?? 0) + 1);
    }
    return counts;
  }

  private wikiCompletions(ctx: CompletionContext): CompletionResult | null {
    const m = ctx.matchBefore(/\[\[[^[\]\n|]*$/);
    if (!m) return null;
    const query = m.text.slice(2);
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const closing = after === ']]' ? '' : ']]';
    const apply = (title: string) => (view: EditorView, _c: Completion, from: number, to: number) => {
      const insert = `${title}${closing}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length + (closing ? 0 : 2) },
        userEvent: 'input.complete',
      });
    };
    // Filtered here, ignoring case and accents (« elec » finds « Électricité »): titles starting with the query first.
    const q = normalizeTitle(query);
    const scored = (this.hooks.wikiTitles?.() ?? [])
      .map((title) => ({ title, at: normalizeTitle(title).indexOf(q) }))
      .filter((t) => t.at !== -1)
      .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.title.localeCompare(b.title, 'fr'));
    const options: Completion[] = scored.map(({ title }) => ({ label: title, apply: apply(title), type: 'text' }));
    // Offer to create a sheet only when no existing note matches what is typed.
    if (q && !options.length) options.push({ label: query.trim(), detail: 'nouvelle fiche', apply: apply(query.trim()) });
    return { from: m.from + 2, options, filter: false };
  }

  private createState(doc: string): EditorState {
    return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: this.extensions });
  }

  /** Flow 1: the first character typed on an empty line prefixes it with the video time. */
  private autoStamp(view: EditorView, from: number, to: number, text: string): boolean {
    if (from !== to || !this.hooks.autoTimestamp()) return false;
    let token: string | null;
    if (this.hooks.stampToken) token = this.hooks.stampToken();
    else {
      const seconds = this.hooks.now();
      token = seconds === null ? null : timestampToken(seconds);
    }
    if (token === null) return false;
    const line = view.state.doc.lineAt(from);
    if (from !== line.to || !shouldAutoStamp(line.text, text)) return false;
    if (inCode(syntaxTree(view.state), Math.max(line.from, from - 1))) return false;
    const stamp = `${token} `;
    view.dispatch({
      changes: { from, to, insert: stamp + text },
      selection: { anchor: from + stamp.length + text.length },
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
}
