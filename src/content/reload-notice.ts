/**
 * Boo Notes was updated or reloaded while this page was open, and could not
 * be restarted in it (a site activated for this tab only): this copy of the
 * script is cut off from the extension. Rather than failing silently
 * (« Extension context invalidated »), a small card asks to reload the page.
 * Self-contained: no extension API is reachable anymore.
 */
const ID = 'boo-notes-reload-notice';

export function showReloadNotice(): void {
  if (document.getElementById(ID)) return;
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .card { display: flex; align-items: center; gap: 12px; max-width: 360px; padding: 12px 12px 12px 16px;
        border-radius: 14px; background: rgba(28, 28, 32, 0.94); color: #fff; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif; backdrop-filter: blur(12px); }
      p { margin: 0; flex: 1; }
      b { display: block; font-weight: 600; }
      button { border: 0; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer; }
      .reload { padding: 7px 12px; background: #7c6cff; color: #fff; }
      .reload:hover { background: #6a59ff; }
      .close { width: 26px; height: 26px; background: transparent; color: rgba(255, 255, 255, 0.7); font-size: 16px; line-height: 1; }
      .close:hover { color: #fff; }
      button:focus-visible { outline: 2px solid #b3aaff; outline-offset: 2px; }
    </style>
    <div class="card" role="alert">
      <p><b>Boo Notes a été mis à jour</b>Rechargez la page pour continuer vos notes (elles sont enregistrées).</p>
      <button type="button" class="reload">Recharger</button>
      <button type="button" class="close" aria-label="Fermer">✕</button>
    </div>`;
  root.querySelector('.reload')?.addEventListener('click', () => location.reload());
  root.querySelector('.close')?.addEventListener('click', () => host.remove());
  document.documentElement.append(host);
}
