import type { FrameEvent, FrameNotice, ScormState } from '../shared/messages';
import { applyScorm, readScormValue, SCORM_EVENT, SCORM_REQUEST_EVENT } from '../shared/scorm';
import { findBinding, formatShortcut, type InPageBinding } from '../shared/shortcuts';
import { frameSite, looksLikePlayer } from './media-scan';
import { PageReader } from './reader';

/**
 * Reading inside a sub-frame: a course module (SCORM, Articulate Rise /
 * Storyline, Captivate, iSpring, an LMS player…) or any page embedded in the
 * page being studied. While the notes are open:
 *
 * - a selection gets its « Citer » bubble, and Alt+Shift+T quotes it (the
 *   page's Boo Notes writes it in the note);
 * - the heading being read anchors new lines, the part read counts as progress;
 * - the passages quoted in the note are highlighted here, and found again
 *   from the note;
 * - page shortcuts pressed here (focus inside the module) reach the notes;
 * - the module's SCORM / xAPI reports (completion, progress, score) go to the notes;
 * - frames inside this one that Boo Notes cannot read yet are reported, so
 *   the notes can offer to allow them.
 */
export class FrameReading {
  private notes: Extract<FrameNotice, { kind: 'notes' }> | null = null;
  private reader: PageReader | null = null;
  private bubble: { host: HTMLElement; button: HTMLButtonElement } | null = null;
  private selectionText = '';
  private lastReading = '';
  private lastFrames = '';
  private scorm: ScormState | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Windows of child frames that run their own agent. */
  private readonly agents = new WeakSet<object>();
  private greeted = false;

  constructor(
    private readonly send: (event: FrameEvent) => void,
    private readonly token: string,
    private readonly signal: AbortSignal,
    /** The link to the background is up (it drops when the service worker sleeps). */
    private readonly connected: () => boolean,
  ) {}

  /** The service worker restarted: the page's notes are asked again as soon as the learner acts here. */
  private wake(): void {
    if (this.connected() || !this.large()) return;
    this.send({ kind: 'hello' });
  }

  start(): void {
    const signal = this.signal;
    document.addEventListener('selectionchange', () => this.scheduleSelection(), { signal });
    document.addEventListener('keydown', (e) => this.onKey(e), { capture: true, signal });
    document.addEventListener('pointerdown', () => this.wake(), { capture: true, passive: true, signal });
    // The bubble follows the selection while the module scrolls.
    let frame = 0;
    const follow = () => {
      if (frame || !this.bubble || this.bubble.host.hidden) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        this.renderBubble();
      });
    };
    document.addEventListener('scroll', follow, { capture: true, passive: true, signal });
    // Child frames with an agent say so; the others may need a permission.
    window.addEventListener(
      'message',
      (e) => {
        const d = e.data as { booNotesAgent?: unknown } | null;
        if (typeof d?.booNotesAgent === 'string' && e.source) this.agents.add(e.source);
      },
      { signal },
    );
    // The module's SCORM / xAPI reports (main-world bridge of this frame).
    document.addEventListener(
      SCORM_EVENT,
      (e) => {
        const v = readScormValue((e as CustomEvent<unknown>).detail);
        if (!v) return;
        this.scorm = applyScorm(this.scorm, v);
        this.send({ kind: 'scorm', state: this.scorm });
      },
      { signal },
    );
    document.dispatchEvent(new CustomEvent(SCORM_REQUEST_EVENT));
    const frames = setInterval(() => this.checkFrames(), 3000);
    signal.addEventListener('abort', () => {
      clearInterval(frames);
      this.reader?.stop();
      this.bubble?.host.remove();
    });
    setTimeout(() => this.checkFrames(), 800);
  }

  /** Large enough to hold a course page or a player (ads and widgets are left alone). */
  private large(): boolean {
    return innerWidth * innerHeight >= 240 * 135;
  }

  /** The page's notes: open or not, their quoted passages, a quote to find. */
  onNotice(notice: FrameNotice): void {
    if (notice.kind === 'reveal') {
      this.ensureReader()?.reveal(notice.url);
      return;
    }
    this.notes = notice;
    if (notice.open && this.textual()) {
      const reader = this.ensureReader();
      reader?.start();
      reader?.setPassages(notice.passages);
      this.reportReading(true);
    }
    this.renderBubble();
  }

  // --- Text being read ---------------------------------------------------------------------------

  /** Enough text to be read here (a course page, not a bare player or an ad). */
  private textual(): boolean {
    const body = document.body;
    if (!body || innerWidth < 280 || innerHeight < 160) return false;
    return (body.innerText ?? '').replace(/\s+/g, ' ').trim().length >= 120;
  }

  private ensureReader(): PageReader | null {
    if (!document.body) return null;
    this.reader ??= new PageReader({
      url: () => this.notes?.page ?? location.href,
      isOwnUi: (el) => el === this.bubble?.host,
      onProgress: () => this.reportReading(),
      onPassage: () => undefined,
    });
    return this.reader;
  }

  private reportReading(force = false): void {
    if (!this.notes?.open || !this.reader) return;
    const where = this.reader.sectionLabel() || (document.title || '').trim().slice(0, 60);
    const ratio = this.reader.progress;
    const key = `${where}|${Math.round(ratio * 20)}`;
    if (!force && key === this.lastReading) return;
    this.lastReading = key;
    this.send({ kind: 'reading', where, ratio });
  }

  // --- Selection and « Citer » -----------------------------------------------------------------

  private selection(): string {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (el && this.bubble && this.bubble.host.contains(el)) return '';
    return sel.toString().replace(/\s+/g, ' ').trim();
  }

  private scheduleSelection(): void {
    this.wake();
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      const text = this.selection();
      if (text !== this.selectionText) {
        this.selectionText = text;
        if (this.notes?.open) this.send({ kind: 'selection', text: text.length >= 2 ? text.slice(0, 4000) : '', where: this.where() });
      }
      this.renderBubble();
    }, 120);
  }

  private where(): string {
    return this.reader?.sectionLabel() || (document.title || '').trim().slice(0, 60);
  }

  private quote(): void {
    const text = this.selection();
    if (text.length < 2) return;
    this.send({ kind: 'quote', text: text.slice(0, 4000), where: this.where() });
    document.getSelection()?.removeAllRanges();
    this.selectionText = '';
    this.renderBubble();
  }

  private renderBubble(): void {
    const text = this.notes?.open ? this.selection() : '';
    const sel = document.getSelection();
    const rects = text.length >= 3 && sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects() : null;
    const rect = rects && rects.length ? rects[rects.length - 1] : null;
    // Out of view (scrolled away): no bubble.
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) {
      if (this.bubble) this.show(false);
      return;
    }
    const b = this.ensureBubble();
    b.button.title = `Citer dans la note (${formatShortcut(this.notes?.shortcut ?? 'Alt+Shift+T', /Mac/.test(navigator.platform))})`;
    this.show(true);
    const x = Math.min(Math.max(8, rect.right - 36), innerWidth - 96);
    const below = rect.bottom + 44 < innerHeight;
    b.host.style.left = `${x}px`;
    b.host.style.top = `${below ? rect.bottom + 8 : Math.max(8, rect.top - 40)}px`;
  }

  /** `all: initial` on the host would defeat the hidden attribute alone. */
  private show(shown: boolean): void {
    if (!this.bubble) return;
    this.bubble.host.hidden = !shown;
    this.bubble.host.style.display = shown ? 'block' : 'none';
  }

  private ensureBubble(): { host: HTMLElement; button: HTMLButtonElement } {
    if (this.bubble?.host.isConnected) return this.bubble;
    const host = document.createElement('boo-notes-quote');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border: 0; border-radius: 999px;
        background: rgba(28, 28, 32, 0.92); color: #fff; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
        font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif; cursor: pointer; }
      button:hover { background: #6d5ef0; }
      button:focus-visible { outline: 2px solid #b3aaff; outline-offset: 2px; }
      svg { width: 14px; height: 14px; }
    </style><button type="button" aria-label="Citer dans la note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6"/></svg>Citer</button>`;
    const button = root.querySelector('button') as HTMLButtonElement;
    // Keeps the selection (a click would collapse it before the quote).
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => this.quote());
    document.documentElement.append(host);
    this.bubble = { host, button };
    return this.bubble;
  }

  // --- Page shortcuts pressed inside the frame -----------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const bindings: InPageBinding[] = this.notes?.bindings ?? [];
    const target = e.target as HTMLElement | null;
    if (!bindings.length || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
    const b = findBinding(bindings, e);
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.send({ kind: 'command', command: b.command });
  }

  // --- Frames inside this one ---------------------------------------------------------------------

  private checkFrames(): void {
    if (!this.large()) return;
    // The parent's agent may start after this one: said again at each round.
    try {
      window.parent.postMessage({ booNotesAgent: this.token }, '*');
    } catch {
      // Parent gone.
    }
    if (!this.greeted) {
      this.greeted = true;
      this.send({ kind: 'hello' });
    }
    const hosts = new Set<string>();
    for (const f of document.querySelectorAll('iframe')) {
      if (f.contentWindow && this.agents.has(f.contentWindow)) continue;
      const site = frameSite(f);
      if (!site) continue;
      const r = f.getBoundingClientRect();
      const big = r.width >= 480 && r.height >= 270;
      if (big || (r.width * r.height >= 240 * 135 && (looksLikePlayer(f.src) || f.allowFullscreen || /autoplay|fullscreen/.test(f.allow)))) hosts.add(site);
    }
    const key = [...hosts].sort().join(' ');
    if (key === this.lastFrames) return;
    this.lastFrames = key;
    this.send({ kind: 'frames', hosts: [...hosts] });
  }
}
