import { KIND_LABELS, PLATFORM_LABELS } from '../../../src/shared/platforms';
import type { MediaKind } from '../core/types';
import type { ItemView, StudyStatus } from '../ipc';
import {
  button,
  confirmDialog,
  errorMessage,
  h,
  icon,
  iconButton,
  KIND_ICON,
  percent,
  progressBar,
  relativeTime,
  showMenu,
  toast,
} from './ui';

export type LibraryFilter = { status: StudyStatus | 'all'; kind: MediaKind | 'all' };

export const FILTER_TITLES: Record<string, string> = {
  all: 'Bibliothèque',
  doing: 'En cours',
  done: 'Terminés',
  todo: 'À commencer',
  video: 'Vidéos',
  audio: 'Audio',
  pdf: 'PDF',
};

const STATUS_LABELS: Record<StudyStatus, string> = { todo: 'À commencer', doing: 'En cours', done: 'Terminé' };

export interface LibraryHost {
  open(id: string): void;
  addFiles(): void;
  openSettings(section?: string): void;
  notionConnected(): boolean;
  extensionConnected(): boolean;
}

/** Every course: "continue" shelf, then the full list with progress and Notion state. */
export class LibraryView {
  readonly el: HTMLElement;
  private items: ItemView[] = [];
  private filter: LibraryFilter = { status: 'all', kind: 'all' };
  private query = '';

  constructor(private readonly host: LibraryHost) {
    this.el = h('div', { class: 'library' });
  }

  setItems(items: ItemView[]): void {
    this.items = items;
    this.render();
  }

  setFilter(filter: LibraryFilter): void {
    this.filter = filter;
    this.render();
  }

  setQuery(q: string): void {
    this.query = q.trim().toLowerCase();
    this.render();
  }

  counts(): Record<string, number> {
    const c: Record<string, number> = { all: this.items.length, doing: 0, done: 0, todo: 0, video: 0, audio: 0, pdf: 0 };
    for (const i of this.items) {
      c[i.studyStatus]++;
      c[i.kind]++;
    }
    return c;
  }

  private visible(): ItemView[] {
    return this.items.filter(
      (i) =>
        (this.filter.status === 'all' || i.studyStatus === this.filter.status) &&
        (this.filter.kind === 'all' || i.kind === this.filter.kind) &&
        (!this.query || `${i.title} ${PLATFORM_LABELS[i.platform]} ${i.source}`.toLowerCase().includes(this.query)),
    );
  }

  private render(): void {
    const key = this.filter.kind !== 'all' ? this.filter.kind : this.filter.status;
    const items = this.visible();
    const add = button('Ajouter un cours', { variant: 'primary', icon: 'plus', title: 'PDF, audio ou vidéo (Ctrl+O)' }, () =>
      this.host.addFiles(),
    );
    const head = h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, FILTER_TITLES[key] ?? 'Bibliothèque'),
        h('p', { class: 'page-sub' }, this.subtitle(items)),
      ),
      h('span', { class: 'spacer' }),
      add,
    );
    if (this.items.length === 0) {
      this.el.replaceChildren(head, this.empty());
      return;
    }
    const sections: Node[] = [head];
    const inProgress = this.items
      .filter((i) => i.studyStatus === 'doing')
      .sort((a, b) => (b.progress?.updatedAt ?? b.updatedAt) - (a.progress?.updatedAt ?? a.updatedAt))
      .slice(0, 4);
    if (key === 'all' && !this.query && inProgress.length) {
      sections.push(
        h('h2', { class: 'section-title' }, 'Reprendre'),
        h('div', { class: 'shelf' }, ...inProgress.map((i) => this.card(i))),
        h('h2', { class: 'section-title' }, 'Tous les cours'),
      );
    }
    sections.push(
      items.length
        ? h('ul', { class: 'rows', role: 'list' }, ...items.map((i) => this.row(i)))
        : h('p', { class: 'no-result' }, this.query ? `Aucun cours ne correspond à « ${this.query} ».` : 'Rien ici pour l’instant.'),
    );
    this.el.replaceChildren(...sections);
  }

  private subtitle(items: ItemView[]): string {
    const n = items.length;
    const done = items.filter((i) => i.studyStatus === 'done').length;
    if (!n) return '';
    return `${n} cours${done ? ` · ${done} terminé${done > 1 ? 's' : ''}` : ''}`;
  }

  private empty(): HTMLElement {
    const steps = h(
      'ol',
      { class: 'empty-steps' },
      h(
        'li',
        {},
        h('span', { class: 'step-icon' }, icon('file', 20)),
        h('strong', {}, 'Un PDF, un audio, une vidéo'),
        h('small', {}, 'Glissez-le dans cette fenêtre : lecture suivie, notes par page ou horodatées.'),
      ),
      h(
        'li',
        {},
        h('span', { class: 'step-icon' }, icon('globe', 20)),
        h('strong', {}, 'Vos cours en ligne'),
        h(
          'small',
          {},
          this.host.extensionConnected()
            ? 'L’extension est connectée : vos notes YouTube, Udemy, Coursera, Notion… arrivent ici.'
            : 'Appairez l’extension du navigateur : vos notes YouTube, Udemy, Coursera, Notion… arriveront ici.',
        ),
      ),
      h(
        'li',
        {},
        h('span', { class: 'step-icon' }, icon('notion', 20)),
        h('strong', {}, 'Suivi dans Notion'),
        h('small', {}, 'Chaque cours devient une page Notion avec sa progression et ses notes.'),
      ),
    );
    const actions = h(
      'div',
      { class: 'empty-actions' },
      button('Ajouter un cours…', { variant: 'primary', icon: 'plus' }, () => this.host.addFiles()),
      this.host.extensionConnected() ? null : button('Appairer l’extension', { icon: 'link' }, () => this.host.openSettings('extension')),
      this.host.notionConnected() ? null : button('Connecter Notion', { icon: 'notion' }, () => this.host.openSettings('notion')),
    );
    return h(
      'div',
      { class: 'empty-library' },
      h('div', { class: 'empty-art' }, icon('ghost', 40)),
      h('h2', {}, 'Votre bibliothèque de cours'),
      h('p', {}, 'Tout ce que vous étudiez, au même endroit, avec votre progression.'),
      steps,
      actions,
    );
  }

  private card(i: ItemView): HTMLElement {
    const card = h(
      'button',
      { type: 'button', class: `card kind-${i.kind}`, 'data-id': i.id, title: `Reprendre « ${i.title} »` },
      h('span', { class: `kind-badge ${i.kind}` }, icon(KIND_ICON[i.kind], 18)),
      h('span', { class: 'card-title' }, i.title),
      h('span', { class: 'card-meta' }, `${PLATFORM_LABELS[i.platform]} · ${i.positionLabel || KIND_LABELS[i.kind]}`),
      h('span', { class: 'card-foot' }, progressBar(i.ratio), h('span', { class: 'card-pct' }, percent(i.ratio))),
    );
    card.addEventListener('click', () => this.host.open(i.id));
    return card;
  }

  private row(i: ItemView): HTMLElement {
    const notion = i.notion
      ? i.notion.error
        ? h('span', { class: 'notion-state error', title: i.notion.error }, icon('alert', 14))
        : h('span', { class: 'notion-state ok', title: `Dans Notion — synchronisé ${relativeTime(i.notion.syncedAt)}` }, icon('notion', 14))
      : h('span', { class: 'notion-state' });
    const more = iconButton('more', 'Actions', (e) => {
      e.stopPropagation();
      this.menu(e.currentTarget as HTMLElement, i);
    });
    more.classList.add('row-more');
    const main = h(
      'button',
      { type: 'button', class: 'row-main', 'data-id': i.id },
      h('span', { class: `kind-badge ${i.kind}` }, icon(KIND_ICON[i.kind], 16)),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-title' }, i.title),
        h(
          'span',
          { class: 'row-meta' },
          [PLATFORM_LABELS[i.platform], KIND_LABELS[i.kind], i.noteCount ? `${i.noteCount} note${i.noteCount > 1 ? 's' : ''}` : '']
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      h('span', { class: 'row-progress' }, progressBar(i.ratio), h('span', { class: 'row-pos' }, i.positionLabel || '—')),
      h('span', { class: `status-chip ${i.studyStatus}` }, STATUS_LABELS[i.studyStatus]),
      notion,
      h('span', { class: 'row-date' }, relativeTime(i.updatedAt)),
    );
    main.addEventListener('click', () => this.host.open(i.id));
    return h('li', { class: 'row' }, main, more);
  }

  private menu(anchor: HTMLElement, i: ItemView): void {
    showMenu(anchor, [
      { label: 'Ouvrir', icon: 'book', run: () => this.host.open(i.id) },
      {
        label: i.notion ? 'Synchroniser avec Notion' : 'Envoyer vers Notion',
        icon: 'notion',
        disabled: !this.host.notionConnected(),
        run: () =>
          void window.boo.notion.syncItem(i.id).then(
            () => toast('Cours synchronisé avec Notion', 'success'),
            (e: unknown) => toast(errorMessage(e), 'error'),
          ),
      },
      ...(i.notion?.url ? [{ label: 'Ouvrir dans Notion', icon: 'popout' as const, run: () => void window.boo.notion.open(i.id) }] : []),
      { label: 'Afficher la note (.md)', icon: 'folder', run: () => void window.boo.library.reveal(i.id) },
      'separator',
      {
        label: 'Marquer comme terminé',
        icon: 'check',
        run: () => void window.boo.library.update(i.id, { status: 'done' }),
      },
      { label: 'Statut automatique', icon: 'refresh', run: () => void window.boo.library.update(i.id, { status: null }) },
      'separator',
      {
        label: 'Retirer de la bibliothèque…',
        icon: 'trash',
        danger: true,
        run: async () => {
          const res = await confirmDialog({
            title: `Retirer « ${i.title} » ?`,
            text:
              i.origin === 'desktop'
                ? 'Le fichier du cours n’est pas supprimé.'
                : 'La note reste dans l’extension du navigateur et reviendra à la prochaine modification.',
            confirm: 'Retirer',
            danger: true,
            checkbox: 'Supprimer aussi le fichier de notes (.md)',
          });
          if (res.ok) await window.boo.library.remove(i.id, res.checked);
        },
      },
    ]);
  }
}
