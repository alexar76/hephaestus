/**
 * The estimate is the studio's one real claim, so it has to be arithmetically boring.
 *
 * Two ways a cost estimate lies, both pinned here: treating an unpriced hop as free, and
 * summing $0.001 and $0.004 in floating point until the total no longer matches the rows
 * it came from. The catalogue's actual prices are exactly that small.
 */

import { describe, expect, it } from 'vitest';

import { catalogFromManifest } from '@/catalog';
import { estimateBlueprint, formatEstimate } from '@/estimate';
import type { Blueprint, Capability } from '@/types';

const CATALOG: Capability[] = catalogFromManifest({
  tools: [
    {
      name: 'sensor', product_id: 'gaia.gateway', capability_id: 'gaia.point.read@v1',
      price_per_call_usd: 0.001, p50_latency_ms: 80,
      reputation_basis: 'measured', observations_30d: 12, success_rate_30d: 1,
      input_schema: { type: 'object', properties: {} }, output_schema: { type: 'object' },
    },
    {
      name: 'oracle', product_id: 'prod-platon', capability_id: 'platon.random@v1',
      price_per_call_usd: 0.004, p50_latency_ms: 5,
      reputation_basis: 'unobserved', observations_30d: 0,
      input_schema: { type: 'object', properties: {} }, output_schema: { type: 'object' },
    },
    {
      name: 'routed', product_id: 'atlas.products', capability_id: 'atlas.point.read@v1',
      price_per_call_usd: 0.01, routed_price_usd: 0.011, p50_latency_ms: 200,
      reputation_basis: 'unobserved', observations_30d: 0,
      input_schema: { type: 'object', properties: {} }, output_schema: { type: 'object' },
    },
    {
      name: 'free-form', product_id: 'prod-x', capability_id: 'unpriced@v1',
      price_per_call_usd: null, input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object' },
    },
  ],
}).capabilities;

const cap = (id: string, key: string) => ({
  id, kind: 'capability' as const, label: id, capabilityKey: key, input: {},
});

const graph = (keys: string[], edges: [string, string][] = []): Blueprint => ({
  name: 'estimate', description: '',
  nodes: keys.map((key, i) => cap(`n${i}`, key)),
  edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
});

describe('money', () => {
  it('sums the small prices exactly', () => {
    const bp = graph([
      'gaia.gateway::gaia.point.read@v1',
      'gaia.gateway::gaia.point.read@v1',
      'gaia.gateway::gaia.point.read@v1',
      'prod-platon::platon.random@v1',
    ], [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']]);

    const estimate = estimateBlueprint(bp, CATALOG);
    // 0.001*3 + 0.004 — in floating point this addition does not land on 0.007.
    expect(estimate.totalUsd).toBe(0.007);
    expect(estimate.pricedHops).toBe(4);
  });

  it('charges the routed price, not the provider ask', () => {
    const bp = graph(['atlas.products::atlas.point.read@v1']);
    expect(estimateBlueprint(bp, CATALOG).totalUsd).toBe(0.011);
  });

  it('names an unpriced hop instead of counting it as free', () => {
    const bp = graph(['prod-x::unpriced@v1', 'prod-platon::platon.random@v1'], [['n0', 'n1']]);
    const estimate = estimateBlueprint(bp, CATALOG);

    expect(estimate.totalUsd).toBe(0.004);
    expect(estimate.pricedHops).toBe(1);
    expect(estimate.hops).toBe(2);
    expect(estimate.unpricedCapabilities).toEqual(['unpriced@v1']);
    expect(estimate.notes.some((n) => n.includes('publish no price'))).toBe(true);
  });

  it('does not estimate a node that is not in the catalogue', () => {
    const bp = graph(['prod-gone::vanished@v1']);
    const estimate = estimateBlueprint(bp, CATALOG);
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.notes.some((n) => n.includes('not in the catalogue'))).toBe(true);
  });
});

describe('latency', () => {
  it('takes the longest branch, not the sum of all of them', () => {
    // n0 → n1 (200ms) and n0 → n2 (5ms): the path is 80+200, not 80+200+5.
    const bp = graph([
      'gaia.gateway::gaia.point.read@v1',
      'atlas.products::atlas.point.read@v1',
      'prod-platon::platon.random@v1',
    ], [['n0', 'n1'], ['n0', 'n2']]);

    expect(estimateBlueprint(bp, CATALOG).criticalPathMs).toBe(280);
  });

  it('reports nothing rather than zero when no hop declares a latency', () => {
    const bp = graph(['prod-x::unpriced@v1']);
    const estimate = estimateBlueprint(bp, CATALOG);
    expect(estimate.criticalPathMs).toBeNull();
    expect(estimate.unknownLatencyCapabilities).toEqual(['unpriced@v1']);
  });

  it('does not hang on a cycle', () => {
    const bp = graph([
      'gaia.gateway::gaia.point.read@v1',
      'prod-platon::platon.random@v1',
    ], [['n0', 'n1'], ['n1', 'n0']]);
    expect(estimateBlueprint(bp, CATALOG).criticalPathMs).toBeGreaterThan(0);
  });
});

describe('what the buyer is warned about', () => {
  it('counts hops whose reliability nothing has measured', () => {
    const bp = graph([
      'gaia.gateway::gaia.point.read@v1',
      'prod-platon::platon.random@v1',
    ], [['n0', 'n1']]);
    const estimate = estimateBlueprint(bp, CATALOG);

    expect(estimate.unobservedCapabilities).toEqual(['platon.random@v1']);
    expect(estimate.notes.some((n) => n.includes('1 of 2 hops have no observed success rate'))).toBe(true);
  });

  it('flags a graph the executor would reject', () => {
    const bp = graph(Array.from({ length: 17 }, () => 'prod-platon::platon.random@v1'));
    const estimate = estimateBlueprint(bp, CATALOG);
    expect(estimate.overPipelineLimit).toBe(true);
    expect(estimate.notes.some((n) => n.includes('at most 16 capabilities'))).toBe(true);
  });
});

describe('formatting', () => {
  it('keeps four decimals while the total is sub-cent', () => {
    const bp = graph(['prod-platon::platon.random@v1']);
    expect(formatEstimate(estimateBlueprint(bp, CATALOG))).toBe('$0.0040 · 1 hop · ≥5 ms');
  });

  it('mentions what it could not price', () => {
    const bp = graph(['prod-x::unpriced@v1', 'prod-platon::platon.random@v1'], [['n0', 'n1']]);
    expect(formatEstimate(estimateBlueprint(bp, CATALOG))).toContain('+1 unpriced');
  });
});
