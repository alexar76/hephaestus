/**
 * The example is discovered from the catalogue, never hard-coded.
 *
 * A curated pair would go stale the first time a capability was renamed or unpriced, and
 * the page would then advertise something that is not on sale. So the pair is found by
 * matching a producer's declared output field names against a consumer's required inputs —
 * which is also exactly the wiring the executor's `${hop.field}` can express.
 */

import { describe, expect, it } from 'vitest';

import { catalogFromManifest } from '@/catalog';
import { exampleBlueprint, isReference, referencedHops } from '@/example';
import { validateBlueprint } from '@/blueprint';
import { estimateBlueprint } from '@/estimate';

const READ = {
  name: 'weather', product_id: 'gaia.gateway', capability_id: 'gaia.weather.read@v1',
  price_per_call_usd: 0.001, p50_latency_ms: 80,
  input_schema: { type: 'object', properties: { device_id: { type: 'string' } } },
  output_schema: { type: 'object', properties: { reading: { type: 'object' }, attestation: { type: 'object' } } },
};
const VERIFY = {
  name: 'verify', product_id: 'gaia.gateway', capability_id: 'gaia.verify@v1',
  price_per_call_usd: 0.002, p50_latency_ms: 5,
  input_schema: {
    type: 'object',
    properties: { reading: { type: 'object' }, attestation: { type: 'object' }, min_verify_score: { type: 'number' } },
    required: ['reading'],
  },
  output_schema: { type: 'object', properties: { verified: { type: 'boolean' }, score: { type: 'number' } } },
};
const LONELY = {
  name: 'lonely', product_id: 'p', capability_id: 'lonely@v1', price_per_call_usd: 0.004,
  input_schema: { type: 'object', properties: {} },
  output_schema: { type: 'object', properties: { whatever: { type: 'string' } } },
};

const catalogOf = (tools: unknown[]) => catalogFromManifest({ tools }).capabilities;

describe('exampleBlueprint', () => {
  it('wires a producer into the consumer that requires its field', () => {
    const result = exampleBlueprint(catalogOf([READ, VERIFY]))!;
    expect(result).not.toBeNull();

    const check = result.blueprint.nodes.find((n) => n.id === 'check')!;
    expect(check.capabilityKey).toBe('gaia.gateway::gaia.verify@v1');
    expect(check.input.reading).toBe('${read.reading}');
    expect(check.input.attestation).toBe('${read.attestation}');
    expect(result.note).toContain('reading');
  });

  it('produces a graph that validates and prices without any typing', () => {
    const catalog = catalogOf([READ, VERIFY]);
    const { blueprint } = exampleBlueprint(catalog)!;

    expect(validateBlueprint(blueprint, catalog).errors).toEqual([]);
    const estimate = estimateBlueprint(blueprint, catalog);
    expect(estimate.hops).toBe(2);
    expect(estimate.totalUsd).toBe(0.003);
  });

  it('marks the connection as the data source', () => {
    const { blueprint } = exampleBlueprint(catalogOf([READ, VERIFY]))!;
    const dataEdges = blueprint.edges.filter((e) => e.carriesData);
    expect(dataEdges).toHaveLength(1);
    expect(dataEdges[0]).toMatchObject({ source: 'read', target: 'check' });
  });

  it('falls back to one priced hop when nothing pairs up', () => {
    const result = exampleBlueprint(catalogOf([LONELY]))!;
    expect(result.blueprint.nodes.filter((n) => n.kind === 'capability')).toHaveLength(1);
    expect(result.note).toContain('single hop');
  });

  it('prefers the cheaper pair', () => {
    const pricey = { ...VERIFY, capability_id: 'gaia.verify.pro@v1', price_per_call_usd: 0.5 };
    const { blueprint } = exampleBlueprint(catalogOf([READ, pricey, VERIFY]))!;
    const check = blueprint.nodes.find((n) => n.id === 'check')!;
    expect(check.capabilityKey).toBe('gaia.gateway::gaia.verify@v1');
  });

  it('never picks a producer whose own required fields need typing', () => {
    const needsTyping = {
      ...READ, capability_id: 'needs.typing@v1',
      input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    };
    const { blueprint } = exampleBlueprint(catalogOf([needsTyping, VERIFY, READ]))!;
    const read = blueprint.nodes.find((n) => n.id === 'read')!;
    expect(read.capabilityKey).toBe('gaia.gateway::gaia.weather.read@v1');
  });

  it('returns null for an empty catalogue rather than inventing a capability', () => {
    expect(exampleBlueprint([])).toBeNull();
  });
});

describe('reference helpers', () => {
  it('recognises a whole reference and rejects prose', () => {
    expect(isReference('${a.b}')).toBe(true);
    expect(isReference('  ${a}  ')).toBe(true);
    expect(isReference('value: ${a.b}')).toBe(false);
    expect(isReference('plain')).toBe(false);
    expect(isReference(42)).toBe(false);
  });

  it('finds every hop mentioned, however nested', () => {
    expect(referencedHops({ a: '${x.f}', b: ['${y}', { c: 'at ${z.q}' }] }).sort())
      .toEqual(['x', 'y', 'z']);
  });
});

describe('which pair the example picks', () => {
  it('prefers the pair that threads more fields over the cheaper coincidence', () => {
    // A free hop whose `count` happens to fit another hop's `count` is valid and cheap,
    // and demonstrates nothing. The reading+attestation pair costs more and shows the point.
    const FLEET = {
      name: 'fleet', product_id: 'gaia.gateway', capability_id: 'gaia.fleet.status@v1',
      price_per_call_usd: 0,
      input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: { devices: { type: 'array' }, count: { type: 'integer' } } },
    };
    const NOISE = {
      name: 'noise', product_id: 'prod-turing', capability_id: 'turing.bluenoise@v1',
      price_per_call_usd: 0.002,
      input_schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
      output_schema: { type: 'object', properties: { points: { type: 'array' } } },
    };

    const catalog = catalogOf([FLEET, NOISE, READ, VERIFY]);
    const { blueprint, note } = exampleBlueprint(catalog)!;
    const check = blueprint.nodes.find((n) => n.id === 'check')!;

    expect(check.capabilityKey).toBe('gaia.gateway::gaia.verify@v1');
    expect(note).toContain('attestation');
  });
});
