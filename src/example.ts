/**
 * A ready chain built from whatever the live catalogue actually offers.
 *
 * The page used to open on two empty boxes — a trigger and an output — and three red
 * errors. Everything that makes it worth using (a real price on a real graph) only
 * appeared after the visitor had guessed which of seventy-six rows to click. That is a
 * product defect, not a user error.
 *
 * The chain is DISCOVERED, not hard-coded: a hop whose output declares the field a second
 * hop requires, wired by that field name. So it keeps working when the catalogue changes,
 * and it cannot advertise a capability that is not on sale today. If nothing pairs up, a
 * single priced hop is still better than an empty canvas.
 */

import { findCapability } from './catalog';
import type { Blueprint, BlueprintNode, Capability, FieldSpec } from './types';

const isFillable = (capability: Capability): boolean =>
  capability.inputFields.every((f) => !f.required || f.default !== undefined);

const priceOf = (capability: Capability): number =>
  capability.routedPriceUsd ?? capability.priceUsd ?? Number.POSITIVE_INFINITY;

const defaultsFor = (capability: Capability): Record<string, unknown> =>
  Object.fromEntries(
    capability.inputFields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]),
  );

/** Fields of `consumer` that `producer` can supply, matched by declared name. */
function wirableFields(producer: Capability, consumer: Capability): FieldSpec[] {
  const produced = new Set(producer.outputFields);
  return consumer.inputFields.filter((f) => produced.has(f.name));
}

function canBeFedBy(producer: Capability, consumer: Capability): boolean {
  const required = consumer.inputFields.filter((f) => f.required);
  if (required.length === 0) return false; // nothing to thread; not a demonstration of piping
  const wirable = new Set(wirableFields(producer, consumer).map((f) => f.name));
  return required.every((f) => wirable.has(f.name) || f.default !== undefined);
}

export interface ExampleResult {
  blueprint: Blueprint;
  /** What the example demonstrates, in one line, for the UI to show. */
  note: string;
}

/**
 * Build a two-hop chain whose second hop is genuinely fed by the first.
 *
 * Ranked by how much data the pair threads, then by price — the example exists to show
 * field-to-field piping, and among equally demonstrative pairs the cheaper one wins,
 * because running it spends the visitor's money.
 */
export function exampleBlueprint(catalog: Capability[]): ExampleResult | null {
  const usable = catalog.filter((c) => c.composable.outputDeclared && c.composable.inputDeclared);
  const producers = usable.filter((c) => isFillable(c) && c.outputFields.length > 0);

  // Ranked by how MUCH data the pair threads, then by price. Cheapest-only picked the
  // cheapest coincidence in the catalogue — a device count wired into a point count,
  // valid but arbitrary — while a pair that hands over a reading AND its attestation
  // demonstrates the thing the example exists to demonstrate. Still discovered, not
  // curated: the ranking is over whatever the catalogue offers today.
  let best: { producer: Capability; consumer: Capability; total: number; wired: number } | null =
    null;
  for (const producer of producers) {
    for (const consumer of usable) {
      if (consumer.key === producer.key) continue;
      if (!canBeFedBy(producer, consumer)) continue;
      const total = priceOf(producer) + priceOf(consumer);
      if (!Number.isFinite(total)) continue;
      const wired = wirableFields(producer, consumer).length;
      const better =
        !best || wired > best.wired || (wired === best.wired && total < best.total);
      if (better) best = { producer, consumer, total, wired };
    }
  }

  if (best) {
    const { producer, consumer } = best;
    const wired = wirableFields(producer, consumer);
    const input: Record<string, unknown> = { ...defaultsFor(consumer) };
    for (const field of wired) input[field.name] = `\${read.${field.name}}`;

    const nodes: BlueprintNode[] = [
      { id: 'trigger', kind: 'trigger', label: 'Start', input: {}, position: { x: 60, y: 40 } },
      {
        id: 'read',
        kind: 'capability',
        label: producer.capabilityId,
        capabilityKey: producer.key,
        input: defaultsFor(producer),
        position: { x: 60, y: 170 },
      },
      {
        id: 'check',
        kind: 'capability',
        label: consumer.capabilityId,
        capabilityKey: consumer.key,
        input,
        position: { x: 60, y: 320 },
      },
      { id: 'output', kind: 'output', label: 'Result', input: {}, position: { x: 60, y: 470 } },
    ];

    return {
      blueprint: {
        name: 'example',
        description: `${producer.capabilityId} → ${consumer.capabilityId}`,
        nodes,
        edges: [
          { id: 'e1', source: 'trigger', target: 'read' },
          { id: 'e2', source: 'read', target: 'check', carriesData: true },
          { id: 'e3', source: 'check', target: 'output' },
        ],
      },
      note: `${wired.map((f) => f.name).join(', ')} flows from ${producer.capabilityId} into ${consumer.capabilityId}`,
    };
  }

  // Nothing in this catalogue pairs up by field name. One priced hop still shows a real
  // price on a real capability, which is the thing the empty canvas failed to show.
  const single = producers.sort((a, b) => priceOf(a) - priceOf(b))[0];
  if (!single) return null;
  return {
    blueprint: {
      name: 'example',
      description: single.capabilityId,
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', input: {}, position: { x: 60, y: 40 } },
        {
          id: 'read',
          kind: 'capability',
          label: single.capabilityId,
          capabilityKey: single.key,
          input: defaultsFor(single),
          position: { x: 60, y: 190 },
        },
        { id: 'output', kind: 'output', label: 'Result', input: {}, position: { x: 60, y: 340 } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'read' },
        { id: 'e2', source: 'read', target: 'output' },
      ],
    },
    note: 'no two capabilities in this catalogue share a field name, so this example is a single hop',
  };
}

/** True when a value is a `${hop.field}` reference rather than a literal. */
export const isReference = (value: unknown): boolean =>
  typeof value === 'string' && /^\s*\$\{[^{}\s.]+(\.[^{}\s.]+)*\}\s*$/.test(value);

/** Hop ids referenced anywhere inside a value. */
export function referencedHops(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\$\{([^{}\s.]+)((?:\.[^{}\s.]+)*)\}/g)) out.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}

export { findCapability };
