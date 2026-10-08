import type { Blueprint, BlueprintEdge, BlueprintNode } from '@core/types';

/** Last node before Result — where a new catalogue hop is spliced in. */
export function chainTail(blueprint: Blueprint): string | null {
  const output = blueprint.nodes.find((n) => n.kind === 'output');
  if (!output) return blueprint.nodes.find((n) => n.kind === 'trigger')?.id ?? null;
  const into = blueprint.edges.find((e) => e.target === output.id);
  if (into) return into.source;
  return blueprint.nodes.find((n) => n.kind === 'trigger')?.id ?? null;
}

/** Insert a capability between the chain tail and Result (or after trigger if empty). */
export function spliceCapability(
  blueprint: Blueprint,
  node: BlueprintNode,
  edgeId: () => string,
): { nodes: BlueprintNode[]; edges: BlueprintEdge[] } {
  const output = blueprint.nodes.find((n) => n.kind === 'output');
  const tail = chainTail(blueprint);
  const tailNode = tail ? blueprint.nodes.find((n) => n.id === tail) : undefined;
  const y = (tailNode?.position?.y ?? 40) + 150;
  const x = tailNode?.position?.x ?? 60;
  const placed: BlueprintNode = { ...node, position: { x, y } };

  let edges = [...blueprint.edges];
  if (tail && output) {
    edges = edges.filter((e) => !(e.source === tail && e.target === output.id));
    edges.push({ id: edgeId(), source: tail, target: placed.id });
    edges.push({ id: edgeId(), source: placed.id, target: output.id });
  } else if (tail) {
    edges.push({ id: edgeId(), source: tail, target: placed.id });
  }

  const nodes = blueprint.nodes.map((n) => {
    if (n.kind === 'output') {
      return { ...n, position: { x: n.position?.x ?? x, y: y + 150 } };
    }
    return n;
  });

  return { nodes: [...nodes, placed], edges };
}

export function disconnectedNodeIds(blueprint: Blueprint): Set<string> {
  if (blueprint.nodes.length <= 1) return new Set();
  const connected = new Set(
    blueprint.edges.flatMap((e) => [e.source, e.target]),
  );
  return new Set(
    blueprint.nodes.filter((n) => !connected.has(n.id)).map((n) => n.id),
  );
}
