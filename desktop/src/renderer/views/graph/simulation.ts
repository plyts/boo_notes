import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { packSiblings } from 'd3-hierarchy';
import type { EdgeKind, GGroup, GKind, GNode, Graph } from './model';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: GKind;
  group: string | null;
  r: number;
  /** Stays where the user dropped it. */
  pinned: boolean;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: EdgeKind;
}

export interface Point {
  x: number;
  y: number;
}

/** Radius of the dot drawn for a note (grows with its links). */
export function dotRadius(n: GNode): number {
  return 12 + Math.min(10, n.degree * 1.3);
}

/** Collision radius of a node of the network. */
export function radiusOf(n: GNode): number {
  switch (n.kind) {
    // Capsules are wide: their circle covers most of the label.
    case 'course':
      return Math.min(150, 50 + n.label.length * 3.4) + Math.min(24, n.folded * 1.2);
    case 'chapter':
      return Math.min(120, 34 + n.label.length * 3) + Math.min(16, n.folded * 1.5);
    case 'resource':
      return Math.max(18, Math.min(56, n.label.length * 2.2));
    case 'note':
      // The label hangs below the dot: keep neighbours' labels apart.
      return Math.max(dotRadius(n) + 4, Math.min(62, n.label.length * 2.5));
    default:
      return 40;
  }
}

const CHARGE: Record<GKind, number> = { root: -600, course: -520, chapter: -300, note: -160, resource: -100, bucket: -300 };
const DISTANCE: Record<EdgeKind, number> = { tree: 70, support: 52, ref: 130 };

/** Room taken by a cluster of `n` nodes. */
const clusterRadius = (n: number) => 120 + 70 * Math.sqrt(n);

/**
 * Centres of the clusters, packed like soap bubbles (the biggest in the
 * middle). Clusters the user moved keep their place.
 */
export function packGroups(groups: GGroup[], kept: Map<string, Point>): Map<string, Point> {
  const fresh = groups.filter((g) => !kept.has(g.id)).sort((a, b) => b.members.length - a.members.length);
  const circles = fresh.map((g) => ({ r: clusterRadius(g.members.length) + 40, x: 0, y: 0 }));
  packSiblings(circles);
  const out = new Map<string, Point>();
  // Fresh clusters go around the kept ones rather than on top of them.
  let dx = 0;
  if (kept.size && circles.length) {
    const keptRight = Math.max(...[...kept.values()].map((p) => p.x)) + 400;
    const freshLeft = Math.min(...circles.map((c) => c.x - c.r));
    dx = keptRight - freshLeft;
  }
  fresh.forEach((g, i) => out.set(g.id, { x: circles[i].x + dx, y: circles[i].y }));
  for (const g of groups) {
    const p = kept.get(g.id);
    if (p) out.set(g.id, p);
  }
  return out;
}

/**
 * Force layout of the network (d3-force): notes repel each other, links pull
 * them together, and each node is drawn towards the centre of its cluster.
 * Positions persist across rebuilds so the graph does not jump when the data
 * changes.
 */
export class NetworkLayout {
  readonly sim: Simulation<SimNode, SimLink>;
  private nodes = new Map<string, SimNode>();
  centers = new Map<string, Point>();
  private movedGroups = new Map<string, Point>();

  constructor(onTick: () => void) {
    this.sim = forceSimulation<SimNode, SimLink>()
      .alphaDecay(0.035)
      .velocityDecay(0.38)
      .force('charge', forceManyBody<SimNode>().strength((n) => CHARGE[n.kind]).distanceMax(700).theta(0.85))
      .force('collide', forceCollide<SimNode>((n) => n.r + 8).strength(0.9).iterations(2))
      .on('tick', onTick)
      .stop();
  }

  /** Loads a new graph, reusing the positions of the nodes it already knew. */
  update(graph: Graph, grouped: boolean, seed?: Map<string, Point>): void {
    const prev = this.nodes;
    this.nodes = new Map();
    this.centers = grouped ? packGroups(graph.groups, this.movedGroups) : new Map();
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const neighbours = new Map<string, string[]>();
    for (const e of graph.edges) {
      (neighbours.get(e.source) ?? neighbours.set(e.source, []).get(e.source)!).push(e.target);
      (neighbours.get(e.target) ?? neighbours.set(e.target, []).get(e.target)!).push(e.source);
    }
    let fresh = 0;
    for (const g of graph.nodes) {
      const old = prev.get(g.id);
      const node: SimNode = old
        ? Object.assign(old, { kind: g.kind, group: g.group, r: radiusOf(g) })
        : { id: g.id, kind: g.kind, group: g.group, r: radiusOf(g), pinned: false };
      const s = seed?.get(g.id);
      if (s) {
        node.x = s.x;
        node.y = s.y;
        if (node.pinned) {
          node.fx = s.x;
          node.fy = s.y;
        }
      } else if (!old) {
        fresh++;
        // New nodes appear next to a known neighbour, else in their cluster.
        const near = (neighbours.get(g.id) ?? []).map((id) => prev.get(id)).find(Boolean);
        const c = near ? { x: near.x ?? 0, y: near.y ?? 0 } : ((g.group ? this.centers.get(g.group) : undefined) ?? { x: 0, y: 0 });
        const a = Math.random() * Math.PI * 2;
        const d = near ? 40 : 30 + Math.random() * 120;
        node.x = c.x + Math.cos(a) * d;
        node.y = c.y + Math.sin(a) * d;
      }
      this.nodes.set(g.id, node);
    }
    const links: SimLink[] = graph.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

    this.grouped = grouped;
    this.sim
      .nodes([...this.nodes.values()])
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((n) => n.id)
          .distance((l) => DISTANCE[l.kind] + ((l.source as SimNode).r ?? 0) * 0.4 + ((l.target as SimNode).r ?? 0) * 0.4)
          .strength((l) => (l.kind === 'ref' ? (grouped ? 0.04 : 0.25) : l.kind === 'support' ? 0.45 : 0.7)),
      );
    this.pull();

    const first = prev.size === 0 && !seed?.size;
    // A first layout is mostly computed before being shown; later ones animate gently.
    this.sim.alpha(first ? 1 : fresh > 0 ? 0.5 : 0.25);
    if (first) for (let i = 0; i < 160; i++) this.sim.tick();
    this.sim.restart();
  }

  private grouped = false;

  /** (Re)creates the pull towards the cluster centres (forces cache their targets). */
  private pull(): void {
    const center = (n: SimNode) => (n.group ? this.centers.get(n.group) : undefined);
    const strength = (n: SimNode) => (center(n) ? 0.14 : this.grouped ? 0.012 : 0.035);
    this.sim.force('x', forceX<SimNode>((n) => center(n)?.x ?? 0).strength(strength));
    this.sim.force('y', forceY<SimNode>((n) => center(n)?.y ?? 0).strength(strength));
  }

  get(id: string): SimNode | undefined {
    return this.nodes.get(id);
  }

  positions(): Map<string, Point> {
    const out = new Map<string, Point>();
    for (const n of this.nodes.values()) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    return out;
  }

  // --- Dragging ----------------------------------------------------------------------------

  grab(id: string, p: Point): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.fx = p.x;
    n.fy = p.y;
    this.sim.alphaTarget(0.25).restart();
  }

  release(id: string, pin: boolean): void {
    const n = this.nodes.get(id);
    this.sim.alphaTarget(0);
    if (!n) return;
    n.pinned = pin;
    if (!pin) {
      n.fx = null;
      n.fy = null;
    }
  }

  setPinned(id: string, pinned: boolean): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.pinned = pinned;
    n.fx = pinned ? n.x : null;
    n.fy = pinned ? n.y : null;
    this.sim.alpha(0.2).restart();
  }

  unpinAll(): void {
    for (const n of this.nodes.values()) {
      n.pinned = false;
      n.fx = null;
      n.fy = null;
    }
    this.movedGroups.clear();
    this.pull();
  }

  /** Moves a whole cluster (dragged by its label) by `d`, from the positions it had at `start`. */
  moveGroup(group: string, start: Map<string, Point>, d: Point): void {
    for (const [id, p] of start) {
      const n = this.nodes.get(id);
      if (!n) continue;
      n.fx = p.x + d.x;
      n.fy = p.y + d.y;
    }
    const c = this.centers.get(group);
    if (c) {
      const moved = { x: (this.groupStart?.x ?? c.x) + d.x, y: (this.groupStart?.y ?? c.y) + d.y };
      this.centers.set(group, moved);
      this.movedGroups.set(group, moved);
    }
    this.sim.alphaTarget(0.2).restart();
  }

  private groupStart: Point | null = null;

  startGroup(group: string): Map<string, Point> {
    const c = this.centers.get(group);
    this.groupStart = c ? { ...c } : null;
    const start = new Map<string, Point>();
    for (const n of this.nodes.values()) if (n.group === group) start.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    return start;
  }

  endGroup(start: Map<string, Point>): void {
    for (const id of start.keys()) {
      const n = this.nodes.get(id);
      if (n && !n.pinned) {
        n.fx = null;
        n.fy = null;
      }
    }
    this.groupStart = null;
    this.pull();
    this.sim.alphaTarget(0).alpha(0.2).restart();
  }

  /** Restarts the forces from scratch (« Réorganiser »). */
  shuffle(): void {
    this.unpinAll();
    for (const n of this.nodes.values()) {
      n.x = (Math.random() - 0.5) * 400;
      n.y = (Math.random() - 0.5) * 400;
    }
    this.sim.alpha(1).restart();
  }

  stop(): void {
    this.sim.stop();
  }
}
