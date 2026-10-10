import { h, icon } from '../shared/icons';
import type { CaptionState, PanelMode, PanelView } from '../shared/messages';
import { formatTimecode } from '../shared/time';
import type { Cue } from '../shared/transcript';

export interface MiniActions {
  /** « Toujours au-dessus » on (a window of its own) or off (back in the page). */
  pin(on: boolean): void;
  glass(value: number): void;
  expand(): void;
  close(): void;
  seek(seconds: number): void;
  /** Size of the line being said (px), chosen with A− / A+, Ctrl + molette or + / −. */
  textSize(px: number): void;
  /** The widget is too short for its lines at this size: at least this tall (px). */
  fit(height: number): void;
}

/** Size of the line being said, in px (the other lines follow it). */
export const MINI_TEXT = { min: 12, max: 48, step: 2, default: 18 } as const;
/** Upcoming lines shown below the one being said (as many as the widget's height allows). */
const UPCOMING = 6;

export interface MiniState {
  cue: Cue | null;
  caption: CaptionState;
  /** The transcript's lines (with their translations), when known. */
  cues: readonly Cue[];
  /** Position of the media (seconds), null when none. */
  now: number | null;
  transcribe: boolean;
}

/** What the Mini says while no line is being spoken. */
function waiting(state: MiniState): string {
  if (!state.transcribe || state.caption.status === 'off') return 'Transcription désactivée dans les options de Boo Notes';
  switch (state.caption.status) {
    case 'searching':
      return 'En attente des sous-titres…';
    case 'captions-off':
      return 'Activez les sous-titres du lecteur : ils s’afficheront ici';
    case 'none':
      return 'Cette vidéo n’a pas de sous-titres';
    default:
      return '…';
  }
}

/**
 * The Mini (« Lyrics »): the line being said, large, its translation in
 * italics, the previous line dimmed above and the next ones below, one after
 * the other; they follow the video. Its bar: the grip (drawn by the page
 * around the panel, see Drawer), « EN DIRECT · mm:ss », the text size
 * (A− / A+; also Ctrl + molette, or + / − on the widget), the pin (always on
 * top), the glass's opacity, ⤢ and ×. A double-click brings the full panel
 * back.
 */
export class MiniView {
  readonly el: HTMLDivElement;
  private readonly clock: HTMLSpanElement;
  private readonly prev: HTMLParagraphElement;
  private readonly now: HTMLButtonElement;
  private readonly tr: HTMLParagraphElement;
  private readonly upcoming: HTMLDivElement;
  private readonly pinButton: HTMLButtonElement;
  private readonly glass: HTMLInputElement;
  private readonly smaller: HTMLButtonElement;
  private readonly larger: HTMLButtonElement;
  private nowCue: Cue | null = null;
  private last = '';
  private size: number = MINI_TEXT.default;

  constructor(private readonly mode: PanelMode, private readonly actions: MiniActions) {
    const button = (name: Parameters<typeof icon>[0], label: string, onClick: () => void, extra: Record<string, string> = {}) => {
      const b = h('button', { type: 'button', class: 'mini-btn', title: label, 'aria-label': label, ...extra }, icon(name, 16));
      b.addEventListener('click', onClick);
      return b;
    };
    this.clock = h('span', { class: 'mini-clock' }, 'EN DIRECT');
    const pinned = mode === 'pip';
    this.pinButton = button('pin', pinned ? 'Toujours au-dessus : activé (cliquer pour revenir dans la page)' : 'Toujours au-dessus des autres fenêtres', () => this.actions.pin(this.pinButton.getAttribute('aria-pressed') !== 'true'), {
      'aria-pressed': String(pinned),
    });
    this.glass = h('input', { type: 'range', class: 'mini-glass', min: '15', max: '90', step: '5', value: '55', 'aria-label': 'Opacité du fond', title: 'Opacité du fond' });
    this.glass.addEventListener('input', () => this.actions.glass(Number(this.glass.value) / 100));
    // A window of its own is opaque: no glass to set there.
    this.glass.hidden = pinned;
    const expand = button('expand', 'Agrandir : panneau complet (double-clic)', () => this.actions.expand());
    const close = button('close', 'Fermer le Mini', () => this.actions.close());
    // Text size: A− / A+ (also Ctrl + molette or a pinch on the widget, + / − on the keyboard).
    const sizeButton = (label: string, cls: string, delta: number) => {
      const b = h('button', { type: 'button', class: `mini-btn mini-size ${cls}`, title: `${label} (Ctrl + molette, ou ${delta > 0 ? '+' : '−'})`, 'aria-label': label }, 'A');
      b.addEventListener('click', () => this.resize(delta));
      return b;
    };
    this.smaller = sizeButton('Texte plus petit', 'smaller', -MINI_TEXT.step);
    this.larger = sizeButton('Texte plus grand', 'larger', MINI_TEXT.step);
    this.prev = h('p', { class: 'mini-prev' });
    this.now = h('button', { type: 'button', class: 'mini-now', title: 'Revoir cette réplique' });
    this.now.addEventListener('click', () => this.nowCue && this.actions.seek(this.nowCue.start));
    this.tr = h('p', { class: 'mini-tr', lang: '' });
    this.upcoming = h('div', { class: 'mini-upcoming', 'aria-label': 'Répliques suivantes' });
    this.el = h(
      'div',
      { class: 'mini', role: 'region', 'aria-label': 'Mini : paroles en direct', hidden: true },
      h('div', { class: 'mini-bar' }, this.clock, h('span', { class: 'spacer' }), this.smaller, this.larger, this.pinButton, this.glass, expand, close),
      h('div', { class: 'mini-lines', 'aria-live': 'off' }, this.prev, this.now, this.tr, this.upcoming),
    );
    this.setTextSize(MINI_TEXT.default);
    // Resized (by hand, or to follow the text), the lines are laid out again.
    new ResizeObserver(() => this.fitLines()).observe(this.prev.parentElement as HTMLElement);
    // Ctrl + molette (a pinch on a touchpad): the text, not the page's zoom.
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey || e.deltaY === 0) return;
        e.preventDefault();
        this.resize(e.deltaY < 0 ? MINI_TEXT.step : -MINI_TEXT.step);
      },
      { passive: false },
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const delta = e.key === '+' || e.key === '=' ? MINI_TEXT.step : e.key === '-' || e.key === '_' ? -MINI_TEXT.step : 0;
      if (!delta) return;
      e.preventDefault();
      this.resize(delta);
    });
    this.el.querySelector('.mini-lines')!.addEventListener('dblclick', (e) => {
      // A double-click selects a word too: the panel instead.
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.actions.expand();
    });
  }

  /** The size chosen (settings), shown. */
  setTextSize(px: number): void {
    this.size = Math.min(MINI_TEXT.max, Math.max(MINI_TEXT.min, Math.round(px)));
    this.el.style.setProperty('--mini-size', `${this.size}px`);
    this.smaller.disabled = this.size <= MINI_TEXT.min;
    this.larger.disabled = this.size >= MINI_TEXT.max;
  }

  private resize(delta: number): void {
    const before = this.size;
    this.setTextSize(this.size + delta);
    this.fitLines();
    if (this.size === before) return;
    this.actions.textSize(this.size);
    // Larger, the line and its translation must still fit: the widget grows if needed (never shrinks by itself).
    requestAnimationFrame(() => this.actions.fit(this.neededHeight()));
  }

  /** Height the widget needs for its bar, the previous line, the line being said, its translation and the next one. */
  neededHeight(): number {
    // The previous line counts even when the room lacks for it now.
    const prevHidden = this.prev.hidden;
    if (this.prev.textContent) this.prev.hidden = false;
    const bar = this.el.querySelector<HTMLElement>('.mini-bar')?.offsetHeight ?? 32;
    const first = this.upcoming.firstElementChild as HTMLElement | null;
    const parts = [this.prev, this.now, this.tr, first].filter((e): e is HTMLElement => Boolean(e) && !(e as HTMLElement).hidden && Boolean((e as HTMLElement).textContent));
    const height = Math.ceil(bar + 6 + 12 + parts.reduce((n, e) => n + e.scrollHeight + 4, 0));
    this.prev.hidden = prevHidden;
    return height;
  }

  setView(view: PanelView): void {
    const pinned = this.mode === 'pip' || view.pip;
    this.pinButton.setAttribute('aria-pressed', String(pinned));
    this.pinButton.title = pinned ? 'Toujours au-dessus : activé (cliquer pour revenir dans la page)' : 'Toujours au-dessus des autres fenêtres';
    this.pinButton.setAttribute('aria-label', 'Toujours au-dessus');
    this.glass.value = String(Math.round(view.glass * 100));
  }

  /** The lines around the one being said: the previous one, then the next ones, one after the other. */
  render(state: MiniState): void {
    this.clock.textContent = state.now === null ? 'EN DIRECT' : `EN DIRECT · ${formatTimecode(state.now)}`;
    const cue = state.cue;
    const i = cue ? state.cues.findIndex((c) => c.id === cue.id) : -1;
    const full = i >= 0 ? state.cues[i] : cue;
    // Between two lines: the next ones still come, from where the video stands.
    const from = i >= 0 ? i + 1 : state.now === null ? -1 : state.cues.findIndex((c) => c.start > (state.now as number));
    const next = from >= 0 ? state.cues.slice(from, from + UPCOMING) : [];
    const key = `${full?.id ?? ''}|${full?.text ?? ''}|${full?.tr ?? ''}|${i}|${state.cues.length}|${cue ? '' : waiting(state)}|${next.map((c) => `${c.id}:${c.text}:${c.tr ?? ''}`).join('|')}`;
    if (key === this.last) return;
    this.last = key;
    this.nowCue = full;
    this.prev.textContent = i > 0 ? state.cues[i - 1].text : '';
    this.now.textContent = full ? full.text : waiting(state);
    this.now.disabled = !full;
    this.now.classList.toggle('idle', !full);
    this.tr.textContent = full?.tr ?? '';
    this.tr.hidden = !full?.tr;
    this.upcoming.replaceChildren(
      ...next.map((c) => h('div', { class: 'mini-next-line' }, h('p', { class: 'mini-next' }, c.text), c.tr ? h('p', { class: 'mini-next-tr' }, c.tr) : null)),
    );
    this.fitLines();
  }

  /** Short of room, the previous line goes (whole, never cut in half): the line being said and its translation first. */
  private fitLines(): void {
    const lines = this.prev.parentElement as HTMLElement;
    if (!lines.clientHeight) return;
    this.prev.hidden = !this.prev.textContent;
    if (this.prev.hidden) return;
    const need = this.prev.offsetHeight + this.now.offsetHeight + (this.tr.hidden ? 0 : this.tr.offsetHeight) + 6;
    this.prev.hidden = need > lines.clientHeight;
  }
}
