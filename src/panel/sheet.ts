import { h, icon } from '../shared/icons';
import { keycaps } from '../shared/keycaps';
import type { CommandId } from '../shared/messages';

export interface ShortcutInfo {
  /** Chrome shortcut string, or our default when handled in-page. */
  keys: string;
  scope: 'global' | 'page' | 'unset';
}

export type ShortcutMap = Record<CommandId, ShortcutInfo>;

export const COMMAND_LABELS: Record<CommandId, string> = {
  'toggle-sidebar': 'Ouvrir / réduire les notes',
  'insert-timestamp': 'Insérer l’horodatage',
  'capture-screenshot': 'Capturer l’image',
  'smart-pause': 'Pause & écrire (re-appuyer pour reprendre)',
  replay: 'Revoir les dernières secondes',
};

const EDITOR_TIPS: Array<[string, string]> = [
  ['Nouvelle ligne horodatée', 'Entrée'],
  ['Aller au moment d’un horodatage', 'Clic'],
  ['Modifier un horodatage', 'Alt+Clic'],
  ['Enregistrer', 'Mod+S'],
  ['Annuler', 'Mod+Z'],
  ['Cette aide', 'Mod+/'],
  ['Fermer le panneau', 'Échap'],
];

const MARKDOWN_TIPS: Array<[string, string]> = [
  ['Titre', '## Titre'],
  ['Liste', '- élément'],
  ['Tâche', '- [ ] à faire'],
  ['Gras', '**texte**'],
  ['Code', '`code`'],
];

/** "Raccourcis clavier" dialog, in the spirit of Gmail / Docs `?` sheets. */
export class ShortcutsSheet {
  readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private restoreFocus: HTMLElement | null = null;

  constructor(
    private readonly mac: boolean,
    onCustomize: () => void,
  ) {
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer' }, icon('close'));
    close.addEventListener('click', () => this.close());
    const customize = h('button', { type: 'button', class: 'btn' }, 'Personnaliser les raccourcis…');
    customize.addEventListener('click', onCustomize);
    this.body = h('div', { class: 'sheet-body' });
    this.dialog = h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-title' }, 'Raccourcis clavier'), close),
      this.body,
      h('div', { class: 'sheet-foot' }, customize),
    );
    this.el = h('div', { class: 'sheet-backdrop', hidden: true }, this.dialog);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => this.trapFocus(e));
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  render(shortcuts: ShortcutMap): void {
    const row = (label: string, keys: Node, note?: string) =>
      h(
        'div',
        { class: 'sheet-row' },
        h('span', { class: 'sheet-label' }, label, note ? h('small', {}, note) : null),
        keys,
      );
    const group = (title: string, ...rows: HTMLElement[]) =>
      h('section', { class: 'sheet-group' }, h('h3', {}, title), ...rows);

    const commandRows = (Object.keys(COMMAND_LABELS) as CommandId[]).map((id) => {
      const info = shortcuts[id];
      const keys = info.scope === 'unset' ? h('span', { class: 'unset' }, 'Non défini') : keycaps(info.keys, this.mac);
      return row(COMMAND_LABELS[id], keys, info.scope === 'page' ? 'dans la page et les notes' : undefined);
    });
    const code = (text: string) => h('code', {}, text);
    this.body.replaceChildren(
      group('Vidéo — partout dans le navigateur', ...commandRows),
      group('Éditeur', ...EDITOR_TIPS.map(([label, keys]) => row(label, keycaps(keys.replace('Mod', this.mac ? 'Command' : 'Ctrl'), this.mac)))),
      group('Markdown', ...MARKDOWN_TIPS.map(([label, syntax]) => row(label, code(syntax)))),
    );
  }

  open(): void {
    if (this.isOpen) return;
    this.restoreFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    this.dialog.querySelector<HTMLButtonElement>('.sheet-head button')?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.restoreFocus?.focus();
  }

  private trapFocus(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = [...this.dialog.querySelectorAll<HTMLElement>('button')];
    const first = focusables[0];
    const last = focusables.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
}

/** Empty note: tells what to do next and teaches the shortcuts. */
export class EmptyState {
  readonly el: HTMLDivElement;
  private readonly list: HTMLDivElement;

  constructor(private readonly mac: boolean) {
    this.list = h('div', { class: 'empty-keys' });
    this.el = h(
      'div',
      { class: 'empty', 'aria-hidden': 'true' },
      h('div', { class: 'empty-art' }, icon('ghost', 28)),
      h('p', { class: 'empty-title' }, 'Prêt à prendre des notes'),
      h('p', { class: 'empty-text' }, 'Écrivez simplement : chaque nouvelle ligne reçoit l’horodatage de la lecture.'),
      this.list,
    );
  }

  render(shortcuts: ShortcutMap): void {
    const items: Array<[CommandId, string]> = [
      ['insert-timestamp', 'Horodater'],
      ['capture-screenshot', 'Capturer'],
      ['smart-pause', 'Pause & écrire'],
      ['replay', 'Revoir'],
    ];
    // Two aligned columns: keys (right-aligned) | action.
    this.list.replaceChildren(
      ...items
        .filter(([id]) => shortcuts[id].scope !== 'unset')
        .flatMap(([id, label]) => [keycaps(shortcuts[id].keys, this.mac), h('span', { class: 'empty-label' }, label)]),
    );
  }
}
