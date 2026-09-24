import { bareUrl, probeFrame, probeMainWorld, type Diagnostic, type FrameProbe, type PageState } from '../shared/diagnostic';
import type { NotionStatus, SyncStatus, TabMessage } from '../shared/messages';

/**
 * « Diagnostic de cette page »: probes the tab — every frame the extension
 * may read, the page's script — and opens the report (diagnostic page).
 */

export const DIAGNOSTIC_KEY = 'diagnostic:last';
export const DIAGNOSTIC_MENU = 'boo-notes-diagnostic';

export interface DiagnosticDeps {
  /** Starts Boo Notes in the tab if it is not there (the user asked from its icon). */
  ensureContentScript(tabId: number): Promise<boolean>;
  syncStatus(): Promise<SyncStatus>;
  notionStatus(): Promise<NotionStatus>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runDiagnostic(tabId: number, deps: DiagnosticDeps): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  let injectError: string | null = null;
  if (!(await deps.ensureContentScript(tabId))) {
    // Why it could not: the same injection, its error kept.
    injectError = await chrome.scripting
      .executeScript({ target: { tabId }, func: () => true })
      .then(() => 'le script de la page n’a pas répondu')
      .catch(message);
  }
  const content = (await chrome.tabs.sendMessage(tabId, { type: 'diagnostic' } satisfies TabMessage, { frameId: 0 }).catch(() => null)) as PageState | null;

  const frames: FrameProbe[] = [];
  const isolated = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeFrame }).catch(() => []);
  const main = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeMainWorld, world: 'MAIN' }).catch(() => []);
  for (const r of isolated) {
    if (!r.result) continue;
    const extra = main.find((m) => m.frameId === r.frameId)?.result;
    frames.push({ frameId: r.frameId, ...(r.result as Omit<FrameProbe, 'frameId'>), ...(extra ?? {}) });
  }
  frames.sort((a, b) => Number(b.top) - Number(a.top) || a.frameId - b.frameId);

  const origin = (() => {
    try {
      return new URL(tab.url ?? '').origin;
    } catch {
      return null;
    }
  })();
  const has = (origins: string[]) => chrome.permissions.contains({ origins }).catch(() => false);
  const [site, all] = await Promise.all([origin && /^https?:/.test(origin) ? has([`${origin}/*`]) : false, has(['https://*/*'])]);
  const desktop = await deps.syncStatus().then((s) => `${s.state}${s.pending ? ` (${s.pending} en attente)` : ''}${s.error ? ` — ${s.error}` : ''}`, message);
  const notion = await deps.notionStatus().then(
    (s) => (s.configured ? `connecté${s.pending ? ` (${s.pending} en attente)` : ''}${s.lastError ? ` — erreur : ${s.lastError}` : ''}` : 'non connecté'),
    message,
  );

  const report: Diagnostic = {
    at: Date.now(),
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent.match(/(Chrome|Edg|OPR|Brave)\/[\d.]+/g)?.join(' ') ?? navigator.userAgent,
    tab: { url: bareUrl(tab.url ?? ''), title: (tab.title ?? '').slice(0, 120) },
    permissions: { site, all },
    content,
    injectError,
    frames,
    sync: { desktop, notion },
  };
  await chrome.storage.session.set({ [DIAGNOSTIC_KEY]: report });
  await chrome.tabs.create({ url: chrome.runtime.getURL('diagnostic/diagnostic.html'), index: tab.index + 1, openerTabId: tabId });
}
