import { chromeAiState, frenchReady, prepareChromeAi, type ChromeAiState } from '../shared/chrome-ai';
import { listModels, type ClaudeModel } from '../shared/claude';
import { h, icon, type IconName } from '../shared/icons';
import { IS_MAC, keycaps } from '../shared/keycaps';
import { callBackground, type CommandId, type NotesSyncStatus, type NotionStatus, type SyncStatus } from '../shared/messages';
import { PLATFORM_LABELS } from '../shared/platforms';
import { loadQa, saveQa, type QaConfig } from '../shared/qa-config';
import { isLoopbackWsUrl, loadSettings, saveSettings, type Settings } from '../shared/settings';
import { DEFAULT_SHORTCUTS, inPageBindings } from '../shared/shortcuts';

const COMMAND_LABELS: Record<CommandId, string> = {
  'toggle-sidebar': 'Ouvrir / réduire le panneau de notes',
  'insert-timestamp': 'Horodater · citer le passage sélectionné (page)',
  'capture-screenshot': 'Capturer l’image de la vidéo ou de la page',
  'smart-pause': 'Pause & écrire (Smart Pause)',
  replay: 'Revoir les dernières secondes',
  'passage-start': 'Début du passage (extrait 02:05 → 06:07)',
  'passage-end': 'Fin du passage : carte, extrait, sous-titres et notes',
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
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), ok ? 1600 : 5000);
}

function field<T extends HTMLElement = HTMLInputElement>(name: string): T[] {
  return [...form.querySelectorAll<T>(`[name="${name}"]`)];
}

function checkRadio(name: string, value: string): void {
  for (const radio of field(name)) radio.checked = radio.value === value;
}

function renderSettings(s: Settings): void {
  for (const key of ['autoTimestamp', 'autoPause', 'pageShortcuts', 'hudEnabled', 'transcribe', 'autoTranslate', 'recordPassages', 'keepAudio'] as const) {
    field(key)[0].checked = s[key];
  }
  field<HTMLSelectElement>('translateTo')[0].value = s.translateTo;
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
    case 'transcribe':
    case 'autoTranslate':
    case 'recordPassages':
    case 'keepAudio':
      return { [name]: (target as HTMLInputElement).checked };
    case 'replaySeconds':
    case 'drawerWidth':
    case 'captureQuality':
      return { [name]: Number(target.value) };
    case 'layout':
    case 'theme':
    case 'captureFormat':
    case 'translateTo':
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

const relative = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

function ago(ts: number): string {
  const min = Math.round((ts - Date.now()) / 60_000);
  if (Math.abs(min) < 1) return 'à l’instant';
  if (Math.abs(min) < 60) return relative.format(min, 'minute');
  if (Math.abs(min) < 1440) return relative.format(Math.round(min / 60), 'hour');
  return relative.format(Math.round(min / 1440), 'day');
}

function renderNotion(status: NotionStatus | undefined): void {
  const card = document.getElementById('notion-card') as HTMLElement;
  const configured = Boolean(status?.configured);
  card.dataset.state = status?.syncing ? 'connecting' : configured ? (status?.lastError ? 'offline' : 'connected') : 'offline';
  (document.getElementById('notion-badge') as HTMLElement).textContent = !configured
    ? 'Non connecté'
    : status?.origin === 'desktop'
      ? `Connecté via l’app Desktop${status.workspace ? ` · ${status.workspace}` : ''}`
      : status?.vault
        ? `Connecté à Notion · coffre « ${status.vault} »`
        : status?.via === 'oauth'
          ? `Connecté avec votre compte Notion${status.workspace ? ` · ${status.workspace}` : ''}`
          : `Connecté${status?.workspace ? ` · ${status.workspace}` : ''}`;
  const parts: string[] = [];
  if (configured) {
    if (status?.syncing) parts.push('Synchronisation…');
    if (status?.pending) parts.push(`${status.pending} note(s) à écrire`);
    if (status?.lastError) parts.push(status.lastError);
    else if (status?.lastSyncAt) parts.push(`Dernière écriture ${ago(status.lastSyncAt)}`);
    if (!parts.length) parts.push('Vos notes seront écrites dans Notion, même app Desktop fermée.');
  } else {
    parts.push('Vos notes restent dans ce navigateur (et l’app Desktop si elle est lancée).');
  }
  (document.getElementById('notion-detail') as HTMLElement).textContent = parts.join(' · ');
  const open = document.getElementById('notion-open') as HTMLAnchorElement;
  const vaultUrl = status?.vaultUrl || status?.databaseUrl;
  open.hidden = !vaultUrl;
  if (vaultUrl) open.href = vaultUrl;
  for (const id of ['notion-oauth', 'notion-advanced']) (document.getElementById(id) as HTMLElement).hidden = configured;
  if (configured) (document.getElementById('notion-vault') as HTMLElement).hidden = true;
  (document.getElementById('notion-actions') as HTMLElement).hidden = !configured;
  // A connection shared by the app is managed there.
  (document.getElementById('notion-disconnect-row') as HTMLElement).hidden = status?.origin === 'desktop';
}

/**
 * « Se connecter à Notion »: Notion's own window, then the vault — one
 * already in this Notion, or a new one named here (« Boo Notes » by
 * default). The service worker does the rest (the table, the course pages,
 * the notes).
 */
async function setUpNotionOAuth(): Promise<void> {
  const info = await callBackground({ type: 'notion:oauth-info' }).catch(() => ({ available: false, redirectUri: '' }));
  const button = document.getElementById('notion-oauth-btn') as HTMLButtonElement;
  const form = document.getElementById('notion-vault') as HTMLFormElement;
  const list = document.getElementById('notion-vault-list') as HTMLElement;
  if (!info.available) {
    button.disabled = true;
    (document.getElementById('notion-oauth-desc') as HTMLElement).textContent =
      `La connexion en un clic n’est pas encore configurée dans cette installation de Boo Notes (voir docs/NOTION.md) : utilisez la méthode avancée ci-dessous.${info.redirectUri ? ` Adresse de retour à déclarer dans l’intégration Notion : ${info.redirectUri}` : ''}`;
    (document.getElementById('notion-advanced') as HTMLDetailsElement).open = true;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Fenêtre Notion ouverte…';
    try {
      const res = await callBackground({ type: 'notion:oauth' });
      const name = h('input', { type: 'text', name: 'notionVaultName', placeholder: 'Boo Notes, Coursera notes, Sample notes…', 'aria-label': 'Nom du coffre', maxlength: '100', autocomplete: 'off' });
      const rows: HTMLElement[] = [];
      if (res.vaults.length) {
        const preferred = res.vaults.find((v) => v.name.trim().toLowerCase() === 'boo notes') ?? res.vaults[0];
        for (const v of res.vaults) {
          const radio = h('input', { type: 'radio', name: 'notionVault', value: v.id });
          radio.checked = v === preferred;
          rows.push(h('label', {}, radio, h('span', {}, `👻 ${v.name}`)));
        }
        const fresh = h('input', { type: 'radio', name: 'notionVault', value: '' });
        name.addEventListener('focus', () => (fresh.checked = true));
        rows.push(h('label', {}, fresh, h('span', {}, 'Nouveau coffre'), name));
      } else {
        name.value = 'Boo Notes';
        rows.push(h('label', {}, h('span', {}, 'Nom du coffre'), name));
      }
      list.replaceChildren(...rows);
      (document.getElementById('notion-vault-help') as HTMLElement).textContent = res.vaults.length
        ? 'Toutes vos notes y sont rangées, une page par cours. Gardez celui-ci, ou créez-en un autre :'
        : 'Toutes vos notes y seront rangées, une page par cours.';
      form.hidden = false;
      (list.querySelector('input:checked, input[type="text"]') as HTMLInputElement | null)?.focus();
    } catch (e) {
      flashSaved(e instanceof Error ? e.message : String(e), false);
    } finally {
      button.disabled = !info.available;
      button.textContent = 'Se connecter à Notion';
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked = form.querySelector<HTMLInputElement>('input[name="notionVault"]:checked');
    const typed = form.querySelector<HTMLInputElement>('input[name="notionVaultName"]')?.value.trim() ?? '';
    if (!picked?.value && !typed) return;
    const submit = document.getElementById('notion-vault-btn') as HTMLButtonElement;
    submit.disabled = true;
    submit.textContent = 'Préparation du coffre…';
    try {
      const status = await callBackground({ type: 'notion:vault', vaultId: picked?.value || null, name: typed || 'Boo Notes' });
      form.hidden = true;
      renderNotion(status);
      flashSaved(`Notion connecté : vos notes vont dans le coffre « ${status.vault ?? typed} »`);
    } catch (err) {
      flashSaved(err instanceof Error ? err.message : String(err), false);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Valider';
    }
  });
}

const PROVIDER_DESC: Record<QaConfig['provider'], string> = {
  chrome: 'Sur cet ordinateur, gratuitement : rien n’est envoyé. Sa réponse s’écrit sous la question, compacte, à vérifier.',
  claude: 'Claude (Anthropic), avec votre clé : la question et les extraits du cours lui sont envoyés.',
  none: 'Pas de réponse aux questions : elles restent des questions.',
};

/** Options › Questions: who writes the answers — Chrome's built-in AI, Claude (the user's key), or no AI. */
function renderQa(qa: QaConfig, shown: QaConfig['provider'], models: ClaudeModel[] | null, error = ''): void {
  checkRadio('qaProvider', shown);
  (document.getElementById('qa-provider-desc') as HTMLElement).textContent = PROVIDER_DESC[shown];
  (document.getElementById('chrome-ai-row') as HTMLElement).hidden = shown !== 'chrome';
  (document.getElementById('qa-claude-card') as HTMLElement).hidden = shown !== 'claude';
  const keyed = Boolean(qa.key && qa.model);
  (document.getElementById('qa-card') as HTMLElement).dataset.state = keyed ? (error ? 'offline' : 'connected') : 'offline';
  (document.getElementById('qa-badge') as HTMLElement).textContent = keyed ? 'Claude activé' : 'Claude : ajoutez votre clé';
  const model = models?.find((m) => m.id === qa.model);
  (document.getElementById('qa-detail') as HTMLElement).textContent = keyed
    ? error || `Modèle : ${model?.name ?? qa.model}`
    : 'Votre clé est vérifiée, puis le modèle le plus récent est choisi.';
  (document.getElementById('qa-form') as HTMLElement).hidden = keyed;
  (document.getElementById('qa-actions') as HTMLElement).hidden = !keyed;
  const select = document.getElementById('qa-model') as HTMLSelectElement;
  const list = models?.length ? models : qa.model ? [{ id: qa.model, name: qa.model }] : [];
  select.replaceChildren(...list.map((m) => h('option', { value: m.id }, m.name)));
  select.value = qa.model;
}

const CHROME_AI_TEXT: Record<ChromeAiState['state'], string> = {
  unsupported: 'Absente de ce navigateur : il faut Chrome 138 ou plus récent, sur ordinateur. Sans elle, choisissez Claude.',
  unavailable: 'Indisponible sur cet ordinateur (il faut une machine assez puissante et de l’espace disque libre). Sans elle, choisissez Claude.',
  downloadable: 'Le modèle n’est pas encore sur cet ordinateur : téléchargez-le une fois (quelques Go, en arrière-plan).',
  downloading: 'Téléchargement du modèle en cours…',
  available: 'Prête : vos questions reçoivent une réponse rédigée sur cet ordinateur.',
};

async function renderChromeAi(): Promise<ChromeAiState> {
  const ai = await chromeAiState();
  // It writes English (French is not offered yet): its answers are translated, the translator downloaded with it.
  const french = ai.lang === 'en' ? await frenchReady() : true;
  const text =
    ai.state === 'available' && !french
      ? 'Prête, mais elle écrit en anglais : téléchargez aussi le traducteur de Chrome pour des réponses en français.'
      : ai.state === 'available' && ai.lang === 'en'
        ? 'Prête : elle écrit en anglais, ses réponses sont traduites en français par le traducteur de Chrome, sur cet ordinateur.'
        : CHROME_AI_TEXT[ai.state];
  (document.getElementById('chrome-ai-state') as HTMLElement).textContent = text;
  const button = document.getElementById('chrome-ai-download') as HTMLButtonElement;
  button.hidden = !(ai.state === 'downloadable' || (ai.state === 'available' && !french));
  button.textContent = ai.state === 'available' ? 'Télécharger le traducteur' : 'Télécharger le modèle';
  (document.getElementById('chrome-ai-row') as HTMLElement).dataset.state = ai.state;
  return ai;
}

async function setUpQa(): Promise<void> {
  let qa = await loadQa();
  let shown: QaConfig['provider'] = qa.provider;
  let models: ClaudeModel[] | null = null;
  renderQa(qa, shown, models);
  void renderChromeAi();
  if (qa.key && qa.model) {
    listModels(qa.key, qa.base).then(
      (list) => renderQa(qa, shown, (models = list)),
      (e: unknown) => renderQa(qa, shown, models, e instanceof Error ? e.message : String(e)),
    );
  }
  for (const radio of field('qaProvider')) {
    radio.addEventListener('change', async () => {
      shown = radio.value as QaConfig['provider'];
      // Claude needs its key first: chosen once the key is checked.
      if (shown !== 'claude' || (qa.key && qa.model)) {
        qa = await saveQa({ provider: shown });
        flashSaved();
      }
      renderQa(qa, shown, models);
      if (shown === 'chrome') void renderChromeAi();
    });
  }
  const download = document.getElementById('chrome-ai-download') as HTMLButtonElement;
  download.addEventListener('click', async () => {
    const state = document.getElementById('chrome-ai-state') as HTMLElement;
    download.disabled = true;
    try {
      const ai = await chromeAiState();
      await prepareChromeAi(ai.lang ?? 'en', (ratio) => {
        state.textContent = `Téléchargement… ${Math.round(ratio * 100)} %`;
      });
      await renderChromeAi();
      flashSaved('IA intégrée de Chrome prête');
    } catch (e) {
      flashSaved(e instanceof Error ? e.message : String(e), false);
      await renderChromeAi();
    } finally {
      download.disabled = false;
    }
  });
  const key = document.getElementById('qa-key') as HTMLInputElement;
  const button = document.getElementById('qa-connect') as HTMLButtonElement;
  document.getElementById('qa-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = 'Vérification…';
    try {
      // The key is tried first: the models it may use, the most recent chosen.
      const list = await listModels(key.value.trim(), qa.base);
      if (!list.length) throw new Error('aucun modèle n’est disponible pour cette clé');
      qa = await saveQa({ provider: 'claude', key: key.value.trim(), model: list[0].id });
      shown = 'claude';
      key.value = '';
      renderQa(qa, shown, (models = list));
      flashSaved('Claude activé : vos questions reçoivent une réponse rédigée');
    } catch (err) {
      flashSaved(err instanceof Error ? err.message : String(err), false);
    } finally {
      button.disabled = false;
      button.textContent = 'Vérifier et activer';
    }
  });
  const select = document.getElementById('qa-model') as HTMLSelectElement;
  select.addEventListener('change', async () => {
    qa = await saveQa({ model: select.value });
    renderQa(qa, shown, models);
    flashSaved('Modèle enregistré');
  });
  document.getElementById('qa-remove')?.addEventListener('click', async () => {
    qa = await saveQa({ provider: 'chrome', key: '', model: '' });
    shown = 'chrome';
    models = null;
    renderQa(qa, shown, models);
    void renderChromeAi();
    flashSaved('Clé retirée');
  });
}

/** Notes picked in the list (kept across refreshes). */
const picked = new Set<string>();

type NoteSync = NotesSyncStatus['notes'][string];

/**
 * Where a note is: in Notion (green, its page a click away), or not yet — a
 * « Sync » button writes it now, in its course's page; the app's pill when
 * the Desktop app is paired.
 */
function syncPills(id: string, title: string, place: string, state: NoteSync | undefined, status: NotesSyncStatus | null): HTMLElement {
  const pills: HTMLElement[] = [];
  if (!status || (!status.desktop.configured && !status.notion.configured)) {
    pills.push(h('span', { class: 'sync-pill', 'data-state': 'local', title: 'Notion n’est pas connecté : la note reste dans ce navigateur (options › Notion, ou « Se connecter à… » dans les notes).' }, 'Pas dans Notion'));
  }
  if (state?.desktop) {
    const synced = state.desktop === 'synced';
    const label = synced ? 'App Desktop : synchronisée' : `App Desktop : en attente${status?.desktop.state === 'connected' ? '' : ' (l’app est hors-ligne)'}`;
    pills.push(h('span', { class: 'sync-pill', 'data-state': state.desktop, title: label, 'aria-label': label }, 'Desktop'));
  }
  if (state?.notion) {
    const n = state.notion;
    if (n.state === 'synced') {
      const label = `Dans Notion${place ? ` · ${place}` : ''} (ouvrir la page)`;
      const attrs = { class: 'sync-pill', 'data-state': 'synced', title: label, 'aria-label': label };
      pills.push(n.url ? h('a', { ...attrs, href: n.url, target: '_blank', rel: 'noopener' }, 'Dans Notion') : h('span', attrs, 'Dans Notion'));
    } else {
      // Not in Notion yet (or it failed): written now, where it belongs.
      const why = n.state === 'error' ? `Notion : erreur — ${n.error ?? 'échec de l’écriture'}. ` : n.state === 'pending' ? 'Notion : en attente. ' : 'Pas encore dans Notion. ';
      const label = `${why}Envoyer « ${title} » maintenant${place ? `, dans ${place}` : ''}`;
      const button = h('button', { type: 'button', class: 'btn sync-now', 'data-state': n.state === 'error' ? 'error' : 'pending', title: label, 'aria-label': label }, icon('refresh', 13), h('span', {}, 'Sync'));
      button.addEventListener('click', () => void syncNote(id, title, place, button));
      pills.push(button);
    }
  }
  return h('span', { class: 'sync' }, ...pills);
}

/** « Tout synchroniser »: what is not in Notion yet, written; the rest left as it is. */
async function syncAllNotes(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = 'Synchronisation…';
  try {
    const { ok, failed, unchanged } = await callBackground({ type: 'notion:sync-all' });
    flashSaved(`Notion : ${ok} note${ok > 1 ? 's' : ''} écrite${ok > 1 ? 's' : ''}${unchanged ? `, ${unchanged} déjà à jour` : ''}${failed ? `, ${failed} en échec` : ''}`, failed === 0);
  } catch (e) {
    flashSaved(e instanceof Error ? e.message : String(e), false);
  } finally {
    await renderData();
  }
}

/** « Sync »: the note written to Notion now (in its course's page), its row redrawn. */
async function syncNote(id: string, title: string, place: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  (button.lastElementChild as HTMLElement).textContent = 'Envoi…';
  try {
    await callBackground({ type: 'notion:sync-note', noteId: id });
    flashSaved(`« ${title} » est dans Notion${place ? ` (${place})` : ''}`);
  } catch (e) {
    flashSaved(e instanceof Error ? e.message : String(e), false);
  } finally {
    await renderData();
  }
}

/** Summary of the sync: what waits, where. */
function syncSummary(status: NotesSyncStatus | null, ids: string[]): string {
  if (!status) return '';
  const parts: string[] = [];
  if (status.desktop.configured) {
    const pending = ids.filter((id) => status.notes[id]?.desktop === 'pending').length;
    const offline = status.desktop.state !== 'connected';
    parts.push(`App Desktop : ${pending ? `${pending} note${pending > 1 ? 's' : ''} en attente${offline ? ' (hors-ligne)' : ''}` : 'tout est synchronisé'}`);
  }
  if (status.notion.configured) {
    const states = ids.map((id) => status.notes[id]?.notion?.state);
    const errors = states.filter((st) => st === 'error').length;
    const waiting = states.filter((st) => st === 'pending' || st === 'new').length;
    const bits = [errors ? `${errors} en erreur` : '', waiting ? `${waiting} en attente` : ''].filter(Boolean);
    parts.push(`Notion : ${bits.length ? bits.join(', ') : 'tout est synchronisé'}`);
  }
  return parts.length ? parts.join(' · ') : 'Vos notes restent dans ce navigateur : ni l’app Desktop ni Notion ne sont connectés.';
}

async function deleteNotes(ids: string[], titles: string[]): Promise<void> {
  const what = ids.length === 1 ? `« ${titles[0] || 'cette note'} »` : `ces ${ids.length} notes`;
  // eslint-disable-next-line no-alert
  if (!confirm(`Supprimer ${what} de ce navigateur ?\n\nLeurs captures, transcriptions et extraits aussi. Ce qui a déjà été envoyé à l’app Desktop ou à Notion y reste.`)) return;
  const { deleted } = await callBackground({ type: 'notes:delete', noteIds: ids });
  for (const id of ids) picked.delete(id);
  flashSaved(deleted > 1 ? `${deleted} notes supprimées` : 'Note supprimée');
  await renderData();
}

async function renderData(): Promise<void> {
  const [notes, status, bytes] = await Promise.all([
    callBackground({ type: 'notes:list' }),
    callBackground({ type: 'notes:status' }).catch(() => null),
    chrome.storage.local.getBytesInUse(null),
  ]);
  const entries = Object.entries(notes).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const id of [...picked]) if (!notes[id]) picked.delete(id);
  const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  (document.getElementById('data-summary') as HTMLElement).textContent =
    entries.length === 0
      ? 'Aucune note pour l’instant.'
      : `${entries.length} note${entries.length > 1 ? 's' : ''} · ${size} utilisés (captures comprises)`;
  const sync = document.getElementById('data-sync') as HTMLElement;
  const ids = entries.map(([id]) => id);
  sync.replaceChildren(entries.length ? syncSummary(status, ids) : '');
  // Notes not in Notion yet: all of them written now (those already there left alone).
  const waiting = status?.notion.configured ? ids.filter((id) => status.notes[id]?.notion?.state !== 'synced').length : 0;
  if (waiting) {
    const all = h('button', { type: 'button', class: 'btn' }, 'Tout synchroniser');
    all.addEventListener('click', () => void syncAllNotes(all));
    sync.append(all);
  }
  sync.hidden = !sync.textContent;
  const list = document.getElementById('note-list') as HTMLElement;
  const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  list.replaceChildren(
    ...entries.map(([id, n]) => {
      const title = n.title || n.url;
      const place = n.course ? `${n.course} › ${n.chapter || 'Chapitre 1'}` : '';
      const pick = h('input', { type: 'checkbox', 'aria-label': `Sélectionner « ${title} »` });
      pick.checked = picked.has(id);
      pick.addEventListener('change', () => {
        if (pick.checked) picked.add(id);
        else picked.delete(id);
        renderSelection(entries.length);
      });
      const remove = h('button', { type: 'button', class: 'delete', title: 'Supprimer cette note de ce navigateur', 'aria-label': `Supprimer « ${title} »` }, icon('trash', 15));
      remove.addEventListener('click', () => void deleteNotes([id], [title]));
      return h(
        'li',
        { 'data-note': id },
        h('label', { class: 'pick' }, pick),
        h('span', { class: 'platform' }, PLATFORM_LABELS[n.platform] ?? n.platform),
        h(
          'span',
          { class: 'note-what' },
          // The lesson, a click away; where it is filed under it.
          h('a', { href: n.url, target: '_blank', rel: 'noopener', title: `Rouvrir la leçon : ${title}` }, title),
          h('small', { class: 'note-place', title: place || 'Rangée dans aucun cours' }, place || 'Non rangée'),
        ),
        syncPills(id, title, place, status?.notes[id], status),
        h('time', { datetime: new Date(n.updatedAt).toISOString() }, dateFmt.format(n.updatedAt)),
        remove,
      );
    }),
  );
  (document.querySelector('.select-all') as HTMLElement).hidden = entries.length === 0;
  renderSelection(entries.length);
  renderPdfScope(entries.map(([, n]) => n.course).filter((c): c is string => Boolean(c)));
}

/** « Télécharger en PDF »: every note, or one course (each with how many lessons). */
function renderPdfScope(courses: string[]): void {
  const select = document.getElementById('pdf-scope') as HTMLSelectElement;
  const counts = new Map<string, number>();
  for (const c of courses) counts.set(c, (counts.get(c) ?? 0) + 1);
  const kept = select.value;
  const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr', { numeric: true }));
  select.replaceChildren(
    h('option', { value: '' }, 'Toutes les notes'),
    ...sorted.map(([c, n]) => h('option', { value: c }, `Cours : ${c} (${n} leçon${n > 1 ? 's' : ''})`)),
  );
  select.value = counts.has(kept) ? kept : '';
}

/** « 3 notes sélectionnées — Supprimer la sélection ». */
function renderSelection(total: number): void {
  const actions = document.getElementById('data-actions') as HTMLElement;
  actions.hidden = picked.size === 0;
  (document.getElementById('data-selected') as HTMLElement).textContent = `${picked.size} note${picked.size > 1 ? 's' : ''} sélectionnée${picked.size > 1 ? 's' : ''}`;
  const all = document.getElementById('select-all') as HTMLInputElement;
  all.checked = total > 0 && picked.size === total;
  all.indeterminate = picked.size > 0 && picked.size < total;
}

let dataTimer: ReturnType<typeof setTimeout> | null = null;
/** Many keys change while syncing: the list is redrawn once they settle. */
function scheduleRenderData(): void {
  if (dataTimer) clearTimeout(dataTimer);
  dataTimer = setTimeout(() => void renderData(), 250);
}

/** « Activer sur tous les sites »: every page may be read (optional permission), scripts registered everywhere. */
async function renderAllSites(): Promise<void> {
  const box = document.getElementById('all-sites') as HTMLInputElement;
  box.checked = await callBackground({ type: 'sites:all', enabled: null });
}

async function toggleAllSites(box: HTMLInputElement): Promise<void> {
  const origins = ['https://*/*', 'http://*/*'];
  try {
    if (box.checked) {
      // Needs this click's user gesture.
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        box.checked = false;
        flashSaved('Autorisation refusée', false);
        return;
      }
      await callBackground({ type: 'sites:all', enabled: true });
      flashSaved('Boo Notes est actif sur tous les sites');
    } else {
      await callBackground({ type: 'sites:all', enabled: false });
      flashSaved('Boo Notes ne s’active plus que sur vos sites');
    }
  } catch (e) {
    box.checked = !box.checked;
    flashSaved(e instanceof Error ? e.message : String(e), false);
  }
}

async function renderSites(): Promise<void> {
  const sites = await callBackground({ type: 'sites:list' });
  const list = document.getElementById('site-list') as HTMLElement;
  (document.getElementById('site-empty') as HTMLElement).hidden = sites.length > 0;
  list.replaceChildren(
    ...sites.map((origin) => {
      const remove = h('button', { type: 'button', class: 'btn' }, 'Retirer');
      remove.addEventListener('click', async () => {
        await callBackground({ type: 'sites:disable', origin });
        await renderSites();
        flashSaved('Site retiré');
      });
      return h('li', {}, h('span', {}, origin), remove);
    }),
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
    // Fields of their own (Questions): saved by their section.
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !target.name || target.name.startsWith('qa') || target.name.startsWith('notion')) return;
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

  const notionForm = document.getElementById('notion-form') as HTMLFormElement;
  notionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = document.getElementById('notion-connect') as HTMLButtonElement;
    const token = (document.getElementById('notion-token') as HTMLInputElement).value;
    const target = (document.getElementById('notion-page') as HTMLInputElement).value;
    button.disabled = true;
    button.textContent = 'Connexion…';
    try {
      renderNotion(await callBackground({ type: 'notion:connect', token, target }));
      (document.getElementById('notion-token') as HTMLInputElement).value = '';
      flashSaved('Notion connecté : tableau créé');
    } catch (err) {
      flashSaved(err instanceof Error ? err.message : String(err), false);
    } finally {
      button.disabled = false;
      button.textContent = 'Connecter avec ce secret';
    }
  });
  document.getElementById('notion-disconnect')?.addEventListener('click', async () => {
    renderNotion(await callBackground({ type: 'notion:disconnect' }));
    flashSaved('Notion déconnecté');
  });
  document.getElementById('notion-sync-all')?.addEventListener('click', async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const { ok, failed, unchanged } = await callBackground({ type: 'notion:sync-all' });
      flashSaved(`${ok} note(s) écrite(s)${unchanged ? `, ${unchanged} déjà à jour` : ''}${failed ? `, ${failed} en échec` : ''}`, failed === 0);
    } catch (err) {
      flashSaved(err instanceof Error ? err.message : String(err), false);
    } finally {
      button.disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes['sync:status']) renderStatus(changes['sync:status'].newValue as SyncStatus);
    if (area === 'session' && changes['notion:status']) renderNotion(changes['notion:status'].newValue as NotionStatus);
    if (area === 'local' && Object.keys(changes).some((k) => k === 'notes:index' || k === 'sync:outbox' || k === 'notion:pending' || k.startsWith('notion:link:'))) scheduleRenderData();
    if (area === 'session' && (changes['sync:status'] || changes['notion:status'])) scheduleRenderData();
    if (area === 'local' && changes['sites:enabled']) void renderSites();
  });
  document.addEventListener('visibilitychange', () => {
    // Shortcuts may have been edited in chrome://extensions/shortcuts meanwhile.
    if (document.visibilityState === 'visible') void renderShortcuts();
  });

  const status = (await chrome.storage.session.get('sync:status'))['sync:status'] as SyncStatus | undefined;
  renderStatus(status);
  callBackground({ type: 'sync:status' }).then(renderStatus, () => undefined);
  renderNotion(undefined);
  callBackground({ type: 'notion:status' }).then(renderNotion, () => undefined);
  const allPdf = document.getElementById('all-pdf') as HTMLButtonElement;
  allPdf.addEventListener('click', async () => {
    const course = (document.getElementById('pdf-scope') as HTMLSelectElement).value;
    allPdf.disabled = true;
    allPdf.textContent = 'Préparation du PDF…';
    try {
      const { message } = await callBackground(course ? { type: 'course:pdf', course } : { type: 'notes:pdf' });
      flashSaved(message);
    } catch (e) {
      flashSaved(e instanceof Error ? e.message : String(e), false);
    } finally {
      allPdf.disabled = false;
      allPdf.textContent = 'Télécharger le PDF';
    }
  });
  const selectAll = document.getElementById('select-all') as HTMLInputElement;
  selectAll.addEventListener('change', () => {
    const ids = [...document.querySelectorAll<HTMLElement>('#note-list li[data-note]')].map((li) => li.dataset.note!);
    picked.clear();
    if (selectAll.checked) for (const id of ids) picked.add(id);
    for (const box of document.querySelectorAll<HTMLInputElement>('#note-list .pick input')) box.checked = selectAll.checked;
    renderSelection(ids.length);
  });
  document.getElementById('delete-selected')?.addEventListener('click', () => {
    const rows = [...document.querySelectorAll<HTMLElement>('#note-list li[data-note]')].filter((li) => picked.has(li.dataset.note!));
    void deleteNotes(
      rows.map((li) => li.dataset.note!),
      rows.map((li) => li.querySelector('a')?.textContent ?? ''),
    );
  });
  const allSites = document.getElementById('all-sites') as HTMLInputElement;
  allSites.addEventListener('change', () => void toggleAllSites(allSites));
  await Promise.all([renderShortcuts(), renderData(), renderSites(), renderAllSites(), setUpQa(), setUpNotionOAuth()]);
}

void main();
