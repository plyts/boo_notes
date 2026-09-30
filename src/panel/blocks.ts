import { EditorState, Facet, Prec, StateEffect, StateField, type Extension, type Range, type Text, type Transaction, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import {
  answerLines,
  convertBlock,
  findCallouts,
  lineToBlock,
  questionNumberAt,
  questionOf,
  renumberQuestions,
  withAnswer,
  type Answer,
  type BlockKind,
  type Callout,
} from '../shared/callouts';

/**
 * Question and « Note libre » blocks in the editor (see shared/callouts):
 * the « + » shown beside the line under the mouse, its menu (Question, Note
 * libre, back to a normal note), the look of the blocks, their numbering,
 * and the questions being answered.
 */

export interface AskRequest {
  /** Given back with the answer. */
  id: number;
  question: string;
  /** When it was asked (seconds of the video), from its header. */
  stamp: number | null;
}

export interface BlockHooks {
  /** A question to answer from the course: `answer(id, …)` puts the answer in its block. */
  onAsk(req: AskRequest): void;
}

// --- The blocks of a document ---------------------------------------------------------------

const cache = new WeakMap<Text, { lines: string[]; callouts: Callout[] }>();

export function blocksOf(doc: Text): { lines: string[]; callouts: Callout[] } {
  let c = cache.get(doc);
  if (!c) {
    const lines = doc.toString().split('\n');
    c = { lines, callouts: findCallouts(lines) };
    cache.set(doc, c);
  }
  return c;
}

/** The block holding line `n` (1-based), if any. */
export function blockAtLine(doc: Text, n: number): Callout | null {
  return blocksOf(doc).callouts.find((c) => n - 1 >= c.from && n - 1 <= c.to) ?? null;
}

// --- Questions being answered ------------------------------------------------------------------

const blockHooks = Facet.define<BlockHooks, BlockHooks>({ combine: (v) => v[0] ?? { onAsk: () => undefined } });

interface Asking {
  id: number;
  /** Start of the question's header line. */
  pos: number;
}

let askSeq = 0;
const addAsking = StateEffect.define<Asking>();
const endAsking = StateEffect.define<number>();

const asking = StateField.define<Asking[]>({
  create: () => [],
  update(list, tr) {
    let next = tr.docChanged ? list.map((a) => ({ ...a, pos: tr.changes.mapPos(a.pos, 1) })) : list;
    for (const e of tr.effects) {
      if (e.is(addAsking)) next = [...next.filter((a) => a.pos !== e.value.pos), e.value];
      else if (e.is(endAsking)) next = next.filter((a) => a.id !== e.value);
    }
    return next;
  },
});

/** The question block a pending answer belongs to (null: the question is gone). */
function askedBlock(state: EditorState, id: number): Callout | null {
  const a = state.field(asking).find((x) => x.id === id);
  if (!a || a.pos > state.doc.length) return null;
  const c = blockAtLine(state.doc, state.doc.lineAt(a.pos).number);
  return c?.kind === 'question' ? c : null;
}

/** Replaces lines `from`..`to` (1-based) with `next`, changing only what differs. */
function replaceLines(view: EditorView, from: number, to: number, next: readonly string[], userEvent: string, extra: TransactionSpec = {}): void {
  const { doc } = view.state;
  const start = doc.line(from).from;
  const end = doc.line(to).to;
  const before = doc.sliceString(start, end);
  const after = next.join('\n');
  let a = 0;
  while (a < before.length && a < after.length && before[a] === after[a]) a++;
  let b = 0;
  while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  view.dispatch({ changes: { from: start + a, to: end - b, insert: after.slice(a, after.length - b) }, userEvent, ...extra });
}

/** Starts answering the question block `c`. */
function ask(view: EditorView, c: Callout): boolean {
  const { lines } = blocksOf(view.state.doc);
  const q = questionOf(lines, c);
  if (!q.text) return false;
  const id = ++askSeq;
  view.dispatch({ effects: addAsking.of({ id, pos: view.state.doc.line(c.from + 1).from }) });
  view.state.facet(blockHooks).onAsk({ id, question: q.text, stamp: q.stamp });
  return true;
}

/** Puts the answer in the block of question `id` (in place of the one it had). */
export function putAnswer(view: EditorView, id: number, answer: Answer): boolean {
  const c = askedBlock(view.state, id);
  if (!c) {
    view.dispatch({ effects: endAsking.of(id) });
    return false;
  }
  const { lines } = blocksOf(view.state.doc);
  const block = lines.slice(c.from, c.to + 1);
  // Written into the note like a paste: saved and undoable, the cursor where it was.
  replaceLines(view, c.from + 1, c.to + 1, withAnswer(block, answerLines(answer)), 'input.answer', { effects: endAsking.of(id) });
  return true;
}

/** The answer did not come: the question waits for another try. */
export function dropAnswer(view: EditorView, id: number): void {
  view.dispatch({ effects: endAsking.of(id) });
}

// --- Turning lines into blocks --------------------------------------------------------------------

export type BlockAction = BlockKind | 'normal' | 'ask';

/** What the + menu offers for line `n` (1-based): the block it is in, if any. */
export function blockState(doc: Text, n: number): { block: Callout | null; answered: boolean } {
  const block = blockAtLine(doc, n);
  const answered = block?.kind === 'question' ? questionOf(blocksOf(doc).lines, block).answered : false;
  return { block, answered };
}

/** Applies a choice of the + menu to line `n` (1-based) and to its block. */
export function applyBlock(view: EditorView, n: number, action: BlockAction): void {
  const { doc } = view.state;
  const { lines } = blocksOf(doc);
  const block = blockAtLine(doc, n);
  if (action === 'ask') {
    if (block?.kind === 'question') ask(view, block);
    return;
  }
  if (block) {
    if ((action === 'question' && block.kind === 'question') || (action === 'free' && block.kind === 'free')) return;
    const next = convertBlock(lines.slice(block.from, block.to + 1), action, questionNumberAt(lines, block.from));
    replaceLines(view, block.from + 1, block.to + 1, next, 'input.block');
    if (action === 'question') {
      const c = blockAtLine(view.state.doc, block.from + 1);
      if (c?.kind === 'question' && !questionOf(blocksOf(view.state.doc).lines, c).answered) ask(view, c);
    }
    view.focus();
    return;
  }
  if (action === 'normal') return;
  const line = doc.line(n);
  const made = lineToBlock(line.text, action, questionNumberAt(lines, n - 1));
  // A blank line around the block: Markdown would otherwise join it to the text next to it.
  const prev = n > 1 ? doc.line(n - 1).text : '';
  const next = n < doc.lines ? doc.line(n + 1).text : null;
  const out = [...(prev.trim() !== '' ? [''] : []), ...made, ...(next !== null && next.trim() !== '' ? [''] : [])];
  const bodyIndex = (prev.trim() !== '' ? 1 : 0) + made.length - 1;
  const offset = out.slice(0, bodyIndex).reduce((sum, l) => sum + l.length + 1, 0) + out[bodyIndex].length;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: out.join('\n') },
    // The cursor at the end of the block's text: writing goes on in it.
    selection: { anchor: line.from + offset },
    scrollIntoView: true,
    userEvent: 'input.block',
  });
  view.focus();
  if (action === 'question') {
    const c = blockAtLine(view.state.doc, view.state.doc.lineAt(line.from + offset).number);
    if (c) ask(view, c);
  }
}

/** Writing goes on under block `c`, as a normal note (a blank line between them). */
function exitBelow(view: EditorView, c: Callout): void {
  const { doc } = view.state;
  const last = doc.line(c.to + 1);
  const after = c.to + 2 <= doc.lines ? doc.line(c.to + 2) : null;
  let at: number;
  let insert: string;
  if (after?.text === '') [at, insert] = [after.to, '\n'];
  else [at, insert] = [last.to, '\n\n'];
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true, userEvent: 'input' });
}

/**
 * Enter in a block. At the end of a question: it is asked (when it is not
 * yet), and writing goes on under the block. On the empty last line of a
 * block: out of it, as a normal note. Elsewhere, a new line in the block.
 */
function blockEnter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || !state.facet(EditorView.editable)) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const c = blockAtLine(state.doc, line.number);
  if (!c || c.kind === 'other') return false;
  const n = line.number - 1;
  if (n === c.to && n > c.from + 1 && /^>[ \t]*$/.test(line.text)) {
    // The empty line leaves the block: it becomes the blank line after it.
    const after = n + 2 <= state.doc.lines ? state.doc.line(n + 2) : null;
    if (after?.text === '') view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: after.from - (line.to - line.from) }, userEvent: 'input' });
    else view.dispatch({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, scrollIntoView: true, userEvent: 'input' });
    return true;
  }
  if (c.kind !== 'question') return false;
  const q = questionOf(blocksOf(state.doc).lines, c);
  if (!q.text || n !== q.lastLine) return false;
  const pending = state.field(asking).some((a) => state.doc.lineAt(Math.min(a.pos, state.doc.length)).number === c.from + 1);
  exitBelow(view, c);
  if (!q.answered && !pending) {
    const asked = blockAtLine(view.state.doc, c.from + 1);
    if (asked?.kind === 'question') ask(view, asked);
  }
  return true;
}

// --- Numbering --------------------------------------------------------------------------------------

function headerIn(doc: Text, from: number, to: number): boolean {
  for (let pos = from; pos <= to && pos <= doc.length; ) {
    const line = doc.lineAt(pos);
    if (line.text.startsWith('>') && line.text.includes('[!')) return true;
    pos = line.to + 1;
  }
  return false;
}

/** Questions keep their numbers in the order of the note, whatever is added, moved or removed. */
const renumber = EditorState.transactionFilter.of((tr: Transaction) => {
  if (!tr.docChanged) return tr;
  let touched = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    touched ||= headerIn(tr.startState.doc, fromA, toA) || headerIn(tr.newDoc, fromB, toB);
  });
  if (!touched) return tr;
  const edits = renumberQuestions(blocksOf(tr.newDoc).lines);
  if (!edits.length) return tr;
  const changes = edits.map((e) => {
    const line = tr.newDoc.line(e.line + 1);
    return { from: line.from + e.from, to: line.from + e.to, insert: e.text };
  });
  return [tr, { changes, sequential: true }];
});

// --- Look ----------------------------------------------------------------------------------------------

const ICONS = {
  question:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17h.01"/></svg>',
  free: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  normal:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
  ask: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  other:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
};

class BadgeWidget extends WidgetType {
  constructor(
    readonly kind: Callout['kind'],
    readonly label: string,
  ) {
    super();
  }

  eq(other: BadgeWidget): boolean {
    return other.kind === this.kind && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-boo-badge cm-boo-badge-${this.kind}`;
    el.innerHTML = ICONS[this.kind === 'question' ? 'question' : this.kind === 'free' ? 'free' : 'other'];
    el.append(document.createTextNode(this.label));
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class StatusWidget extends WidgetType {
  constructor(readonly state: 'pending' | 'ask' | 'empty' | 'enter') {
    super();
  }

  eq(other: StatusWidget): boolean {
    return other.state === this.state;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-boo-qstate cm-boo-qstate-${this.state}`;
    if (this.state === 'pending') {
      el.setAttribute('role', 'status');
      el.textContent = 'Recherche de la réponse dans le cours…';
    } else if (this.state === 'ask') {
      el.setAttribute('role', 'button');
      el.dataset.booAsk = '';
      el.title = 'Chercher la réponse dans la transcription, la page du cours et vos notes';
      el.innerHTML = `${ICONS.ask}<span>Chercher la réponse</span>`;
    } else if (this.state === 'enter') {
      el.textContent = 'Entrée : chercher la réponse';
    } else {
      el.textContent = 'Écrivez votre question, puis Entrée';
    }
    return el;
  }

  ignoreEvent(): boolean {
    return this.state !== 'ask';
  }
}

const hideMark = Decoration.replace({});
const QUESTION_LABEL = /^Question(?:[ \t]+\d+)?/;

function activeLines(view: EditorView): Set<number> {
  const active = new Set<number>();
  if (!view.hasFocus) return active;
  const { state } = view;
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) active.add(n);
  }
  return active;
}

function buildBlocks(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const { lines, callouts } = blocksOf(doc);
  const active = activeLines(view);
  const pending = new Set(state.field(asking).map((a) => doc.lineAt(Math.min(a.pos, doc.length)).number));
  const visible = (from: number, to: number) => view.visibleRanges.some((r) => r.from <= to && r.to >= from);
  const out: Range<Decoration>[] = [];
  for (const c of callouts) {
    const first = doc.line(c.from + 1);
    if (!visible(first.from, doc.line(c.to + 1).to)) continue;
    const kind = c.kind === 'question' ? 'q' : c.kind;
    for (let n = c.from; n <= c.to; n++) {
      const line = doc.line(n + 1);
      const cls = `cm-boo-callout cm-boo-callout-${kind}${n === c.from ? ' cm-boo-callout-head' : ''}${n === c.to ? ' cm-boo-callout-last' : ''}`;
      out.push(Decoration.line({ class: cls }).range(line.from));
      if (active.has(n + 1)) continue;
      if (n === c.from) {
        const marker = /^>[ \t]?\[![\w-]+\][+-]?[ \t]*/.exec(line.text)?.[0] ?? '';
        const title = line.text.slice(marker.length);
        // « Question 3 » (what follows, the moment it was asked, stays as a chip); another title: up to « · ».
        const shown = c.kind === 'question' ? (QUESTION_LABEL.exec(title)?.[0] ?? '') : title.split(' · ')[0];
        const label = shown || (c.kind === 'free' ? 'Note libre' : c.kind === 'question' ? 'Question' : c.type.charAt(0).toUpperCase() + c.type.slice(1));
        // « · » before the moment the question was asked: the badge stands for it.
        const sep = /^[ \t]*·[ \t]*/.exec(title.slice(shown.length))?.[0].length ?? 0;
        out.push(Decoration.replace({ widget: new BadgeWidget(c.kind, label) }).range(line.from, line.from + marker.length + shown.length + sep));
      } else {
        const mark = /^>[ \t]?/.exec(line.text)?.[0] ?? '';
        if (mark) out.push(hideMark.range(line.from, line.from + mark.length));
      }
    }
    if (c.kind === 'question') {
      const q = questionOf(lines, c);
      const end = doc.line(q.lastLine + 1).to;
      if (pending.has(c.from + 1)) out.push(Decoration.widget({ widget: new StatusWidget('pending'), side: 1 }).range(end));
      else if (!q.text && c.to > c.from) out.push(Decoration.widget({ widget: new StatusWidget('empty'), side: 1 }).range(doc.line(c.from + 2).to));
      // While the question is being written: Enter asks it; afterwards, a chip does.
      else if (q.text && !q.answered) out.push(Decoration.widget({ widget: new StatusWidget(active.has(q.lastLine + 1) ? 'enter' : 'ask'), side: 1 }).range(end));
    }
  }
  return Decoration.set(out, true);
}

const blockLook = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBlocks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.startState.field(asking) !== u.state.field(asking)) {
        this.decorations = buildBlocks(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// --- The + and its menu ----------------------------------------------------------------------------------

interface MenuItem {
  action: BlockAction;
  label: string;
  hint: string;
  icon: keyof typeof ICONS;
  checked?: boolean;
}

function menuItems(doc: Text, n: number): MenuItem[] {
  const { block, answered } = blockState(doc, n);
  const kind = block?.kind ?? null;
  const items: MenuItem[] = [
    { action: 'question', label: 'Question', hint: 'L’IA cherche la réponse dans le cours', icon: 'question', checked: kind === 'question' },
    { action: 'free', label: 'Note libre', hint: 'Note personnelle, sans horodatage ni réponse', icon: 'free', checked: kind === 'free' },
  ];
  if (kind === 'question') items.push({ action: 'ask', label: answered ? 'Chercher à nouveau' : 'Chercher la réponse', hint: answered ? 'Remplace la réponse' : 'Dans la transcription, la page et vos notes', icon: 'ask' });
  if (block) items.push({ action: 'normal', label: 'Note normale', hint: 'Retire le bloc, garde le texte', icon: 'normal' });
  return items;
}

class BlockHandle {
  private readonly button: HTMLButtonElement;
  private menu: HTMLElement | null = null;
  /** Line (1-based) the + stands for: the header line of a block. */
  private line: number | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly view: EditorView) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'boo-block-handle';
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'Question ou note libre');
    b.title = 'Question ou note libre (Ctrl + .)';
    b.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    // The editor keeps its cursor and its focus.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      if (this.line !== null) this.open(this.line, { left: r.right + 2, top: r.top, bottom: r.bottom });
    });
    this.button = b;
    view.scrollDOM.append(b);
    const signal = this.abort.signal;
    view.scrollDOM.addEventListener('mousemove', (e) => this.onMove(e), { signal });
    view.dom.addEventListener('mouseleave', (e) => {
      if (!this.menu && !(e.relatedTarget instanceof Node && this.button.contains(e.relatedTarget))) this.hide();
    }, { signal });
    // Typing: the + steps aside (it comes back with the mouse).
    view.contentDOM.addEventListener('keydown', () => {
      if (!this.menu) this.hide();
    }, { signal });
  }

  private onMove(e: MouseEvent): void {
    if (this.menu || e.target === this.button || this.button.contains(e.target as Node)) return;
    if (!this.view.state.facet(EditorView.editable)) return this.hide();
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const { doc } = this.view.state;
    let n = doc.lineAt(pos).number;
    // Past the end of the text: no line there.
    const lineBox = this.view.coordsAtPos(doc.line(n).from, 1);
    if (!lineBox) return this.hide();
    const block = blockAtLine(doc, n);
    if (block) n = block.from + 1;
    this.show(n);
  }

  private show(n: number): void {
    const { doc } = this.view.state;
    if (n > doc.lines) return this.hide();
    const at = this.view.coordsAtPos(doc.line(n).from, 1);
    if (!at) return this.hide();
    const box = this.view.scrollDOM.getBoundingClientRect();
    const lineHeight = this.view.defaultLineHeight;
    const top = at.top - box.top + this.view.scrollDOM.scrollTop + Math.max(0, (at.bottom - at.top - lineHeight) / 2) + (lineHeight - 22) / 2;
    this.button.style.top = `${Math.round(top)}px`;
    this.button.classList.add('visible');
    this.line = n;
  }

  hide(): void {
    this.button.classList.remove('visible');
    this.line = null;
  }

  /** The menu for line `n` (1-based), beside `anchor` (the + or the cursor). */
  /** `anchor`: the line's box — the menu opens under it (above it, near the bottom), the line left visible. */
  open(n: number, anchor: { left: number; top: number; bottom: number }): void {
    this.close(false);
    const { doc } = this.view.state;
    if (n > doc.lines) return;
    const menu = document.createElement('div');
    menu.className = 'boo-block-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Transformer la ligne');
    for (const item of menuItems(doc, n)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', item.action === 'question' || item.action === 'free' ? 'menuitemradio' : 'menuitem');
      if (item.action === 'question' || item.action === 'free') b.setAttribute('aria-checked', String(Boolean(item.checked)));
      b.dataset.action = item.action;
      b.innerHTML = `${ICONS[item.icon]}<span><span class="boo-block-menu-label"></span><small></small></span>`;
      b.querySelector('.boo-block-menu-label')!.textContent = item.label;
      b.querySelector('small')!.textContent = item.hint;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        this.close(true);
        this.hide();
        // The line may have moved while the menu was open (an answer arrived above it).
        applyBlock(this.view, Math.min(n, this.view.state.doc.lines), item.action);
      });
      menu.append(b);
    }
    menu.addEventListener('keydown', (e) => this.onMenuKey(e));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left), innerWidth - r.width - 8);
    const top = anchor.bottom + 4 + r.height > innerHeight - 8 ? Math.max(8, anchor.top - 4 - r.height) : anchor.bottom + 4;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    this.menu = menu;
    this.button.classList.add('open');
    (menu.querySelector('button[aria-checked="false"], button') as HTMLButtonElement | null)?.focus();
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node) && e.target !== this.button && !this.button.contains(e.target as Node)) this.close(false);
    };
    document.addEventListener('mousedown', outside, { capture: true, signal: this.abort.signal });
    window.addEventListener('blur', () => this.close(false), { once: true, signal: this.abort.signal });
    this.view.scrollDOM.addEventListener('scroll', () => this.close(false), { once: true, signal: this.abort.signal });
    this.closeListeners = () => document.removeEventListener('mousedown', outside, { capture: true });
  }

  private closeListeners: (() => void) | null = null;

  private onMenuKey(e: KeyboardEvent): void {
    const items = [...(this.menu?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (j: number) => items[(j + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') this.close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  close(refocus: boolean): void {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.closeListeners?.();
    this.closeListeners = null;
    this.button.classList.remove('open');
    if (refocus) this.view.focus();
  }

  update(u: ViewUpdate): void {
    if (u.docChanged && this.line !== null && !this.menu) this.hide();
  }

  destroy(): void {
    this.close(false);
    this.abort.abort();
    this.button.remove();
  }
}

/** Ctrl/⌘ + . : the menu of the cursor line, from the keyboard. */
function openMenuAtCursor(view: EditorView): boolean {
  const handle = view.plugin(handlePlugin);
  if (!handle || !view.state.facet(EditorView.editable)) return false;
  const { state } = view;
  let n = state.doc.lineAt(state.selection.main.head).number;
  const block = blockAtLine(state.doc, n);
  if (block) n = block.from + 1;
  const at = view.coordsAtPos(state.selection.main.head) ?? view.dom.getBoundingClientRect();
  handle.open(n, { left: at.left, top: at.top, bottom: at.bottom });
  return true;
}

const handlePlugin = ViewPlugin.define((view) => new BlockHandle(view));

/** Opens the + menu of line `n` (1-based), as a click on the + would. */
export function openBlockMenu(view: EditorView, n: number): void {
  const handle = view.plugin(handlePlugin);
  const at = view.coordsAtPos(view.state.doc.line(n).from, 1) ?? view.dom.getBoundingClientRect();
  handle?.open(n, { left: at.left, top: at.top, bottom: at.bottom });
}

/** Where a capture or a quote goes in a free note: its lines quoted, without the automatic timestamp. */
export function intoFreeNote(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      // A capture is not tied to the video in a free note: « [04:15] ![Capture 04:15](…) » → « ![Capture](…) ».
      const capture = /^\[(?:\d+:)?\d{1,3}:\d{2}\](?:\([^()\s]*\))?\s+!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/.exec(l);
      const line = capture ? `![${capture[1].replace(/\s*(?:\d+:)?\d{1,2}:\d{2}\s*/, ' ').trim() || 'Capture'}](${capture[2]})` : l;
      return line ? `> ${line}` : '>';
    })
    .join('\n');
}

export function blockExtensions(hooks: BlockHooks): Extension {
  return [
    blockHooks.of(hooks),
    asking,
    blockLook,
    renumber,
    handlePlugin,
    Prec.high(
      keymap.of([
        { key: 'Enter', run: blockEnter },
        { key: 'Mod-.', preventDefault: true, run: openMenuAtCursor },
      ]),
    ),
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        const chip = (e.target as Element | null)?.closest?.('[data-boo-ask]');
        if (!chip || e.button !== 0) return false;
        e.preventDefault();
        const pos = view.posAtDOM(chip);
        const block = blockAtLine(view.state.doc, view.state.doc.lineAt(pos).number);
        if (block?.kind === 'question') ask(view, block);
        return true;
      },
    }),
  ];
}

/** Line `n` (1-based) is in a question or a free note: nothing is stamped there. */
export function inQuestionOrFreeNote(doc: Text, n: number): boolean {
  const line = doc.line(n).text;
  if (!line.startsWith('>')) return false;
  const c = blockAtLine(doc, n);
  return c !== null && c.kind !== 'other';
}

