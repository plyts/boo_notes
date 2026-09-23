import type { AppStatus, ItemView } from '../ipc';
import { ItemScreen } from './item-view';
import { FILTER_TITLES, LibraryView, type LibraryFilter } from './library-view';
import { SettingsScreen } from './settings-view';
import { button, errorMessage, h, icon, toast, type IconName } from './ui';

type Route = { name: 'library' } | { name: 'item'; id: string } | { name: 'settings'; section?: string };

const NAV: Array<{ key: string; label: string; icon: IconName; filter: LibraryFilter } | 'separator'> = [
  { key: 'all', label: FILTER_TITLES.all, icon: 'library', filter: { status: 'all', kind: 'all' } },
  { key: 'doing', label: FILTER_TITLES.doing, icon: 'clock', filter: { status: 'doing', kind: 'all' } },
  { key: 'done', label: FILTER_TITLES.done, icon: 'check', filter: { status: 'done', kind: 'all' } },
  'separator',
  { key: 'video', label: FILTER_TITLES.video, icon: 'video', filter: { status: 'all', kind: 'video' } },
  { key: 'audio', label: FILTER_TITLES.audio, icon: 'headphones', filter: { status: 'all', kind: 'audio' } },
  { key: 'pdf', label: FILTER_TITLES.pdf, icon: 'file', filter: { status: 'all', kind: 'pdf' } },
];

function filterFor(key: string): LibraryFilter {
  for (const n of NAV) if (n !== 'separator' && n.key === key) return n.filter;
  return { status: 'all', kind: 'all' };
}

class App {
  private route: Route = { name: 'library' };
  private navKey = 'all';
  private items: ItemView[] = [];
  private status: AppStatus | null = null;
  private readonly library: LibraryView;
  private readonly settings = new SettingsScreen();
  private item: ItemScreen | null = null;
  private readonly main: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly search: HTMLInputElement;

  constructor(root: HTMLElement) {
    this.library = new LibraryView({
      open: (id) => void this.go({ name: 'item', id }),
      addFiles: () => void this.addFiles(),
      openSettings: (section) => void this.go({ name: 'settings', section }),
      notionConnected: () => this.status?.notion.connected ?? false,
      extensionConnected: () => (this.status?.extension.clients ?? 0) > 0,
    });
    this.search = h('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Rechercher un cours',
      'aria-label': 'Rechercher un cours (Ctrl+F)',
      spellcheck: 'false',
    });
    this.search.addEventListener('input', () => {
      if (this.route.name !== 'library') void this.go({ name: 'library' });
      this.library.setQuery(this.search.value);
    });
    this.nav = h('nav', { class: 'nav', 'aria-label': 'Bibliothèque' });
    this.statusEl = h('div', { class: 'side-status' });
    this.main = h('main', { class: 'main', id: 'main', tabindex: '-1' });

    const settingsLink = h('button', { type: 'button', class: 'nav-item settings-link', 'data-key': 'settings' }, icon('settings', 18), h('span', {}, 'Réglages'));
    settingsLink.addEventListener('click', () => void this.go({ name: 'settings' }));

    root.append(
      h(
        'header',
        { class: 'titlebar' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('ghost', 18)), h('strong', {}, 'Boo Notes')),
        h('div', { class: 'title-search' }, icon('search', 15), this.search),
      ),
      h('aside', { class: 'sidebar' }, this.nav, h('div', { class: 'side-bottom' }, this.statusEl, settingsLink)),
      this.main,
    );
    this.setupDrop(root);
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.boo.on('library', () => void this.refresh());
    window.boo.on('status', (s) => this.setStatus(s));
    window.boo.on('open-item', (id) => void this.refresh().then(() => this.go({ name: 'item', id })));
    window.boo.on('navigate', (view) => void this.go(view === 'settings' ? { name: 'settings' } : { name: 'library' }));
  }

  async start(): Promise<void> {
    const [items, status, settings] = await Promise.all([
      window.boo.library.list(),
      window.boo.status(),
      window.boo.settings.get(),
    ]);
    this.items = items;
    this.status = status;
    this.library.setItems(items);
    this.renderNav();
    this.renderStatus();
    await this.go({ name: 'library' });
    if (!settings.onboarded) this.welcome(settings.token, settings.port);
  }

  private async refresh(): Promise<void> {
    this.items = await window.boo.library.list();
    this.library.setItems(this.items);
    this.renderNav();
    if (this.item) {
      const current = this.items.find((i) => i.id === this.item!.id);
      if (current) this.item.update(current);
    }
  }

  private setStatus(status: AppStatus): void {
    this.status = status;
    this.renderStatus();
    this.settings.setStatus(status);
    this.item?.onStatus();
  }

  async go(route: Route): Promise<void> {
    if (this.item && !(route.name === 'item' && route.id === this.item.id)) {
      const leaving = this.item;
      this.item = null;
      await leaving.dispose();
    }
    this.route = route;
    document.body.dataset.route = route.name;
    if (route.name === 'library') {
      this.main.replaceChildren(this.library.el);
      this.library.setFilter(filterFor(this.navKey));
    } else if (route.name === 'settings') {
      await this.settings.load();
      if (this.status) this.settings.setStatus(this.status);
      this.main.replaceChildren(this.settings.el);
      if (route.section) requestAnimationFrame(() => this.settings.scrollTo(route.section!));
    } else {
      const item = this.items.find((i) => i.id === route.id) ?? (await window.boo.library.get(route.id));
      if (!item) {
        toast('Ce cours n’est plus dans la bibliothèque', 'error');
        await this.go({ name: 'library' });
        return;
      }
      if (this.item?.id !== item.id) {
        this.item = new ItemScreen(item, {
          back: () => void this.go({ name: 'library' }),
          openSettings: (section) => void this.go({ name: 'settings', section }),
          status: () => this.status,
        });
        this.main.replaceChildren(this.item.el);
        await this.item.mount();
      }
    }
    this.renderNav();
  }

  private renderNav(): void {
    const counts = this.library.counts();
    const current = this.route.name === 'library' ? this.navKey : this.route.name === 'settings' ? 'settings' : '';
    this.nav.replaceChildren(
      ...NAV.map((n) => {
        if (n === 'separator') return h('div', { class: 'nav-sep', role: 'separator' });
        const b = h(
          'button',
          { type: 'button', class: 'nav-item', 'data-key': n.key, 'aria-current': current === n.key ? 'page' : undefined },
          icon(n.icon, 18),
          h('span', {}, n.label),
          counts[n.key] ? h('span', { class: 'nav-count' }, String(counts[n.key])) : null,
        );
        b.addEventListener('click', () => {
          this.navKey = n.key;
          this.library.setFilter(n.filter);
          void this.go({ name: 'library' });
        });
        return b;
      }),
    );
    this.nav.parentElement?.querySelector('.settings-link')?.setAttribute('aria-current', current === 'settings' ? 'page' : 'false');
  }

  private renderStatus(): void {
    const s = this.status;
    if (!s) return;
    const ext = s.extension.error ? 'error' : s.extension.clients ? 'ok' : 'wait';
    const notion = !s.notion.connected ? 'off' : s.notion.lastError ? 'error' : s.notion.syncing ? 'busy' : 'ok';
    const extLabel = s.extension.error ? 'Extension : erreur' : s.extension.clients ? 'Extension connectée' : 'Extension en attente';
    const notionLabel =
      notion === 'off' ? 'Notion non connecté' : notion === 'error' ? 'Notion : erreur' : notion === 'busy' ? 'Notion : envoi…' : 'Notion synchronisé';
    const extBtn = h(
      'button',
      { type: 'button', class: `conn ${ext}`, title: s.extension.error ?? (s.extension.active ? `En cours : ${s.extension.active.title}` : extLabel) },
      h('span', { class: 'orb', 'aria-hidden': 'true' }),
      h('span', {}, extLabel),
    );
    extBtn.addEventListener('click', () => void this.go({ name: 'settings', section: 'extension' }));
    const notionBtn = h(
      'button',
      { type: 'button', class: `conn ${notion}`, title: s.notion.lastError ?? notionLabel },
      h('span', { class: 'orb', 'aria-hidden': 'true' }),
      h('span', {}, notionLabel),
    );
    notionBtn.addEventListener('click', () => void this.go({ name: 'settings', section: 'notion' }));
    const nowPlaying = s.extension.active
      ? h('div', { class: 'now-playing', title: s.extension.active.url }, icon('play', 12), h('span', {}, s.extension.active.title))
      : null;
    this.statusEl.replaceChildren(...(nowPlaying ? [nowPlaying] : []), extBtn, notionBtn);
  }

  private async addFiles(paths?: string[]): Promise<void> {
    try {
      const res = paths ? await window.boo.library.addFiles(paths) : await window.boo.library.openFiles();
      for (const err of res.errors) toast(err, 'error');
      await this.refresh();
      if (res.added.length === 1) await this.go({ name: 'item', id: res.added[0].id });
      else if (res.added.length > 1) toast(`${res.added.length} cours ajoutés`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private setupDrop(root: HTMLElement): void {
    const overlay = h(
      'div',
      { class: 'drop-overlay', hidden: true },
      h('div', { class: 'drop-card' }, icon('plus', 28), h('strong', {}, 'Déposez pour ajouter à la bibliothèque'), h('small', {}, 'PDF, audio (MP3, M4A, WAV…) ou vidéo (MP4, WebM…)')),
    );
    root.append(overlay);
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.boo.pathForFile(f)).filter(Boolean);
      if (paths.length) void this.addFiles(paths);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.item && this.item.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'o') {
      e.preventDefault();
      void this.addFiles();
    } else if (mod && key === 'f') {
      e.preventDefault();
      this.search.focus();
      this.search.select();
    } else if (mod && key === ',') {
      e.preventDefault();
      void this.go({ name: 'settings' });
    } else if (e.key === 'Escape' && this.route.name !== 'library' && !document.querySelector('dialog[open], .menu')) {
      const inEditor = (e.target as Element | null)?.closest?.('.cm-editor, input, textarea');
      if (!inEditor) {
        e.preventDefault();
        void this.go({ name: 'library' });
      }
    }
  }

  private welcome(token: string, port: number): void {
    const dialog = h('dialog', { class: 'dialog welcome', 'aria-labelledby': 'welcome-title' });
    const copy = button('Copier le jeton', { icon: 'copy', small: true }, () => {
      void window.boo.settings.copy(token).then(() => toast('Jeton copié', 'success'));
    });
    const finish = async (next?: () => void) => {
      dialog.close();
      dialog.remove();
      await window.boo.settings.set({ onboarded: true });
      next?.();
    };
    dialog.append(
      h('div', { class: 'welcome-art' }, icon('ghost', 36)),
      h('h2', { id: 'welcome-title' }, 'Bienvenue dans Boo Notes'),
      h('p', {}, 'Vos cours — vidéos, podcasts, PDF — annotés, suivis, et synchronisés avec Notion.'),
      h(
        'ol',
        { class: 'welcome-steps' },
        h(
          'li',
          {},
          h('strong', {}, 'Reliez l’extension du navigateur'),
          h('span', {}, 'Réglages de l’extension › App Desktop : adresse ', h('code', {}, `ws://localhost:${port}`), ' et jeton :'),
          h('span', { class: 'token-row' }, h('code', { class: 'token' }, token), copy),
        ),
        h('li', {}, h('strong', {}, 'Ajoutez un PDF, un audio ou une vidéo'), h('span', {}, 'Glissez-le dans la fenêtre, ou Ctrl+O.')),
        h('li', {}, h('strong', {}, 'Connectez Notion (facultatif)'), h('span', {}, 'Une page Notion par cours, avec progression et notes horodatées.')),
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        button('Connecter Notion', { variant: 'plain', icon: 'notion' }, () => void finish(() => void this.go({ name: 'settings', section: 'notion' }))),
        button('Commencer', { variant: 'primary' }, () => void finish()),
      ),
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      void finish();
    });
    document.body.append(dialog);
    dialog.showModal();
  }
}

// --- Theme ------------------------------------------------------------------------------------

async function applyTheme(): Promise<void> {
  const { theme } = await window.boo.settings.get();
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

document.documentElement.dataset.platform = window.boo.platform;
void applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void applyTheme());
window.boo.on('status', () => void applyTheme());

const app = new App(document.getElementById('app') as HTMLElement);
void app.start().catch((e: unknown) => toast(errorMessage(e), 'error'));
