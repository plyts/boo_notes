import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react';
import { animate, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button as AriaButton, Header, Menu, MenuItem, MenuSection, MenuTrigger, Popover, type Selection } from 'react-aria-components';
import { errorMessage, plural } from '../lib/format';
import { courseColor, KIND_COLOR, KIND_ICON, KIND_LABELS, KIND_PLURALS } from '../lib/kinds';
import { newCourse, newNote } from '../actions';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { useApp, useCourse } from '../store';
import { Button, Icon, IconButton, SearchField, Segmented, toast } from '../ui';
import {
  buildGraph,
  collapsibleIds,
  neighbourhood,
  layoutMindMap,
  type GEdge,
  type GNode,
  type Graph,
  type GraphOptions,
  type Grouping,
  type Layout,
  type Placed,
} from './graph/model';
import { edgeTypes, nodeTypes, type BrainEdge, type BrainNode, type Emphasis } from './graph/nodes';
import { NetworkLayout, type Point } from './graph/simulation';

const PREFS_KEY = 'boo:graph';

interface GraphPrefs {
  layout: Layout;
  grouping: Grouping;
  show: GraphOptions['show'];
  links: GraphOptions['links'];
  collapsed: string[];
}

const DEFAULT_PREFS: GraphPrefs = {
  layout: 'network',
  grouping: 'course',
  show: { chapters: true, notes: true, resources: true },
  links: { tree: true, support: true, ref: true },
  collapsed: [],
};

function loadPrefs(): GraphPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<GraphPrefs>;
    return { ...DEFAULT_PREFS, ...p, show: { ...DEFAULT_PREFS.show, ...p.show }, links: { ...DEFAULT_PREFS.links, ...p.links } };
  } catch {
    return DEFAULT_PREFS;
  }
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Same graph (ids, labels, links, folding) → same object, so data refreshes do not shake the layout. */
function signature(g: Graph): string {
  return JSON.stringify([
    g.nodes.map((n) => [n.id, n.label, n.group, n.parent, n.collapsed, n.folded, n.due, n.emoji, n.hue, n.media, Math.round((n.ratio ?? 0) * 20)]),
    g.edges.map((e) => [e.id, e.count]),
  ]);
}

const zoomBucket = (z: number) => (z < 0.45 ? 'far' : z < 0.9 ? 'mid' : 'near');

export function GraphView({ courseId }: { courseId?: string }) {
  return (
    <ReactFlowProvider>
      <GraphCanvas courseId={courseId} />
    </ReactFlowProvider>
  );
}

function GraphCanvas({ courseId }: { courseId?: string }) {
  const snap = useApp((s) => s.snap);
  const resources = useApp((s) => s.resources);
  const go = useApp((s) => s.go);
  const course = useCourse(courseId);
  const rf = useReactFlow<BrainNode, BrainEdge>();
  const reduced = useReducedMotion() ?? false;

  const [prefs, setPrefs] = useState<GraphPrefs>(loadPrefs);
  const [layout, setLayout] = useState<Layout>(courseId ? 'mindmap' : prefs.layout);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(prefs.collapsed));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [zoom, setZoom] = useState<'far' | 'mid' | 'near'>('mid');
  const [nodes, setNodes] = useState<BrainNode[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, layout: courseId ? prefs.layout : layout, collapsed: [...collapsed] }));
    } catch {
      // Preferences last for the session.
    }
  }, [prefs, layout, collapsed, courseId]);

  // --- Data -------------------------------------------------------------------------------------

  const options = useMemo<GraphOptions>(
    () => ({ layout, courseId, collapsed, show: prefs.show, links: prefs.links, grouping: prefs.grouping }),
    [layout, courseId, collapsed, prefs.show, prefs.links, prefs.grouping],
  );
  const lastGraph = useRef<{ key: string; graph: Graph } | null>(null);
  const graph = useMemo(() => {
    const g = buildGraph(snap, options);
    const key = signature(g);
    if (lastGraph.current?.key === key) return lastGraph.current.graph;
    lastGraph.current = { key, graph: g };
    return g;
  }, [snap, options]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const placed = useMemo(() => (layout === 'mindmap' ? layoutMindMap(graph) : new Map<string, Placed>()), [graph, layout]);

  // --- Layout -----------------------------------------------------------------------------------

  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const net = useRef<NetworkLayout | null>(null);
  if (!net.current) {
    net.current = new NetworkLayout(() => {
      const sim = net.current!;
      setNodes((ns) =>
        ns.map((n) => {
          const p = sim.get(n.id);
          return p && (p.x !== n.position.x || p.y !== n.position.y) ? { ...n, position: { x: p.x ?? 0, y: p.y ?? 0 } } : n;
        }),
      );
    });
  }
  useEffect(() => () => net.current?.stop(), []);

  const fitKey = useRef('');
  /** Frames the whole graph, never below a readable zoom (the rest is a pan away). */
  const frame = useCallback(
    () => void rf.fitView({ padding: 0.12, minZoom: layoutRef.current === 'mindmap' ? 0.72 : 0.3, maxZoom: 1.25, duration: reduced ? 0 : 520 }),
    [rf, reduced],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const prevLayout = useRef<Layout | null>(null);
  useEffect(() => {
    const sim = net.current!;
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const switched = prevLayout.current !== null && prevLayout.current !== layout;
    prevLayout.current = layout;
    const make = (g: GNode, position: Point): BrainNode => ({
      id: g.id,
      type: 'brain',
      position,
      measured: prev.get(g.id)?.measured,
      ariaLabel: `${kindName(g)} : ${g.label}`,
      data: {
        g,
        layout,
        emphasis: 'normal',
        side: placed.get(g.id)?.side ?? 'center',
        pinned: layout === 'network' && Boolean(sim.get(g.id)?.pinned),
        onToggle: toggle,
      },
    });
    const key = `${layout}|${courseId ?? ''}`;
    const refit = fitKey.current !== key;
    fitKey.current = key;

    if (layout === 'network') {
      sim.update(graph, prefs.grouping !== 'none', switched ? new Map([...prev].map(([id, n]) => [id, n.position])) : undefined);
      if (reduced) {
        sim.stop();
        for (let i = 0; i < 240; i++) sim.sim.tick();
      }
      const pos = sim.positions();
      setNodes(graph.nodes.map((g) => make(g, pos.get(g.id) ?? { x: 0, y: 0 })));
      if (refit) {
        // Let the forces settle a little before framing.
        const t = setTimeout(frame, reduced ? 50 : 450);
        return () => clearTimeout(t);
      }
      return;
    }

    sim.stop();
    const target = (id: string) => placed.get(id) ?? { x: 0, y: 0 };
    const from = new Map<string, Point>();
    for (const g of graph.nodes) {
      const old = prev.get(g.id)?.position;
      // New branches grow out of their parent.
      const parent = g.parent ? (prev.get(g.parent)?.position ?? placed.get(g.parent)) : undefined;
      from.set(g.id, old ?? parent ?? target(g.id));
    }
    if (reduced) {
      setNodes(graph.nodes.map((g) => make(g, target(g.id))));
      if (refit) {
        const t = setTimeout(frame, 50);
        return () => clearTimeout(t);
      }
      return;
    }
    setNodes(graph.nodes.map((g) => make(g, from.get(g.id)!)));
    const controls = animate(0, 1, {
      duration: 0.55,
      ease: [0.32, 0.72, 0, 1],
      onComplete: () => refit && frame(),
      onUpdate: (t) =>
        setNodes((ns) =>
          ns.map((n) => {
            const a = from.get(n.id);
            const b = placed.get(n.id);
            return a && b ? { ...n, position: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } } : n;
          }),
        ),
    });
    return () => controls.stop();
    // `placed` follows `graph`; the prefs that matter to the forces are in `graph` too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, layout]);

  // --- Focus, search --------------------------------------------------------------------------

  const focusId = hovered ?? selected;
  const focus = useMemo(() => (focusId && byId.has(focusId) ? neighbourhood(graph, focusId) : null), [graph, byId, focusId]);
  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return null;
    return new Set(graph.nodes.filter((n) => fold(n.label).includes(q)).map((n) => n.id));
  }, [graph, query]);
  const emphasisOf = useCallback(
    (id: string): Emphasis => (matches ? (matches.has(id) ? 'match' : 'dim') : focus ? (focus.has(id) ? 'focus' : 'dim') : 'normal'),
    [matches, focus],
  );

  const viewNodes = useMemo(
    () =>
      nodes.map((n) => {
        const emphasis = emphasisOf(n.id);
        const isSelected = n.id === selected;
        return emphasis === n.data.emphasis && isSelected === Boolean(n.selected) ? n : { ...n, selected: isSelected, data: { ...n.data, emphasis } };
      }),
    [nodes, emphasisOf, selected],
  );

  const viewEdges = useMemo<BrainEdge[]>(
    () =>
      graph.edges.map((e: GEdge) => {
        const s = byId.get(e.source)!;
        const t = byId.get(e.target)!;
        const emphasis: Emphasis = matches
          ? matches.has(e.source) && matches.has(e.target)
            ? 'focus'
            : 'dim'
          : focusId
            ? e.source === focusId || e.target === focusId
              ? 'focus'
              : 'dim'
            : 'normal';
        const res = s.kind === 'resource' ? s : t.kind === 'resource' ? t : null;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'brain',
          selectable: false,
          focusable: false,
          data: {
            kind: e.kind,
            layout,
            emphasis,
            count: e.count,
            hue: e.kind === 'tree' ? (t.hue ?? s.hue) : undefined,
            depth: placed.get(e.target)?.depth ?? 1,
            color: e.kind === 'support' && res?.media ? `color-mix(in srgb, ${KIND_COLOR[res.media]} 55%, transparent)` : undefined,
          },
        };
      }),
    [graph, byId, matches, focusId, layout, placed],
  );

  // --- Clusters of the network (drawn behind the nodes, dragged by their label) ----------------

  const hulls = useMemo(() => {
    if (layout !== 'network' || prefs.grouping === 'none') return [];
    const at = new Map(nodes.map((n) => [n.id, n]));
    return graph.groups.flatMap((g) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const id of g.members) {
        const n = at.get(id);
        if (!n) continue;
        const w = n.measured?.width ?? 40;
        const h = n.measured?.height ?? 40;
        const labelled = n.data.g.kind === 'note' || n.data.g.kind === 'resource';
        x0 = Math.min(x0, n.position.x - Math.max(w / 2, labelled ? 60 : 0));
        x1 = Math.max(x1, n.position.x + Math.max(w / 2, labelled ? 60 : 0));
        y0 = Math.min(y0, n.position.y - h / 2);
        y1 = Math.max(y1, n.position.y + h / 2 + (labelled ? 20 : 0));
      }
      if (!Number.isFinite(x0)) return [];
      const pad = 26;
      return [{ g, x: x0 - pad, y: y0 - pad - 26, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 + 26 }];
    });
  }, [nodes, graph, layout, prefs.grouping]);

  const dragGroup = (e: React.PointerEvent, group: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sim = net.current!;
    const start = sim.startGroup(group);
    const z = rf.getZoom();
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => sim.moveGroup(group, start, { x: (ev.clientX - sx) / z, y: (ev.clientY - sy) / z });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      sim.endGroup(start);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- Interactions ---------------------------------------------------------------------------

  const open = useCallback(
    async (id: string) => {
      const g = byId.get(id);
      if (!g) return;
      try {
        if (g.kind === 'course') go({ name: 'course', id: g.ref });
        else if (g.kind === 'chapter' && g.courseId) go({ name: 'course', id: g.courseId });
        else if (g.kind === 'note') go({ name: 'note', id: g.ref });
        else if (g.kind === 'resource') {
          const res = resources.get(g.ref);
          if (res?.notes.length) go({ name: 'note', id: res.notes[0], resource: res.id });
          else if (res) {
            const note = await window.boo.library.createNote({ title: res.title, resources: [res.id] });
            await useApp.getState().refresh();
            go({ name: 'note', id: note.id });
          }
        } else if (g.kind === 'bucket') go(g.ref === 'library' ? { name: 'resources', kind: 'all' } : { name: 'notes', filter: 'inbox' });
        else if (g.collapsible) toggle(id);
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    },
    [byId, go, resources, toggle],
  );

  const centerOn = useCallback(
    (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      setSelected(id);
      void rf.setCenter(n.position.x, n.position.y, { zoom: Math.max(rf.getZoom(), 1.05), duration: reduced ? 0 : 480 });
    },
    [rf, reduced],
  );

  const subtree = useRef<{ id: string; origin: Point; start: Map<string, Point> } | null>(null);
  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const walk = (p: string) => {
      for (const n of graph.nodes) {
        if (n.parent === p) {
          out.push(n.id);
          walk(n.id);
        }
      }
    };
    walk(id);
    return out;
  };

  const onNodesChange = useCallback((changes: NodeChange<BrainNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  const setPinned = (id: string, pinned: boolean) => {
    net.current!.setPinned(id, pinned);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, pinned } } : n)));
  };

  const empty = !graph.nodes.some((n) => n.kind !== 'root');
  const collapsibles = useMemo(() => collapsibleIds(snap, layout === 'mindmap' && courseId ? 'chapter' : 'course'), [snap, layout, courseId]);
  const anyCollapsed = collapsed.size > 0;
  const selectedNode = selected ? byId.get(selected) : undefined;
  const kinds = useMemo(() => [...new Set(graph.nodes.flatMap((n) => (n.media ? [n.media] : [])))], [graph]);

  const title = course ? `Carte de ${course.title}` : 'Mon second cerveau';
  const stats = [
    plural(graph.nodes.filter((n) => n.kind === 'note').length, 'note'),
    plural(graph.nodes.filter((n) => n.kind === 'resource').length, 'support'),
    plural(graph.edges.filter((e) => e.kind === 'ref').length, 'référence'),
  ].join(' · ');

  return (
    <div className="page page-graph">
      <PageHeader
        crumbs={course ? [{ label: `${course.emoji} ${course.title}`, route: { name: 'course', id: course.id } }, { label: 'Carte' }] : [{ label: 'Carte mentale' }]}
        center={
          <Segmented<Layout>
            label="Disposition"
            value={layout}
            onChange={setLayout}
            options={[
              { id: 'network', label: 'Réseau', icon: 'graph' },
              { id: 'mindmap', label: 'Carte mentale', icon: 'mindmap' },
            ]}
          />
        }
        actions={
          <>
            <div className="graph-search">
              <SearchField
                value={query}
                onChange={setQuery}
                label="Chercher dans le graphe"
                placeholder="Chercher…"
                onSubmit={() => {
                  const first = graph.nodes.find((n) => matches?.has(n.id));
                  if (first) centerOn(first.id);
                }}
              />
            </div>
            <GraphMenu layout={layout} prefs={prefs} setPrefs={setPrefs} />
            <IconButton
              icon={anyCollapsed ? 'expand' : 'collapse'}
              label={anyCollapsed ? 'Tout déplier' : layout === 'mindmap' && courseId ? 'Replier les chapitres' : 'Replier les cours'}
              isDisabled={!anyCollapsed && !collapsibles.length}
              onPress={() => setCollapsed(anyCollapsed ? new Set() : new Set(collapsibles))}
            />
            {layout === 'network' ? (
              <IconButton
                icon="sparkles"
                label="Réorganiser"
                onPress={() => {
                  net.current!.shuffle();
                  setNodes((ns) => ns.map((n) => (n.data.pinned ? { ...n, data: { ...n.data, pinned: false } } : n)));
                  setTimeout(frame, reduced ? 50 : 900);
                }}
              />
            ) : null}
            <IconButton icon="fit" label="Tout voir" onPress={() => void rf.fitView({ padding: 0.12, duration: reduced ? 0 : 400 })} />
          </>
        }
      />
      <div
        className="graph"
        data-zoom={zoom}
        data-layout={layout}
        onKeyDown={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node');
          if (e.key === 'Enter' && el?.dataset.id) {
            e.preventDefault();
            void open(el.dataset.id);
          } else if (e.key === 'Escape') {
            setSelected(null);
            setQuery('');
          }
        }}
        onFocus={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node');
          if (el?.dataset.id && e.target === el) setSelected(el.dataset.id);
        }}
      >
        <ReactFlow<BrainNode, BrainEdge>
          nodes={viewNodes}
          edges={viewEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          nodeOrigin={[0.5, 0.5]}
          minZoom={0.08}
          maxZoom={2.5}
          elementsSelectable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
          onMove={(_, vp) => setZoom(zoomBucket(vp.zoom))}
          onPaneClick={() => setSelected(null)}
          onNodeClick={(_, n) => setSelected(n.id)}
          onNodeDoubleClick={(_, n) => void open(n.id)}
          onNodeMouseEnter={(_, n) => setHovered(n.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onNodeDragStart={(_, n) => {
            setHovered(null);
            if (layout === 'network') net.current!.grab(n.id, n.position);
            else {
              const ids = new Set(descendants(n.id));
              subtree.current = {
                id: n.id,
                origin: { ...n.position },
                start: new Map(nodesRef.current.filter((x) => ids.has(x.id)).map((x) => [x.id, { ...x.position }])),
              };
            }
          }}
          onNodeDrag={(_, n) => {
            if (layout === 'network') {
              net.current!.grab(n.id, n.position);
              return;
            }
            const st = subtree.current;
            if (!st || st.id !== n.id || !st.start.size) return;
            const dx = n.position.x - st.origin.x;
            const dy = n.position.y - st.origin.y;
            setNodes((ns) => ns.map((x) => (st.start.has(x.id) ? { ...x, position: { x: st.start.get(x.id)!.x + dx, y: st.start.get(x.id)!.y + dy } } : x)));
          }}
          onNodeDragStop={(_, n) => {
            if (layout === 'network') {
              net.current!.release(n.id, true);
              setNodes((ns) => ns.map((x) => (x.id === n.id ? { ...x, data: { ...x.data, pinned: true } } : x)));
            }
            subtree.current = null;
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="graph-bg" />
          <ViewportPortal>
            {hulls.map((h) => {
              const tint = h.g.hue !== null ? courseColor(h.g.hue) : h.g.media ? KIND_COLOR[h.g.media] : 'var(--faint)';
              const dim = focus ? !h.g.members.some((m) => focus.has(m)) : matches ? !h.g.members.some((m) => matches.has(m)) : false;
              return (
                <div
                  key={h.g.id}
                  className={`hull${dim ? ' is-dim' : ''}`}
                  style={{ transform: `translate(${h.x}px, ${h.y}px)`, width: h.w, height: h.h, ['--tint' as string]: tint } as CSSProperties}
                >
                  <div className="hull-head nopan nodrag" onPointerDown={(e) => dragGroup(e, h.g.id)} title="Glisser pour déplacer le groupe">
                    {h.g.media ? <Icon name={KIND_ICON[h.g.media]} size={12} /> : null}
                    <span className="hull-title">{h.g.label}</span>
                    <span className="hull-count">{h.g.members.length}</span>
                    {h.g.collapseId ? (
                      <button
                        type="button"
                        className="hull-fold"
                        aria-label={`Replier ${h.g.label}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => toggle(h.g.collapseId!)}
                      >
                        <Icon name={collapsed.has(h.g.collapseId) ? 'expand' : 'collapse'} size={11} />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </ViewportPortal>
          <Controls showInteractive={false} orientation="horizontal" position="bottom-right" className="graph-controls glass" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="graph-minimap glass"
            nodeBorderRadius={8}
            nodeColor={(n) => {
              const g = (n as BrainNode).data.g;
              return g.hue !== undefined && (g.kind === 'course' || g.kind === 'chapter') ? courseColor(g.hue) : g.media ? KIND_COLOR[g.media] : 'var(--faint)';
            }}
            maskColor="var(--graph-mask)"
          />
          {kinds.length ? (
            <Panel position="bottom-center" className="graph-legend glass" aria-label="Légende">
              {kinds.map((k) => (
                <span key={k} className="legend-item" style={{ ['--kind' as string]: KIND_COLOR[k] } as CSSProperties}>
                  <span className="legend-dot" />
                  {KIND_PLURALS[k]}
                </span>
              ))}
              <span className="legend-sep" />
              {prefs.links.support ? (
                <span className="legend-item">
                  <span className="legend-line support" />
                  Supports
                </span>
              ) : null}
              {prefs.links.ref ? (
                <span className="legend-item">
                  <span className="legend-line ref" />
                  Références
                </span>
              ) : null}
            </Panel>
          ) : null}
          {selectedNode ? (
            <Panel position="bottom-left" className="graph-card-panel">
              <NodeCard
                node={selectedNode}
                graph={graph}
                layout={layout}
                pinned={Boolean(net.current!.get(selectedNode.id)?.pinned)}
                onOpen={() => void open(selectedNode.id)}
                onCenter={() => centerOn(selectedNode.id)}
                onToggle={() => toggle(selectedNode.id)}
                onPin={(p) => setPinned(selectedNode.id, p)}
                onSelect={centerOn}
                onClose={() => setSelected(null)}
              />
            </Panel>
          ) : null}
          {!selectedNode && !empty ? (
            <Panel position="top-left" className="graph-caption">
              <LargeTitle title={title} subtitle={stats} />
            </Panel>
          ) : null}
        </ReactFlow>
        {empty ? (
          <div className="graph-empty">
            <div className="welcome glass">
              <Icon name="mindmap" size={36} />
              <h2>Votre carte se dessinera ici</h2>
              <p>
                Chaque cours, chapitre, note et support devient un nœud ; les <code>[[liens]]</code> entre notes tissent les références de votre
                second cerveau.
              </p>
              <div className="welcome-actions">
                <Button variant="primary" icon="course" onPress={() => void newCourse()}>
                  Créer un cours
                </Button>
                <Button icon="edit" onPress={() => void newNote()}>
                  Nouvelle note
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function kindName(g: GNode): string {
  switch (g.kind) {
    case 'course':
      return 'Cours';
    case 'chapter':
      return `Chapitre ${g.index}`;
    case 'note':
      return g.media && g.media !== 'note' ? `Note (${KIND_LABELS[g.media]})` : 'Fiche';
    case 'resource':
      return g.media ? KIND_LABELS[g.media] : 'Support';
    case 'bucket':
      return 'Groupe';
    default:
      return 'Racine';
  }
}

const LINK_NAMES = { tree: 'Structure', support: 'Support', ref: 'Référence' } as const;

function NodeCard({
  node,
  graph,
  layout,
  pinned,
  onOpen,
  onCenter,
  onToggle,
  onPin,
  onSelect,
  onClose,
}: {
  node: GNode;
  graph: Graph;
  layout: Layout;
  pinned: boolean;
  onOpen(): void;
  onCenter(): void;
  onToggle(): void;
  onPin(pinned: boolean): void;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const links = graph.edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => ({ other: byId.get(e.source === node.id ? e.target : e.source)!, kind: e.kind, count: e.count }))
    .sort((a, b) => (a.kind === b.kind ? a.other.label.localeCompare(b.other.label, 'fr') : a.kind.localeCompare(b.kind)));
  const tint = node.hue !== undefined ? courseColor(node.hue) : node.media ? KIND_COLOR[node.media] : undefined;
  return (
    <section className="graph-card glass-thick" aria-label={`${kindName(node)} : ${node.label}`} style={{ ['--tint' as string]: tint } as CSSProperties}>
      <header className="graph-card-head">
        <span className="graph-card-icon">
          {node.kind === 'course' ? node.emoji : <Icon name={node.media ? KIND_ICON[node.media] : node.kind === 'chapter' ? 'list' : 'layers'} size={16} />}
        </span>
        <span className="graph-card-text">
          <small>{kindName(node)}</small>
          <strong>{node.label}</strong>
        </span>
        <IconButton icon="close" label="Fermer" size="s" onPress={onClose} />
      </header>
      {links.length ? (
        <ul className="graph-card-links" aria-label="Relié à">
          {links.slice(0, 14).map(({ other, kind, count }) => (
            <li key={`${kind}:${other.id}`}>
              <AriaButton className={`graph-link-chip link-${kind}`} onPress={() => onSelect(other.id)}>
                <Icon name={other.media ? KIND_ICON[other.media] : other.kind === 'course' ? 'course' : 'list'} size={12} />
                <span>{other.kind === 'course' ? `${other.emoji} ${other.label}` : other.label}</span>
                <small>
                  {LINK_NAMES[kind]}
                  {count > 1 ? ` ×${count}` : ''}
                </small>
              </AriaButton>
            </li>
          ))}
          {links.length > 14 ? <li className="graph-card-more">+{links.length - 14}</li> : null}
        </ul>
      ) : (
        <p className="graph-card-empty">Aucun lien pour l’instant.</p>
      )}
      <div className="graph-card-actions">
        {node.kind !== 'root' ? (
          <Button size="s" variant="primary" icon="popout" onPress={onOpen}>
            Ouvrir
          </Button>
        ) : null}
        <Button size="s" icon="target" onPress={onCenter}>
          Centrer
        </Button>
        {node.collapsible ? (
          <Button size="s" icon={node.collapsed ? 'expand' : 'collapse'} onPress={onToggle}>
            {node.collapsed ? `Déplier (${node.folded})` : 'Replier'}
          </Button>
        ) : null}
        {layout === 'network' ? (
          <Button size="s" variant="plain" icon="pin" onPress={() => onPin(!pinned)}>
            {pinned ? 'Libérer' : 'Épingler'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function keysOf(sel: Selection, all: string[]): Set<string> {
  return sel === 'all' ? new Set(all) : new Set([...sel].map(String));
}

function GraphMenu({ layout, prefs, setPrefs }: { layout: Layout; prefs: GraphPrefs; setPrefs(p: GraphPrefs): void }) {
  const shown = Object.entries(prefs.show).flatMap(([k, v]) => (v ? [k] : []));
  const links = Object.entries(prefs.links).flatMap(([k, v]) => (v ? [k] : []));
  const item = (id: string, label: string, icon?: Parameters<typeof Icon>[0]['name']) => (
    <MenuItem id={id} className="menu-item" textValue={label}>
      {({ isSelected }) => (
        <>
          <span className="menu-check">{isSelected ? <Icon name="check" size={14} /> : null}</span>
          {icon ? <Icon name={icon} size={15} /> : null}
          <span className="menu-label">{label}</span>
        </>
      )}
    </MenuItem>
  );
  return (
    <MenuTrigger>
      <AriaButton className="btn btn-glass btn-m" aria-label="Options d’affichage du graphe">
        <Icon name="filter" size={16} />
        <span className="btn-label">Affichage</span>
      </AriaButton>
      <Popover placement="bottom end" offset={6} className="popover glass-thick">
        <Menu className="menu" aria-label="Options d’affichage du graphe">
          {layout === 'network' ? (
            <MenuSection
              className="menu-section"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[prefs.grouping]}
              onSelectionChange={(sel) => {
                const k = [...keysOf(sel, [])][0];
                if (k) setPrefs({ ...prefs, grouping: k as Grouping });
              }}
            >
              <Header className="menu-header">Regrouper par</Header>
              {item('course', 'Cours', 'course')}
              {item('kind', 'Type de support', 'layers')}
              {item('none', 'Sans groupe', 'graph')}
            </MenuSection>
          ) : null}
          <MenuSection
            className="menu-section"
            selectionMode="multiple"
            shouldCloseOnSelect={false}
            selectedKeys={shown}
            onSelectionChange={(sel) => {
              const k = keysOf(sel, ['chapters', 'notes', 'resources']);
              setPrefs({ ...prefs, show: { chapters: k.has('chapters'), notes: k.has('notes'), resources: k.has('resources') } });
            }}
          >
            <Header className="menu-header">Afficher</Header>
            {item('chapters', 'Chapitres', 'list')}
            {item('notes', 'Notes', 'edit')}
            {item('resources', 'Supports (vidéos, PDF…)', 'file')}
          </MenuSection>
          <MenuSection
            className="menu-section"
            selectionMode="multiple"
            shouldCloseOnSelect={false}
            selectedKeys={links}
            onSelectionChange={(sel) => {
              const k = keysOf(sel, ['tree', 'support', 'ref']);
              setPrefs({ ...prefs, links: { tree: k.has('tree'), support: k.has('support'), ref: k.has('ref') } });
            }}
          >
            <Header className="menu-header">Liens</Header>
            {layout === 'network' ? item('tree', 'Cours › chapitres › notes') : null}
            {item('support', 'Note → supports')}
            {item('ref', 'Références [[entre notes]]')}
          </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

