import { findings, reportText, unreadFrames, type Diagnostic } from '../shared/diagnostic';
import { callBackground } from '../shared/messages';

/** The report of « Diagnostic de cette page » (made by the background, kept in session storage). */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const d = (await chrome.storage.session.get('diagnostic:last'))['diagnostic:last'] as Diagnostic | undefined;
  if (!d) {
    $('where').textContent = 'Aucun diagnostic : faites un clic droit sur l’icône Boo Notes, sur la page du cours, puis « Diagnostic de cette page ».';
    return;
  }
  $('title').textContent = d.tab.title || 'Page sans titre';
  $('where').textContent = `${d.tab.url} · ${new Date(d.at).toLocaleString('fr-FR')}`;
  const list = $('findings');
  for (const f of findings(d)) {
    const li = document.createElement('li');
    li.className = f.level;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-label', f.level === 'ok' ? 'OK' : f.level === 'warn' ? 'Attention' : 'Problème');
    mark.textContent = f.level === 'ok' ? '✓' : f.level === 'warn' ? '!' : '✗';
    const text = document.createElement('span');
    text.textContent = f.text;
    li.append(mark, text);
    list.append(li);
  }
  const text = reportText(d);
  $('report').textContent = text;
  const status = $('status');
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copié : collez-le dans votre message.';
    } catch {
      status.textContent = 'Copie refusée : sélectionnez le texte des détails.';
    }
  });
  // A frame of another site out of reach: one click allows Boo Notes everywhere.
  const allow = $<HTMLButtonElement>('allow-all');
  allow.hidden = d.permissions.all || !unreadFrames(d).length;
  allow.addEventListener('click', async () => {
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
    if (!granted) {
      status.textContent = 'Autorisation refusée.';
      return;
    }
    await callBackground({ type: 'sites:all', enabled: true }).catch(() => undefined);
    allow.hidden = true;
    status.textContent = 'Boo Notes est autorisé partout : rechargez la page du cours, puis relancez le diagnostic.';
  });
}

void main();
