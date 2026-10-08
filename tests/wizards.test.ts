/**
 * A wizard states a goal and finds the rows that satisfy it in the live catalogue.
 *
 * The properties worth holding onto: the chain it produces must validate and price without
 * anyone typing anything, the hops must actually be wired to each other (a title that
 * promises a verified reading must not hand back two unrelated purchases), and a catalogue
 * that cannot satisfy the goal must produce a stated reason rather than a shortened chain.
 */

import { describe, expect, it } from 'vitest';

import { catalogFromManifest } from '@/catalog';
import { validateBlueprint, toPipelineRequest } from '@/blueprint';
import { estimateBlueprint } from '@/estimate';
import { WIZARDS, planWizard, planWizards } from '@/wizards';
import type { WizardPlan } from '@/wizards';

const READ = {
  name: 'weather', product_id: 'gaia.gateway', capability_id: 'gaia.weather.read@v1',
  price_per_call_usd: 0.001, p50_latency_ms: 80,
  input_schema: { type: 'object', properties: { device_id: { type: 'string', default: 'dev-1' } } },
  output_schema: { type: 'object', properties: { reading: { type: 'object' }, attestation: { type: 'object' } } },
  success_rate_30d: 0.98, reputation_basis: 'measured', observations_30d: 93,
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
/** Same role as VERIFY, cheaper, but threads only one of the two fields. */
const THIN_VERIFY = {
  name: 'thin', product_id: 'p', capability_id: 'thin.validate@v1', price_per_call_usd: 0.0001,
  input_schema: { type: 'object', properties: { reading: { type: 'object' } }, required: ['reading'] },
  output_schema: { type: 'object', properties: { verified: { type: 'boolean' } } },
};
const RANDOM = {
  name: 'random', product_id: 'platon', capability_id: 'platon.random@v1', price_per_call_usd: 0.004,
  input_schema: { type: 'object', properties: {} },
  output_schema: { type: 'object', properties: { value: { type: 'string' }, proof: { type: 'object' } } },
};
/**
 * The real platon rows, trimmed: a draw that ECHOES its own `num_bytes` parameter, and a
 * beacon that ACCEPTS `num_bytes` as a parameter. They wire together on that field and
 * audit nothing — the defect the `consumes` guard exists for.
 */
const ECHO_DRAW = {
  name: 'draw', product_id: 'platon', capability_id: 'platon.random@v1', price_per_call_usd: 0.004,
  input_schema: { type: 'object', properties: { num_bytes: { type: 'number', default: 32 } } },
  output_schema: {
    type: 'object',
    properties: { random_hex: { type: 'string' }, num_bytes: { type: 'number' }, proof: { type: 'object' } },
  },
};
const PARAM_BEACON = {
  name: 'beacon', product_id: 'platon', capability_id: 'platon.beacon@v1', price_per_call_usd: 0.004,
  input_schema: { type: 'object', properties: { num_bytes: { type: 'number' }, client_seed: { type: 'string' } } },
  output_schema: { type: 'object', properties: { round: { type: 'number' }, proof: { type: 'object' } } },
};
/** Same role, but it actually reads the draw. */
const PROOF_AUDIT = {
  name: 'audit', product_id: 'platon', capability_id: 'platon.verify@v1', price_per_call_usd: 0.001,
  input_schema: {
    type: 'object',
    properties: { random_hex: { type: 'string' }, proof: { type: 'object' } },
    required: ['proof'],
  },
  output_schema: { type: 'object', properties: { valid: { type: 'boolean' } } },
};
const FREE_ROW = {
  name: 'fleet', product_id: 'gaia.gateway', capability_id: 'gaia.fleet.status@v1',
  price_per_call_usd: 0, p50_latency_ms: 1,
  input_schema: { type: 'object', properties: {} },
  output_schema: { type: 'object', properties: { devices: { type: 'array' }, count: { type: 'number' } } },
  success_rate_30d: 1, reputation_basis: 'measured', observations_30d: 12,
};

const catalogOf = (tools: unknown[]) => catalogFromManifest({ tools }).capabilities;
const wizard = (id: string) => WIZARDS.find((w) => w.id === id)!;
const available = (plan: WizardPlan) => {
  if (!plan.available) throw new Error(`expected an available plan, got: ${plan.reason}`);
  return plan;
};

describe('planWizard', () => {
  it('builds a chain whose second hop reads the first', () => {
    const plan = available(planWizard(wizard('prove-a-reading'), catalogOf([READ, VERIFY])));

    expect(plan.picks.map((p) => p.capability.capabilityId)).toEqual([
      'gaia.weather.read@v1',
      'gaia.verify@v1',
    ]);
    const verify = plan.blueprint.nodes.find((n) => n.id === 'verify')!;
    expect(verify.input.reading).toBe('${read.reading}');
    expect(verify.input.attestation).toBe('${read.attestation}');
    expect(plan.note).toContain('reading, attestation flows into gaia.verify@v1');
  });

  it('prefers the hop that threads more data over the cheaper one', () => {
    // thin.validate@v1 is twenty times cheaper and fills the same role, but it takes only
    // the reading. A wizard exists to produce a chain that works, not the cheapest chain.
    const plan = available(planWizard(wizard('prove-a-reading'), catalogOf([READ, VERIFY, THIN_VERIFY])));
    expect(plan.picks[1]!.capability.capabilityId).toBe('gaia.verify@v1');
    expect(plan.picks[1]!.wired).toEqual(['reading', 'attestation']);
  });

  it('produces a graph that validates, prices and converts with nothing typed in', () => {
    const catalog = catalogOf([READ, VERIFY]);
    const plan = available(planWizard(wizard('prove-a-reading'), catalog));

    expect(validateBlueprint(plan.blueprint, catalog).errors).toEqual([]);
    const estimate = estimateBlueprint(plan.blueprint, catalog);
    expect(estimate.hops).toBe(2);
    expect(estimate.totalUsd).toBe(0.003);

    const conversion = toPipelineRequest(plan.blueprint, catalog);
    if (!conversion.ok) throw new Error(conversion.errors.join('; '));
    const request = conversion.request;
    expect(request.nodes.map((n) => n.id)).toEqual(['read', 'verify']);
    expect(request.nodes[1]!.input_from).toBe('read');
    expect(request.nodes[1]!.input.reading).toBe('${read.reading}');
  });

  it('says which step a catalogue cannot fill instead of shortening the chain', () => {
    const plan = planWizard(wizard('prove-a-reading'), catalogOf([READ]));
    expect(plan.available).toBe(false);
    if (plan.available) return;
    expect(plan.missingRole).toBe('verify');
    expect(plan.reason).toContain('verifier');
  });

  it('refuses a role whose candidate is fed by nothing', () => {
    // platon.random produces `value`/`proof`; the verifier requires a `reading`. The role
    // matches by id, so only the wiring check keeps this from becoming a bogus chain.
    const plan = planWizard(wizard('prove-a-reading'), catalogOf([RANDOM, VERIFY]));
    expect(plan.available).toBe(false);
  });

  it('never reuses one capability for two roles', () => {
    const both = {
      ...VERIFY,
      capability_id: 'gaia.verify.loop@v1',
      output_schema: { type: 'object', properties: { reading: { type: 'object' } } },
    };
    const plan = planWizard(wizard('prove-a-reading'), catalogOf([both, VERIFY]));
    if (plan.available) {
      const keys = plan.picks.map((p) => p.capability.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('names what is left to fill in when nothing supplies a required field', () => {
    const needsInput = {
      ...READ,
      capability_id: 'gaia.point.read@v1',
      input_schema: { type: 'object', properties: { lat: { type: 'number' } }, required: ['lat'] },
    };
    const plan = available(planWizard(wizard('prove-a-reading'), catalogOf([needsInput, VERIFY])));
    expect(plan.picks[0]!.toFill).toEqual(['lat']);
    expect(plan.note).toContain('fill in read.lat');
  });

  it('offers a single measured hop for the try-before-you-buy goal', () => {
    const plan = available(planWizard(wizard('try-before-you-buy'), catalogOf([READ, VERIFY])));
    expect(plan.picks).toHaveLength(1);
    // VERIFY carries no observations; a trial hop with no evidence behind it is not a trial.
    expect(plan.picks[0]!.capability.capabilityId).toBe('gaia.weather.read@v1');
    expect(plan.note).toBe('one priced hop, defaults already filled in');
  });

  it('will not offer a trial over a row nothing has invoked', () => {
    const plan = planWizard(wizard('try-before-you-buy'), catalogOf([VERIFY]));
    expect(plan.available).toBe(false);
  });

  it('refuses a hop that only consumes the previous hop\'s parameters', () => {
    // Found on the live catalogue: platon.random echoes `num_bytes` and platon.beacon
    // takes `num_bytes`, so the pair wired up cleanly under a title promising an audited
    // draw — a chain that threads a parameter, not a result.
    const plan = planWizard(wizard('random-you-can-audit'), catalogOf([ECHO_DRAW, PARAM_BEACON]));
    expect(plan.available).toBe(false);
    if (plan.available) return;
    expect(plan.missingRole).toBe('audit');
  });

  it('takes the hop that reads the draw itself over the one that shares a parameter', () => {
    const plan = available(
      planWizard(wizard('random-you-can-audit'), catalogOf([ECHO_DRAW, PARAM_BEACON, PROOF_AUDIT])),
    );
    expect(plan.picks[1]!.capability.capabilityId).toBe('platon.verify@v1');
    expect(plan.picks[1]!.wired).toContain('proof');
  });

  it('refuses a proof-consuming hop from a different provider', () => {
    // Live catalogue again: platon's VRF `proof` was wired into chronos.verify, a VDF
    // verifier, purely because both spell the field `proof`. That chain bills for the draw
    // and then fails on a proof the verifier cannot parse.
    const foreign = {
      name: 'vdf', product_id: 'chronos', capability_id: 'chronos.verify@v1',
      price_per_call_usd: 0.001,
      input_schema: {
        type: 'object',
        properties: { proof: { type: 'object' }, g: { type: 'string' }, difficulty: { type: 'number' } },
        required: ['proof', 'g'],
      },
      output_schema: { type: 'object', properties: { valid: { type: 'boolean' } } },
    };
    expect(planWizard(wizard('random-you-can-audit'), catalogOf([ECHO_DRAW, foreign])).available)
      .toBe(false);
    // Same field, same provider: fine.
    const plan = available(
      planWizard(wizard('random-you-can-audit'), catalogOf([ECHO_DRAW, foreign, PROOF_AUDIT])),
    );
    expect(plan.picks[1]!.capability.productId).toBe('platon');
  });

  it('will not offer a free row as something to try before buying', () => {
    // Also live: the free fleet-status row won on price and the note called it a priced
    // hop. A row that costs nothing answers a different question than "is it worth paying
    // for", so the goal has no candidate here rather than a misleading one.
    expect(planWizard(wizard('try-before-you-buy'), catalogOf([FREE_ROW])).available).toBe(false);
    const plan = available(planWizard(wizard('try-before-you-buy'), catalogOf([FREE_ROW, READ])));
    expect(plan.picks[0]!.capability.capabilityId).toBe('gaia.weather.read@v1');
  });
});

describe('planWizards', () => {
  it('returns every wizard, available ones first, with a reason on the rest', () => {
    const plans = planWizards(catalogOf([READ, VERIFY]));
    expect(plans).toHaveLength(WIZARDS.length);

    const firstUnavailable = plans.findIndex((p) => !p.available);
    const lastAvailable = plans.map((p) => p.available).lastIndexOf(true);
    expect(lastAvailable).toBeLessThan(firstUnavailable);

    for (const plan of plans) {
      if (!plan.available) expect(plan.reason).toMatch(/nothing on sale/);
    }
  });

  it('holds up against an empty catalogue', () => {
    const plans = planWizards([]);
    expect(plans.every((p) => !p.available)).toBe(true);
  });

  it('gives every wizard a goal a person could act on', () => {
    for (const w of WIZARDS) {
      expect(w.title.length).toBeGreaterThan(10);
      expect(w.goal.length).toBeGreaterThan(40);
      expect(w.roles.length).toBeGreaterThan(0);
      // Only the first role may stand alone; the rest exist to consume the one before.
      expect(w.roles.slice(1).every((r) => r.fedByPrevious)).toBe(true);
    }
  });
});
