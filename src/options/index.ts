import { h, icon, type IconName } from '../shared/icons';
import { IS_MAC, keycaps } from '../shared/keycaps';
import { callBackground, type CommandId, type SyncStatus } from '../shared/messages';
import { PLATFORM_LABELS } from '../shared/platforms';
import { isLoopbackWsUrl, loadSettings, saveSettings, type Settings } from '../shared/settings';
import { DEFAULT_SHORTCUTS, inPageBindings } from '../shared/shortcuts';

const COMMAND_LABELS: Record<CommandId, string> = {
  'toggle-sidebar': 'Ouvrir / réduire le panneau de notes',
  'insert-timestamp': 'Insérer l’horodatage au curseur',
  'capture-screenshot': 'Capturer l’image de la vidéo',
  'smart-pause': 'Pause & écrire (Smart Pause)',
  replay: 'Revoir les dernières secondes',
};

const FORMAT_DESC: Record<string, string> = {
  'image/jpeg': 'Compact, idéal pour les vidéos.',
  'image/png': 'Sans perte : parfait pour les schémas et le texte.',
  'image/webp': 'Compact et net, moins universel.',
};

type Scope = 'global' | 'page' | 'unset';

const form = document.querySelector('main') as HTMLElement;
const savedEl = document.getElementById('saved') as HTMLElement;
let savedTimer: ReturnType<typeof setTimeout> | null = null;

function applyTheme(): void {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function flashSaved(text = 'Enregistré', ok = true): void {
  savedEl.replaceChildren(icon(ok ? 'check' : 'alert', 15), h('span', {}, text));
  savedEl.classList.add('show');
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1600);
}

function field<T extends HTMLElement = HTMLInputElement>(name: string): T[] {
  return [...form.querySelectorAll<T>(`[name="${name}"]`)];
}

function checkRadio(name: string, value: string): void {
  for (const radio of field(name)) radio.checked = radio.value === value;
}

function renderSettings(s: Settings): void {
  for (const key of ['autoTimestamp', 'autoPause', 'pageShortcuts', 'hudEnabled'] as const) {
    field(key)[0].checked = s[key];
  }
  checkRadio('layout', s.layout);
  checkRadio('theme', s.theme);
  checkRadio('replaySeconds', String(s.replaySeconds));
  checkRadio('captureFormat', s.captureFormat);
  field('drawerWidth')[0].value = String(s.drawerWidth);
  field('captureQuality')[0].value = String(s.captureQuality);
  field('desktopUrl')[0].value = s.desktopUrl;
  field('desktopToken')[0].value = s.desktopToken;
  renderOutputs();
}

function renderOutputs(): void {
  (document.getElementById('drawerWidth-out') as HTMLOutputElement).value = `${field('drawerWidth')[0].value} px`;
  (document.getElementById('captureQuality-out') as HTMLOutputElement).value =
    `${Math.round(Number(field('captureQuality')[0].value) * 100)} %`;
  const format = field('captureFormat').find((r) => r.checked)?.value ?? 'image/jpeg';
  (document.getElementById('format-desc') as HTMLElement).textContent = FORMAT_DESC[format] ?? '';
  // PNG is lossless: the quality setting does not apply.
  field('captureQuality')[0].disabled = format === 'image/png';
}

function readPatch(target: HTMLInputElement | HTMLSelectElement): Partial<Settings> | null {
  const name = target.name as keyof Settings;
  switch (name) {
    case 'autoTimestamp':
    case 'autoPause':
    case 'pageShortcuts':
    case 'hudEnabled':
      return { [name]: (target as HTMLInputElement).checked };
    case 'replaySeconds':
    case 'drawerWidth':
    case 'captureQuality':
      return { [name]: Number(target.value) };
    case 'layout':
    case 'theme':
    case 'captureFormat':
      return { [name]: target.value } as Partial<Settings>;
    case 'desktopUrl': {
      const value = target.value.trim();
      const valid = isLoopbackWsUrl(value);
      target.setAttribute('aria-invalid', String(!valid));
      return valid ? { desktopUrl: value } : null;
    }
    case 'desktopToken':
      return { desktopToken: target.value };
    default:
      return null;
  }
}

/** Effective shortcut per command: global (Chrome), in-page fallback, or none. */
async function effectiveShortcuts(): Promise<Record<CommandId, { keys: string; scope: Scope }>> {
  const settings = await loadSettings();
  const list = await callBackground({ type: 'shortcuts:list' });
  const registered = new Map(list.map((c) => [c.name, c.shortcut]));
  const inPage = new Set(inPageBindings(list).map((b) => b.command));
  const out = {} as Record<CommandId, { keys: string; scope: Scope }>;
  for (const [id, fallback] of Object.entries(DEFAULT_SHORTCUTS) as Array<[CommandId, string]>) {
    const global = registered.get(id);
    if (global) out[id] = { keys: global, scope: 'global' };
    else if (settings.pageShortcuts && inPage.has(id)) out[id] = { keys: fallback, scope: 'page' };
    else out[id] = { keys: '', scope: 'unset' };
  }
  return out;
}

async function renderShortcuts(): Promise<void> {
  const shortcuts = await effectiveShortcuts();
  const rows = document.getElementById('shortcut-rows') as HTMLElement;
  rows.replaceChildren(
    ...(Object.keys(COMMAND_LABELS) as CommandId[]).map((id) => {
      const info = shortcuts[id];
      const right =
        info.scope === 'unset'
          ? h('span', { class: 'unset' }, 'Non défini')
          : h(
              'span',
              {},
              info.scope === 'page'
                ? h('span', { class: 'scope', title: 'Actif quand le focus est sur la vidéo ou dans les notes' }, 'dans la page')
                : null,
              keycaps(info.keys, IS_MAC),
            );
      return h('div', { class: 'row' }, h('span', { class: 'row-label' }, COMMAND_LABELS[id]), right);
    }),
  );
  for (const slot of document.querySelectorAll<HTMLElement>('.step-keys[data-command]')) {
    const info = shortcuts[slot.dataset.command as CommandId];
    slot.replaceChildren(info && info.scope !== 'unset' ? keycaps(info.keys, IS_MAC) : '');
  }
}

function renderStatus(status: SyncStatus | undefined): void {
  const state = status?.state ?? 'offline';
  const title =
    state === 'connected'
      ? `Connecté${status?.app ? ` à ${status.app.name}` : ''}`
      : state === 'connecting'
        ? 'Connexion…'
        : 'Hors-ligne';
  (document.getElementById('sync-card') as HTMLElement).dataset.state = state;
  (document.getElementById('sync-badge') as HTMLElement).textContent = title;
  const parts: string[] = [];
  if (status?.app && state === 'connected') parts.push(`Version ${status.app.version}`);
  if (status?.pending) parts.push(`${status.pending} note(s) en attente d’envoi`);
  if (state === 'offline') parts.push(status?.error ?? 'Application Desktop non détectée : vos notes restent sur cet appareil.');
  (document.getElementById('sync-detail') as HTMLElement).textContent = parts.join(' · ');

  const side = document.getElementById('sidebar-status') as HTMLElement;
  side.dataset.state = state;
  (side.querySelector('.label') as HTMLElement).textContent =
    state === 'connected' ? 'Desktop connecté' : state === 'connecting' ? 'Connexion…' : 'Desktop hors-ligne';
}

async function renderData(): Promise<void> {
  const notes = await callBackground({ type: 'notes:list' });
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const entries = Object.entries(notes).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  (document.getElementById('data-summary') as HTMLElement).textContent =
    entries.length === 0
      ? 'Aucune note pour l’instant.'
      : `${entries.length} note${entries.length > 1 ? 's' : ''} · ${size} utilisés (captures comprises)`;
  const list = document.getElementById('note-list') as HTMLElement;
  const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  list.replaceChildren(
    ...entries.slice(0, 50).map(([, n]) =>
      h(
        'li',
        {},
        h('span', { class: 'platform' }, PLATFORM_LABELS[n.platform] ?? n.platform),
        h('a', { href: n.url, target: '_blank', rel: 'noopener' }, n.title || n.url),
        h('time', { datetime: new Date(n.updatedAt).toISOString() }, dateFmt.format(n.updatedAt)),
      ),
    ),
  );
}

/** Sidebar icons + scrollspy highlighting the section being read. */
function decorateNav(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav a')];
  for (const a of links) {
    if (a.dataset.icon) a.prepend(icon(a.dataset.icon as IconName, 16));
  }
  const sections = links
    .map((a) => document.querySelector<HTMLElement>(a.getAttribute('href') ?? ''))
    .filter((s): s is HTMLElement => s !== null);
  const visible = new Map<string, boolean>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) visible.set(e.target.id, e.isIntersecting);
      const current = sections.find((s) => visible.get(s.id))?.id ?? sections[0]?.id;
      for (const a of links) a.setAttribute('aria-current', String(a.getAttribute('href') === `#${current}`));
    },
    { rootMargin: '-15% 0px -60% 0px' },
  );
  for (const s of sections) observer.observe(s);
}

async function main(): Promise<void> {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  (document.getElementById('version') as HTMLElement).textContent = `Version ${chrome.runtime.getManifest().version}`;
  if (location.hash === '#bienvenue') (document.getElementById('bienvenue') as HTMLElement).hidden = false;
  decorateNav();

  renderSettings(await loadSettings());
  form.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'range') renderOutputs();
  });
  form.addEventListener('change', async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !target.name) return;
    const patch = readPatch(target);
    if (!patch) {
      flashSaved('Adresse invalide : ws://localhost:PORT', false);
      return;
    }
    await saveSettings(patch);
    renderOutputs();
    flashSaved();
    if (target.name === 'pageShortcuts') void renderShortcuts();
  });

  const token = document.getElementById('desktopToken') as HTMLInputElement;
  const toggleToken = document.getElementById('toggle-token') as HTMLButtonElement;
  toggleToken.addEventListener('click', () => {
    const show = token.type === 'password';
    token.type = show ? 'text' : 'password';
    toggleToken.textContent = show ? 'Masquer' : 'Afficher';
    toggleToken.setAttribute('aria-pressed', String(show));
  });

  document.getElementById('edit-shortcuts')?.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  const retry = async () => {
    renderStatus({ state: 'connecting', pending: 0, at: Date.now() });
    renderStatus(await callBackground({ type: 'sync:retry' }));
  };
  document.getElementById('sync-retry')?.addEventListener('click', () => void retry());
  document.getElementById('sidebar-status')?.addEventListener('click', () => {
    document.getElementById('desktop')?.scrollIntoView();
    void retry();
  });
  document.getElementById('clear-all')?.addEventListener('click', async () => {
    // eslint-disable-next-line no-alert
    if (!confirm('Supprimer définitivement toutes les notes et captures stockées dans ce navigateur ?')) return;
    await callBackground({ type: 'notes:clear' });
    await renderData();
    flashSaved('Notes effacées');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes['sync:status']) renderStatus(changes['sync:status'].newValue as SyncStatus);
    if (area === 'local' && changes['notes:index']) void renderData();
  });
  document.addEventListener('visibilitychange', () => {
    // Shortcuts may have been edited in chrome://extensions/shortcuts meanwhile.
    if (document.visibilityState === 'visible') void renderShortcuts();
  });

  const status = (await chrome.storage.session.get('sync:status'))['sync:status'] as SyncStatus | undefined;
  renderStatus(status);
  callBackground({ type: 'sync:status' }).then(renderStatus, () => undefined);
  await Promise.all([renderShortcuts(), renderData()]);
}

void main();
