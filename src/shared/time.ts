/** Formats a position in seconds as `MM:SS` (or `H:MM:SS` past one hour). */
export function formatTimecode(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * Parses `MM:SS` / `H:MM:SS` back into seconds. Minutes may exceed 59 when
 * there is no hour part (`75:00` is accepted), seconds may not.
 */
export function parseTimecode(label: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (seconds >= 60) return null;
  if (m[1] !== undefined && minutes >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parses the value of a `t=` URL parameter / media fragment:
 * `255`, `255s`, `4m15s`, `1h2m3s`, `04:15`, `255.5`.
 */
export function parseTimeParam(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  if (/^\d+(?:\.\d+)?s?$/.test(v)) return Math.floor(Number.parseFloat(v));
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0);
  }
  return parseTimecode(v);
}
