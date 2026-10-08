import { h, icon, type IconName } from '../shared/icons';
import { callBackground, type NotionStatus, type SyncStatus } from '../shared/messages';

/**
 * « Se connecter à… »: the one button of the notes about where they go.
 * It opens a small window: Notion (its own sign-in window, then the name of
 * the vault — « Boo Notes » by default, or one already there), or the Boo
 * Notes Desktop app. Connected, it shows the vault, and the window offers
 * to open it, to sync now, to disconnect.
 */

type Step = 'home' | 'opening' | 'vault' | 'saving';

interface Choices {
  workspace: string | null;
  vaults: Array<{ id: string; name: string }>;
}

export interface ConnectHooks {
  notify(text: string, kind?: 'info' | 'success' | 'error'): void;
}

const DEFAULT_VAULT = 'Boo Notes';

export class ConnectPanel {
  readonly button: HTMLButtonElement;
  readonly pop: HTMLDivElement;
  private notion: NotionStatus | null = null;
  private desktop: SyncStatus | null = null;
  private step: Step = 'home';
  private choices: Choices | null = null;
  /** The build knows Boo Notes' Notion integration (one-click connection). */
  private readonly oauth: Promise<boolean>;

  constructor(private readonly hooks: ConnectHooks) {
    this.button = h('button', { type: 'button', class: 'connect-btn', 'data-state': 'off', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
    this.button.addEventListener('click', () => this.toggle());
    this.pop = h('div', { class: 'menu connect-pop', role: 'dialog', 'aria-label': 'Se connecter à', hidden: true });
    this.pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    });
    this.oauth = callBackground({ type: 'notion:oauth-info' }).then(
      (i) => i.available,
      () => false,
    );
    this.renderButton();
  }

  get isOpen(): boolean {
    return !this.pop.hidden;
  }

  setNotion(status: NotionStatus | null): void {
    this.notion = status;
    this.renderButton();
    if (this.isOpen && (this.step === 'home' || status?.configured)) {
      if (status?.configured) this.step = 'home';
      this.render();
    }
  }

  setDesktop(status: SyncStatus | null): void {
    this.desktop = status;
    this.renderButton();
    if (this.isOpen && this.step === 'home') this.render();
  }

  get desktopOnline(): boolean {
    return this.desktop?.state === 'connected';
  }

  // --- The button -------------------------------------------------------------------------------

  private renderButton(): void {
    const n = this.notion;
    const b = this.button;
    let state: 'off' | 'on' | 'error' | 'busy' = 'off';
    let label = 'Se connecter à…';
    let glyph: IconName = 'link';
    if (this.step === 'opening' || this.step === 'saving') {
      state = 'busy';
      label = 'Connexion…';
      glyph = 'notion';
    } else if (n?.configured) {
      state = n.lastError ? 'error' : 'on';
      label = n.vault || 'Notion';
      glyph = 'notion';
    } else if (this.desktopOnline) {
      state = 'on';
      label = 'Boo Notes Desktop';
      glyph = 'desktop';
    }
    b.dataset.state = state;
    b.replaceChildren(icon(glyph, 14), h('span', { class: 'connect-label' }, label), ...(state === 'on' || state === 'error' ? [h('span', { class: 'status-dot', 'aria-hidden': 'true' })] : []));
    const where = n?.vault ? ` · coffre « ${n.vault} »` : '';
    const aria =
      state === 'off'
        ? 'Se connecter à…'
        : state === 'busy'
          ? 'Connexion à Notion…'
          : n?.configured
            ? `Connecté à Notion${where}${n.lastError ? ` — ${n.lastError}` : ''}`
            : 'Connecté à Boo Notes Desktop';
    b.setAttribute('aria-label', aria);
    b.title =
      state === 'off'
        ? 'Envoyer vos notes vers Notion (ou l’app Boo Notes Desktop)'
        : n?.configured
          ? `${aria}${n.lastError ? '' : ' : vos notes y sont envoyées automatiquement.'}${n.pending ? ` ${n.pending} note(s) en attente.` : ''}`
          : aria;
    b.setAttribute('aria-expanded', String(this.isOpen));
  }

  // --- The window -------------------------------------------------------------------------------

  toggle(): void {
    if (this.isOpen) this.close(false);
    else this.open();
  }

  open(): void {
    if (this.step !== 'opening' && this.step !== 'saving' && this.step !== 'vault') this.step = 'home';
    this.render();
    this.pop.hidden = false;
    this.renderButton();
    this.pop.querySelector<HTMLElement>('input:checked, input[type="text"], button:not(:disabled)')?.focus();
  }

  close(refocus: boolean): void {
    if (!this.isOpen) return;
    this.pop.hidden = true;
    this.renderButton();
    if (refocus) this.button.focus();
  }

  private render(): void {
    const n = this.notion;
    if (this.step === 'opening') return this.fill(this.waiting('La fenêtre de Notion est ouverte', 'Connectez-vous, choisissez « Utiliser le modèle » (ou une page), puis « Autoriser l’accès ».'));
    if (this.step === 'saving') return this.fill(this.waiting('Préparation de votre coffre…', 'Le coffre, la table de vos notes et une page par cours.'));
    if (this.step === 'vault' && this.choices) return this.fill(...this.vaultForm(this.choices));
    if (n?.configured) return this.fill(...this.connected(n), h('div', { class: 'menu-sep', role: 'separator' }), this.desktopRow());
    this.fill(
      h('div', { class: 'menu-label' }, 'Se connecter à'),
      this.destination('notion', 'Notion', 'Vos notes dans votre Notion, rangées par cours', () => void this.startNotion()),
      this.desktopRow(),
    );
  }

  private fill(...children: HTMLElement[]): void {
    this.pop.replaceChildren(...children);
  }

  private destination(glyph: IconName, label: string, hint: string, onClick: () => void, extra?: HTMLElement): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'connect-dest', 'data-dest': glyph }, icon(glyph, 18), h('span', { class: 'connect-dest-text' }, label, h('small', {}, hint)), ...(extra ? [extra] : []));
    b.addEventListener('click', onClick);
    return b;
  }

  private waiting(title: string, hint: string): HTMLElement {
    return h('div', { class: 'connect-wait', role: 'status' }, h('span', { class: 'connect-spinner', 'aria-hidden': 'true' }), h('span', {}, h('strong', {}, title), h('small', {}, hint)));
  }

  /** The app on this computer: its state, a click tries again. */
  private desktopRow(): HTMLButtonElement {
    const d = this.desktop;
    const state = d?.state ?? 'offline';
    const text = state === 'connected' ? `Connectée${d?.app?.name ? ` · ${d.app.name}` : ''}` : state === 'connecting' ? 'Connexion…' : 'Non détectée';
    const badge = h('span', { class: 'connect-state', 'data-state': state }, text);
    const hint = state === 'connected' ? 'Vos notes y sont envoyées' : d?.error ? d.error : 'L’application sur cet ordinateur (facultative) — cliquer pour réessayer';
    const b = this.destination('desktop', 'Boo Notes Desktop', hint, () => {
      this.desktop = { state: 'connecting', pending: d?.pending ?? 0, at: Date.now() };
      this.render();
      callBackground({ type: 'sync:retry' }).then(
        (s) => this.setDesktop(s),
        () => undefined,
      );
    }, badge);
    b.classList.add('connect-desktop');
    b.dataset.state = state;
    if (d?.error) b.title = d.error;
    return b;
  }

  /** Connected to Notion: the vault, open it, sync now, disconnect. */
  private connected(n: NotionStatus): HTMLElement[] {
    const out: HTMLElement[] = [h('div', { class: 'menu-label' }, `Notion${n.workspace ? ` · ${n.workspace}` : ''}`)];
    const state = n.lastError ? n.lastError : n.syncing ? 'Synchronisation…' : n.pending ? `${n.pending} note(s) en attente` : 'À jour';
    out.push(h('div', { class: 'connect-vault' }, h('span', { class: 'connect-vault-icon', 'aria-hidden': 'true' }, '👻'), h('span', {}, h('strong', {}, n.vault || 'Votre coffre'), h('small', { class: n.lastError ? 'connect-error' : '' }, state))));
    const url = n.vaultUrl || n.databaseUrl;
    if (url) out.push(this.action('popout', 'Ouvrir le coffre dans Notion', () => void chrome.tabs.create({ url })));
    if (n.origin !== 'desktop') {
      out.push(this.action('refresh', 'Synchroniser maintenant', () => void this.syncNow()));
      if (n.lastError && n.via === 'oauth') out.push(this.action('replay', 'Reconnecter Notion', () => void this.startNotion()));
      out.push(this.action('close', 'Déconnecter', () => void this.disconnect(), 'danger'));
    } else {
      const managed = this.action('desktop', 'Connexion gérée par l’app Desktop', () => undefined);
      managed.disabled = true;
      out.push(managed);
    }
    return out;
  }

  private action(glyph: IconName, label: string, onClick: () => void, cls?: string): HTMLButtonElement {
    const b = h('button', { type: 'button', class: `connect-action${cls ? ` ${cls}` : ''}` }, icon(glyph, 16), h('span', {}, label));
    b.addEventListener('click', onClick);
    return b;
  }

  /** The vault: one already in this Notion, or a new one named here (« Boo Notes » by default). */
  private vaultForm(c: Choices): HTMLElement[] {
    const form = h('form', { class: 'connect-form' });
    const existing = c.vaults;
    const preferred = existing.find((v) => v.name.trim().toLowerCase() === DEFAULT_VAULT.toLowerCase()) ?? existing[0];
    const name = h('input', { type: 'text', name: 'vaultName', value: existing.length ? '' : DEFAULT_VAULT, placeholder: 'Boo Notes, Coursera notes, Sample notes…', 'aria-label': 'Nom du coffre', maxlength: '100', autocomplete: 'off', spellcheck: 'false' });
    const rows: HTMLElement[] = [];
    if (existing.length) {
      for (const v of existing) {
        const radio = h('input', { type: 'radio', name: 'vault', value: v.id });
        radio.checked = v === preferred;
        rows.push(h('label', { class: 'connect-choice' }, radio, h('span', {}, '👻 ', v.name)));
      }
      const fresh = h('input', { type: 'radio', name: 'vault', value: '' });
      rows.push(h('label', { class: 'connect-choice connect-new' }, fresh, h('span', {}, 'Nouveau coffre'), name));
      name.addEventListener('focus', () => (fresh.checked = true));
    } else {
      rows.push(h('label', { class: 'connect-field' }, h('span', {}, 'Nom du coffre'), name));
    }
    const submit = h('button', { type: 'submit', class: 'connect-submit' }, 'Valider');
    form.append(...rows, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = form.querySelector<HTMLInputElement>('input[name="vault"]:checked');
      const vaultId = picked?.value || null;
      const typed = name.value.trim();
      if (!vaultId && !typed) {
        name.focus();
        return;
      }
      void this.chooseVault(vaultId, typed || DEFAULT_VAULT);
    });
    return [
      h('div', { class: 'menu-label' }, `Votre coffre Notion${c.workspace ? ` · ${c.workspace}` : ''}`),
      h('p', { class: 'connect-help' }, existing.length ? 'Toutes vos notes y sont rangées, une page par cours. Gardez celui-ci, ou créez-en un autre :' : 'Toutes vos notes y seront rangées, une page par cours. Son nom :'),
      form,
    ];
  }

  // --- Actions ----------------------------------------------------------------------------------

  /** Notion's own window (sign in, allow), then the choice of the vault. */
  private async startNotion(): Promise<void> {
    if (!(await this.oauth)) {
      // This installation has no one-click connection: the options explain the other way.
      this.close(false);
      this.hooks.notify('Connexion à Notion : ouvrez les options de Boo Notes › Notion', 'info');
      void callBackground({ type: 'options:open' }).catch(() => undefined);
      return;
    }
    this.step = 'opening';
    this.render();
    this.renderButton();
    try {
      const res = await callBackground({ type: 'notion:oauth' });
      this.choices = { workspace: res.workspace, vaults: res.vaults };
      this.step = 'vault';
      this.pop.hidden = false;
      this.render();
      this.pop.querySelector<HTMLElement>('input:checked, input[type="text"]')?.focus();
    } catch (e) {
      this.step = 'home';
      this.render();
      const message = e instanceof Error ? e.message : String(e);
      this.hooks.notify(`Notion : ${message}`, /annulée/.test(message) ? 'info' : 'error');
    } finally {
      this.renderButton();
    }
  }

  private async chooseVault(vaultId: string | null, name: string): Promise<void> {
    this.step = 'saving';
    this.render();
    this.renderButton();
    try {
      const status = await callBackground({ type: 'notion:vault', vaultId, name });
      this.step = 'home';
      this.choices = null;
      this.setNotion(status);
      this.close(true);
      this.hooks.notify(`Notion connecté : vos notes vont dans le coffre « ${status.vault ?? name} »`, 'success');
    } catch (e) {
      this.step = 'vault';
      this.render();
      this.hooks.notify(`Notion : ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      this.renderButton();
    }
  }

  private async syncNow(): Promise<void> {
    this.close(true);
    try {
      const { ok, failed, unchanged } = await callBackground({ type: 'notion:sync-all' });
      const parts = [`${ok} note(s) écrite(s)`, ...(unchanged ? [`${unchanged} déjà à jour`] : []), ...(failed ? [`${failed} en échec`] : [])];
      this.hooks.notify(`Notion : ${parts.join(', ')}`, failed ? 'error' : 'success');
    } catch (e) {
      this.hooks.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private async disconnect(): Promise<void> {
    this.close(true);
    try {
      this.setNotion(await callBackground({ type: 'notion:disconnect' }));
      this.hooks.notify('Notion déconnecté : Boo Notes n’y a plus accès', 'success');
    } catch (e) {
      this.hooks.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }
}
