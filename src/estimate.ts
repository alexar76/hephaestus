/**
 * What this graph will cost, before anyone pays for it.
 *
 * This is the studio's reason to exist. Every other visual builder can draw boxes; the
 * catalogue behind these boxes publishes a price, a latency and — since the reputation
 * work — how much evidence stands behind its numbers, so a blueprint can be costed while
 * it is still a drawing.
 *
 * Two rules keep the number honest:
 *   * an unpriced capability is COUNTED and NAMED, never treated as free
 *   * money is summed in integer micro-dollars, because the catalogue's real prices are
 *     $0.001 sensor reads and $0.004 oracle calls, and floating-point addition of those
 *     drifts in the digits the total is made of
 */

import { findCapability } from './catalog';
import { PIPELINE_MAX_NODES } from './types';
import type { Blueprint, Capability } from './types';

export interface Estimate {
  /** Sum of the priced hops, in USD, rounded to the micro-dollar. */
  totalUsd: number;
  hops: number;
  pricedHops: number;
  /** Capability ids that publish no price; their cost is unknown, not zero. */
  unpricedCapabilities: string[];
  /** Longest declared-latency path through the graph, in ms; `null` when nothing declares one. */
  criticalPathMs: number | null;
  /** Capability ids with no declared latency — the path below is a lower bound. */
  unknownLatencyCapabilities: string[];
  overPipelineLimit: boolean;
  /** Rows whose reliability the catalogue cannot vouch for yet. */
  unobservedCapabilities: string[];
  notes: string[];
}

const MICROS = 1_000_000;

export function estimateBlueprint(blueprint: Blueprint, catalog: Capability[]): Estimate {
  const capabilityNodes = blueprint.nodes.filter((n) => n.kind === 'capability');
  const resolved = capabilityNodes.map((node) => ({
    node,
    capability: node.capabilityKey ? findCapability(catalog, node.capabilityKey) : undefined,
  }));

  let micros = 0;
  let pricedHops = 0;
  const unpriced: string[] = [];
  const unknownLatency: string[] = [];
  const unobserved: string[] = [];
  const notes: string[] = [];

  for (const { node, capability } of resolved) {
    if (!capability) {
      notes.push(`"${node.label || node.id}" is not in the catalogue and is not estimated`);
      continue;
    }
    // What a buyer is actually charged is the routed price when the hub routes to a peer;
    // the base price is what the provider asks. Estimating the base would under-quote
    // every federated hop by the routing fee.
    const price = capability.routedPriceUsd ?? capability.priceUsd;
    if (price === null) {
      unpriced.push(capability.capabilityId);
    } else {
      micros += Math.round(price * MICROS);
      pricedHops += 1;
    }
    if (capability.p50LatencyMs === null) unknownLatency.push(capability.capabilityId);
    if (capability.reputation.basis !== 'measured') unobserved.push(capability.capabilityId);
  }

  const criticalPathMs = longestLatencyPath(blueprint, catalog);

  if (unpriced.length > 0) {
    notes.push(
      `${unpriced.length} capabilit${unpriced.length === 1 ? 'y' : 'ies'} publish no price; ` +
        'the total below excludes them',
    );
  }
  if (unobserved.length > 0) {
    notes.push(
      `${unobserved.length} of ${capabilityNodes.length} hops have no observed success rate yet`,
    );
  }
  if (capabilityNodes.length > PIPELINE_MAX_NODES) {
    notes.push(`A pipeline runs at most ${PIPELINE_MAX_NODES} capabilities`);
  }

  return {
    totalUsd: micros / MICROS,
    hops: capabilityNodes.length,
    pricedHops,
    unpricedCapabilities: unpriced,
    criticalPathMs,
    unknownLatencyCapabilities: unknownLatency,
    overPipelineLimit: capabilityNodes.length > PIPELINE_MAX_NODES,
    unobservedCapabilities: unobserved,
    notes,
  };
}

/**
 * Longest path by declared p50 latency.
 *
 * The executor runs hops sequentially today, so this is a floor rather than a forecast —
 * but it is the floor a parallel executor could not beat, which is the useful number to
 * show next to a graph. Unknown latencies count as zero and are named separately, so the
 * figure is never inflated by a guess.
 */
function longestLatencyPath(blueprint: Blueprint, catalog: Capability[]): number | null {
  const byId = new Map(blueprint.nodes.map((n) => [n.id, n]));
  const cost = (id: string): number => {
    const node = byId.get(id);
    if (!node || node.kind !== 'capability' || !node.capabilityKey) return 0;
    return findCapability(catalog, node.capabilityKey)?.p50LatencyMs ?? 0;
  };

  const children = new Map<string, string[]>();
  for (const node of blueprint.nodes) children.set(node.id, []);
  for (const edge of blueprint.edges) {
    if (!children.has(edge.source) || !byId.has(edge.target)) continue;
    children.get(edge.source)!.push(edge.target);
  }

  const best = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    if (best.has(id)) return best.get(id)!;
    if (visiting.has(id)) return 0; // a cycle is a validation error; do not hang on it
    visiting.add(id);
    const downstream = (children.get(id) ?? []).map(walk);
    const total = cost(id) + (downstream.length > 0 ? Math.max(...downstream) : 0);
    visiting.delete(id);
    best.set(id, total);
    return total;
  };

  const anyDeclared = blueprint.nodes.some((n) => {
    if (n.kind !== 'capability' || !n.capabilityKey) return false;
    return findCapability(catalog, n.capabilityKey)?.p50LatencyMs !== null;
  });
  if (!anyDeclared) return null;

  const paths = blueprint.nodes.map((n) => walk(n.id));
  return paths.length > 0 ? Math.max(...paths) : null;
}

/** One-line summary for a header or a chip. */
export function formatEstimate(estimate: Estimate): string {
  const money = `$${estimate.totalUsd.toFixed(estimate.totalUsd < 0.01 ? 4 : 2)}`;
  const parts = [`${money} · ${estimate.hops} hop${estimate.hops === 1 ? '' : 's'}`];
  if (estimate.criticalPathMs !== null) parts.push(`≥${estimate.criticalPathMs} ms`);
  if (estimate.unpricedCapabilities.length > 0) {
    parts.push(`+${estimate.unpricedCapabilities.length} unpriced`);
  }
  return parts.join(' · ');
}
