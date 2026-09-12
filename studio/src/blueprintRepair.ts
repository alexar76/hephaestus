import type { Blueprint } from '@core/types';

/** Keep `nextId('e')` / `nextId('n')` ahead of hardcoded ids from Example/Wizards (e1, e2…). */
export function syncSeqFromBlueprint(blueprint: Blueprint, seqRef: { current: number }): void {
  let max = seqRef.current;
  for (const edge of blueprint.edges) {
    const m = /^e(\d+)$/.exec(edge.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (const node of blueprint.nodes) {
    const m = /^n(\d+)$/.exec(node.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  seqRef.current = max;
}

/** Duplicate connection ids block Run; repair in place when the graph gets corrupted. */
export function repairDuplicateEdgeIds(blueprint: Blueprint): Blueprint {
  const ids = blueprint.edges.map((e) => e.id);
  if (new Set(ids).size === ids.length) return blueprint;

  const used = new Set<string>();
  let n = 1;
  const edges = blueprint.edges.map((e) => {
    let id = e.id;
    while (used.has(id)) id = `e${n++}`;
    used.add(id);
    return id === e.id ? e : { ...e, id };
  });
  return { ...blueprint, edges };
}
