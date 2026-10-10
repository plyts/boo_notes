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
}

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
 * italics, the previous and next lines dimmed; they follow the video. Its
 * bar: the grip (drawn by the page around the panel, see Drawer), « EN
 * DIRECT · mm:ss », the pin (always on top), the glass's opacity, ⤢ and ×.
 * A double-click brings the full panel back.
 */
export class MiniView {
  readonly el: HTMLDivElement;
  private readonly clock: HTMLSpanElement;
  private readonly prev: HTMLParagraphElement;
  private readonly now: HTMLButtonElement;
  private readonly tr: HTMLParagraphElement;
  private readonly next: HTMLParagraphElement;
  private readonly pinButton: HTMLButtonElement;
  private readonly glass: HTMLInputElement;
  private nowCue: Cue | null = null;
  private last = '';

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
    this.prev = h('p', { class: 'mini-prev' });
    this.now = h('button', { type: 'button', class: 'mini-now', title: 'Revoir cette réplique' });
    this.now.addEventListener('click', () => this.nowCue && this.actions.seek(this.nowCue.start));
    this.tr = h('p', { class: 'mini-tr', lang: '' });
    this.next = h('p', { class: 'mini-next' });
    this.el = h(
      'div',
      { class: 'mini', role: 'region', 'aria-label': 'Mini : paroles en direct', hidden: true },
      h('div', { class: 'mini-bar' }, this.clock, h('span', { class: 'spacer' }), this.pinButton, this.glass, expand, close),
      h('div', { class: 'mini-lines', 'aria-live': 'off' }, this.prev, this.now, this.tr, this.next),
    );
    this.el.querySelector('.mini-lines')!.addEventListener('dblclick', (e) => {
      // A double-click selects a word too: the panel instead.
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.actions.expand();
    });
  }

  setView(view: PanelView): void {
    const pinned = this.mode === 'pip' || view.pip;
    this.pinButton.setAttribute('aria-pressed', String(pinned));
    this.pinButton.title = pinned ? 'Toujours au-dessus : activé (cliquer pour revenir dans la page)' : 'Toujours au-dessus des autres fenêtres';
    this.pinButton.setAttribute('aria-label', 'Toujours au-dessus');
    this.glass.value = String(Math.round(view.glass * 100));
  }

  /** The lines around the one being said. */
  render(state: MiniState): void {
    this.clock.textContent = state.now === null ? 'EN DIRECT' : `EN DIRECT · ${formatTimecode(state.now)}`;
    const cue = state.cue;
    const i = cue ? state.cues.findIndex((c) => c.id === cue.id) : -1;
    const full = i >= 0 ? state.cues[i] : cue;
    const key = `${full?.id ?? ''}|${full?.text ?? ''}|${full?.tr ?? ''}|${i}|${state.cues.length}|${cue ? '' : waiting(state)}`;
    if (key === this.last) return;
    this.last = key;
    this.nowCue = full;
    this.prev.textContent = i > 0 ? state.cues[i - 1].text : '';
    this.next.textContent = i >= 0 && i + 1 < state.cues.length ? state.cues[i + 1].text : '';
    this.now.textContent = full ? full.text : waiting(state);
    this.now.disabled = !full;
    this.now.classList.toggle('idle', !full);
    this.tr.textContent = full?.tr ?? '';
    this.tr.hidden = !full?.tr;
  }
}
