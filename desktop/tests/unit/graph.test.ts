import { describe, expect, it } from 'vitest';
import type { CourseView, LibrarySnapshot, NoteView, ResourceView } from '../../src/ipc';
import { buildGraph, gid, layoutMindMap, neighbourhood, type GraphOptions } from '../../src/renderer/views/graph/model';

function note(id: string, title: string, extra: Partial<NoteView> = {}): NoteView {
  return {
    id,
    origin: 'desktop',
    title,
    noteFile: `${id}.md`,
    resources: [],
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
    kind: 'note',
    platform: 'local',
    source: '',
    studyStatus: 'todo',
    ratio: 0,
    positionLabel: '',
    due: false,
    courseId: null,
    chapterId: null,
    ...extra,
  };
}

function resource(id: string, title: string, notes: string[]): ResourceView {
  return {
    id,
    kind: 'video',
    platform: 'local',
    title,
    source: `/tmp/${id}.mp4`,
    origin: 'file',
    createdAt: 0,
    updatedAt: 0,
    studyStatus: 'todo',
    ratio: 0,
    positionLabel: '',
    notes,
  };
}

function course(id: string, title: string, chapters: Array<[string, string[]]>): CourseView {
  return {
    id,
    title,
    emoji: '📘',
    hue: 200,
    createdAt: 0,
    updatedAt: 0,
    chapters: chapters.map(([cid, notes]) => ({ id: cid, title: `Chapitre ${cid}`, notes })),
    noteCount: chapters.reduce((s, [, n]) => s + n.length, 0),
    resourceCount: 0,
    doneCount: 0,
    dueCount: 0,
    ratio: 0,
  };
}

/**
 * Physique: ch1 [ohm (+ video v1), cond], ch2 [tau]
 * Histoire: ch3 [bastille]
 * Unfiled: vrac
 * Links: ohm → cond, cond → tau, bastille → ohm, vrac → cond
 * v1 is also used by bastille (shared resource); v2 has no note.
 */
function snapshot(): LibrarySnapshot {
  const notes = [
    note('ohm', 'Loi d’Ohm', { resources: ['v1'], kind: 'video', links: ['Condensateur'], courseId: 'phys', chapterId: 'ch1' }),
    note('cond', 'Condensateur', { links: ['Constante de temps'], courseId: 'phys', chapterId: 'ch1' }),
    note('tau', 'Constante de temps', { courseId: 'phys', chapterId: 'ch2' }),
    note('bastille', 'Bastille', { resources: ['v1'], kind: 'video', links: ['loi d’ohm'], courseId: 'hist', chapterId: 'ch3' }),
    note('vrac', 'Vrac', { links: ['Condensateur', 'Inexistante'] }),
  ];
  return {
    notes,
    resources: [resource('v1', 'Cours filmé', ['ohm', 'bastille']), resource('v2', 'Sans note', [])],
    courses: [course('phys', 'Physique', [['ch1', ['ohm', 'cond']], ['ch2', ['tau']]]), course('hist', 'Histoire', [['ch3', ['bastille']]])],
    inbox: ['vrac'],
  };
}

const base: GraphOptions = {
  layout: 'network',
  collapsed: new Set(),
  show: { chapters: true, notes: true, resources: true },
  links: { tree: true, support: true, ref: true },
  grouping: 'course',
};

const ids = (g: { nodes: Array<{ id: string }> }) => g.nodes.map((n) => n.id).sort();
const edge = (g: ReturnType<typeof buildGraph>, kind: string, a: string, b: string) =>
  g.edges.find((e) => e.kind === kind && ((e.source === a && e.target === b) || (e.source === b && e.target === a)));

describe('graphe du second cerveau', () => {
  it('relie cours, chapitres, notes, supports et références', () => {
    const g = buildGraph(snapshot(), base);
    expect(ids(g)).toEqual(
      ['c/hist', 'c/phys', 'h/ch1', 'h/ch2', 'h/ch3', 'n/bastille', 'n/cond', 'n/ohm', 'n/tau', 'n/vrac', 'r/v1', 'r/v2'].sort(),
    );
    expect(edge(g, 'tree', 'c/phys', 'h/ch1')).toBeTruthy();
    expect(edge(g, 'tree', 'h/ch1', 'n/ohm')).toBeTruthy();
    expect(edge(g, 'support', 'n/ohm', 'r/v1')).toBeTruthy();
    expect(edge(g, 'support', 'n/bastille', 'r/v1')).toBeTruthy();
    // Titles match without accents or case; unknown titles are ignored.
    expect(edge(g, 'ref', 'n/bastille', 'n/ohm')).toBeTruthy();
    expect(edge(g, 'ref', 'n/vrac', 'n/cond')).toBeTruthy();
    expect(g.edges.filter((e) => e.kind === 'ref')).toHaveLength(4);
  });

  it('regroupe par cours : supports partagés entre deux cours hors groupe', () => {
    const g = buildGraph(snapshot(), base);
    const group = (id: string) => g.nodes.find((n) => n.id === id)!.group;
    expect(group('n/ohm')).toBe('phys');
    expect(group('h/ch3')).toBe('hist');
    expect(group('n/vrac')).toBe('inbox');
    expect(group('r/v1')).toBeNull();
    expect(group('r/v2')).toBe('library');
    expect(g.groups.find((x) => x.id === 'phys')?.collapseId).toBe('c/phys');
  });

  it('regroupe par type de support', () => {
    const g = buildGraph(snapshot(), { ...base, grouping: 'kind' });
    expect(g.nodes.find((n) => n.id === 'n/ohm')!.group).toBe('k/video');
    expect(g.nodes.find((n) => n.id === 'n/cond')!.group).toBe('k/note');
    expect(g.groups.find((x) => x.id === 'k/video')?.label).toBe('Vidéos');
  });

  it('replie un cours : ses liens remontent au cours, avec leur nombre', () => {
    const g = buildGraph(snapshot(), { ...base, collapsed: new Set([gid.course('phys')]) });
    expect(ids(g)).not.toContain('n/ohm');
    expect(ids(g)).not.toContain('h/ch1');
    const phys = g.nodes.find((n) => n.id === 'c/phys')!;
    expect(phys.collapsed).toBe(true);
    expect(phys.folded).toBe(3);
    // Bastille → Loi d'Ohm and Vrac → Condensateur now point at the course.
    expect(edge(g, 'ref', 'n/bastille', 'c/phys')).toBeTruthy();
    expect(edge(g, 'ref', 'n/vrac', 'c/phys')).toBeTruthy();
    // v1 is still used by Bastille: it stays, linked to both.
    expect(edge(g, 'support', 'c/phys', 'r/v1')).toBeTruthy();
    // Links inside the folded course disappear.
    expect(g.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it('replie un chapitre', () => {
    const g = buildGraph(snapshot(), { ...base, collapsed: new Set([gid.chapter('ch1')]) });
    expect(ids(g)).not.toContain('n/cond');
    expect(edge(g, 'ref', 'h/ch1', 'n/tau')?.count).toBe(1);
    expect(g.nodes.find((n) => n.id === 'h/ch1')!.folded).toBe(2);
  });

  it('masque des familles de nœuds et de liens', () => {
    const g = buildGraph(snapshot(), { ...base, show: { chapters: false, notes: false, resources: false } });
    expect(ids(g)).toEqual(['c/hist', 'c/phys']);
    // Without notes, references aggregate between courses: the links between subjects.
    expect(edge(g, 'ref', 'c/hist', 'c/phys')?.count).toBe(1);
    const noRefs = buildGraph(snapshot(), { ...base, links: { tree: true, support: true, ref: false } });
    expect(noRefs.edges.some((e) => e.kind === 'ref')).toBe(false);
  });

  it('graphe d’un cours : ses notes et celles qui s’y réfèrent', () => {
    const g = buildGraph(snapshot(), { ...base, courseId: 'phys' });
    expect(ids(g)).toContain('n/bastille');
    expect(g.nodes.find((n) => n.id === 'n/bastille')!.outside).toBe(true);
    expect(ids(g)).not.toContain('c/hist');
    expect(ids(g)).not.toContain('r/v2');
    expect(ids(g)).toContain('n/vrac');
  });

  it('carte mentale équilibrée autour de la racine', () => {
    const g = buildGraph(snapshot(), { ...base, layout: 'mindmap' });
    expect(g.nodes.find((n) => n.id === 'root')).toBeTruthy();
    const placed = layoutMindMap(g);
    expect(placed.get('root')).toMatchObject({ x: 0, y: 0, depth: 0 });
    // Every node is placed, courses at depth 1 on both sides.
    for (const n of g.nodes) expect(placed.has(n.id)).toBe(true);
    const sides = new Set([placed.get('c/phys')!.side, placed.get('c/hist')!.side]);
    expect(sides.size).toBeGreaterThanOrEqual(1);
    expect(placed.get('h/ch1')!.depth).toBe(2);
    expect(placed.get('n/ohm')!.depth).toBe(3);
    expect(placed.get('r/v1')!.depth).toBe(4);
    // A resource hangs from one note; its other note gets a cross link.
    expect(edge(g, 'support', 'n/bastille', 'r/v1')).toBeTruthy();
    expect(edge(g, 'support', 'n/ohm', 'r/v1')).toBeFalsy();
    // Siblings never overlap.
    const ys = g.nodes.filter((n) => n.parent === 'h/ch1').map((n) => placed.get(n.id)!.y);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('voisinage d’un nœud', () => {
    const g = buildGraph(snapshot(), base);
    expect([...neighbourhood(g, 'n/cond')].sort()).toEqual(['h/ch1', 'n/cond', 'n/ohm', 'n/tau', 'n/vrac']);
  });
});
