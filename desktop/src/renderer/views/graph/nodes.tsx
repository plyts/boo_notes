import { BaseEdge, Handle, Position, getBezierPath, useInternalNode, type Edge, type EdgeProps, type InternalNode, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { courseColor, KIND_COLOR, KIND_ICON } from '../../lib/kinds';
import { Icon } from '../../ui';
import type { EdgeKind, GNode, Layout } from './model';
import { dotRadius } from './simulation';

/** Emphasis of a node or link: dimmed outside the focus / search, highlighted inside. */
export type Emphasis = 'normal' | 'dim' | 'focus' | 'match';

export interface BrainNodeData extends Record<string, unknown> {
  g: GNode;
  layout: Layout;
  emphasis: Emphasis;
  side: 'left' | 'right' | 'center';
  pinned: boolean;
  onToggle(id: string): void;
}

export type BrainNode = Node<BrainNodeData, 'brain'>;

export interface BrainEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  layout: Layout;
  emphasis: Emphasis;
  count: number;
  hue?: number;
  /** Depth of the child end (mind map branches get thinner). */
  depth: number;
  color?: string;
}

export type BrainEdge = Edge<BrainEdgeData, 'brain'>;

/** Handles are required by React Flow; links are drawn centre to centre, so they stay invisible. */
function Anchors() {
  return (
    <>
      <Handle type="target" position={Position.Top} className="gn-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="gn-handle" isConnectable={false} />
    </>
  );
}

function Toggle({ g, onToggle, side }: { g: GNode; onToggle(id: string): void; side: string }) {
  if (!g.collapsible) return null;
  return (
    <button
      type="button"
      className={`gn-toggle nodrag nopan gn-toggle-${side}`}
      aria-label={g.collapsed ? `Déplier ${g.label}` : `Replier ${g.label}`}
      aria-expanded={!g.collapsed}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(g.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {g.collapsed ? `+${g.folded}` : <Icon name="minus" size={10} />}
    </button>
  );
}

export const BrainNodeView = memo(function BrainNodeView({ data }: NodeProps<BrainNode>) {
  const { g, layout, emphasis, side, pinned, onToggle } = data;
  const hue = g.hue !== undefined ? courseColor(g.hue) : undefined;
  const kindColor = g.media ? KIND_COLOR[g.media] : undefined;
  const cls = `gn gn-${g.kind} gn-${layout} is-${emphasis}${g.due ? ' is-due' : ''}${g.outside ? ' is-outside' : ''}${g.collapsed ? ' is-collapsed' : ''}`;
  const style = { ['--hue' as string]: hue, ['--kind' as string]: kindColor } as React.CSSProperties;

  if (g.kind === 'root') {
    return (
      <div className={cls} style={style}>
        <Anchors />
        <span className="gn-root-icon">
          <Icon name="ghost" size={22} />
        </span>
        <span className="gn-title">{g.label}</span>
      </div>
    );
  }

  if (g.kind === 'course' || g.kind === 'chapter' || g.kind === 'bucket') {
    return (
      <div className={cls} style={style}>
        <Anchors />
        {g.kind === 'course' ? <span className="gn-emoji">{g.emoji}</span> : null}
        {g.kind === 'chapter' ? <span className="gn-index">{g.index}</span> : null}
        {g.kind === 'bucket' ? <Icon name={g.ref === 'library' ? 'library' : g.ref === 'outside' ? 'link' : 'inbox'} size={14} /> : null}
        <span className="gn-title">{g.label}</span>
        {g.kind === 'course' && g.ratio !== undefined && g.ratio > 0 ? (
          <span className="gn-progress" style={{ ['--p' as string]: `${Math.round(g.ratio * 100)}%` }} aria-hidden="true" />
        ) : null}
        {pinned ? <span className="gn-pin" title="Épinglé" /> : null}
        <Toggle g={g} onToggle={onToggle} side={side} />
      </div>
    );
  }

  // Notes and resources: dots in the network, capsules in the mind map.
  if (layout === 'network') {
    const size = g.kind === 'note' ? Math.round(dotRadius(g) * 1.6) : 26;
    return (
      <div className={cls} style={style}>
        <Anchors />
        <span className="gn-dot" style={{ width: size, height: size }}>
          <Icon name={g.kind === 'note' && g.media === 'note' ? 'cards' : KIND_ICON[g.media ?? 'note']} size={Math.max(10, Math.round(size * 0.5))} />
          {g.kind === 'note' && g.ratio !== undefined && g.ratio > 0 && g.ratio < 1 ? (
            <svg className="gn-arc" viewBox="0 0 36 36" aria-hidden="true">
              <circle cx="18" cy="18" r="16" pathLength="100" strokeDasharray={`${Math.round(g.ratio * 100)} 100`} />
            </svg>
          ) : null}
        </span>
        <span className="gn-label">{g.label}</span>
        {pinned ? <span className="gn-pin" title="Épinglé" /> : null}
      </div>
    );
  }
  return (
    <div className={cls} style={style}>
      <Anchors />
      <span className="gn-chip">
        <Icon name={g.kind === 'note' && g.media === 'note' ? 'cards' : KIND_ICON[g.media ?? 'note']} size={12} />
      </span>
      <span className="gn-title">{g.label}</span>
      {g.kind === 'note' ? <Toggle g={g} onToggle={onToggle} side={side} /> : null}
    </div>
  );
});

function box(n: InternalNode) {
  const w = n.measured.width ?? 0;
  const h = n.measured.height ?? 0;
  return { x: n.internals.positionAbsolute.x + w / 2, y: n.internals.positionAbsolute.y + h / 2, w, h };
}

const BRANCH_WIDTH = [4, 4, 3, 2, 1.5, 1.2];

export const BrainEdgeView = memo(function BrainEdgeView({ id, source, target, data }: EdgeProps<BrainEdge>) {
  const s = useInternalNode<BrainNode>(source);
  const t = useInternalNode<BrainNode>(target);
  if (!s || !t || !data) return null;
  const a = box(s);
  const b = box(t);
  let path: string;
  if (data.layout === 'mindmap' && data.kind === 'tree') {
    // Branch leaving the parent by the side facing the child.
    const dir = b.x >= a.x ? 1 : -1;
    const sx = a.x + (dir * a.w) / 2;
    const tx = b.x - (dir * b.w) / 2;
    [path] = getBezierPath({
      sourceX: sx,
      sourceY: a.y,
      sourcePosition: dir > 0 ? Position.Right : Position.Left,
      targetX: tx,
      targetY: b.y,
      targetPosition: dir > 0 ? Position.Left : Position.Right,
      curvature: 0.5,
    });
  } else if (data.kind === 'ref' || data.layout === 'mindmap') {
    // Cross-references bow slightly, so they read apart from the structure.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const bend = data.layout === 'mindmap' ? 0.25 : 0.12;
    path = `M${a.x},${a.y} Q${(a.x + b.x) / 2 - dy * bend},${(a.y + b.y) / 2 + dx * bend} ${b.x},${b.y}`;
  } else path = `M${a.x},${a.y} L${b.x},${b.y}`;

  const width =
    data.layout === 'mindmap' && data.kind === 'tree'
      ? BRANCH_WIDTH[Math.min(data.depth, BRANCH_WIDTH.length - 1)]
      : data.kind === 'tree'
        ? 1.6
        : 1.2 + Math.min(4, Math.log2(data.count + 1) * 1.1);
  const stroke = data.color ?? (data.hue !== undefined ? courseColor(data.hue, 0.7) : undefined);
  return (
    <BaseEdge
      id={id}
      path={path}
      className={`ge ge-${data.kind} ge-${data.layout} is-${data.emphasis}`}
      style={{ strokeWidth: width, stroke }}
      interactionWidth={0}
    />
  );
});

export const nodeTypes = { brain: BrainNodeView };
export const edgeTypes = { brain: BrainEdgeView };
