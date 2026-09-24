import type { ScormState } from './messages';

/**
 * Course modules (SCORM 1.2 / 2004, xAPI): what a module tells its LMS —
 * completion, progress, score, bookmark — seen by the main-world bridge
 * (media-bridge.ts) and turned into a state for the notes. Kept tiny: the
 * bridge runs at document_start in every frame.
 */

/** Main world → isolated world: `detail` is a JSON `ScormValue`. */
export const SCORM_EVENT = 'boo-notes:scorm';
/** Isolated world → main world: send the values seen so far again. */
export const SCORM_REQUEST_EVENT = 'boo-notes:scorm?';

export interface ScormValue {
  /** `1.2`, `2004` or `xapi`. */
  version: string;
  key: string;
  value: string;
}

/** The cmi.* values worth following (the others are the module's own data). */
export const SCORM_KEYS = /^cmi\.(?:core\.(?:lesson_status|lesson_location|score\.raw|score\.max)|completion_status|success_status|progress_measure|location|score\.(?:raw|scaled|max))$|^xapi\./;

export function emptyScorm(version: string): ScormState {
  return { version, status: '', progress: null, score: null, location: '' };
}

const num = (v: string): number | null => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
};

/** The state after a value reported by the module. */
export function applyScorm(prev: ScormState | null, v: ScormValue): ScormState {
  const s: ScormState & { success?: string; max?: number | null } = { ...(prev ?? emptyScorm(v.version)), version: prev?.version || v.version };
  const value = String(v.value ?? '').trim();
  switch (v.key) {
    case 'cmi.core.lesson_status':
    case 'cmi.completion_status':
    case 'xapi.status':
      // A pass or a fail says more than « completed ».
      if (!/^(passed|failed)$/.test(s.status) || /^(passed|failed)$/.test(value)) s.status = value;
      break;
    case 'cmi.success_status':
      if (value === 'passed' || value === 'failed') s.status = value;
      break;
    case 'cmi.progress_measure':
    case 'xapi.progress': {
      const n = num(value);
      if (n !== null) s.progress = Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
      break;
    }
    case 'cmi.core.score.raw':
    case 'cmi.score.raw':
    case 'xapi.score': {
      const n = num(value);
      if (n !== null) s.score = Math.round(n * 10) / 10;
      break;
    }
    case 'cmi.score.scaled': {
      const n = num(value);
      if (n !== null && s.score === null) s.score = Math.round(n * 1000) / 10;
      break;
    }
    case 'cmi.core.lesson_location':
    case 'cmi.location':
      s.location = value.slice(0, 200);
      break;
  }
  return { version: s.version, status: s.status, progress: s.progress, score: s.score, location: s.location };
}

/** Finished, for course tracking. */
export function scormDone(s: ScormState): boolean {
  return /^(completed|passed)$/.test(s.status);
}

/** « Terminé · 80 % · score 85 », for people. */
export function scormLabel(s: ScormState): string {
  const status: Record<string, string> = {
    completed: 'Terminé',
    passed: 'Réussi',
    failed: 'Échoué',
    incomplete: 'En cours',
    browsed: 'Parcouru',
    'not attempted': 'Pas commencé',
    not_attempted: 'Pas commencé',
    unknown: '',
  };
  const parts = [
    status[s.status] ?? s.status,
    s.progress !== null && !scormDone(s) ? `${Math.round(s.progress * 100)} %` : '',
    s.score !== null ? `score ${s.score}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * xAPI statements a module posts (`/statements`): its verb (completed,
 * passed, failed, progressed) and result as values.
 */
export function xapiValues(body: unknown): ScormValue[] {
  const list = Array.isArray(body) ? body : [body];
  const out: ScormValue[] = [];
  for (const st of list.slice(0, 50) as Array<{ verb?: { id?: string }; result?: Record<string, unknown> }>) {
    const verb = /\/(completed|passed|failed|progressed|terminated|initialized|experienced)$/.exec(st?.verb?.id ?? '')?.[1];
    if (!verb) continue;
    if (verb === 'completed' || verb === 'passed' || verb === 'failed') out.push({ version: 'xapi', key: 'xapi.status', value: verb });
    const r = st.result ?? {};
    const score = (r.score as { scaled?: number; raw?: number } | undefined) ?? {};
    if (typeof score.raw === 'number') out.push({ version: 'xapi', key: 'xapi.score', value: String(score.raw) });
    else if (typeof score.scaled === 'number') out.push({ version: 'xapi', key: 'xapi.score', value: String(score.scaled * 100) });
    const ext = (r.extensions as Record<string, unknown> | undefined) ?? {};
    const progress = Object.entries(ext).find(([k]) => /progress/i.test(k))?.[1];
    if (typeof progress === 'number') out.push({ version: 'xapi', key: 'xapi.progress', value: String(progress) });
  }
  return out;
}

/** A value received from the main world (any page script may send one): checked, or null. */
export function readScormValue(detail: unknown): ScormValue | null {
  if (typeof detail !== 'string' || detail.length > 4000) return null;
  try {
    const v = JSON.parse(detail) as Partial<ScormValue>;
    if (typeof v.key !== 'string' || !SCORM_KEYS.test(v.key)) return null;
    return { version: typeof v.version === 'string' ? v.version.slice(0, 8) : '', key: v.key, value: String(v.value ?? '').slice(0, 500) };
  } catch {
    return null;
  }
}
