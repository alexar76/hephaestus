/**
 * Blueprint validation and conversion to a real pipeline request.
 *
 * The conversion is the honest half of the studio. A canvas can draw anything; the
 * executor accepts a specific shape and enforces specific limits, so a graph that cannot
 * be expressed must be refused HERE, with a reason, rather than exported as JSON that
 * fails or — worse — succeeds while feeding a hop from the wrong upstream.
 *
 * Two limits come straight from the executor and are not negotiable in the UI:
 *   * at most sixteen nodes per pipeline (`PipelineRequest.nodes` max_length)
 *   * one data-carrying parent per node (`input_from` names a single node)
 */

import { findCapability } from './catalog';
import { referencedHops } from './example';
import { PIPELINE_MAX_NODES } from './types';
import type {
  Blueprint,
  BlueprintNode,
  Capability,
  PipelineRequest,
  PipelineRequestNode,
} from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const label = (node: BlueprintNode): string => node.label || node.id;

function parentsOf(blueprint: Blueprint): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const node of blueprint.nodes) parents.set(node.id, []);
  for (const edge of blueprint.edges) {
    if (!parents.has(edge.target)) continue;
    parents.get(edge.target)!.push(edge.source);
  }
  return parents;
}

/**
 * Nearest capability ancestors of a node, looking through local markers.
 *
 * `trigger → search → output` puts one node in the pipeline, not three: triggers and
 * outputs are studio furniture. So a dependency edge that passes through furniture still
 * has to connect the capabilities on either side of it.
 */
function capabilityAncestors(
  nodeId: string,
  blueprint: Blueprint,
  parents: Map<string, string[]>,
  byId: Map<string, BlueprintNode>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue = [...(parents.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = byId.get(current);
    if (!node) continue;
    if (node.kind === 'capability') {
      found.push(current);
      continue; // its own ancestry is its problem, not ours
    }
    queue.push(...(parents.get(current) ?? []));
  }
  return found;
}


/** Every node that is guaranteed to run before this one, following all edges upward. */
function capabilityAncestorsDeep(
  nodeId: string,
  blueprint: Blueprint,
  parents: Map<string, string[]>,
): string[] {
  const seen = new Set<string>();
  const queue = [...(parents.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(parents.get(current) ?? []));
  }
  return [...seen];
}

function detectCycle(blueprint: Blueprint): string[] {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of blueprint.nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of blueprint.edges) {
    if (!outgoing.has(edge.source) || !indegree.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return visited === blueprint.nodes.length ? [] : ['Graph contains a cycle'];
}

export function validateBlueprint(blueprint: Blueprint, catalog: Capability[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = blueprint.nodes.map((n) => n.id);
  const known = new Set(ids);
  const byId = new Map(blueprint.nodes.map((n) => [n.id, n]));

  if (blueprint.nodes.length === 0) errors.push('Blueprint has no nodes');
  if (new Set(ids).size !== ids.length) errors.push('Node ids must be unique');

  const edgeIds = blueprint.edges.map((e) => e.id);
  if (new Set(edgeIds).size !== edgeIds.length) errors.push('Connection ids must be unique');

  for (const edge of blueprint.edges) {
    if (!known.has(edge.source)) errors.push(`Connection "${edge.id}" starts at an unknown node`);
    if (!known.has(edge.target)) errors.push(`Connection "${edge.id}" ends at an unknown node`);
    if (edge.source === edge.target) errors.push(`Connection "${edge.id}" loops a node to itself`);
  }

  errors.push(...detectCycle(blueprint));

  const capabilityNodes = blueprint.nodes.filter((n) => n.kind === 'capability');
  if (capabilityNodes.length === 0) errors.push('Blueprint runs nothing: add at least one capability');
  if (capabilityNodes.length > PIPELINE_MAX_NODES) {
    errors.push(
      `Pipelines take at most ${PIPELINE_MAX_NODES} capabilities; this blueprint has ` +
        `${capabilityNodes.length}. Split it into stages.`,
    );
  }

  const connected = new Set(
    blueprint.edges.flatMap((e) => (known.has(e.source) && known.has(e.target) ? [e.source, e.target] : [])),
  );
  for (const node of blueprint.nodes) {
    if (blueprint.nodes.length > 1 && !connected.has(node.id)) {
      errors.push(`"${label(node)}" is not connected to anything`);
    }
    if (!node.label?.trim()) errors.push(`Node "${node.id}" has no label`);
  }

  for (const node of capabilityNodes) {
    if (!node.capabilityKey) {
      errors.push(`"${label(node)}" does not reference a capability`);
      continue;
    }
    const capability = findCapability(catalog, node.capabilityKey);
    if (!capability) {
      // The catalogue is live, so this is the normal way a saved blueprint goes stale.
      errors.push(
        `"${label(node)}" references ${node.capabilityKey}, which the catalogue no longer offers`,
      );
      continue;
    }
    if (!capability.composable.inputDeclared) {
      warnings.push(
        `${capability.capabilityId} does not declare its input fields — its parameters cannot be checked here`,
      );
    }
    if (!capability.composable.outputDeclared) {
      warnings.push(
        `${capability.capabilityId} does not declare an output schema — nothing downstream can rely on its result`,
      );
    }
    if (capability.priceUsd === null) {
      warnings.push(`${capability.capabilityId} publishes no price — it is not included in the estimate`);
    }
    for (const field of capability.inputFields) {
      if (!field.required) continue;
      const value = node.input[field.name];
      // A `${hop.field}` reference IS a filled field — the value arrives from that hop at
      // run time. Reporting it as missing is what made every real chain look broken.
      if (value === undefined || value === null || value === '') {
        errors.push(`"${label(node)}" needs "${field.name}" (${field.type})`);
      }
    }

    // References are checked the way the executor checks them, so a graph the studio
    // accepts is a graph the executor will not refuse: the hop must exist, must not be
    // itself, and must be guaranteed to run first.
    const ancestors = new Set(capabilityAncestorsDeep(node.id, blueprint, parentsOf(blueprint)));
    for (const referenced of referencedHops(node.input)) {
      if (referenced === node.id) {
        errors.push(`"${label(node)}" references its own result`);
      } else if (!known.has(referenced)) {
        errors.push(`"${label(node)}" references "${referenced}", which is not on the canvas`);
      } else if (!ancestors.has(referenced)) {
        errors.push(
          `"${label(node)}" reads from "${referenced}", but nothing guarantees it runs first — ` +
            'connect them',
        );
      }
    }
  }

  // One data-carrying parent per node — the executor's `input_from` names exactly one.
  const dataParents = new Map<string, number>();
  for (const edge of blueprint.edges) {
    if (!edge.carriesData) continue;
    dataParents.set(edge.target, (dataParents.get(edge.target) ?? 0) + 1);
  }
  for (const [target, count] of dataParents) {
    if (count > 1) {
      const node = byId.get(target);
      errors.push(
        `"${node ? label(node) : target}" is fed by ${count} connections at once. A hop receives ` +
          'data from one upstream node; mark a single connection as the data source.',
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export type ConversionResult =
  | { ok: true; request: PipelineRequest; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Turn a validated blueprint into the body of `POST /ai-market/pipelines`.
 *
 * Only capability nodes travel: triggers and outputs are how a person reads the canvas,
 * not hops anyone is billed for.
 */
export function toPipelineRequest(
  blueprint: Blueprint,
  catalog: Capability[],
  options: { channelId?: string } = {},
): ConversionResult {
  const validation = validateBlueprint(blueprint, catalog);
  if (!validation.valid) return { ok: false, errors: validation.errors };

  const byId = new Map(blueprint.nodes.map((n) => [n.id, n]));
  const parents = parentsOf(blueprint);
  const capabilityNodes = blueprint.nodes.filter((n) => n.kind === 'capability');
  const capabilityIds = new Set(capabilityNodes.map((n) => n.id));

  const dependsOn = new Map<string, string[]>();
  for (const node of capabilityNodes) {
    dependsOn.set(
      node.id,
      capabilityAncestors(node.id, blueprint, parents, byId).filter((id) => capabilityIds.has(id)),
    );
  }

  // Emit in dependency order. The executor topologically sorts too, but a request whose
  // own order is arbitrary is harder to read in a trace than one that already reads
  // top-to-bottom, and the ordering here is what the estimate's critical path used.
  const emitted: string[] = [];
  const placed = new Set<string>();
  let progressed = true;
  while (progressed && emitted.length < capabilityNodes.length) {
    progressed = false;
    for (const node of capabilityNodes) {
      if (placed.has(node.id)) continue;
      if ((dependsOn.get(node.id) ?? []).every((dep) => placed.has(dep))) {
        emitted.push(node.id);
        placed.add(node.id);
        progressed = true;
      }
    }
  }
  if (emitted.length !== capabilityNodes.length) {
    return { ok: false, errors: ['Graph contains a cycle'] };
  }

  const dataParentOf = new Map<string, string>();
  for (const edge of blueprint.edges) {
    if (!edge.carriesData) continue;
    const source = byId.get(edge.source);
    if (!source) continue;
    if (source.kind === 'capability') {
      dataParentOf.set(edge.target, edge.source);
      continue;
    }
    // A data edge drawn from furniture means "take the upstream capability's result".
    const [ancestor] = capabilityAncestors(edge.source, blueprint, parents, byId);
    if (ancestor) dataParentOf.set(edge.target, ancestor);
  }

  const nodes: PipelineRequestNode[] = emitted.map((id) => {
    const node = byId.get(id)!;
    const capability = findCapability(catalog, node.capabilityKey!)!;
    const source = dataParentOf.get(id);
    return {
      id,
      product_id: capability.productId,
      capability_id: capability.capabilityId,
      input: { ...node.input },
      depends_on: dependsOn.get(id) ?? [],
      // The catalogue knows which peer sells this row; the executor cannot guess it, and
      // without it a federated hop is looked up in the wrong inventory.
      ...(capability.sourceHub && capability.sourceHub !== 'local'
        ? { source_hub: capability.sourceHub }
        : {}),
      ...(source && capabilityIds.has(source) ? { input_from: source } : {}),
    };
  });

  return {
    ok: true,
    request: { nodes, ...(options.channelId ? { channel_id: options.channelId } : {}) },
    warnings: validation.warnings,
  };
}
