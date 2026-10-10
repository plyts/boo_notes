import { h, icon } from '../shared/icons';
import type { PanelMode, PanelView } from '../shared/messages';
import { SIDE_LABELS, type DockSide } from '../shared/placement';
import { TILES, type TileId } from '../shared/tiling';

export interface LayoutActions {
  place(to: DockSide | 'float'): void;
  mini(): void;
  tile(id: TileId): void;
  untile(): void;
}

/**
 * Where the panel stands, from the panel: docked to a side or floating, the
 * Mini, and « Côte à côte » (the video's Chrome window and the notes' window
 * sharing the screen). In the notes' own window, the « Côte à côte » chip
 * offers the splits only.
 */
export class LayoutMenu {
  readonly button: HTMLButtonElement;
  readonly menu: HTMLDivElement;
  private tiled: TileId | null = null;
  private view: PanelView | null = null;

  constructor(mode: PanelMode, private readonly actions: LayoutActions) {
    const popout = mode === 'popout';
    this.button = popout
      ? h('button', { type: 'button', class: 'tile-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Côte à côte', title: 'Côte à côte : partager l’écran avec la vidéo' }, icon('dock', 15), h('span', {}, 'Côte à côte'))
      : h('button', { type: 'button', class: 'icon-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Disposition du panneau', 'aria-label': 'Disposition du panneau' }, icon('placement'));
    this.button.addEventListener('click', () => this.toggle());
    const children: Array<Node> = [];
    if (!popout) {
      children.push(h('div', { class: 'menu-label', 'aria-hidden': 'true' }, 'Panneau'));
      for (const side of ['right', 'left', 'top', 'bottom'] as const) children.push(this.placeItem(side, `Ancré ${SIDE_LABELS[side]}`));
      children.push(this.placeItem('float', 'Flottant, où vous le posez'));
      const mini = h('button', { type: 'button', role: 'menuitem', class: 'layout-mini' }, icon('mini', 18), h('span', {}, 'Mode Mini', h('small', {}, 'Les paroles en direct et leur traduction (Alt+Maj+M)')));
      mini.addEventListener('click', () => {
        this.close(false);
        this.actions.mini();
      });
      children.push(h('div', { class: 'menu-sep', role: 'separator' }), mini, h('div', { class: 'menu-sep', role: 'separator' }));
    }
    children.push(h('div', { class: 'menu-label', 'aria-hidden': 'true' }, popout ? 'Répartition' : 'Côte à côte (fenêtres)'));
    const grid = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Répartition de l’écran' });
    for (const t of TILES) {
      const notesFirst = t.side === 'left';
      const video = h('span', { class: 'tile-video', style: `flex:${(1 - t.notes).toFixed(3)}` });
      const notes = h('span', { class: 'tile-notes', style: `flex:${t.notes.toFixed(3)}` });
      const b = h(
        'button',
        {
          type: 'button',
          role: 'menuitemradio',
          class: 'tile',
          'data-tile': t.id,
          'aria-checked': 'false',
          'aria-label': `${t.label} : ${notesFirst ? 'notes à gauche, vidéo à droite' : 'vidéo à gauche, notes à droite'}`,
          title: notesFirst ? 'Notes à gauche (1/3), vidéo à droite' : `Vidéo ${t.label.split(' · ')[0]}, notes ${t.label.split(' · ')[1]}`,
        },
        h('span', { class: 'tile-vis', 'aria-hidden': 'true' }, ...(notesFirst ? [notes, video] : [video, notes])),
        h('span', { class: 'tile-label', 'aria-hidden': 'true' }, t.id === 'left' ? 'notes à gauche' : t.label),
      );
      b.addEventListener('click', () => {
        this.close(false);
        this.actions.tile(t.id);
      });
      grid.append(b);
    }
    children.push(grid);
    const quit = h('button', { type: 'button', role: 'menuitem', class: 'tile-quit', hidden: true }, icon('close', 16), h('span', {}, 'Quitter côte à côte'));
    quit.addEventListener('click', () => {
      this.close(false);
      this.actions.untile();
    });
    children.push(quit, h('p', { class: 'menu-note' }, 'Chrome et la fenêtre des notes se partagent l’écran ; tirez la frontière pour changer la part de chacune. Les autres applications : avec l’app Desktop.'));
    this.menu = h('div', { class: 'menu layout-menu', role: 'menu', hidden: true, 'aria-label': popout ? 'Côte à côte' : 'Disposition du panneau' }, ...children);
    this.menu.addEventListener('keydown', (e) => this.onKey(e));
  }

  private placeItem(to: DockSide | 'float', label: string): HTMLButtonElement {
    const b = h('button', { type: 'button', role: 'menuitemradio', class: 'layout-place', 'data-place': to, 'aria-checked': 'false' }, h('span', { class: 'radio', 'aria-hidden': 'true' }), h('span', {}, label));
    b.addEventListener('click', () => {
      this.close(false);
      this.actions.place(to);
    });
    return b;
  }

  get isOpen(): boolean {
    return !this.menu.hidden;
  }

  setView(view: PanelView): void {
    this.view = view;
    this.render();
  }

  setTiled(id: TileId | null): void {
    this.tiled = id;
    this.button.classList.toggle('on', id !== null);
    this.render();
  }

  private render(): void {
    const v = this.view;
    const current = v ? (v.mode === 'float' ? 'float' : v.side) : null;
    for (const b of this.menu.querySelectorAll<HTMLButtonElement>('.layout-place')) b.setAttribute('aria-checked', String(b.dataset.place === current));
    for (const b of this.menu.querySelectorAll<HTMLButtonElement>('.tile')) b.setAttribute('aria-checked', String(b.dataset.tile === this.tiled));
    (this.menu.querySelector('.tile-quit') as HTMLElement).hidden = this.tiled === null;
  }

  toggle(): void {
    if (this.isOpen) {
      this.close(false);
      return;
    }
    this.render();
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    (this.menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? this.menu.querySelector<HTMLButtonElement>('button'))?.focus();
  }

  close(refocus: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (refocus) this.button.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button:not([hidden]):not(:disabled)')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    }
  }
}
