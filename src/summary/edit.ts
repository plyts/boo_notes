import { h, icon, type IconName } from '../shared/icons';
import { POINT_LABELS, type PlanNode, type PointKind } from '../shared/summary';
import { formatTimecode, parseTimecode } from '../shared/time';

/**
 * « Modifier » on the large page: the summary's texts edited in place (a
 * click on a sentence), each point's kind chosen, points and parts added,
 * moved or removed, a moment typed. Everything works on a copy (the draft):
 * « Enregistrer » keeps it, « Annuler » drops it.
 */

/** A text edited in place (plain text: what is typed is what is kept). */
export function editText(value: string, onChange: (v: string) => void, opts: { label: string; placeholder?: string; cls?: string; multiline?: boolean } = { label: '' }): HTMLElement {
  const el = h('span', {
    class: `ed${opts.cls ? ` ${opts.cls}` : ''}`,
    contenteditable: 'plaintext-only',
    role: 'textbox',
    'aria-label': opts.label,
    'data-placeholder': opts.placeholder ?? '',
    spellcheck: 'true',
    ...(opts.multiline ? { 'aria-multiline': 'true' } : {}),
  });
  el.textContent = value;
  el.addEventListener('input', () => {
    const text = el.innerText ?? el.textContent ?? '';
    onChange(opts.multiline ? text.replace(/\n{3,}/g, '\n\n').trim() : text.replace(/\s*\n\s*/g, ' ').trim());
  });
  // One line: Enter leaves the field.
  if (!opts.multiline) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
    });
  }
  return el;
}

/** A moment typed (« 02:40 »; empty: none); a wrong one is said, the last good one kept. */
export function editTime(at: number | null, onChange: (v: number | null) => void, label: string): HTMLInputElement {
  const input = h('input', { type: 'text', class: 'ed-time', value: at === null ? '' : formatTimecode(at), placeholder: '--:--', 'aria-label': label, inputmode: 'numeric', size: '5' });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v) {
      input.classList.remove('bad');
      onChange(null);
      return;
    }
    const s = parseTimecode(v);
    input.classList.toggle('bad', s === null);
    if (s !== null) onChange(s);
  });
  return input;
}

export function smallButton(iconName: IconName, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `ed-btn${cls ? ` ${cls}` : ''}`, title: label, 'aria-label': label }, icon(iconName, 14));
  b.addEventListener('click', onClick);
  return b;
}

export function addButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'ed-add' }, icon('plus', 14), label);
  b.addEventListener('click', onClick);
  return b;
}

const KINDS: Array<{ kind: PointKind; label: string }> = [
  { kind: 'key', label: `★ ${POINT_LABELS.key.label}` },
  { kind: 'definition', label: POINT_LABELS.definition.label },
  { kind: 'example', label: POINT_LABELS.example.label },
  { kind: 'warning', label: POINT_LABELS.warning.label },
  { kind: 'point', label: 'Point' },
];

/** Moves item `i` of `list` by `by` (−1 up, +1 down). */
function move<T>(list: T[], i: number, by: number): void {
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

/**
 * The plan of a lesson, editable: each part (title, moment, sentence) and
 * its points (kind, title, explanation, command, moment). `onChange`: the
 * draft changed (a text typed, a point added…).
 */
export function planEditor(plan: PlanNode[], onChange: () => void): HTMLElement {
  const root = h('div', { class: 'ed-plan' });
  const redraw = () => {
    root.replaceChildren(...parts());
    onChange();
  };
  const parts = (): HTMLElement[] => {
    const out = plan.map((part, i) => {
      const points = h(
        'ul',
        { class: 'ed-points' },
        ...part.children.map((pt, j) => {
          const kind = pt.kind ?? 'point';
          const select = h('select', { class: 'ed-kind', 'aria-label': `Sorte du point « ${pt.title || 'nouveau'} »` }, ...KINDS.map((k) => h('option', { value: k.kind, ...(k.kind === kind ? { selected: true } : {}) }, k.label)));
          select.addEventListener('change', () => {
            const next = select.value as PointKind;
            // One essential point per part: the one chosen; the one before becomes a plain point.
            if (next === 'key') for (const other of part.children) if (other !== pt && other.kind === 'key') other.kind = 'point';
            pt.kind = next;
            redraw();
          });
          const code =
            kind === 'example' || pt.code
              ? editText(pt.code ?? '', (v) => {
                  if (v) pt.code = v;
                  else delete pt.code;
                  onChange();
                }, { label: 'Commande ou formule', placeholder: 'Commande ou formule (facultatif)', cls: 'ed-code' })
              : null;
          return h(
            'li',
            { class: `ed-pt k-${kind}` },
            h(
              'div',
              { class: 'ed-pt-head' },
              select,
              editText(pt.title, (v) => {
                pt.title = v;
                onChange();
              }, { label: 'Titre du point', placeholder: 'Titre du point', cls: 'ed-pt-title' }),
              editTime(pt.at, (v) => {
                pt.at = v;
                onChange();
              }, `Instant du point « ${pt.title || 'nouveau'} »`),
              smallButton('arrowUp', 'Monter le point', () => {
                move(part.children, j, -1);
                redraw();
              }),
              smallButton('arrowDown', 'Descendre le point', () => {
                move(part.children, j, 1);
                redraw();
              }),
              smallButton('trash', 'Supprimer le point', () => {
                part.children.splice(j, 1);
                redraw();
              }, 'danger'),
            ),
            editText(pt.detail ?? '', (v) => {
              pt.detail = v;
              onChange();
            }, { label: 'Explication du point', placeholder: 'Ce qu’il faut en savoir, en une ou deux phrases', cls: 'ed-detail', multiline: true }),
            code,
          );
        }),
      );
      return h(
        'section',
        { class: 'ed-part', 'aria-label': `Partie ${i + 1}` },
        h(
          'div',
          { class: 'ed-part-head' },
          h('span', { class: 'ed-num' }, String(i + 1)),
          editText(part.title, (v) => {
            part.title = v;
            onChange();
          }, { label: `Titre de la partie ${i + 1}`, placeholder: 'Titre de la partie', cls: 'ed-part-title' }),
          editTime(part.at, (v) => {
            part.at = v;
            onChange();
          }, `Instant de la partie ${i + 1}`),
          smallButton('arrowUp', 'Monter la partie', () => {
            move(plan, i, -1);
            redraw();
          }),
          smallButton('arrowDown', 'Descendre la partie', () => {
            move(plan, i, 1);
            redraw();
          }),
          smallButton('trash', 'Supprimer la partie', () => {
            plan.splice(i, 1);
            redraw();
          }, 'danger'),
        ),
        editText(part.intro ?? '', (v) => {
          if (v) part.intro = v;
          else delete part.intro;
          onChange();
        }, { label: `Phrase de la partie ${i + 1}`, placeholder: 'Ce que la partie apporte, en une phrase', cls: 'ed-intro' }),
        points,
        addButton('Ajouter un point', () => {
          part.children.push({ title: '', at: null, children: [], detail: '', kind: 'point' });
          redraw();
          root.querySelectorAll<HTMLElement>('.ed-part')[i]?.querySelectorAll<HTMLElement>('.ed-pt-title').item(part.children.length - 1)?.focus();
        }),
      );
    });
    out.push(
      addButton('Ajouter une partie', () => {
        plan.push({ title: '', at: null, intro: '', children: [] });
        redraw();
        root.querySelectorAll<HTMLElement>('.ed-part-title').item(plan.length - 1)?.focus();
      }),
    );
    return out;
  };
  root.replaceChildren(...parts());
  return root;
}

/**
 * The plan as it is kept: texts trimmed; a point with neither title nor
 * explanation, a part with neither title nor point, left out; parts in the
 * order chosen.
 */
export function cleanPlan(plan: readonly PlanNode[]): PlanNode[] {
  const out: PlanNode[] = [];
  for (const part of plan) {
    const children: PlanNode[] = [];
    for (const pt of part.children) {
      const title = pt.title.trim();
      const detail = pt.detail?.trim() ?? '';
      if (!title && !detail) continue;
      const node: PlanNode = { title: title || detail.split(/[.:;]/)[0].slice(0, 60), at: pt.at, children: pt.children };
      if (detail) node.detail = detail;
      if (pt.kind !== undefined || detail) node.kind = pt.kind ?? 'point';
      if (pt.code?.trim()) node.code = pt.code.trim().slice(0, 300);
      children.push(node);
    }
    const title = part.title.trim();
    if (!title && !children.length) continue;
    const node: PlanNode = { title: title || 'Partie', at: part.at, children };
    if (part.intro?.trim()) node.intro = part.intro.trim();
    out.push(node);
  }
  return out;
}
