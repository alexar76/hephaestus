/**
 * The catalogue comes from the hub's signed manifest — never from a bundled list.
 *
 * A hand-maintained capability library is a copy of someone else's catalogue, and it
 * drifts the day after it is written: the version this replaced offered one Platon
 * capability under the id `platon-random` while the live hub served eleven under
 * `prod-platon` / `platon.random@v1`. Nothing built on that could have run.
 *
 * Normalising here is also where the hub's reputation-honesty fields are honoured. The
 * manifest publishes `reputation_basis` next to `success_rate_30d` precisely because a
 * rate with no invocations behind it is a placeholder, so this module drops the number
 * unless the hub says it was measured. Never render `successRate` without checking `basis`.
 */

import type { Capability, FieldSpec, JsonSchema, Reputation, ReputationBasis } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const capabilityKey = (productId: string, capabilityId: string): string =>
  `${productId}::${capabilityId}`;

function readFields(schema: JsonSchema): FieldSpec[] {
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
  );
  return Object.entries(properties).map(([name, raw]) => {
    const spec = isRecord(raw) ? raw : {};
    const type = spec.type;
    return {
      name,
      // JSON Schema allows a type union (`["number", "null"]`); keep it readable rather
      // than picking one arbitrarily.
      type: Array.isArray(type)
        ? type.filter((t): t is string => typeof t === 'string').join('|') || 'any'
        : typeof type === 'string'
          ? type
          : 'any',
      required: required.has(name),
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
      ...('default' in spec ? { default: spec.default } : {}),
    };
  });
}

function readReputation(tool: Record<string, unknown>): Reputation {
  const declared = asString(tool.reputation_basis);
  const observations = asFiniteNumber(tool.observations_30d) ?? 0;
  // A hub that predates the honesty fields says nothing about evidence, and silence is
  // not the same as "no evidence" — hence a third state rather than assuming the worst.
  const basis: ReputationBasis =
    declared === 'measured' ? 'measured' : declared === 'unobserved' ? 'unobserved' : 'unknown';
  const rate = asFiniteNumber(tool.success_rate_30d);
  const trust = asFiniteNumber(tool.trust_score);
  return {
    basis,
    observations: Math.max(0, Math.trunc(observations)),
    successRate: basis === 'measured' ? rate : null,
    trustScore: basis === 'measured' ? trust : null,
  };
}

export interface CatalogResult {
  capabilities: Capability[];
  /** Rows that could not be used, with the reason — surfaced, never silently dropped. */
  skipped: { row: unknown; reason: string }[];
  hubs: string[];
  generatedAt: string;
  baseUrl: string;
  signed: boolean;
}

export function catalogFromManifest(manifest: unknown): CatalogResult {
  const doc = isRecord(manifest) ? manifest : {};
  const tools = Array.isArray(doc.tools) ? doc.tools : [];
  const capabilities: Capability[] = [];
  const skipped: { row: unknown; reason: string }[] = [];
  const seen = new Set<string>();

  for (const row of tools) {
    if (!isRecord(row)) {
      skipped.push({ row, reason: 'not an object' });
      continue;
    }
    const productId = asString(row.product_id);
    const capabilityId = asString(row.capability_id);
    if (!productId || !capabilityId) {
      // Without both halves there is nothing to POST to /ai-market/pipelines, so the row
      // is undrawable no matter how good its description is.
      skipped.push({ row, reason: 'missing product_id or capability_id' });
      continue;
    }
    const key = capabilityKey(productId, capabilityId);
    if (seen.has(key)) {
      // The same capability legitimately appears from several hubs; the studio needs one
      // node per capability, and the first (highest-ranked) offer wins.
      skipped.push({ row, reason: `duplicate offer for ${key}` });
      continue;
    }
    seen.add(key);

    const inputSchema = isRecord(row.input_schema) ? (row.input_schema as JsonSchema) : {};
    const outputSchema = isRecord(row.output_schema) ? (row.output_schema as JsonSchema) : {};
    const inputFields = readFields(inputSchema);
    const outputFields = readFields(outputSchema).map((f) => f.name);
    const inputDeclared = isRecord(inputSchema.properties);
    const outputDeclared = Object.keys(outputSchema).length > 0;

    capabilities.push({
      key,
      productId,
      capabilityId,
      name: asString(row.name) || capabilityId,
      description: asString(row.description),
      sourceHub: asString(row.source_hub) || 'local',
      sourceHubName: asString(row.source_hub_name),
      priceUsd: asFiniteNumber(row.price_per_call_usd),
      routedPriceUsd: asFiniteNumber(row.routed_price_usd),
      p50LatencyMs: asFiniteNumber(row.p50_latency_ms),
      inputSchema,
      outputSchema,
      inputFields,
      outputFields,
      reputation: readReputation(row),
      composable: {
        inputDeclared,
        outputDeclared,
        takesNoInput: inputDeclared && inputFields.length === 0,
      },
    });
  }

  const byHub = isRecord(doc.by_hub) ? Object.keys(doc.by_hub) : [];
  return {
    capabilities,
    skipped,
    hubs: byHub,
    generatedAt: asString(doc.generated_at),
    baseUrl: asString(doc.base_url),
    signed: isRecord(doc.signature),
  };
}

/**
 * What the UI should print for a capability's reliability.
 *
 * Kept next to the normaliser on purpose: the rule that "unobserved means no number" has
 * to live in one place, or the next surface to render a catalogue will print 0.5 again.
 */
export function reputationLabel(reputation: Reputation): string {
  if (reputation.basis === 'measured' && reputation.successRate !== null) {
    const pct = Math.round(reputation.successRate * 1000) / 10;
    return `${pct}% over ${reputation.observations} call${reputation.observations === 1 ? '' : 's'} (30d)`;
  }
  if (reputation.basis === 'unobserved') return 'no calls yet';
  return 'not reported';
}

export const findCapability = (catalog: Capability[], key: string): Capability | undefined =>
  catalog.find((c) => c.key === key);
