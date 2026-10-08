/**
 * A blueprint either converts to a request the executor can run, or it is refused here.
 *
 * The refusals are the interesting part. A canvas will happily draw a graph with two
 * upstreams feeding one hop, seventeen paid steps, or a node pointing at a capability the
 * catalogue dropped last week — and each of those either fails at the executor or, in the
 * fan-in case, used to succeed while feeding the hop from the wrong parent.
 */

import { describe, expect, it } from 'vitest';

import { toPipelineRequest, validateBlueprint } from '@/blueprint';
import { catalogFromManifest } from '@/catalog';
import type { Blueprint, Capability } from '@/types';

const CATALOG: Capability[] = catalogFromManifest({
  tools: [
    {
      name: 'search', product_id: 'prod-mcp', capability_id: 'web.search@v1',
      price_per_call_usd: 0.01, p50_latency_ms: 300,
      reputation_basis: 'measured', observations_30d: 10, success_rate_30d: 0.9,
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      output_schema: { type: 'object', properties: { results: { type: 'array' } } },
    },
    {
      name: 'verify', product_id: 'prod-metis', capability_id: 'metis.verify@v1',
      price_per_call_usd: 0.005, p50_latency_ms: 900,
      reputation_basis: 'unobserved', observations_30d: 0, success_rate_30d: 0.5,
      input_schema: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] },
      output_schema: { type: 'object', properties: { verdict: { type: 'string' } } },
    },
    {
      name: 'random', product_id: 'prod-platon', capability_id: 'platon.random@v1',
      price_per_call_usd: 0.004, p50_latency_ms: 5,
      reputation_basis: 'unobserved', observations_30d: 0,
      input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: { random_hex: { type: 'string' } } },
    },
    {
      name: 'silent', product_id: 'prod-x', capability_id: 'silent@v1',
      price_per_call_usd: null, input_schema: {}, output_schema: {},
    },
  ],
}).capabilities;

const node = (
  id: string,
  kind: Blueprint['nodes'][number]['kind'],
  over: Partial<Blueprint['nodes'][number]> = {},
) => ({ id, kind, label: id, input: {}, ...over });

const chain = (): Blueprint => ({
  name: 'verify a claim',
  description: 'search then verify',
  nodes: [
    node('t', 'trigger'),
    node('s', 'capability', { capabilityKey: 'prod-mcp::web.search@v1', input: { query: 'a claim' } }),
    node('v', 'capability', { capabilityKey: 'prod-metis::metis.verify@v1', input: { claim: 'a claim' } }),
    node('o', 'output'),
  ],
  edges: [
    { id: 'e1', source: 't', target: 's' },
    { id: 'e2', source: 's', target: 'v', carriesData: true },
    { id: 'e3', source: 'v', target: 'o' },
  ],
});

describe('validation', () => {
  it('accepts a well-formed chain', () => {
    const result = validateBlueprint(chain(), CATALOG);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('requires a required input to be filled', () => {
    const bp = chain();
    bp.nodes[1]!.input = {};
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('needs "query"'))).toBe(true);
  });

  it('refuses a blueprint that runs nothing', () => {
    const bp: Blueprint = {
      name: 'empty', description: '',
      nodes: [node('t', 'trigger'), node('o', 'output')],
      edges: [{ id: 'e', source: 't', target: 'o' }],
    };
    expect(validateBlueprint(bp, CATALOG).errors).toContain(
      'Blueprint runs nothing: add at least one capability',
    );
  });

  it('names a capability the catalogue no longer offers', () => {
    const bp = chain();
    bp.nodes[1]!.capabilityKey = 'prod-gone::vanished@v1';
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('no longer offers'))).toBe(true);
  });

  it('refuses two data sources for one hop', () => {
    const bp = chain();
    bp.nodes.push(node('r', 'capability', { capabilityKey: 'prod-platon::platon.random@v1' }));
    bp.edges.push({ id: 'e4', source: 't', target: 'r' });
    bp.edges.push({ id: 'e5', source: 'r', target: 'v', carriesData: true });
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('fed by 2 connections'))).toBe(true);
  });

  it('refuses more hops than a pipeline takes', () => {
    const bp: Blueprint = { name: 'big', description: '', nodes: [node('t', 'trigger')], edges: [] };
    for (let i = 0; i < 17; i += 1) {
      bp.nodes.push(node(`c${i}`, 'capability', {
        capabilityKey: 'prod-platon::platon.random@v1',
      }));
      bp.edges.push({ id: `e${i}`, source: i === 0 ? 't' : `c${i - 1}`, target: `c${i}` });
    }
    bp.nodes.push(node('o', 'output'));
    bp.edges.push({ id: 'eo', source: 'c16', target: 'o' });
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('at most 16 capabilities'))).toBe(true);
  });

  it('catches a cycle instead of hanging on it', () => {
    const bp = chain();
    bp.edges.push({ id: 'loop', source: 'v', target: 's' });
    expect(validateBlueprint(bp, CATALOG).errors).toContain('Graph contains a cycle');
  });

  it('catches an orphan and a self-loop', () => {
    const bp = chain();
    bp.nodes.push(node('lonely', 'capability', { capabilityKey: 'prod-platon::platon.random@v1' }));
    bp.edges.push({ id: 'self', source: 's', target: 's' });
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('not connected'))).toBe(true);
    expect(errors.some((e) => e.includes('loops a node to itself'))).toBe(true);
  });

  it('warns without blocking when a capability will not say what it does', () => {
    const bp = chain();
    bp.nodes[1]! = node('s', 'capability', { capabilityKey: 'prod-x::silent@v1' });
    const { valid, warnings } = validateBlueprint(bp, CATALOG);
    expect(valid).toBe(true);
    expect(warnings.some((w) => w.includes('does not declare its input fields'))).toBe(true);
    expect(warnings.some((w) => w.includes('does not declare an output schema'))).toBe(true);
    expect(warnings.some((w) => w.includes('publishes no price'))).toBe(true);
  });
});

describe('conversion to a pipeline request', () => {
  it('emits only the paid hops, in dependency order', () => {
    const result = toPipelineRequest(chain(), CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.nodes.map((n) => n.id)).toEqual(['s', 'v']);
    expect(result.request.nodes[0]).toMatchObject({
      product_id: 'prod-mcp', capability_id: 'web.search@v1', depends_on: [],
    });
    expect(result.request.nodes[1]).toMatchObject({
      product_id: 'prod-metis', capability_id: 'metis.verify@v1',
      depends_on: ['s'], input_from: 's',
    });
  });

  it('looks through triggers and outputs to connect the capabilities', () => {
    const bp: Blueprint = {
      name: 'furniture', description: '',
      nodes: [
        node('s', 'capability', { capabilityKey: 'prod-mcp::web.search@v1', input: { query: 'q' } }),
        node('mid', 'output'),
        node('v', 'capability', { capabilityKey: 'prod-metis::metis.verify@v1', input: { claim: 'c' } }),
      ],
      edges: [
        { id: 'a', source: 's', target: 'mid', carriesData: true },
        { id: 'b', source: 'mid', target: 'v', carriesData: true },
      ],
    };
    const result = toPipelineRequest(bp, CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.nodes[1]).toMatchObject({ depends_on: ['s'], input_from: 's' });
  });

  it('names the data parent in a fan-in, and only that one', () => {
    const bp: Blueprint = {
      name: 'diamond', description: '',
      nodes: [
        node('r', 'capability', { capabilityKey: 'prod-platon::platon.random@v1' }),
        node('s', 'capability', { capabilityKey: 'prod-mcp::web.search@v1', input: { query: 'q' } }),
        node('v', 'capability', { capabilityKey: 'prod-metis::metis.verify@v1', input: { claim: 'c' } }),
      ],
      edges: [
        { id: 'a', source: 'r', target: 'v' },
        { id: 'b', source: 's', target: 'v', carriesData: true },
      ],
    };
    const result = toPipelineRequest(bp, CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verify = result.request.nodes.find((n) => n.id === 'v')!;
    expect(verify.depends_on.sort()).toEqual(['r', 's']);
    expect(verify.input_from).toBe('s');
  });

  it('omits input_from when an edge carries ordering only', () => {
    const bp = chain();
    bp.edges[1]!.carriesData = false;
    const result = toPipelineRequest(bp, CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.nodes[1]!.input_from).toBeUndefined();
    expect(result.request.nodes[1]!.depends_on).toEqual(['s']);
  });

  it('refuses to convert an invalid blueprint at all', () => {
    const bp = chain();
    bp.nodes[1]!.input = {};
    const result = toPipelineRequest(bp, CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('passes a payment channel through when one is supplied', () => {
    const result = toPipelineRequest(chain(), CATALOG, { channelId: 'ch_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.channel_id).toBe('ch_1');
  });

  it('copies inputs rather than aliasing the blueprint', () => {
    const bp = chain();
    const result = toPipelineRequest(bp, CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.request.nodes[0]!.input.query = 'mutated';
    expect(bp.nodes[1]!.input.query).toBe('a claim');
  });
});

describe('references between hops', () => {
  it('accepts a required field filled by a reference', () => {
    const bp = chain();
    // metis.verify's `claim` comes from the search hop at run time, not from typing.
    bp.nodes[2]!.input = { claim: '${s.results}' };
    const result = validateBlueprint(bp, CATALOG);
    expect(result.errors).toEqual([]);
  });

  it('refuses a reference to a hop that is not on the canvas', () => {
    const bp = chain();
    bp.nodes[2]!.input = { claim: '${ghost.x}' };
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('not on the canvas'))).toBe(true);
  });

  it('refuses a self-reference', () => {
    const bp = chain();
    bp.nodes[2]!.input = { claim: '${v.x}' };
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('its own result'))).toBe(true);
  });

  it('refuses reading from a hop that is not guaranteed to run first', () => {
    const bp = chain();
    bp.nodes.push(node('r', 'capability', { capabilityKey: 'prod-platon::platon.random@v1' }));
    bp.edges.push({ id: 'e4', source: 't', target: 'r' });   // parallel branch, not upstream of v
    bp.nodes[2]!.input = { claim: '${r.random_hex}' };
    const { errors } = validateBlueprint(bp, CATALOG);
    expect(errors.some((e) => e.includes('nothing guarantees it runs first'))).toBe(true);
  });

  it('carries references through to the pipeline request untouched', () => {
    const bp = chain();
    bp.nodes[2]!.input = { claim: '${s.results}' };
    const result = toPipelineRequest(bp, CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.nodes[1]!.input).toEqual({ claim: '${s.results}' });
  });
});

describe('federated routing', () => {
  it('names the hub that sells a row so the executor can reach it', () => {
    const catalog = catalogFromManifest({
      tools: [{
        name: 'read', product_id: 'gaia.gateway', capability_id: 'gaia.weather.read@v1',
        price_per_call_usd: 0.001, source_hub: 'https://iot.modelmarket.dev',
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: { reading: { type: 'object' } } },
      }],
    }).capabilities;

    const bp: Blueprint = {
      name: 'one', description: '',
      nodes: [node('r', 'capability', { capabilityKey: 'gaia.gateway::gaia.weather.read@v1' }),
              node('o', 'output')],
      edges: [{ id: 'e', source: 'r', target: 'o' }],
    };
    const result = toPipelineRequest(bp, catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.nodes[0]!.source_hub).toBe('https://iot.modelmarket.dev');
  });

  it('omits source_hub for a row the executor hosts itself', () => {
    const result = toPipelineRequest(chain(), CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fixture rows carry no source_hub, so nothing is invented for them.
    expect(result.request.nodes[0]!.source_hub).toBeUndefined();
  });
});
