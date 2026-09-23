import { formatTimecode } from '../../../../src/shared/time';

export { formatTimecode };

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'à l’instant';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** « demain », « dans 3 jours », « le 12 oct. ». */
export function dueLabel(ts: number, now = Date.now()): string {
  const day = (t: number) => Math.floor((new Date(t).setHours(0, 0, 0, 0) as number) / 86_400_000);
  const d = day(ts) - day(now);
  if (d <= 0) return 'aujourd’hui';
  if (d === 1) return 'demain';
  if (d < 7) return `dans ${d} jours`;
  return `le ${new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n > 1 ? pluralWord : word}`;
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Errors crossing IPC are prefixed by Electron.
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
}
