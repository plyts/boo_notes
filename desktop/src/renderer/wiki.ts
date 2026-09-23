import { KIND_LABELS, PLATFORM_LABELS } from '../../../src/shared/platforms';
import type { ItemView } from '../ipc';
import { h, icon, KIND_ICON } from './ui';

/** Readable excerpt of a note: first lines, Markdown syntax removed. */
export function excerpt(markdown: string, lines = 7): string[] {
  const out: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼')
      .replace(/\[((?:\d+:)?\d{1,3}:\d{2})\](?:\([^)]*\))?/g, '$1')
      .replace(/\[(p\.\s?\d+|§\s?\d+)\]/g, '$1')
      .replace(/\[pin\s?(\d+)\]/gi, '◉ $1')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_a, t: string, alias?: string) => alias ?? t)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
      .replace(/[*_`~]{1,2}/g, '')
      .trim();
    if (line) out.push(line);
    if (out.length >= lines) break;
  }
  return out;
}

/**
 * Hover card of a `[[Titre]]` link: kind, title, first lines of the note —
 * or an invitation to create the sheet. Stays open while hovered.
 */
export class WikiPreview {
  private el: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;

  constructor(private readonly open: (title: string) => void) {}

  hover(title: string | null, anchor: HTMLElement | null): void {
    if (this.showTimer) clearTimeout(this.showTimer);
    if (!title || !anchor) {
      this.scheduleHide();
      return;
    }
    this.cancelHide();
    this.showTimer = setTimeout(() => void this.show(title, anchor), 320);
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.hide(), 220);
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private async show(title: string, anchor: HTMLElement): Promise<void> {
    const token = ++this.token;
    const item = await window.boo.library.findByTitle(title).catch(() => null);
    const body = item ? await window.boo.library.readNote(item.id).catch(() => '') : '';
    if (token !== this.token || !anchor.isConnected) return;
    this.hide();
    const card = item ? this.card(item, body) : this.missing(title);
    card.addEventListener('mouseenter', () => this.cancelHide());
    card.addEventListener('mouseleave', () => this.scheduleHide());
    card.addEventListener('click', () => {
      this.hide();
      this.open(title);
    });
    document.body.append(card);
    const r = anchor.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - cr.width - 8);
    const below = r.bottom + 8 + cr.height < window.innerHeight;
    card.style.left = `${left}px`;
    card.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - cr.height - 8)}px`;
    this.el = card;
  }

  private card(item: ItemView, body: string): HTMLElement {
    const lines = excerpt(body);
    return h(
      'div',
      { class: 'wiki-card', role: 'dialog', 'aria-label': `Aperçu de « ${item.title} »` },
      h(
        'div',
        { class: 'wiki-card-head' },
        h('span', { class: `kind-badge small ${item.kind}` }, icon(KIND_ICON[item.kind], 14)),
        h(
          'span',
          { class: 'wiki-card-titles' },
          h('strong', {}, item.title),
          h('small', {}, [KIND_LABELS[item.kind], item.platform !== 'local' ? PLATFORM_LABELS[item.platform] : '', item.positionLabel].filter(Boolean).join(' · ')),
        ),
      ),
      lines.length
        ? h('div', { class: 'wiki-card-body' }, ...lines.map((l) => h('p', {}, l)))
        : h('p', { class: 'wiki-card-empty' }, 'Note vide pour l’instant.'),
      h('div', { class: 'wiki-card-foot' }, 'Cliquer pour ouvrir'),
    );
  }

  private missing(title: string): HTMLElement {
    return h(
      'div',
      { class: 'wiki-card missing', role: 'dialog' },
      h('div', { class: 'wiki-card-head' }, h('span', { class: 'kind-badge small note' }, icon('cards', 14)), h('strong', {}, title)),
      h('p', { class: 'wiki-card-empty' }, 'Cette fiche n’existe pas encore.'),
      h('div', { class: 'wiki-card-foot' }, 'Cliquer pour la créer'),
    );
  }
}
