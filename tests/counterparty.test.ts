import { describe, expect, it } from 'vitest';
import { catalogFromManifest } from '@/catalog';
import { toPipelineRequest, validateBlueprint } from '@/blueprint';
import { buildCounterpartyReport, planCounterparty } from '@/counterparty';
import type { CounterpartyRun } from '@/counterparty';

const capability = (id: string, properties: Record<string, unknown> = {}) => ({
  product_id: 'symmartys', capability_id: `symmartys.${id}@v1`, price_per_call_usd: 0.001,
  input_schema: { type: 'object', properties }, output_schema: { type: 'object' },
});
const catalog = catalogFromManifest({ tools: [
  capability('company.lookup', {
    country: { type: 'string', enum: ['NO', 'FR'], default: 'NO' },
    number: { type: 'string', default: '923609016' }, name: { type: 'string' },
  }),
  capability('lei.lookup', { lei: { type: 'string' }, name: { type: 'string' } }),
  capability('sanctions.screen', { name: { type: 'string' }, address: { type: 'string' } }),
  capability('vat.check', { vat: { type: 'string', default: 'NL004495445B01' }, requester_vat: { type: 'string' } }),
  capability('domain.rdap', { domain: { type: 'string', default: 'example.com' } }),
  capability('eori.check', { eori: { type: 'string', default: 'CZ00177041' } }),
] }).capabilities;

const NOW = Date.parse('2026-10-28T12:00:00Z');
const source = (fetched_at = '2026-10-28T11:00:00Z') => ({
  source: 'registry', url: 'https://registry.example/record', fetched_at, sha256: 'a'.repeat(64),
});
const signedReceipt = { nonce: 'nonce-1', signature: { algorithm: 'ed25519', value: 'signature-bytes' } };
const namedPlan = () => planCounterparty({ legalName: 'Example AS', country: 'NO' }, catalog);
const run = (): CounterpartyRun => ({
  trace_id: 'tr_counterparty',
  bill_of_materials: {
    signature: 'bill-signature',
    steps: [
      { id: 'identity', success: true, result_sha256: 'b'.repeat(64) },
      { id: 'sanctions', success: true, result_sha256: 'c'.repeat(64) },
    ],
  },
  step_results: {
    identity: { result: { found: true, companies: [{ number: '123', name: 'Example AS' }], evidence: source() }, receipt: signedReceipt },
    sanctions: { result: { listed: false, hits: [], lists: [{ list: 'OFAC', published: '2026-10-27', fetched_at: '2026-10-28T11:00:00Z', sha256: ['d'.repeat(64)] }] }, receipt: signedReceipt },
  },
});

describe('counterparty planning', () => {
  it('prices only supplied party identifiers and does not buy manifest example defaults', () => {
    const plan = namedPlan();
    expect(plan.errors).toEqual([]);
    expect(plan.checks.filter((check) => check.status === 'planned').map((check) => check.id)).toEqual(['identity', 'sanctions']);
    expect(plan.checks.find((check) => check.id === 'identity')?.input).toEqual({ country: 'NO', name: 'Example AS' });
    expect(plan.checks.filter((check) => check.status === 'skipped').map((check) => check.id)).toEqual(['vat', 'domain', 'wallet', 'eori']);
    expect(JSON.stringify(plan.blueprint)).not.toContain('923609016');
    expect(JSON.stringify(plan.blueprint)).not.toContain('NL004495445B01');
    expect(JSON.stringify(plan.blueprint)).not.toContain('example.com');
  });

  it('builds independent checks that convert to real catalogue product and capability keys', () => {
    const plan = planCounterparty({ legalName: 'Example AS', country: 'no', registrationNumber: '123', vat: 'NO123', domain: 'shop.example', wallet: 'wallet-1', eori: 'NO123' }, catalog);
    expect(plan.blueprint).not.toBeNull();
    expect(validateBlueprint(plan.blueprint!, catalog).errors).toEqual([]);
    const conversion = toPipelineRequest(plan.blueprint!, catalog);
    if (!conversion.ok) throw new Error(conversion.errors.join('; '));
    expect(conversion.request.nodes).toHaveLength(6);
    expect(conversion.request.nodes.every((node) => node.depends_on.length === 0 && !node.input_from)).toBe(true);
    expect(conversion.request.nodes.find((node) => node.id === 'identity')?.input).toEqual({ country: 'NO', number: '123' });
    expect(conversion.request.nodes.every((node) => node.product_id === 'symmartys')).toBe(true);
    expect(conversion.request.nodes.find((node) => node.id === 'wallet')?.input).toEqual({ address: 'wallet-1' });
  });

  it('uses an explicit LEI and keeps both a supplied national registration and LEI', () => {
    const exact = planCounterparty({ legalName: 'Example AS', lei: 'LEI-1' }, catalog);
    expect(exact.checks[0]?.capabilityId).toBe('symmartys.lei.lookup@v1');
    expect(exact.checks[0]?.input).toEqual({ lei: 'LEI-1' });
    const both = planCounterparty({ legalName: 'Example AS', lei: 'LEI-1', country: 'NO', registrationNumber: '123' }, catalog);
    expect(both.checks).toHaveLength(7);
    expect(both.checks[0]?.capabilityId).toBe('symmartys.company.lookup@v1');
    expect(both.checks[0]?.input).toEqual({ country: 'NO', number: '123' });
    expect(both.checks.find((check) => check.id === 'lei')?.input).toEqual({ lei: 'LEI-1' });
    const byName = planCounterparty({ legalName: ' Example AS ' }, catalog);
    expect(byName.checks[0]?.input).toEqual({ name: 'Example AS' });
  });

  it('blocks an unsupported country or missing requested capability rather than skipping it', () => {
    const unsupported = planCounterparty({ legalName: 'Example', country: 'US' }, catalog);
    expect(unsupported.blueprint).toBeNull();
    expect(unsupported.errors.join(' ')).toContain('does not support US');
    const missing = planCounterparty({ legalName: 'Example', vat: 'FR123' }, catalog.filter((row) => !row.capabilityId.includes('vat.check')));
    expect(missing.blueprint).toBeNull();
    expect(missing.checks.find((check) => check.id === 'vat')?.status).toBe('unavailable');
  });

  it('refuses inputs that would discard an identifier because its context is missing', () => {
    const plan = planCounterparty({ legalName: '', registrationNumber: '123', requesterVat: 'FR123' }, catalog);
    expect(plan.blueprint).toBeNull();
    expect(plan.errors).toHaveLength(3);
    expect(planCounterparty({ legalName: 'x'.repeat(121) }, catalog).blueprint).toBeNull();
  });
});

describe('counterparty evidence report', () => {
  it('keeps original result, receipt and signed bill while treating a name candidate as unconfirmed', () => {
    const original = run();
    const report = buildCounterpartyReport(namedPlan(), original, NOW);
    const identity = report.checks[0]!;
    expect(report.status).toBe('complete');
    expect(report.evidenceComplete).toBe(true);
    expect(report.signatureVerified).toBe(false);
    expect(identity.summaryCode).toBe('identity_candidates');
    expect(identity.findingCodes).toContain('identity_unconfirmed');
    expect(identity.receipt).toBe(signedReceipt);
    expect(identity.receiptHasSignature).toBe(true);
    expect(identity.signatureVerified).toBe(false);
    expect(identity.result).toBe(original.step_results?.identity?.result);
    expect(identity.resultSha256).toBe('b'.repeat(64));
    expect(report.billOfMaterials).toBe(original.bill_of_materials);
    expect(report.rawRun).toBe(original);
    expect(identity.sources[0]).toMatchObject({ name: 'registry', freshness: 'fresh', ageHours: 1, maxAgeHours: 24 });
    expect(report.checks.find((check) => check.id === 'sanctions')?.sources[0]?.url).toBeUndefined();
  });

  it('does not turn several candidates, sanctions hits or invalid VAT into clearance', () => {
    const plan = planCounterparty({ legalName: 'Example', country: 'NO', vat: 'NO123', domain: 'shop.example', eori: 'NO123' }, catalog);
    const report = buildCounterpartyReport(plan, {
      bill_of_materials: { steps: ['identity', 'sanctions', 'vat', 'domain', 'eori'].map((id) => ({ id, success: true })) },
      step_results: {
        identity: { result: { found: true, companies: [{ name: 'Example A' }, { name: 'Example B' }], evidence: source() } },
        sanctions: { result: { listed: true, hits: [{ matched: 'Example' }] } },
        vat: { result: { valid: false, evidence: source() } },
        domain: { result: { registered: false, evidence: source() } },
        eori: { result: { results: [{ valid: false }], evidence: source() } },
      },
    }, NOW);
    expect(report.checks.filter((check) => check.status === 'completed').map((check) => check.summaryCode)).toEqual([
      'identity_ambiguous', 'listed', 'vat_invalid', 'domain_unregistered', 'eori_invalid',
    ]);
    expect(report.evidenceComplete).toBe(false);
    expect(report.checks[1]?.findingCodes).toContain('sanctions_hit');
    expect(report.checks[1]?.findingCodes).toContain('receipt_missing');
  });

  it('does not substitute the last result when intermediate evidence is absent', () => {
    const original = run();
    delete original.step_results;
    const report = buildCounterpartyReport(namedPlan(), original, NOW);
    expect(report.status).toBe('incomplete');
    expect(report.checks[0]?.status).toBe('missing');
    expect(report.checks[1]?.status).toBe('missing');
    expect(report.checks[0]?.result).toBeUndefined();
    expect(report.checks.every((check) => check.facts.length === 0)).toBe(true);
  });

  it('does not invent zero sanctions matches for skipped, missing or failed checks', () => {
    const plan = namedPlan();
    const original = run();
    const report = buildCounterpartyReport(plan, original, NOW);
    expect(report.checks.find((check) => check.id === 'wallet')?.facts).toEqual([]);
    expect(report.checks.find((check) => check.id === 'sanctions')?.facts).toContainEqual({ key: 'matched_candidates', value: '0' });
    original.step_results!.sanctions!.result = { listed: false };
    const noHitsField = buildCounterpartyReport(plan, original, NOW);
    expect(noHitsField.checks.find((check) => check.id === 'sanctions')?.facts).toEqual([]);
    original.bill_of_materials = { steps: [{ id: 'sanctions', success: false }] };
    original.step_results!.sanctions!.result = { error: 'unavailable', hits: [] };
    const failed = buildCounterpartyReport(plan, original, NOW);
    expect(failed.checks.find((check) => check.id === 'sanctions')?.facts).toEqual([]);
  });

  it('retains partial success and reports failed and unexecuted checks', () => {
    const original = run();
    const report = buildCounterpartyReport(planCounterparty({ legalName: 'Example', country: 'NO', vat: 'NO123' }, catalog), {
      ...original,
      bill_of_materials: { steps: [{ id: 'identity', success: true }, { id: 'sanctions', success: false, error: 'Upstream unavailable' }] },
      step_results: { identity: original.step_results!.identity!, sanctions: { result: {}, receipt: { nonce: 'unsigned' } } },
    }, NOW);
    expect(report.status).toBe('incomplete');
    expect(report.checks[0]?.status).toBe('completed');
    expect(report.checks[1]?.status).toBe('failed');
    expect(report.checks[1]?.summaryCode).toBe('failed');
    expect(report.checks[1]?.detail).toBe('Upstream unavailable');
    expect(report.checks[1]?.findingCodes).toContain('receipt_unsigned');
    expect(report.checks.find((check) => check.id === 'vat')?.status).toBe('not_executed');
  });

  it('keeps an explicitly skipped dependency separate from a failed source', () => {
    const report = buildCounterpartyReport(namedPlan(), {
      bill_of_materials: { steps: [{ id: 'identity', success: false, status: 'skipped', error: 'dependency failed' }] },
    }, NOW);
    expect(report.checks[0]?.status).toBe('not_executed');
    expect(report.checks[0]?.summaryCode).toBe('not_executed');
  });

  it('uses original source fetch times, rejects unknown/future times and distinguishes list policy', () => {
    const original = run();
    original.step_results!.identity!.result = { found: false, evidence: source('2026-10-26T11:00:00Z') };
    original.step_results!.sanctions!.result = { listed: false, lists: [
      { list: 'OFAC', fetched_at: '2026-10-27T00:00:00Z', age_hours: 0, sha256: ['hash'] },
      { list: 'EU', fetched_at: '2026-10-29T00:00:00Z' },
      { list: 'UK', fetched_at: 'not-a-date' },
      { list: 'Other', fetched_at: '2026-10-28' },
      { list: 'Invalid day', fetched_at: '2026-02-30T10:00:00Z' },
    ] };
    const report = buildCounterpartyReport(namedPlan(), original, NOW);
    expect(report.checks[0]?.sources[0]?.freshness).toBe('stale');
    expect(report.checks[0]?.summaryCode).toBe('identity_not_found');
    expect(report.checks[1]?.sources.map((entry) => entry.freshness)).toEqual(['fresh', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(report.checks[1]?.sources[0]?.ageHours).toBe(36);
    expect(report.checks[1]?.sources[0]?.maxAgeHours).toBe(48);
    expect(report.evidenceComplete).toBe(false);
  });

  it('extracts provider output evidence while preserving both original receipt layers', () => {
    const original = run();
    const wrapped = { output: original.step_results!.identity!.result, receipt: signedReceipt, provenance: { source: 'symmartys' } };
    original.step_results!.identity = { result: wrapped, receipt: { nonce: 'outer-receipt' } };
    const report = buildCounterpartyReport(namedPlan(), original, NOW);
    expect(report.checks[0]?.result).toBe(wrapped);
    expect(report.checks[0]?.receipt).toBe(signedReceipt);
    expect(report.checks[0]?.hubReceipt).toEqual({ nonce: 'outer-receipt' });
    expect(report.checks[0]?.providerReceipt).toBe(signedReceipt);
    expect(report.checks[0]?.receiptHasSignature).toBe(true);
    expect(report.checks[0]?.sources[0]?.name).toBe('registry');
  });

  it('does not label a refused provider wrapper as a completed check', () => {
    const original = run();
    original.step_results!.identity!.result = { ok: false, output: {}, error: 'Provider refused the check' };
    const report = buildCounterpartyReport(namedPlan(), original, NOW);
    expect(report.checks[0]?.status).toBe('failed');
    expect(report.checks[0]?.detail).toBe('Provider refused the check');
    expect(report.status).toBe('incomplete');
  });

  it('surfaces identity status and identifiers and flags only recognized adverse status values', () => {
    const plan = planCounterparty({ legalName: 'Example', lei: 'LEI-1' }, catalog);
    const original = run();
    original.step_results!.identity!.result = { found: true, record: {
      legal_name: 'Example Legal Name', registered_as: 'REG-1', lei: 'LEI-1', jurisdiction: 'NO',
      entity_status: 'INACTIVE', registration_status: 'LAPSED',
      legal_address: { lines: ['Example Road 1'], postal_code: '0123', city: 'Oslo', country: 'NO' },
    }, evidence: source() };
    const report = buildCounterpartyReport(plan, original, NOW);
    expect(report.checks[0]?.facts).toEqual(expect.arrayContaining([
      { key: 'legal_name', value: 'Example Legal Name' },
      { key: 'registration_number', value: 'REG-1' }, { key: 'lei', value: 'LEI-1' },
      { key: 'entity_status', value: 'INACTIVE' }, { key: 'registration_status', value: 'LAPSED' },
      { key: 'country', value: 'NO' }, { key: 'registered_address', value: 'Example Road 1, 0123, Oslo, NO' },
    ]));
    expect(report.checks[0]?.findingCodes).toContain('identity_adverse_status');
    original.step_results!.identity!.result = { found: true, record: { entity_status: 'pending review in local register' } };
    const unknown = buildCounterpartyReport(plan, original, NOW);
    expect(unknown.checks[0]?.facts).toContainEqual({ key: 'entity_status', value: 'pending review in local register' });
    expect(unknown.checks[0]?.findingCodes).not.toContain('identity_adverse_status');
  });

  it('shows all name-search candidates including a single record without promoting one as confirmed', () => {
    const original = run();
    original.step_results!.identity!.result = { found: true, companies: [
      { name: 'Example A', number: '1', status: 'active' },
      { name: 'Example B', number: '2', status: 'in liquidation' },
    ] };
    const report = buildCounterpartyReport(namedPlan(), original, NOW);
    expect(report.checks[0]?.facts).toEqual([
      { key: 'matched_candidates', value: '2' },
      { key: 'candidate', value: 'Example A · 1 · active' },
      { key: 'candidate', value: 'Example B · 2 · in liquidation' },
    ]);
    expect(report.checks[0]?.findingCodes).toContain('identity_adverse_status');
    original.step_results!.identity!.result = { record: { legal_name: 'Example C', lei: 'LEI-3', entity_status: 'ACTIVE' } };
    const single = buildCounterpartyReport(planCounterparty({ legalName: 'Example' }, catalog), original, NOW);
    expect(single.checks[0]?.summaryCode).toBe('identity_candidates');
    expect(single.checks[0]?.findingCodes).toContain('identity_unconfirmed');
    expect(single.checks[0]?.facts).toContainEqual({ key: 'candidate', value: 'Example C · LEI-3 · ACTIVE' });
  });

  it('shows returned VAT consultation details and domain registration facts', () => {
    const plan = planCounterparty({ legalName: 'Example', vat: 'FR123', domain: 'shop.example' }, catalog);
    const report = buildCounterpartyReport(plan, { step_results: {
      vat: { result: { vat: 'FR123', valid: true, name: 'Registered Example', address: 'Paris',
        checked_at: '2026-10-28', consultation_number: 'CONSULT-1' } },
      domain: { result: { domain: 'shop.example', registered: true, age_days: 4, registrar: { name: 'Example Registrar' } } },
    } }, NOW);
    expect(report.checks.find((check) => check.id === 'vat')?.facts).toEqual([
      { key: 'vat', value: 'FR123' }, { key: 'registered_name', value: 'Registered Example' },
      { key: 'registered_address', value: 'Paris' }, { key: 'consultation_number', value: 'CONSULT-1' },
      { key: 'checked_at', value: '2026-10-28' },
    ]);
    expect(report.checks.find((check) => check.id === 'domain')?.facts).toEqual([
      { key: 'domain', value: 'shop.example' }, { key: 'domain_age_days', value: '4' },
      { key: 'registrar', value: 'Example Registrar' },
    ]);
  });
});
