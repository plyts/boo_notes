import { hierarchy, tree } from 'd3-hierarchy';
import type { MediaKind } from '../../../../../src/shared/platforms';
import type { LibrarySnapshot, NoteView } from '../../../ipc';
import { KIND_PLURALS } from '../../lib/kinds';

/**
 * The second brain as a graph: courses, chapters, notes and resources, joined
 * by the course structure, the notes' resources and the `[[liens]]` between
 * notes. Pure data — the view lays it out (forces or mind map) and draws it.
 *
 * Graph ids are prefixed by kind (`c/` course, `h/` chapter, `n/` note,
 * `r/` resource) so that library ids never collide.
 */

export type GKind = 'root' | 'course' | 'chapter' | 'note' | 'resource' | 'bucket';
export type EdgeKind = 'tree' | 'support' | 'ref';
export type Grouping = 'course' | 'kind' | 'none';
export type Layout = 'network' | 'mindmap';

export interface GNode {
  id: string;
  kind: GKind;
  /** Library id (course, chapter, note or resource). */
  ref: string;
  label: string;
  /** Media kind of a note (its main resource) or of a resource. */
  media?: MediaKind;
  /** Colour of the course it belongs to. */
  hue?: number;
  emoji?: string;
  courseId?: string;
  /** Chapter number. */
  index?: number;
  /** Children hidden in this node (collapsed course, chapter or note). */
  folded: number;
  collapsible: boolean;
  collapsed: boolean;
  /** Links drawn to it (sizes the dots of the network). */
  degree: number;
  /** Cluster of the network (grouping mode), null when floating between clusters. */
  group: string | null;
  /** Parent in the course tree (mind map), null for roots. */
  parent: string | null;
  due?: boolean;
  ratio?: number;
  /** Note of another course, shown because it is linked (course graph). */
  outside?: boolean;
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Links merged into this edge (collapsed groups). */
  count: number;
}

export interface GGroup {
  id: string;
  label: string;
  /** Course hue, or null (kind colour, neutral). */
  hue: number | null;
  media?: MediaKind;
  members: string[];
  /** Graph id of the node that folds the group (a course). */
  collapseId?: string;
}

export interface GraphOptions {
  layout: Layout;
  /** Only this course (and the notes linked to it). */
  courseId?: string;
  /** Graph ids of the collapsed courses, chapters and notes. */
  collapsed: ReadonlySet<string>;
  show: { chapters: boolean; notes: boolean; resources: boolean };
  links: { tree: boolean; support: boolean; ref: boolean };
  grouping: Grouping;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  groups: GGroup[];
}

export const ROOT_ID = 'root';
const INBOX = 'inbox';
const OUTSIDE = 'outside';
const LIBRARY = 'library';

export const GROUP_LABELS: Record<string, string> = {
  [INBOX]: 'Non classées',
  [OUTSIDE]: 'Autres cours',
  [LIBRARY]: 'Supports sans note',
};

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[[Titre]]` → note, preferring revision sheets on equal titles (like the app). */
function titleIndex(notes: NoteView[]): Map<string, NoteView> {
  const map = new Map<string, NoteView>();
  for (const n of notes) {
    const key = normalizeTitle(n.title);
    const prev = map.get(key);
    if (!prev || (prev.resources.length > 0 && n.resources.length === 0)) map.set(key, n);
  }
  return map;
}

export const gid = {
  course: (id: string) => `c/${id}`,
  chapter: (id: string) => `h/${id}`,
  note: (id: string) => `n/${id}`,
  resource: (id: string) => `r/${id}`,
};

export function buildGraph(snap: LibrarySnapshot, opts: GraphOptions): Graph {
  const mindmap = opts.layout === 'mindmap';
  const notes = new Map(snap.notes.map((n) => [n.id, n]));
  const byTitle = titleIndex(snap.notes);
  const courses = opts.courseId ? snap.courses.filter((c) => c.id === opts.courseId) : snap.courses;
  const courseOfNote = new Map<string, string>();
  for (const c of snap.courses) for (const ch of c.chapters) for (const id of ch.notes) courseOfNote.set(id, c.id);
  const targetsOf = (n: NoteView) =>
    (n.links ?? []).flatMap((t) => {
      const m = byTitle.get(normalizeTitle(t));
      return m && m.id !== n.id ? [m] : [];
    });

  // Notes of the graph: all of them, or those of the course plus their linked neighbours.
  const inScope = new Set<string>();
  const outside = new Set<string>();
  if (opts.courseId) {
    for (const c of courses) for (const ch of c.chapters) for (const id of ch.notes) if (notes.has(id)) inScope.add(id);
    for (const n of snap.notes) {
      const targets = targetsOf(n);
      if (inScope.has(n.id)) for (const m of targets) !inScope.has(m.id) && outside.add(m.id);
      else if (targets.some((m) => inScope.has(m.id))) outside.add(n.id);
    }
  } else for (const n of snap.notes) inScope.add(n.id);

  const nodes = new Map<string, GNode>();
  /** Library key (`n/…`, `r/…`) → visible graph node standing for it (itself or a collapsed container). */
  const rep = new Map<string, string | null>();
  /** Notes hidden inside a collapsed course / chapter. */
  const absorbed = new Set<string>();
  const add = (n: Omit<GNode, 'degree' | 'group' | 'folded' | 'collapsible' | 'collapsed'> & Partial<GNode>) => {
    const node: GNode = { degree: 0, group: null, folded: 0, collapsible: false, collapsed: false, ...n };
    nodes.set(node.id, node);
    return node;
  };
  const noteNode = (n: NoteView, parent: string | null, extra: Partial<GNode> = {}) => {
    const id = gid.note(n.id);
    const collapsed = opts.collapsed.has(id) && n.resources.length > 0;
    return add({
      id,
      kind: 'note',
      ref: n.id,
      label: n.title,
      media: n.kind,
      parent,
      due: n.due,
      ratio: n.ratio,
      collapsible: n.resources.length > 0,
      collapsed,
      folded: collapsed ? n.resources.length : 0,
      ...extra,
    });
  };

  if (mindmap && !opts.courseId) add({ id: ROOT_ID, kind: 'root', ref: '', label: 'Mon second cerveau', parent: null });

  for (const course of courses) {
    const cid = gid.course(course.id);
    const foldable = course.noteCount > 0 || (mindmap && opts.show.chapters && course.chapters.length > 0);
    const collapsed = foldable && opts.collapsed.has(cid);
    add({
      id: cid,
      kind: 'course',
      ref: course.id,
      label: course.title,
      emoji: course.emoji,
      hue: course.hue,
      courseId: course.id,
      parent: mindmap && !opts.courseId ? ROOT_ID : null,
      ratio: course.ratio,
      collapsible: foldable,
      collapsed,
      folded: collapsed ? course.noteCount || course.chapters.length : 0,
    });
    course.chapters.forEach((ch, i) => {
      const hid = gid.chapter(ch.id);
      const chVisible = !collapsed && opts.show.chapters;
      const chCollapsed = chVisible && opts.collapsed.has(hid) && ch.notes.length > 0;
      if (chVisible) {
        add({
          id: hid,
          kind: 'chapter',
          ref: ch.id,
          label: ch.title,
          index: i + 1,
          hue: course.hue,
          courseId: course.id,
          parent: cid,
          collapsible: ch.notes.length > 0,
          collapsed: chCollapsed,
          folded: chCollapsed ? ch.notes.length : 0,
        });
      }
      for (const id of ch.notes) {
        const n = notes.get(id);
        if (!n) continue;
        const key = gid.note(id);
        if (collapsed) {
          rep.set(key, cid);
          absorbed.add(id);
        } else if (chCollapsed) {
          rep.set(key, hid);
          absorbed.add(id);
        } else if (!opts.show.notes) {
          rep.set(key, chVisible ? hid : cid);
        } else {
          noteNode(n, chVisible ? hid : cid, { hue: course.hue, courseId: course.id });
          rep.set(key, key);
        }
      }
    });
  }

  // Unfiled notes, and notes of other courses linked from this one.
  const buckets: Array<[string, string[]]> = [
    [INBOX, snap.inbox.filter((id) => inScope.has(id) && !courseOfNote.has(id))],
    [OUTSIDE, [...outside]],
  ];
  for (const [bucket, ids] of buckets) {
    if (!ids.length || !opts.show.notes) continue;
    const bid = `b/${bucket}`;
    const parent = mindmap ? (opts.courseId ? gid.course(opts.courseId) : ROOT_ID) : null;
    const collapsed = mindmap && opts.collapsed.has(bid);
    if (mindmap) add({ id: bid, kind: 'bucket', ref: bucket, label: GROUP_LABELS[bucket], parent, collapsible: true, collapsed, folded: collapsed ? ids.length : 0 });
    for (const id of ids) {
      const n = notes.get(id)!;
      const key = gid.note(id);
      if (collapsed) {
        rep.set(key, bid);
        absorbed.add(id);
        continue;
      }
      const cid = courseOfNote.get(id);
      const c = cid ? snap.courses.find((x) => x.id === cid) : undefined;
      noteNode(n, mindmap ? bid : null, { outside: bucket === OUTSIDE, hue: c?.hue, courseId: c?.id });
      rep.set(key, key);
    }
  }

  // Resources: shown unless every note using them is folded away.
  const orphans: string[] = [];
  for (const r of snap.resources) {
    const noteIds = r.notes.filter((id) => inScope.has(id));
    if (opts.courseId && !noteIds.length) continue;
    if (!opts.show.resources) continue;
    const folded = noteIds.length > 0 && noteIds.every((id) => absorbed.has(id) || (rep.get(gid.note(id)) === gid.note(id) && nodes.get(gid.note(id))!.collapsed));
    if (folded) continue;
    const holders = noteIds.map((id) => rep.get(gid.note(id))).filter((k): k is string => Boolean(k && nodes.has(k)));
    if (!noteIds.length) orphans.push(r.id);
    const key = gid.resource(r.id);
    const parent = holders.find((k) => k.startsWith('n/')) ?? holders[0] ?? null;
    add({ id: key, kind: 'resource', ref: r.id, label: r.title, media: r.kind, ratio: r.ratio, parent });
    rep.set(key, key);
  }
  if (mindmap && orphans.length) {
    const bid = `b/${LIBRARY}`;
    const collapsed = opts.collapsed.has(bid);
    add({ id: bid, kind: 'bucket', ref: LIBRARY, label: GROUP_LABELS[LIBRARY], parent: ROOT_ID, collapsible: true, collapsed, folded: collapsed ? orphans.length : 0 });
    for (const id of orphans) {
      if (collapsed) nodes.delete(gid.resource(id));
      else nodes.get(gid.resource(id))!.parent = bid;
    }
  }
  // A course graph has no root: parentless resources hang from the course.
  if (mindmap && opts.courseId) {
    for (const n of nodes.values()) if (n.parent === null && n.kind === 'resource') n.parent = gid.course(opts.courseId);
  }

  // Edges.
  const edges = new Map<string, GEdge>();
  const link = (a: string | null | undefined, b: string | null | undefined, kind: EdgeKind) => {
    if (!a || !b || a === b || !nodes.has(a) || !nodes.has(b)) return;
    const key = `${kind}:${a < b ? `${a}|${b}` : `${b}|${a}`}`;
    const e = edges.get(key);
    if (e) e.count++;
    else edges.set(key, { id: key, source: a, target: b, kind, count: 1 });
  };
  // Structure: mind maps always draw their branches; the network only when asked.
  if (mindmap || opts.links.tree) for (const n of nodes.values()) if (n.parent && (mindmap || n.kind !== 'resource')) link(n.parent, n.id, 'tree');
  if (opts.links.support) {
    for (const n of snap.notes) {
      if (!inScope.has(n.id) && !outside.has(n.id)) continue;
      for (const r of n.resources) {
        const a = rep.get(gid.note(n.id));
        const b = rep.get(gid.resource(r));
        // In a mind map the first note already holds the resource as a branch.
        if (mindmap && nodes.get(b ?? '')?.parent === a) continue;
        link(a, b, 'support');
      }
    }
  }
  if (opts.links.ref) {
    for (const n of snap.notes) {
      if (!inScope.has(n.id) && !outside.has(n.id)) continue;
      for (const m of targetsOf(n)) link(rep.get(gid.note(n.id)), rep.get(gid.note(m.id)), 'ref');
    }
  }
  for (const e of edges.values()) {
    nodes.get(e.source)!.degree += e.count;
    nodes.get(e.target)!.degree += e.count;
  }

  // Clusters of the network.
  const groups = new Map<string, GGroup>();
  const join = (node: GNode, id: string | null) => {
    node.group = id;
    if (!id) return;
    let g = groups.get(id);
    if (!g) {
      const course = snap.courses.find((c) => c.id === id);
      g = course
        ? { id, label: `${course.emoji} ${course.title}`, hue: course.hue, members: [], collapseId: gid.course(course.id) }
        : id.startsWith('k/')
          ? { id, label: KIND_PLURALS[id.slice(2) as MediaKind], hue: null, media: id.slice(2) as MediaKind, members: [] }
          : { id, label: GROUP_LABELS[id] ?? id, hue: null, members: [] };
      groups.set(id, g);
    }
    g.members.push(node.id);
  };
  if (!mindmap && opts.grouping !== 'none') {
    for (const node of nodes.values()) {
      if (opts.grouping === 'kind') {
        join(node, node.media ? `k/${node.media}` : null);
        continue;
      }
      if (node.kind === 'course' || node.kind === 'chapter') join(node, node.courseId!);
      else if (node.kind === 'note') join(node, node.outside ? OUTSIDE : (courseOfNote.get(node.ref) ?? INBOX));
      else if (node.kind === 'resource') {
        const res = snap.resources.find((r) => r.id === node.ref)!;
        const owners = new Set(res.notes.filter((id) => rep.get(gid.note(id))).map((id) => courseOfNote.get(id) ?? (outside.has(id) ? OUTSIDE : INBOX)));
        join(node, owners.size === 1 ? [...owners][0] : owners.size === 0 ? LIBRARY : null);
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], groups: [...groups.values()] };
}

/** Graph ids of every node that can be collapsed (to fold / unfold everything). */
export function collapsibleIds(snap: LibrarySnapshot, level: 'course' | 'chapter'): string[] {
  return level === 'course'
    ? snap.courses.filter((c) => c.noteCount > 0).map((c) => gid.course(c.id))
    : snap.courses.flatMap((c) => c.chapters.filter((ch) => ch.notes.length).map((ch) => gid.chapter(ch.id)));
}

// --- Mind map layout ---------------------------------------------------------------------------

export interface Placed {
  x: number;
  y: number;
  depth: number;
  side: 'left' | 'right' | 'center';
}

/** Horizontal distance of each depth from the centre. */
const DEPTH_X = [0, 250, 480, 720, 940, 1140];
const ROW = 38;

interface TreeDatum {
  id: string;
  children?: TreeDatum[];
}

/**
 * Balanced mind map (as in XMind or MindNode): the root in the centre, its
 * branches shared between the right and the left so both sides weigh the same.
 */
export function layoutMindMap(graph: Graph): Map<string, Placed> {
  const kids = new Map<string, string[]>();
  const ids = new Set(graph.nodes.map((n) => n.id));
  const roots: string[] = [];
  for (const n of graph.nodes) {
    if (n.parent && ids.has(n.parent)) {
      const list = kids.get(n.parent);
      if (list) list.push(n.id);
      else kids.set(n.parent, [n.id]);
    } else roots.push(n.id);
  }
  const out = new Map<string, Placed>();
  if (!roots.length) return out;
  const [root, ...strays] = roots;
  // Nodes without a parent (should not happen) hang from the root.
  if (strays.length) kids.set(root, [...(kids.get(root) ?? []), ...strays]);

  const datum = (id: string): TreeDatum => {
    const c = kids.get(id);
    return c?.length ? { id, children: c.map(datum) } : { id };
  };
  const leaves = (d: TreeDatum): number => (d.children ? d.children.reduce((s, c) => s + leaves(c), 0) : 1);

  const top = (kids.get(root) ?? []).map(datum);
  const right: TreeDatum[] = [];
  const left: TreeDatum[] = [];
  let wr = 0;
  let wl = 0;
  for (const d of top) {
    const w = leaves(d);
    if (wr <= wl) {
      right.push(d);
      wr += w;
    } else {
      left.push(d);
      wl += w;
    }
  }
  out.set(root, { x: 0, y: 0, depth: 0, side: 'center' });
  const layoutSide = (children: TreeDatum[], side: 'left' | 'right') => {
    if (!children.length) return;
    const h = hierarchy<TreeDatum>({ id: root, children });
    tree<TreeDatum>()
      .nodeSize([ROW, 1])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.35) * (Math.min(a.depth, b.depth) <= 1 ? 1.7 : 1))(h);
    const sign = side === 'right' ? 1 : -1;
    for (const node of h.descendants()) {
      if (node.depth === 0) continue;
      const depthX = DEPTH_X[Math.min(node.depth, DEPTH_X.length - 1)] + Math.max(0, node.depth - DEPTH_X.length + 1) * 220;
      out.set(node.data.id, { x: sign * depthX, y: node.x ?? 0, depth: node.depth, side });
    }
  };
  layoutSide(right, 'right');
  layoutSide(left, 'left');
  return out;
}

/** Nodes within one link of `id` (the node included). */
export function neighbourhood(graph: Graph, id: string): Set<string> {
  const set = new Set([id]);
  for (const e of graph.edges) {
    if (e.source === id) set.add(e.target);
    else if (e.target === id) set.add(e.source);
  }
  return set;
}
