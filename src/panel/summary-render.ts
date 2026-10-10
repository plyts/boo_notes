import { h, icon, type IconName } from '../shared/icons';
import type { Cited, CourseSummary, LessonSummary, PlanNode } from '../shared/summary';
import { formatTimecode } from '../shared/time';

/**
 * The pieces of a summary as the panel and the course page show them: the
 * Problem · Goals · Solution cards, and the plan as a tree whose parts fold,
 * each line with its moment (a click: the video there). The part being
 * watched is lit while the video plays.
 */

export interface RenderHooks {
  /** A moment clicked: the video there (null: no video here). */
  seek?: ((seconds: number) => void) | null;
}

export function timeChip(seconds: number, hooks: RenderHooks, label = `Aller à ${formatTimecode(seconds)}`): HTMLElement {
  const text = formatTimecode(seconds);
  if (!hooks.seek) return h('span', { class: 'sum-ts' }, text);
  const b = h('button', { type: 'button', class: 'sum-ts', title: label, 'aria-label': label }, text);
  b.addEventListener('click', () => hooks.seek?.(seconds));
  return b;
}

type Kind = 'problem' | 'goals' | 'solution' | 'plan';

const HEADS: Record<Kind, { label: string; icon: IconName }> = {
  problem: { label: 'Problématique', icon: 'target' },
  goals: { label: 'Objectifs', icon: 'flag' },
  solution: { label: 'Solution', icon: 'bulb' },
  plan: { label: 'Plan du cours', icon: 'outline' },
};

export function card(kind: Kind, body: Node[], opts: { label?: string; extra?: Node | null } = {}): HTMLElement {
  const head = HEADS[kind];
  return h(
    'section',
    { class: `sum-card sum-${kind}`, 'aria-label': opts.label ?? head.label },
    h('h3', { class: 'sum-head' }, h('span', { class: 'sum-ico' }, icon(head.icon, 15)), h('span', {}, opts.label ?? head.label), opts.extra ?? null),
    ...body,
  );
}

function sources(at: readonly number[], hooks: RenderHooks): HTMLElement | null {
  if (!at.length) return null;
  return h('p', { class: 'sum-src' }, h('span', {}, 'Source'), ...at.map((s) => timeChip(s, hooks)));
}

function citedText(c: Cited, hooks: RenderHooks): Node[] {
  return [h('p', { class: 'sum-text' }, c.text), sources(c.at, hooks)].filter((x): x is HTMLElement => x !== null);
}

/** Problem · Goals · Solution of a lesson. */
export function lessonCards(s: Pick<LessonSummary, 'problem' | 'goals' | 'solution'>, hooks: RenderHooks): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (s.problem.text) out.push(card('problem', citedText(s.problem, hooks)));
  if (s.goals.length) {
    out.push(
      card('goals', [
        h(
          'ul',
          { class: 'sum-goals' },
          ...s.goals.map((g) => h('li', {}, h('span', { class: 'sum-check' }, icon('check', 14)), h('span', {}, g.text), g.at.length ? timeChip(g.at[0], hooks) : h('span', {}))),
        ),
      ]),
    );
  }
  if (s.solution.text) out.push(card('solution', citedText(s.solution, hooks)));
  return out;
}

/** Problem · Goals · Solution of a course (goals with their chapter). */
export function courseCards(s: CourseSummary): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (s.problem) out.push(card('problem', [h('p', { class: 'sum-text' }, s.problem)], { label: 'Problématique du cours' }));
  if (s.goals.length) {
    out.push(
      card(
        'goals',
        [
          h(
            'ul',
            { class: 'sum-goals' },
            ...s.goals.map((g) => h('li', {}, h('span', { class: 'sum-check' }, icon('check', 14)), h('span', {}, g.text), g.chapter ? h('span', { class: 'sum-chap' }, `ch. ${g.chapter}`) : h('span', {}))),
          ),
        ],
        { label: 'Objectifs du cours' },
      ),
    );
  }
  if (s.solution) out.push(card('solution', [h('p', { class: 'sum-text' }, s.solution)], { label: 'Solution — la démarche' }));
  return out;
}

const numberOf = (path: readonly number[]) => (path.length === 3 ? String.fromCharCode(97 + path[2]) : path.map((n) => n + 1).join('.'));

/** The plan, a tree: parts › points › details; a part folds; each line with its moment. */
export function planTree(nodes: readonly PlanNode[], hooks: RenderHooks): HTMLElement {
  const list = (items: readonly PlanNode[], path: number[]): HTMLElement =>
    h(
      'ul',
      { class: 'sum-tree', role: path.length ? 'group' : 'tree' },
      ...items.map((n, i) => {
        const here = [...path, i];
        const kids = n.children.length ? list(n.children, here) : null;
        const toggle = kids ? h('button', { type: 'button', class: 'sum-fold', 'aria-expanded': 'true', 'aria-label': `Replier « ${n.title} »` }, icon('chevronDown', 14)) : h('span', { class: 'sum-fold' });
        toggle.addEventListener('click', () => {
          const open = toggle.getAttribute('aria-expanded') !== 'true';
          toggle.setAttribute('aria-expanded', String(open));
          toggle.setAttribute('aria-label', `${open ? 'Replier' : 'Déplier'} « ${n.title} »`);
          if (kids) kids.hidden = !open;
        });
        const row = h(
          'div',
          { class: 'sum-node', ...(n.at !== null ? { 'data-at': String(n.at) } : {}) },
          toggle,
          h('span', { class: 'sum-num' }, numberOf(here)),
          h('span', { class: 'sum-title' }, n.title),
          n.at !== null ? timeChip(n.at, hooks, `Aller à « ${n.title} » (${formatTimecode(n.at)})`) : h('span', {}),
        );
        return h('li', { class: `sum-lvl${here.length}`, role: 'treeitem' }, row, kids);
      }),
    );
  return list(nodes, []);
}

/** Counts of a plan: its parts and every point under them. */
export function planCounts(nodes: readonly PlanNode[]): { parts: number; points: number } {
  const all = (ns: readonly PlanNode[]): number => ns.reduce((n, x) => n + 1 + all(x.children), 0);
  return { parts: nodes.length, points: all(nodes) - nodes.length };
}

/** Lights the line of the plan being watched (the last one begun), « en cours ». */
export function markCurrent(tree: HTMLElement, now: number | null): void {
  const rows = [...tree.querySelectorAll<HTMLElement>('.sum-node[data-at]')];
  let current: HTMLElement | null = null;
  if (now !== null) for (const r of rows) if (Number(r.dataset.at) <= now + 0.5 && (!current || Number(r.dataset.at) >= Number(current.dataset.at))) current = r;
  for (const r of rows) r.classList.toggle('now', r === current);
}
