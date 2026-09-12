/**
 * The catalogue is the hub's manifest, normalised — and the reputation rules are the point.
 *
 * The live manifest published `success_rate_30d: 0.5` and `trust_score: 0.5` on all
 * seventy-six rows: a neutral placeholder the hub uses because peer-declared rates are not
 * trustworthy, indistinguishable from a measurement to anything reading the number. The
 * hub now says which it is; these tests pin that this module refuses to pass on a number
 * the hub did not stand behind, because rendering it is how "the network looks half
 * broken" gets shipped to a buyer.
 */

import { describe, expect, it } from 'vitest';

import { capabilityKey, catalogFromManifest, findCapability, reputationLabel } from '@/catalog';

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'platon.random@v1',
  description: 'Signed chaos-VRF randomness',
  product_id: 'prod-platon',
  capability_id: 'platon.random@v1',
  source_hub: 'https://oracles.modelmarket.dev/family',
  source_hub_name: 'Oracle family',
  price_per_call_usd: 0.004,
  p50_latency_ms: 5,
  success_rate_30d: 0.5,
  trust_score: 0.5,
  reputation_basis: 'unobserved',
  observations_30d: 0,
  input_schema: {
    type: 'object',
    properties: { num_bytes: { type: 'integer', default: 32 }, client_seed: { type: 'string' } },
    required: ['num_bytes'],
  },
  output_schema: { type: 'object', properties: { random_hex: { type: 'string' } } },
  ...over,
});

const manifest = (tools: unknown[], over: Record<string, unknown> = {}) => ({
  protocol_version: 'v2',
  generated_at: '2026-08-21T00:00:00Z',
  base_url: 'https://modelmarket.dev',
  tools,
  by_hub: { local: {}, 'https://atlas.modelmarket.dev': {} },
  signature: { algorithm: 'ed25519', value: 'sig' },
  ...over,
});

describe('normalisation', () => {
  it('keys a capability by the pair the hub routes on', () => {
    const { capabilities } = catalogFromManifest(manifest([tool()]));
    expect(capabilities[0]!.key).toBe(capabilityKey('prod-platon', 'platon.random@v1'));
    expect(findCapability(capabilities, 'prod-platon::platon.random@v1')).toBeDefined();
  });

  it('reads input fields with their requiredness and defaults', () => {
    const { capabilities } = catalogFromManifest(manifest([tool()]));
    const fields = capabilities[0]!.inputFields;
    expect(fields.map((f) => f.name)).toEqual(['num_bytes', 'client_seed']);
    expect(fields[0]).toMatchObject({ type: 'integer', required: true, default: 32 });
    expect(fields[1]!.required).toBe(false);
  });

  it('keeps a JSON Schema type union readable instead of picking one', () => {
    const { capabilities } = catalogFromManifest(
      manifest([tool({ input_schema: { type: 'object', properties: { km: { type: ['number', 'null'] } } } })]),
    );
    expect(capabilities[0]!.inputFields[0]!.type).toBe('number|null');
  });

  it('drops a row that cannot be invoked and says why', () => {
    const { capabilities, skipped } = catalogFromManifest(
      manifest([tool(), { name: 'orphan', capability_id: 'x@v1' }]),
    );
    expect(capabilities).toHaveLength(1);
    expect(skipped[0]!.reason).toContain('missing product_id');
  });

  it('keeps the first offer when two hubs sell the same capability', () => {
    const { capabilities, skipped } = catalogFromManifest(
      manifest([tool({ source_hub: 'https://a.example' }), tool({ source_hub: 'https://b.example' })]),
    );
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.sourceHub).toBe('https://a.example');
    expect(skipped[0]!.reason).toContain('duplicate offer');
  });

  it('never coerces a missing price to zero', () => {
    const { capabilities } = catalogFromManifest(
      manifest([tool({ price_per_call_usd: null, p50_latency_ms: undefined })]),
    );
    expect(capabilities[0]!.priceUsd).toBeNull();
    expect(capabilities[0]!.p50LatencyMs).toBeNull();
  });

  it('survives a manifest that is not one', () => {
    expect(catalogFromManifest(null).capabilities).toEqual([]);
    expect(catalogFromManifest({ tools: 'nope' }).capabilities).toEqual([]);
    expect(catalogFromManifest({}).signed).toBe(false);
  });
});

describe('reputation honesty', () => {
  it('discards an unobserved rate rather than showing it as a score', () => {
    const { capabilities } = catalogFromManifest(manifest([tool()]));
    const { reputation } = capabilities[0]!;
    expect(reputation.basis).toBe('unobserved');
    expect(reputation.successRate).toBeNull();
    expect(reputation.trustScore).toBeNull();
    expect(reputationLabel(reputation)).toBe('no calls yet');
  });

  it('carries a measured rate through with its evidence', () => {
    const { capabilities } = catalogFromManifest(
      manifest([tool({ reputation_basis: 'measured', observations_30d: 4, success_rate_30d: 0.75 })]),
    );
    const { reputation } = capabilities[0]!;
    expect(reputation.successRate).toBe(0.75);
    expect(reputationLabel(reputation)).toBe('75% over 4 calls (30d)');
  });

  it('treats a hub that says nothing as unknown, not as bad', () => {
    const older = tool();
    delete (older as Record<string, unknown>).reputation_basis;
    delete (older as Record<string, unknown>).observations_30d;
    const { capabilities } = catalogFromManifest(manifest([older]));
    expect(capabilities[0]!.reputation.basis).toBe('unknown');
    expect(capabilities[0]!.reputation.successRate).toBeNull();
    expect(reputationLabel(capabilities[0]!.reputation)).toBe('not reported');
  });

  it('singularises one observation', () => {
    const { capabilities } = catalogFromManifest(
      manifest([tool({ reputation_basis: 'measured', observations_30d: 1, success_rate_30d: 1 })]),
    );
    expect(reputationLabel(capabilities[0]!.reputation)).toBe('100% over 1 call (30d)');
  });
});

describe('composability', () => {
  it('separates "takes no input" from "does not say"', () => {
    const explicit = tool({ capability_id: 'platon.state@v1', input_schema: { type: 'object', properties: {} } });
    const silent = tool({ capability_id: 'mystery@v1', input_schema: {} });
    const { capabilities } = catalogFromManifest(manifest([explicit, silent]));

    const state = findCapability(capabilities, 'prod-platon::platon.state@v1')!;
    expect(state.composable.inputDeclared).toBe(true);
    expect(state.composable.takesNoInput).toBe(true);

    const mystery = findCapability(capabilities, 'prod-platon::mystery@v1')!;
    expect(mystery.composable.inputDeclared).toBe(false);
    expect(mystery.composable.takesNoInput).toBe(false);
  });

  it('flags a capability that never declared what it returns', () => {
    const { capabilities } = catalogFromManifest(manifest([tool({ output_schema: {} })]));
    expect(capabilities[0]!.composable.outputDeclared).toBe(false);
    expect(capabilities[0]!.outputFields).toEqual([]);
  });
});
