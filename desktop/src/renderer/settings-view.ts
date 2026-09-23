import type { AppStatus, SettingsPatch, SettingsView, Theme } from '../ipc';
import { button, errorMessage, h, icon, relativeTime, toast } from './ui';

const INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations';

function row(label: string, desc: string | Node | null, control: Node): HTMLElement {
  return h(
    'div',
    { class: 'set-row' },
    h('span', { class: 'set-text' }, h('span', { class: 'set-label' }, label), desc ? h('span', { class: 'set-desc' }, desc) : null),
    control,
  );
}

function toggle(checked: boolean, label: string, onChange: (v: boolean) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

/** Réglages: extension pairing, notes folder, Notion, general. */
export class SettingsScreen {
  readonly el: HTMLElement;
  private settings: SettingsView | null = null;
  private status: AppStatus | null = null;
  private notionDraft = { token: '', target: '' };
  private connecting = false;

  constructor() {
    this.el = h('div', { class: 'settings' });
  }

  async load(): Promise<void> {
    this.settings = await window.boo.settings.get();
    this.render();
  }

  setStatus(status: AppStatus): void {
    this.status = status;
    if (this.settings) {
      this.settings.notion = status.notion;
      this.render();
    }
  }

  scrollTo(section: string): void {
    this.el.querySelector(`#set-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private async save(patch: SettingsPatch): Promise<void> {
    try {
      this.settings = await window.boo.settings.set(patch);
      this.render();
    } catch (e) {
      toast(errorMessage(e), 'error');
      await this.load();
    }
  }

  private render(): void {
    const s = this.settings;
    if (!s) return;
    const scrollTop = this.el.scrollTop;
    const active = document.activeElement?.id;
    this.el.replaceChildren(
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Réglages'), h('p', { class: 'page-sub' }, `Boo Notes ${s.version}`))),
      this.extensionSection(s),
      this.notionSection(s),
      this.vaultSection(s),
      this.generalSection(s),
    );
    this.el.scrollTop = scrollTop;
    if (active) (document.getElementById(active) as HTMLElement | null)?.focus();
  }

  private extensionSection(s: SettingsView): HTMLElement {
    const clients = this.status?.extension.clients ?? 0;
    const error = this.status?.extension.error;
    const token = h('code', { class: 'token', id: 'pairing-token' }, s.token);
    const copy = button('Copier', { icon: 'copy', small: true }, () => {
      void window.boo.settings.copy(s.token).then(() => toast('Jeton copié', 'success'));
    });
    const regen = button('Nouveau jeton', { small: true, variant: 'ghost' }, async () => {
      this.settings = await window.boo.settings.regenerateToken();
      this.render();
      toast('Nouveau jeton : collez-le dans l’extension', 'info');
    });
    const port = h('input', { type: 'number', class: 'port-input', min: '1024', max: '65535', value: String(s.port), 'aria-label': 'Port' });
    port.addEventListener('change', () => void this.save({ port: Number(port.value) }));
    return h(
      'section',
      { class: 'set-group', id: 'set-extension', 'aria-labelledby': 'h-ext' },
      h('h2', { id: 'h-ext' }, 'Extension du navigateur'),
      h(
        'div',
        { class: 'set-card' },
        h(
          'div',
          { class: `conn-status ${error ? 'error' : clients ? 'ok' : 'wait'}` },
          h('span', { class: 'orb', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'set-text' },
            h('span', { class: 'set-label' }, error ? 'Serveur local indisponible' : clients ? 'Extension connectée' : 'En attente de l’extension'),
            h(
              'span',
              { class: 'set-desc' },
              error ??
                (clients
                  ? `${clients} navigateur${clients > 1 ? 's' : ''} relié${clients > 1 ? 's' : ''} · ws://localhost:${s.port}`
                  : 'Dans l’extension : Réglages › App Desktop, collez le jeton ci-dessous.'),
            ),
          ),
        ),
        h(
          'div',
          { class: 'token-block' },
          h('span', { class: 'set-label' }, 'Jeton d’appairage'),
          h('div', { class: 'token-row' }, token, copy, regen),
          h(
            'span',
            { class: 'set-desc' },
            'Il empêche les autres programmes de votre ordinateur d’écrire dans vos notes. L’adresse à saisir dans l’extension est ',
            h('code', {}, `ws://localhost:${s.port}`),
            '.',
          ),
        ),
        h('details', { class: 'advanced' }, h('summary', {}, 'Avancé'), row('Port local', 'Uniquement sur cet ordinateur (127.0.0.1).', port)),
      ),
    );
  }

  private notionSection(s: SettingsView): HTMLElement {
    const n = s.notion;
    const body = h('div', { class: 'set-card' });
    if (n.connected) {
      const sync = button(n.syncing ? 'Synchronisation…' : 'Tout synchroniser', { icon: 'refresh', small: true }, async () => {
        try {
          const res = await window.boo.notion.syncAll();
          toast(
            res.failed ? `${res.ok} cours synchronisés, ${res.failed} en erreur` : `${res.ok} cours synchronisés`,
            res.failed ? 'error' : 'success',
          );
        } catch (e) {
          toast(errorMessage(e), 'error');
        }
      });
      sync.disabled = n.syncing > 0;
      body.append(
        h(
          'div',
          { class: `conn-status ${n.lastError ? 'error' : 'ok'}` },
          h('span', { class: 'orb', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'set-text' },
            h('span', { class: 'set-label' }, `Connecté à ${n.workspace ?? 'Notion'}`),
            h(
              'span',
              { class: 'set-desc' },
              n.lastError ?? (n.lastSyncAt ? `Dernière synchronisation ${relativeTime(n.lastSyncAt)}` : 'Tableau « Boo Notes — Mes notes » prêt'),
            ),
          ),
          button('Ouvrir le tableau', { icon: 'popout', small: true }, () => void window.boo.notion.open()),
        ),
        row(
          'Synchronisation automatique',
          'Chaque note, progression, surlignage et lien est envoyé à Notion quelques secondes après la modification.',
          toggle(n.autoSync, 'Synchronisation automatique', (v) => void this.save({ notionAutoSync: v })),
        ),
        row(
          'Synchroniser aussi depuis le navigateur',
          'L’extension reçoit cette connexion : vos notes en ligne partent vers Notion même quand Boo Notes est fermé.',
          toggle(n.share, 'Partager la connexion Notion avec l’extension', (v) => void this.save({ notionShare: v })),
        ),
        h(
          'div',
          { class: 'set-row' },
          h('span', { class: 'set-text' }, h('span', { class: 'set-label' }, 'Toutes les notes'), h('span', { class: 'set-desc' }, 'Crée ou met à jour une page par note, cours ou fiche.')),
          h(
            'span',
            { class: 'row-actions' },
            sync,
            button('Déconnecter', { small: true, variant: 'ghost' }, async () => {
              this.settings = await window.boo.notion.disconnect();
              this.render();
            }),
          ),
        ),
      );
    } else {
      const tokenInput = h('input', {
        type: 'password',
        id: 'notion-token',
        placeholder: 'ntn_… ou secret_…',
        autocomplete: 'off',
        spellcheck: 'false',
        value: this.notionDraft.token,
      });
      const targetInput = h('input', {
        type: 'url',
        id: 'notion-target',
        placeholder: 'https://www.notion.so/…',
        autocomplete: 'off',
        spellcheck: 'false',
        value: this.notionDraft.target,
      });
      tokenInput.addEventListener('input', () => (this.notionDraft.token = tokenInput.value));
      targetInput.addEventListener('input', () => (this.notionDraft.target = targetInput.value));
      const connect = button(this.connecting ? 'Connexion…' : 'Connecter Notion', { variant: 'primary', icon: 'notion' }, async () => {
        this.connecting = true;
        connect.disabled = true;
        connect.querySelector('span')!.textContent = 'Connexion…';
        try {
          this.settings = await window.boo.notion.connect(this.notionDraft.token, this.notionDraft.target);
          this.notionDraft = { token: '', target: '' };
          toast('Notion est connecté : le tableau « Boo Notes — Mes notes » a été ajouté à votre page', 'success');
        } catch (e) {
          toast(errorMessage(e), 'error');
        } finally {
          this.connecting = false;
          this.render();
        }
      });
      body.append(
        h(
          'ol',
          { class: 'notion-steps' },
          h(
            'li',
            {},
            h('strong', {}, 'Créez une intégration'),
            h(
              'span',
              {},
              'Sur ',
              linkButton('notion.so › Intégrations', INTEGRATIONS_URL),
              ', « Nouvelle intégration » (type interne), puis copiez son secret.',
            ),
          ),
          h('li', {}, h('strong', {}, 'Partagez une page'), h('span', {}, 'Dans Notion, créez ou ouvrez la page qui rassemblera vos notes (ex. « Mes études ») › ••• › Connexions › ajoutez l’intégration. Boo Notes y insère un tableau de toutes vos notes.')),
          h(
            'li',
            {},
            h('strong', {}, 'Collez-les ici'),
            h(
              'span',
              { class: 'notion-fields' },
              h('label', { for: 'notion-token' }, 'Secret de l’intégration'),
              tokenInput,
              h('label', { for: 'notion-target' }, 'Lien de la page (ou d’une base existante)'),
              targetInput,
            ),
          ),
        ),
        h('div', { class: 'card-actions' }, connect),
        h(
          'p',
          { class: 'set-desc privacy' },
          icon('eye', 14),
          h('span', {}, 'Le secret est chiffré par Windows sur cet ordinateur et n’est envoyé qu’à Notion.'),
        ),
      );
    }
    return h('section', { class: 'set-group', id: 'set-notion', 'aria-labelledby': 'h-notion' }, h('h2', { id: 'h-notion' }, 'Notion'), body);
  }

  private vaultSection(s: SettingsView): HTMLElement {
    return h(
      'section',
      { class: 'set-group', id: 'set-vault', 'aria-labelledby': 'h-vault' },
      h('h2', { id: 'h-vault' }, 'Dossier de notes'),
      h(
        'div',
        { class: 'set-card' },
        row(
          'Emplacement',
          h('code', { class: 'path' }, s.vault),
          h(
            'span',
            { class: 'row-actions' },
            button('Ouvrir', { icon: 'folder', small: true }, () => void window.boo.settings.openVault()),
            button('Changer…', { small: true }, async () => {
              this.settings = await window.boo.settings.chooseVault();
              this.render();
            }),
          ),
        ),
        h(
          'p',
          { class: 'set-desc inset' },
          'Un fichier Markdown par cours, lisible par n’importe quel éditeur (Obsidian, VS Code…), et les captures dans assets/.',
        ),
      ),
    );
  }

  private generalSection(s: SettingsView): HTMLElement {
    const isWin = s.platform === 'win32';
    const themes: Array<[Theme, string]> = [
      ['auto', 'Auto'],
      ['dark', 'Sombre'],
      ['light', 'Clair'],
    ];
    const segmented = h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': 'Apparence' },
      ...themes.map(([value, label]) => {
        const input = h('input', { type: 'radio', name: 'theme', value });
        input.checked = s.theme === value;
        input.addEventListener('change', () => void this.save({ theme: value }));
        return h('label', {}, input, h('span', {}, label));
      }),
    );
    return h(
      'section',
      { class: 'set-group', id: 'set-general', 'aria-labelledby': 'h-general' },
      h('h2', { id: 'h-general' }, 'Général'),
      h(
        'div',
        { class: 'set-card' },
        row(
          isWin ? 'Lancer au démarrage de Windows' : 'Lancer à l’ouverture de session',
          'Discrètement, dans la zone de notification : l’extension trouve toujours l’application.',
          toggle(s.openAtLogin, 'Lancer au démarrage', (v) => void this.save({ openAtLogin: v })),
        ),
        row(
          'Garder en arrière-plan',
          'Fermer la fenêtre laisse Boo Notes dans la zone de notification.',
          toggle(s.closeToTray, 'Garder en arrière-plan', (v) => void this.save({ closeToTray: v })),
        ),
        row('Apparence', null, segmented),
      ),
    );
  }
}

function linkButton(label: string, url: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'link' }, label);
  b.addEventListener('click', () => void window.boo.settings.openExternal(url));
  return b;
}
