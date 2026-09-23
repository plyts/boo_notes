import { callBackground, type SyncStatus } from '../shared/messages';
import { PLATFORM_LABELS } from '../shared/platforms';
import { isLoopbackWsUrl, loadSettings, saveSettings, type Settings } from '../shared/settings';
import { h } from '../shared/icons';
import { DEFAULT_SHORTCUTS, formatShortcut, inPageBindings } from '../shared/shortcuts';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const COMMAND_LABELS: Record<string, string> = {
  'toggle-sidebar': 'Ouvrir / réduire le panneau de notes',
  'insert-timestamp': 'Insérer l’horodatage au curseur',
  'capture-screenshot': 'Capturer l’image de la vidéo',
  'smart-pause': 'Pause + focus sur l’éditeur (Smart Pause)',
  replay: 'Saut arrière (réécouter une phrase)',
};

const form = document.querySelector('main') as HTMLElement;
const savedEl = document.getElementById('saved') as HTMLElement;
let savedTimer: ReturnType<typeof setTimeout> | null = null;

function applyTheme(): void {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function flashSaved(text = 'Enregistré'): void {
  savedEl.textContent = text;
  savedEl.classList.add('show');
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1400);
}

function field<T extends HTMLElement = HTMLInputElement>(name: string): T[] {
  return [...form.querySelectorAll<T>(`[name="${name}"]`)];
}

function renderSettings(s: Settings): void {
  for (const key of ['autoTimestamp', 'autoPause', 'pageShortcuts', 'hudEnabled'] as const) {
    field(key)[0].checked = s[key];
  }
  for (const key of ['layout', 'theme'] as const) {
    for (const radio of field(key)) radio.checked = radio.value === s[key];
  }
  field('replaySeconds')[0].value = String(s.replaySeconds);
  field('drawerWidth')[0].value = String(s.drawerWidth);
  field('captureQuality')[0].value = String(s.captureQuality);
  field<HTMLSelectElement>('captureFormat')[0].value = s.captureFormat;
  field('desktopUrl')[0].value = s.desktopUrl;
  field('desktopToken')[0].value = s.desktopToken;
  renderOutputs();
}

function renderOutputs(): void {
  (document.getElementById('drawerWidth-out') as HTMLOutputElement).value = `${field('drawerWidth')[0].value} px`;
  (document.getElementById('captureQuality-out') as HTMLOutputElement).value =
    `${Math.round(Number(field('captureQuality')[0].value) * 100)} %`;
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

async function renderShortcuts(): Promise<void> {
  const rows = document.getElementById('shortcut-rows') as HTMLElement;
  const settings = await loadSettings();
  const list = await callBackground({ type: 'shortcuts:list' });
  const inPage = inPageBindings(list);
  const order = Object.keys(DEFAULT_SHORTCUTS);
  list.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  rows.replaceChildren(
    ...list.map((c) => {
      let keys: Node;
      const fallback = settings.pageShortcuts ? inPage.find((b) => b.command === c.name) : undefined;
      if (c.shortcut) keys = h('span', { class: 'key' }, c.shortcut);
      else if (fallback) {
        keys = h(
          'span',
          {},
          h('span', { class: 'key' }, formatShortcut(fallback.shortcut, IS_MAC)),
          h('small', { class: 'scope' }, 'dans la page'),
        );
      } else keys = h('span', { class: 'key unset' }, 'Non défini');
      return h('tr', {}, h('td', {}, COMMAND_LABELS[c.name] ?? c.description), h('td', {}, keys));
    }),
  );
}

function renderStatus(status: SyncStatus | undefined): void {
  const badge = document.getElementById('sync-badge') as HTMLElement;
  const detail = document.getElementById('sync-detail') as HTMLElement;
  const state = status?.state ?? 'offline';
  badge.dataset.state = state;
  badge.textContent = state === 'connected' ? 'Connecté' : state === 'connecting' ? 'Connexion…' : 'Hors-ligne';
  const parts: string[] = [];
  if (status?.app) parts.push(`${status.app.name} ${status.app.version}`);
  if (status?.pending) parts.push(`${status.pending} note(s) en attente`);
  if (state !== 'connected' && status?.error) parts.push(status.error);
  detail.textContent = parts.join(' · ');
}

async function renderData(): Promise<void> {
  const notes = await callBackground({ type: 'notes:list' });
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const entries = Object.entries(notes).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  (document.getElementById('data-summary') as HTMLElement).textContent =
    `${entries.length} note(s) · ${(bytes / 1024 / 1024).toFixed(1)} Mo utilisés (captures comprises).`;
  const list = document.getElementById('note-list') as HTMLElement;
  list.replaceChildren(
    ...entries.slice(0, 50).map(([, n]) =>
      h(
        'li',
        {},
        h('a', { href: n.url, target: '_blank', rel: 'noopener' }, `${PLATFORM_LABELS[n.platform] ?? n.platform} — ${n.title || n.url}`),
        h('time', { datetime: new Date(n.updatedAt).toISOString() }, new Date(n.updatedAt).toLocaleString('fr-FR')),
      ),
    ),
  );
}

async function main(): Promise<void> {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  if (location.hash === '#bienvenue') (document.getElementById('bienvenue') as HTMLElement).hidden = false;

  renderSettings(await loadSettings());
  form.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'range') renderOutputs();
  });
  form.addEventListener('change', async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !target.name) return;
    const patch = readPatch(target);
    if (!patch) {
      flashSaved('Adresse invalide : ws://localhost:PORT');
      return;
    }
    await saveSettings(patch);
    flashSaved();
    if (target.name === 'pageShortcuts') void renderShortcuts();
  });

  document.getElementById('edit-shortcuts')?.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  document.getElementById('sync-retry')?.addEventListener('click', async () => {
    renderStatus({ state: 'connecting', pending: 0, at: Date.now() });
    renderStatus(await callBackground({ type: 'sync:retry' }));
  });
  document.getElementById('clear-all')?.addEventListener('click', async () => {
    // eslint-disable-next-line no-alert
    if (!confirm('Supprimer définitivement toutes les notes et captures stockées dans le navigateur ?')) return;
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
