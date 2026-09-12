import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { catalogFromManifest, findCapability, reputationLabel } from '@core/catalog';
import { estimateBlueprint, formatEstimate } from '@core/estimate';
import { toPipelineRequest, validateBlueprint } from '@core/blueprint';
import { exampleBlueprint } from '@core/example';
import type { Blueprint, BlueprintNode, Capability } from '@core/types';

import CapabilityNode, { type StudioFlowNode } from './CapabilityNode';
import CanvasGuide from './CanvasGuide';
import ConnectHint from './ConnectHint';
import Inspector from './Inspector';
import LangSwitch from './LangSwitch';
import Palette from './Palette';
import Wizards from './Wizards';
import { disconnectedNodeIds, spliceCapability } from './chain';
import { repairDuplicateEdgeIds, syncSeqFromBlueprint } from './blueprintRepair';
import { useI18n } from './i18n';
import { fetchManifest, fetchTrialQuota, runBlueprint, type RunResult, type TrialQuota } from './api';
import './styles.css';

const NODE_TYPES = { studio: CapabilityNode };

const seqRef = { current: 0 };
const nextId = (prefix: string) => `${prefix}${(seqRef.current += 1)}`;

function adoptBlueprint(raw: Blueprint): Blueprint {
  syncSeqFromBlueprint(raw, seqRef);
  return repairDuplicateEdgeIds(raw);
}

function starterBlueprint(): Blueprint {
  return {
    name: 'untitled',
    description: '',
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', input: {}, position: { x: 40, y: 40 } },
      { id: 'output', kind: 'output', label: 'Result', input: {}, position: { x: 40, y: 420 } },
    ],
    edges: [],
  };
}

type View = 'catalogue' | 'canvas' | 'checks';

const NARROW_PX = 900;

function useNarrowContainer(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.innerWidth <= NARROW_PX ||
        window.matchMedia(`(max-width: ${NARROW_PX}px)`).matches),
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (width: number) => setNarrow(width > 0 && width <= NARROW_PX);
    measure(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

export default function App() {
  const { t } = useI18n();
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [blueprint, setBlueprint] = useState<Blueprint>(starterBlueprint);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const narrow = useNarrowContainer(shellRef);
  const [view, setView] = useState<View>('canvas');
  const [exampleNote, setExampleNote] = useState<string | null>(null);
  const [quota, setQuota] = useState<TrialQuota | null>(null);
  const [guideDismissed, setGuideDismissed] = useState(false);
  const [connectHintDismissed, setConnectHintDismissed] = useState(false);
  const [wizardsOpen, setWizardsOpen] = useState(false);
  /** Node sizes as React Flow measured them; see onNodesChange for why they are kept. */
  const [measured, setMeasured] = useState<
    Record<string, { width: number; height: number }>
  >({});

  useEffect(() => {
    let alive = true;
    fetchManifest()
      .then((manifest) => {
        if (!alive) return;
        const catalog = catalogFromManifest(manifest);
        setCapabilities(catalog.capabilities);
        const example = exampleBlueprint(catalog.capabilities);
        if (example) {
          setBlueprint((prev) =>
            prev.nodes.length === 2 && prev.edges.length === 0 ? example.blueprint : prev,
          );
          setExampleNote(example.note);
        }
      })
      .catch((err: unknown) => {
        if (alive) setCatalogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    fetchTrialQuota().then((q) => {
      if (alive) setQuota(q);
    });
    return () => {
      alive = false;
    };
  }, []);

  const validation = useMemo(
    () => validateBlueprint(blueprint, capabilities),
    [blueprint, capabilities],
  );
  const estimate = useMemo(
    () => estimateBlueprint(blueprint, capabilities),
    [blueprint, capabilities],
  );
  const looseIds = useMemo(() => disconnectedNodeIds(blueprint), [blueprint]);
  const looseCapabilityCount = useMemo(
    () => blueprint.nodes.filter((n) => n.kind === 'capability' && looseIds.has(n.id)).length,
    [blueprint.nodes, looseIds],
  );

  const invalidNodeIds = useMemo(() => {
    const flagged = new Set<string>();
    for (const node of blueprint.nodes) {
      const needle = `"${node.label || node.id}"`;
      if (validation.errors.some((e) => e.includes(needle))) flagged.add(node.id);
    }
    return flagged;
  }, [blueprint.nodes, validation.errors]);

  const selectNode = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (narrow) setView('checks');
      inspectorRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [narrow],
  );

  /**
   * Stable on purpose. React Flow calls this from an effect that also depends on the
   * handler's identity, so an inline arrow re-fires it on every render — with whatever
   * selection the store still holds. Clicking empty canvas cleared the selection and this
   * handler immediately put it back, so the parameters pane could never be closed.
   */
  const onSelectionChange = useCallback(
    ({ nodes }: OnSelectionChangeParams) => {
      const picked = nodes[0];
      if (picked) selectNode(picked.id);
    },
    [selectNode],
  );

  useEffect(() => {
    const repaired = repairDuplicateEdgeIds(blueprint);
    if (repaired !== blueprint) setBlueprint(repaired);
    syncSeqFromBlueprint(repaired, seqRef);
  }, [blueprint]);

  const flowNodes: StudioFlowNode[] = useMemo(
    () =>
      blueprint.nodes.map((node) => {
        const capability = node.capabilityKey
          ? findCapability(capabilities, node.capabilityKey)
          : undefined;
        return {
          id: node.id,
          type: 'studio' as const,
          position: node.position ?? { x: 0, y: 0 },
          // Handed straight back from the `dimensions` changes React Flow reported. A node
          // that comes back without its measurement is re-adopted as "not initialized":
          // hidden for a frame, handle bounds dropped, drag refused. See onNodesChange.
          measured: measured[node.id],
          selected: node.id === selectedId,
          data: {
            label: node.label,
            kind: node.kind,
            priceUsd: capability ? (capability.routedPriceUsd ?? capability.priceUsd) : null,
            latencyMs: capability?.p50LatencyMs ?? null,
            reputation: capability ? reputationLabel(capability.reputation) : '',
            invalid: invalidNodeIds.has(node.id),
            needsWire: node.kind === 'capability' && looseIds.has(node.id),
            onSelect: () => selectNode(node.id),
          },
        };
      }),
    [blueprint.nodes, capabilities, selectedId, invalidNodeIds, looseIds, selectNode, measured],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      blueprint.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: Boolean(edge.carriesData),
        label: edge.carriesData ? 'data' : undefined,
        style: edge.carriesData
          ? { stroke: '#ffa94d', strokeWidth: 2 }
          : { strokeWidth: 2 },
        labelStyle: { fill: '#ffa94d', fontSize: 10 },
        labelBgStyle: { fill: '#0d1424' },
      })),
    [blueprint.edges],
  );

  /** Catalogue click inserts into the chain — never drops an orphan square. */
  const addCapability = useCallback((capability: Capability) => {
    setBlueprint((prev) => {
      const id = nextId('n');
      const node: BlueprintNode = {
        id,
        kind: 'capability',
        label: capability.capabilityId,
        capabilityKey: capability.key,
        input: Object.fromEntries(
          capability.inputFields
            .filter((f) => f.default !== undefined)
            .map((f) => [f.name, f.default]),
        ),
        position: { x: 0, y: 0 },
      };
      const spliced = spliceCapability(prev, node, () => nextId('e'));
      return { ...prev, nodes: spliced.nodes, edges: spliced.edges };
    });
    setSelectedId(null);
    setConnectHintDismissed(false);
    setView('canvas');
  }, []);

  const removeLoose = useCallback(() => {
    setBlueprint((prev) => {
      const loose = disconnectedNodeIds(prev);
      const nodes = prev.nodes.filter(
        (n) => n.kind !== 'capability' || !loose.has(n.id),
      );
      const keep = new Set(nodes.map((n) => n.id));
      return {
        ...prev,
        nodes,
        edges: prev.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      };
    });
    setSelectedId(null);
    setConnectHintDismissed(false);
  }, []);

  /**
   * The blueprint is the source of truth for the canvas, so React Flow reports every change
   * here — including the ResizeObserver measurement of each box.
   *
   * Both halves matter. A measurement that is not stored is not on the nodes we hand back,
   * and React Flow then re-adopts those nodes as "not initialized": it hides them for a
   * frame, throws away their handle bounds and refuses to drag them, so the mousedown falls
   * through to the pane and pulling a box panned the whole canvas instead. And a change that
   * carries no geometry (a measurement, a selection) must not produce a new blueprint object,
   * or every measurement re-renders the graph, which re-measures it — the loop that made
   * boxes flicker and swallowed clicks before the inspector ever saw them.
   */
  const onNodesChange = useCallback((changes: NodeChange<StudioFlowNode>[]) => {
    const sizes = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
    if (sizes.length > 0) {
      setMeasured((prev) => {
        let next = prev;
        for (const change of sizes) {
          if (change.type !== 'dimensions' || !change.dimensions) continue;
          const { width, height } = change.dimensions;
          const current = prev[change.id];
          if (current && current.width === width && current.height === height) continue;
          if (next === prev) next = { ...prev };
          next[change.id] = { width, height };
        }
        return next;
      });
    }

    const geometry = changes.filter((c) => c.type === 'position' || c.type === 'remove');
    if (geometry.length === 0) return;

    setBlueprint((prev) => {
      const updated = applyNodeChanges(
        geometry,
        prev.nodes.map((n) => ({
          id: n.id,
          type: 'studio' as const,
          position: n.position ?? { x: 0, y: 0 },
          data: {} as never,
        })),
      );
      const positions = new Map(updated.map((n) => [n.id, n.position]));
      const removed = new Set(
        geometry.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id),
      );
      const moved = prev.nodes.some((n) => {
        const next = positions.get(n.id);
        return next && (next.x !== n.position?.x || next.y !== n.position?.y);
      });
      // A drag ends with a position change that carries no movement; rebuilding the
      // blueprint for it would restart the measure/render cycle for nothing.
      if (removed.size === 0 && !moved) return prev;
      return {
        ...prev,
        nodes: prev.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })),
        edges: prev.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
      };
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setBlueprint((prev) => {
      const kept = applyEdgeChanges(
        changes,
        prev.edges.map((e) => ({ ...e })) as Edge[],
      );
      const keptIds = new Set(kept.map((e) => e.id));
      return { ...prev, edges: prev.edges.filter((e) => keptIds.has(e.id)) };
    });
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setBlueprint((prev) => {
      const added = addEdge({ ...connection, id: nextId('e') }, [] as Edge[])[0];
      if (!added) return prev;
      const alreadyFed = prev.edges.some(
        (e) => e.target === connection.target && e.carriesData,
      );
      return {
        ...prev,
        edges: [
          ...prev.edges,
          {
            id: added.id,
            source: added.source,
            target: added.target,
            carriesData: !alreadyFed,
          },
        ],
      };
    });
    setConnectHintDismissed(false);
  }, []);

  const toggleEdgeData = useCallback((_: unknown, edge: Edge) => {
    setBlueprint((prev) => ({
      ...prev,
      edges: prev.edges.map((e) =>
        e.id === edge.id ? { ...e, carriesData: !e.carriesData } : e,
      ),
    }));
  }, []);

  const setInput = useCallback((nodeId: string, field: string, value: unknown) => {
    setBlueprint((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === nodeId ? { ...n, input: { ...n.input, [field]: value } } : n,
      ),
    }));
  }, []);

  const conversion = useMemo(
    () => toPipelineRequest(blueprint, capabilities),
    [blueprint, capabilities],
  );

  const copyRequest = useCallback(async () => {
    if (!conversion.ok) return;
    await navigator.clipboard.writeText(JSON.stringify(conversion.request, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [conversion]);

  const loadExample = useCallback(() => {
    const example = exampleBlueprint(capabilities);
    if (!example) return;
    setBlueprint(adoptBlueprint(example.blueprint));
    setExampleNote(example.note);
    setRun(null);
    setSelectedId(null);
    setView('canvas');
    setGuideDismissed(true);
    setConnectHintDismissed(false);
  }, [capabilities]);

  const submit = useCallback(async () => {
    if (!conversion.ok) return;
    setRunning(true);
    setRun(null);
    try {
      setRun(await runBlueprint(conversion.request));
      setQuota(await fetchTrialQuota());
      if (narrow) setView('checks');
    } catch (err: unknown) {
      setRun({
        error: 'request_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      if (narrow) setView('checks');
    } finally {
      setRunning(false);
    }
  }, [conversion, narrow]);

  const selected = blueprint.nodes.find((n) => n.id === selectedId) ?? null;
  const showGuide =
    !guideDismissed && !loading && validation.errors.length === 0 && !run;
  const showConnectHint = !connectHintDismissed && looseCapabilityCount > 0;

  const quotaText =
    quota?.enabled && typeof quota.remaining === 'number'
      ? quota.remaining === 1
        ? t('quota_free_run', { n: quota.remaining })
        : t('quota_free_runs', { n: quota.remaining })
      : '';

  const metaText =
    estimate.unobservedCapabilities.length > 0
      ? t('meta_unproven', {
          n: estimate.unobservedCapabilities.length,
          h: estimate.hops,
        })
      : estimate.hops > 0
        ? t('meta_observed')
        : t('meta_empty');

  return (
    <div className={narrow ? 'app narrow' : 'app'} ref={shellRef}>
      <header className="bar">
        <div className="brand">
          <h1>HEPHAESTUS</h1>
          <span>{t('brand_tagline')}</span>
        </div>

        <LangSwitch />

        <div className="estimate">
          <div>
            <div className="figure">{formatEstimate(estimate)}</div>
            <div className="meta">
              {quotaText}
              {metaText}
            </div>
          </div>
        </div>

        <div className="actions">
          <Wizards
            capabilities={capabilities}
            forceOpen={wizardsOpen}
            onForceOpenHandled={() => setWizardsOpen(false)}
            onPick={(bp, note) => {
              setBlueprint(adoptBlueprint(bp));
              setExampleNote(note);
              setRun(null);
              setSelectedId(null);
              setView('canvas');
              setGuideDismissed(true);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setBlueprint(adoptBlueprint(starterBlueprint()));
              setExampleNote(null);
              setRun(null);
              setSelectedId(null);
              setGuideDismissed(false);
            }}
          >
            {t('clear')}
          </button>
          <button type="button" onClick={loadExample} disabled={capabilities.length === 0}>
            {t('example')}
          </button>
          <button type="button" onClick={copyRequest} disabled={!conversion.ok}>
            {copied ? t('copied') : t('copy_request')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={!conversion.ok || running}
          >
            {running ? t('running') : t('run')}
          </button>
        </div>
      </header>

      <div className="main">
        {(!narrow || view === 'catalogue') && (
          <Palette
            capabilities={capabilities}
            onAdd={addCapability}
            onLoadExample={loadExample}
            onOpenWizards={() => setWizardsOpen(true)}
            loading={loading}
            error={catalogError}
          />
        )}

        <div className="canvas" hidden={narrow && view !== 'canvas'}>
          <CanvasGuide visible={showGuide} onDismiss={() => setGuideDismissed(true)} />
          {showConnectHint && (
            <ConnectHint
              looseCount={looseCapabilityCount}
              onLoadExample={loadExample}
              onRemoveLoose={removeLoose}
              onDismiss={() => setConnectHintDismissed(true)}
            />
          )}
          <div className="canvas-hint" role="note">
            {t('canvas_hint')}
          </div>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeClick={toggleEdgeData}
            onNodeClick={(_, node) => selectNode(node.id)}
            onSelectionChange={onSelectionChange}
            onPaneClick={() => setSelectedId(null)}
            fitView
            // Unclamped, fitView zooms a two-hop chain to 1.75× — the boxes fill the canvas
            // and Result lands under the bottom edge. Never enlarge, and leave a margin.
            fitViewOptions={{ maxZoom: 1, padding: 0.18 }}
            panActivationKeyCode="Space"
            selectionOnDrag={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1e2c48" gap={22} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {(!narrow || view === 'checks') && (
          <Inspector
            ref={inspectorRef}
            node={selected}
            capabilities={capabilities}
            errors={validation.errors}
            warnings={validation.warnings}
            run={run}
            note={exampleNote}
            onInput={setInput}
            onRemoveLoose={removeLoose}
            onLoadExample={loadExample}
          />
        )}
      </div>

      <nav className="tabs" aria-label="Sections">
        {(
          [
            ['catalogue', t('tab_catalogue'), capabilities.length],
            ['canvas', t('tab_canvas'), blueprint.nodes.length],
            ['checks', t('tab_checks'), validation.errors.length],
          ] as [View, string, number][]
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            aria-current={view === id}
            onClick={() => setView(id)}
          >
            {label}
            {id === 'checks' && count > 0 && <span className="count">{count}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
