/** A counterparty recipe over live SYMMARTYS offers, with portable run evidence. */
import type { Blueprint, Capability } from './types';

export interface CounterpartyInput {
  legalName: string;
  country?: string;
  registrationNumber?: string;
  vat?: string;
  requesterVat?: string;
  lei?: string;
  domain?: string;
  wallet?: string;
  eori?: string;
}

export interface CounterpartyCheck {
  id: string;
  label: string;
  capabilityId: string;
  input: Record<string, unknown>;
  status: 'planned' | 'skipped' | 'unavailable';
  reason?: string;
  capabilityKey?: string;
}

export interface CounterpartyPlan {
  input: CounterpartyInput;
  blueprint: Blueprint | null;
  checks: CounterpartyCheck[];
  errors: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(record) : [];

function countries(capability: Capability): string[] | null {
  const properties = capability.inputSchema.properties;
  const country = record(properties) ? properties.country : null;
  if (!record(country) || !Array.isArray(country.enum)) return null;
  return country.enum.filter((value): value is string => typeof value === 'string');
}

/** Never uses example defaults: every purchased check refers to the supplied party. */
export function planCounterparty(input: CounterpartyInput, catalog: Capability[]): CounterpartyPlan {
  const clean = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : '']),
  ) as unknown as CounterpartyInput;
  clean.legalName = clean.legalName ?? '';
  if (clean.country) clean.country = clean.country.toUpperCase();
  const errors: string[] = [];
  if (!clean.legalName) errors.push('Enter the counterparty legal name.');
  if (clean.legalName.length > 120) errors.push('The legal name must be at most 120 characters.');
  if (clean.registrationNumber && !clean.country) errors.push('A registration number needs its country.');
  if (clean.requesterVat && !clean.vat) errors.push('Your requester VAT number needs a counterparty VAT number.');

  const checks: CounterpartyCheck[] = [];
  function add(id: string, label: string, capabilityId: string, values: Record<string, unknown>, requested = true) {
    const check: CounterpartyCheck = {
      id, label, capabilityId, input: values, status: requested ? 'unavailable' : 'skipped',
    };
    checks.push(check);
    if (!requested) {
      check.reason = 'No identifier supplied.';
      return;
    }
    // The signed catalogue remains the source of the product key and routing location.
    const offers = catalog.filter((capability) => capability.capabilityId === capabilityId);
    const compatible = offers.filter((capability) => {
      const supported = countries(capability);
      return !values.country || !supported || supported.includes(String(values.country));
    });
    compatible.sort((a, b) =>
      (a.routedPriceUsd ?? a.priceUsd ?? Infinity) - (b.routedPriceUsd ?? b.priceUsd ?? Infinity) ||
      a.key.localeCompare(b.key),
    );
    const chosen = compatible[0];
    if (!chosen) {
      check.reason = offers.length > 0 && values.country
        ? `The live company register offer does not support ${values.country}.`
        : `${capabilityId} is not available in this catalogue.`;
      errors.push(check.reason);
      return;
    }
    check.status = 'planned';
    check.capabilityKey = chosen.key;
  }

  const identityInput: Record<string, unknown> = clean.country
    ? { country: clean.country, ...(clean.registrationNumber ? { number: clean.registrationNumber } : { name: clean.legalName }) }
    : clean.lei ? { lei: clean.lei } : { name: clean.legalName };
  add('identity', 'Legal identity', clean.country
    ? 'symmartys.company.lookup@v1' : 'symmartys.lei.lookup@v1', identityInput);
  // When both identifiers are supplied, retain both checks. An LEI must not silently
  // replace the explicitly requested national register lookup.
  if (clean.country && clean.lei) add('lei', 'Legal entity identifier', 'symmartys.lei.lookup@v1', { lei: clean.lei });
  add('sanctions', 'Name in sanctions lists', 'symmartys.sanctions.screen@v1', { name: clean.legalName, kind: 'entity' });
  add('vat', 'VAT number', 'symmartys.vat.check@v1', {
    ...(clean.vat ? { vat: clean.vat } : {}),
    ...(clean.requesterVat ? { requester_vat: clean.requesterVat } : {}),
  }, Boolean(clean.vat));
  add('domain', 'Domain registration', 'symmartys.domain.rdap@v1', clean.domain ? { domain: clean.domain } : {}, Boolean(clean.domain));
  add('wallet', 'Wallet in sanctions lists', 'symmartys.sanctions.screen@v1', clean.wallet ? { address: clean.wallet } : {}, Boolean(clean.wallet));
  add('eori', 'EORI number', 'symmartys.eori.check@v1', clean.eori ? { eori: clean.eori } : {}, Boolean(clean.eori));

  const planned = checks.filter((check) => check.status === 'planned');
  const blueprint: Blueprint | null = errors.length > 0 ? null : {
    name: 'check-counterparty-before-payment',
    description: 'Public-record checks with sources, freshness and original signed receipts.',
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', input: {}, position: { x: 300, y: 30 } },
      ...planned.map((check, index) => ({
        id: check.id, kind: 'capability' as const, label: check.label,
        capabilityKey: check.capabilityKey, input: check.input,
        position: { x: 40 + (index % 3) * 260, y: 170 + Math.floor(index / 3) * 150 },
      })),
      { id: 'output', kind: 'output', label: 'Counterparty report', input: {},
        position: { x: 300, y: 220 + Math.ceil(planned.length / 3) * 150 } },
    ],
    edges: planned.flatMap((check) => [
      { id: `start-${check.id}`, source: 'trigger', target: check.id },
      { id: `${check.id}-report`, source: check.id, target: 'output' },
    ]),
  };
  return { input: clean, blueprint, checks, errors };
}

/** Structural wire type: the core does not depend on the studio HTTP client. */
export interface CounterpartyRun {
  trace_id?: string;
  bill_of_materials?: unknown;
  step_results?: Record<string, { result?: unknown; receipt?: unknown; success?: boolean; error?: unknown }>;
  error?: string;
  detail?: string;
}

export interface ReportSource {
  name: string;
  url?: string;
  fetchedAt?: string;
  publishedAt?: string;
  sha256: string[];
  ageHours: number | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  /** A report freshness policy, not a guarantee from the source. */
  maxAgeHours: number;
}

export interface ReportCheck {
  id: string;
  label: string;
  capabilityId: string;
  status: 'completed' | 'failed' | 'not_executed' | 'skipped' | 'unavailable' | 'missing';
  summary: string;
  summaryCode: string;
  detail?: string;
  facts: Array<{ key: string; value: string }>;
  findings: string[];
  findingCodes: string[];
  sources: ReportSource[];
  receipt?: unknown;
  hubReceipt?: unknown;
  providerReceipt?: unknown;
  receiptStatus: 'attached' | 'missing';
  receiptHasSignature: boolean;
  signatureVerified: false;
  result?: unknown;
  resultSha256?: string;
}

export interface CounterpartyReport {
  schema: 'hephaestus.counterparty-report.v1';
  generatedAt: string;
  input: CounterpartyInput;
  traceId?: string;
  status: 'complete' | 'incomplete';
  checks: ReportCheck[];
  /** Complete evidence means attached signatures and dated sources, not verified signatures. */
  evidenceComplete: boolean;
  signatureVerified: false;
  billOfMaterials?: unknown;
  rawRun: CounterpartyRun;
}

export interface CounterpartyReportPolicy {
  maxAgeHours?: number;
  sanctionsMaxAgeHours?: number;
}

function hasSignature(value: unknown): boolean {
  if (!record(value)) return false;
  const signature = value.signature;
  return Boolean(text(signature) || (record(signature) && (text(signature.value) || text(signature.signature))));
}

function fetchTimestamp(value: string | undefined): number {
  if (!value) return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return NaN;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
    Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return NaN;
  return Date.parse(value);
}

function sourceFrom(raw: Record<string, unknown>, now: number, maxAgeHours: number): ReportSource {
  const fetchedAt = text(raw.fetched_at);
  // Require a timezone for a fetch timestamp; a date-only string has no observation time.
  const fetched = fetchTimestamp(fetchedAt);
  const age = (now - fetched) / 3_600_000;
  const ageHours = Number.isFinite(age) && age >= 0 ? age : null;
  const digest = Array.isArray(raw.sha256) ? raw.sha256.filter((v): v is string => typeof v === 'string') : text(raw.sha256) ? [String(raw.sha256)] : [];
  const publishedAt = text(raw.published) ?? text(raw.published_at);
  return {
    name: text(raw.source) ?? text(raw.list) ?? 'Source not named',
    ...(text(raw.url) ? { url: String(raw.url) } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    sha256: digest,
    ageHours,
    freshness: ageHours === null ? 'unknown' : ageHours > maxAgeHours ? 'stale' : 'fresh',
    maxAgeHours,
  };
}

const summaries: Record<string, string> = {
  identity_found: 'A registry record was returned for the supplied identifier.',
  identity_candidates: 'A name-search candidate was returned; confirm the identifier.',
  identity_ambiguous: 'Several identity candidates were returned; choose the correct entity.',
  identity_not_found: 'No identity record was found in the queried register.',
  listed: 'The public sanctions lists returned a possible match.',
  not_listed: 'No match was returned by the queried sanctions lists.',
  vat_valid: 'The VAT number was reported valid.',
  vat_invalid: 'The VAT number was reported invalid.',
  domain_registered: 'The domain was reported registered.',
  domain_unregistered: 'The domain was reported unregistered.',
  eori_valid: 'The EORI number was reported valid.',
  eori_invalid: 'The EORI number was reported invalid.',
  completed: 'The check returned a result.',
  skipped: 'No identifier supplied.',
  unavailable: 'The requested check is unavailable.',
  failed: 'The check failed.',
  missing: 'The executor did not return the evidence for this check.',
  not_executed: 'The check was not executed.',
};
const findings: Record<string, string> = {
  identity_unconfirmed: 'A name-search candidate is not a confirmed counterparty identity.',
  identity_ambiguous: 'More than one entity matches the supplied name.',
  identity_not_found: 'No matching entity was found; this alone does not establish fraud.',
  identity_adverse_status: 'A returned entity or registration status requires attention.',
  sanctions_hit: 'Review each possible sanctions match against the official list.',
  vat_invalid: 'The supplied VAT number was not valid at the time of the check.',
  domain_unregistered: 'The queried domain was not registered at the time of the check.',
  eori_invalid: 'The supplied EORI number was not valid at the time of the check.',
  stale_source: 'A source is older than this report freshness policy.',
  unknown_freshness: 'A source fetch time is missing, invalid or in the future.',
  receipt_missing: 'No original receipt was returned for this check.',
  receipt_unsigned: 'The attached receipt has no signature value.',
  signature_not_verified: 'A signature is attached; it has not been cryptographically verified here.',
};

function summaryFor(check: CounterpartyCheck, facts: Record<string, unknown>): { code: string; findings: string[] } {
  if (check.id === 'identity' || check.id === 'lei') {
    const candidates = identityRows(facts);
    const nameSearch = typeof check.input.name === 'string';
    if (facts.found === false || ((Array.isArray(facts.companies) || Array.isArray(facts.candidates)) && candidates.length === 0)) {
      return { code: 'identity_not_found', findings: ['identity_not_found'] };
    }
    if (candidates.length > 1) return { code: 'identity_ambiguous', findings: ['identity_ambiguous', 'identity_unconfirmed'] };
    if (nameSearch && (candidates.length || facts.found === true || record(facts.record))) return { code: 'identity_candidates', findings: ['identity_unconfirmed'] };
    if (facts.found === true || record(facts.record)) return { code: 'identity_found', findings: [] };
  }
  if (check.id === 'sanctions' || check.id === 'wallet') {
    if (facts.listed === true) return { code: 'listed', findings: ['sanctions_hit'] };
    if (facts.listed === false) return { code: 'not_listed', findings: [] };
  }
  if (check.id === 'vat' && typeof facts.valid === 'boolean') {
    return { code: facts.valid ? 'vat_valid' : 'vat_invalid', findings: facts.valid ? [] : ['vat_invalid'] };
  }
  if (check.id === 'domain' && typeof facts.registered === 'boolean') {
    return { code: facts.registered ? 'domain_registered' : 'domain_unregistered', findings: facts.registered ? [] : ['domain_unregistered'] };
  }
  if (check.id === 'eori') {
    const results = objects(facts.results);
    if (results.length && results.every((result) => typeof result.valid === 'boolean')) {
      const valid = results.every((result) => result.valid === true);
      return { code: valid ? 'eori_valid' : 'eori_invalid', findings: valid ? [] : ['eori_invalid'] };
    }
  }
  return { code: 'completed', findings: [] };
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

function addressText(value: unknown): string | undefined {
  if (text(value)) return String(value);
  if (!record(value)) return undefined;
  const parts = [
    ...(Array.isArray(value.lines) ? value.lines.map(displayValue) : []),
    displayValue(value.street),
    displayValue(value.postal_code ?? value.postalCode),
    displayValue(value.city), displayValue(value.region), displayValue(value.country),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(', ') : undefined;
}

const ADVERSE_IDENTITY_STATUSES = new Set([
  'INACTIVE', 'LIQUIDATED', 'DISSOLVED', 'DELETED', 'BANKRUPT', 'CANCELLED', 'CANCELED',
  'CEASED', 'IN LIQUIDATION', 'COMPULSORY DISSOLUTION', 'REMOVED FROM REGISTER',
  'START UP NOT REGISTERED', 'RETIRED', 'ANNULLED', 'LAPSED', 'STRUCK OFF',
  'IN ADMINISTRATION', 'ADMINISTRATION', 'RECEIVERSHIP', 'INSOLVENT', 'IN RE ORGANISATION',
]);

function identityRows(facts: Record<string, unknown>): Record<string, unknown>[] {
  return [...objects(facts.companies), ...objects(facts.candidates), ...(record(facts.record) ? [facts.record] : [])];
}

function hasAdverseIdentityStatus(facts: Record<string, unknown>): boolean {
  return identityRows(facts).some((row) => [row.entity_status, row.status, row.registration_status].some((status) =>
    typeof status === 'string' && ADVERSE_IDENTITY_STATUSES.has(status.trim().toUpperCase().replace(/[\s_-]+/g, ' ')),
  ));
}

/** A readable projection of returned fields; candidates are never silently selected. */
function reportFacts(check: CounterpartyCheck, facts: Record<string, unknown>): ReportCheck['facts'] {
  const out: ReportCheck['facts'] = [];
  const add = (key: string, value: unknown) => {
    const readable = displayValue(value);
    if (readable !== undefined) out.push({ key, value: readable });
  };
  if (check.id === 'identity' || check.id === 'lei') {
    const rows = identityRows(facts);
    const isSearch = typeof check.input.name === 'string';
    if (isSearch || rows.length > 1) {
      add('matched_candidates', rows.length);
      for (const candidate of rows) {
        const parts = [candidate.legal_name ?? candidate.name, candidate.lei ?? candidate.number ?? candidate.registered_as,
          candidate.entity_status ?? candidate.status, candidate.registration_status]
          .map(displayValue).filter((value): value is string => value !== undefined);
        if (parts.length) out.push({ key: 'candidate', value: parts.join(' · ') });
      }
    } else if (rows.length === 1) {
      const row = rows[0]!;
      add('legal_name', row.legal_name ?? row.name);
      add('registration_number', row.number ?? row.registered_as);
      add('lei', row.lei);
      add('entity_status', row.entity_status ?? row.status);
      add('registration_status', row.registration_status);
      add('country', row.jurisdiction ?? row.country ?? facts.country);
      add('vat', row.vat);
      add('registered_address', addressText(row.legal_address ?? row.address));
    }
  } else if (check.id === 'vat') {
    add('vat', facts.vat);
    add('country', facts.country_code);
    add('registered_name', facts.name);
    add('registered_address', addressText(facts.address));
    add('consultation_number', facts.consultation_number);
    add('checked_at', facts.checked_at);
  } else if (check.id === 'domain') {
    add('domain', facts.domain);
    add('domain_age_days', facts.age_days);
    add('registrar', record(facts.registrar) ? facts.registrar.name : facts.registrar);
  } else if (check.id === 'sanctions' || check.id === 'wallet') {
    if (Array.isArray(facts.hits)) add('matched_candidates', objects(facts.hits).length);
    for (const hit of objects(facts.hits)) {
      const entry = record(hit.entry) ? hit.entry : {};
      const parts = [hit.matched ?? entry.name, entry.list, entry.ref].map(displayValue)
        .filter((value): value is string => value !== undefined);
      if (parts.length) out.push({ key: 'candidate', value: parts.join(' · ') });
    }
  } else if (check.id === 'eori') {
    add('checked_at', facts.checked_on);
    for (const result of objects(facts.results)) {
      add('registered_name', result.name);
      add('registered_address', addressText(result.address) ?? addressText(result));
    }
  }
  return out;
}

/**
 * Build a readable projection while retaining the original receipt, result and signed bill.
 * An executor returning only its final hop cannot produce a complete report.
 */
export function buildCounterpartyReport(
  plan: CounterpartyPlan,
  run: CounterpartyRun,
  nowMillis = Date.now(),
  policy: CounterpartyReportPolicy = {},
): CounterpartyReport {
  const bill = record(run.bill_of_materials) ? run.bill_of_materials : {};
  const steps = objects(bill.steps);
  const checks: ReportCheck[] = plan.checks.map((check) => {
    const step = steps.find((candidate) => candidate.id === check.id);
    const evidence = run.step_results?.[check.id];
    const raw = evidence?.result;
    const outer = record(raw) ? raw : {};
    const facts = record(outer.output) ? outer.output : outer;
    const hubReceipt = evidence?.receipt;
    const providerReceipt = outer.receipt;
    const receipt = hasSignature(hubReceipt) ? hubReceipt : hasSignature(providerReceipt)
      ? providerReceipt : hubReceipt ?? providerReceipt;
    const receiptAttached = receipt !== undefined && receipt !== null;
    const receiptHasSignature = hasSignature(receipt);
    let status: ReportCheck['status'];
    if (check.status !== 'planned') status = check.status;
    else if (step?.status === 'skipped' || step?.status === 'not_executed') status = 'not_executed';
    else if (step?.success === false || evidence?.success === false || facts.ok === false || outer.ok === false || outer.success === false ||
      (typeof step?.status_code === 'number' && step.status_code >= 400)) status = 'failed';
    else if (evidence && record(raw)) status = 'completed';
    else if (step?.success === true) status = 'missing';
    else status = 'not_executed';

    const maxAge = check.id === 'sanctions' || check.id === 'wallet'
      ? policy.sanctionsMaxAgeHours ?? 48 : policy.maxAgeHours ?? 24;
    const evidenceSources = record(facts.evidence) ? [facts.evidence] : objects(facts.evidence);
    const sources = [...evidenceSources, ...objects(facts.lists)].map((source) => sourceFrom(source, nowMillis, maxAge));
    const outcome = status === 'completed' ? summaryFor(check, facts) : { code: status, findings: [] };
    const findingCodes = [...outcome.findings];
    if ((check.id === 'identity' || check.id === 'lei') && hasAdverseIdentityStatus(facts)) {
      findingCodes.push('identity_adverse_status');
    }
    if (status === 'completed' || status === 'failed') {
      if (sources.some((source) => source.freshness === 'stale')) findingCodes.push('stale_source');
      if (sources.length === 0 || sources.some((source) => source.freshness === 'unknown')) findingCodes.push('unknown_freshness');
      if (!receiptAttached && !outer.receipt) findingCodes.push('receipt_missing');
      else if (!receiptHasSignature) findingCodes.push('receipt_unsigned');
      if (receiptHasSignature) findingCodes.push('signature_not_verified');
    }
    const detail = text(evidence?.error) ?? text(step?.error) ?? text(facts.error) ?? text(outer.error) ??
      text(facts.detail) ?? text(outer.detail) ?? check.reason;
    return {
      id: check.id, label: check.label, capabilityId: check.capabilityId, status,
      summaryCode: outcome.code,
      summary: summaries[outcome.code] ?? summaries.completed!,
      ...(detail ? { detail } : {}),
      facts: status === 'completed' ? reportFacts(check, facts) : [],
      findingCodes,
      findings: findingCodes.map((code) => findings[code] ?? code),
      sources,
      ...(receiptAttached ? { receipt } : {}),
      ...(hubReceipt !== undefined ? { hubReceipt } : {}),
      ...(providerReceipt !== undefined ? { providerReceipt } : {}),
      receiptStatus: receiptAttached ? 'attached' : 'missing',
      receiptHasSignature,
      signatureVerified: false,
      ...(raw !== undefined ? { result: raw } : {}),
      ...(text(step?.result_sha256) ? { resultSha256: String(step?.result_sha256) } : {}),
    };
  });
  const requested = checks.filter((check) => check.status !== 'skipped');
  const allExecuted = plan.errors.length === 0 && requested.length > 0 && requested.every((check) => check.status === 'completed');
  const evidenceComplete = allExecuted && requested.every((check) =>
    check.receiptHasSignature && check.sources.length > 0 && check.sources.every((source) => source.freshness === 'fresh'),
  ) && hasSignature(run.bill_of_materials);
  return {
    schema: 'hephaestus.counterparty-report.v1',
    generatedAt: new Date(nowMillis).toISOString(),
    input: plan.input,
    ...(run.trace_id ? { traceId: run.trace_id } : {}),
    status: allExecuted ? 'complete' : 'incomplete',
    checks,
    evidenceComplete,
    signatureVerified: false,
    ...(run.bill_of_materials !== undefined ? { billOfMaterials: run.bill_of_materials } : {}),
    rawRun: run,
  };
}
