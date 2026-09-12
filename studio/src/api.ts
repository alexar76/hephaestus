/**
 * Everything the page fetches, in one place.
 *
 * The studio is served by the hub, so the manifest is same-origin — that is the whole
 * reason it lives there rather than on a domain of its own (the hub's CORS is fail-closed,
 * and a builder that cannot read the catalogue is not a builder).
 *
 * Running is same-origin too, via the hub's `/studio/run`, which forwards to the pipeline
 * executor. The executor is a different service and the browser cannot reach it directly;
 * the forwarder's target comes from the hub's own configuration, never from this page.
 */

import type { PipelineRequest } from '@core/types';

const VISITOR_KEY = 'hephaestus.visitor';

/**
 * An opaque, browser-local id that identifies THIS visitor to the hub's free trial.
 *
 * The hub meters a renewing allowance per visitor. Without an id of their own, every
 * person clicking Run is metered as the one service that forwarded the request, so the
 * first visitor exhausts the allowance for everyone — the same bucket-collapse this
 * ecosystem has already been bitten by. It is a random opaque value, never an account and
 * never anything about the person.
 */
export function visitorId(): string {
  try {
    const stored = localStorage.getItem(VISITOR_KEY);
    if (stored) return stored;
    const fresh =
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    // Private mode or storage disabled: a per-session id still beats being merged into
    // the service's bucket, it just does not survive a reload.
    return `v-${Math.random().toString(36).slice(2)}`;
  }
}

export interface TrialQuota {
  enabled?: boolean;
  used?: number;
  remaining?: number;
  max?: number;
  window?: string;
}

export async function fetchTrialQuota(): Promise<TrialQuota | null> {
  try {
    const resp = await fetch('/ai-market/v2/sandbox/quota', {
      headers: { 'X-AIMarket-Sandbox-Visitor': visitorId(), accept: 'application/json' },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as TrialQuota;
  } catch {
    return null;
  }
}

export interface RunResult {
  trace_id?: string;
  trace_url?: string;
  bill_of_materials?: {
    total_usd?: number;
    duration_ms?: number;
    steps?: { id?: string; capability_id?: string; success?: boolean; price_usd?: number | null }[];
    blame?: {
      at_fault?: { id?: string; capability_id?: string; status_code?: number };
      not_at_fault?: string[];
      not_executed?: string[];
    } | null;
  };
  final_result?: Record<string, unknown>;
  error?: string;
  detail?: string;
}

export async function fetchManifest(): Promise<unknown> {
  const resp = await fetch('/ai-market/v2/manifest', { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`manifest: HTTP ${resp.status}`);
  return resp.json();
}

export async function runBlueprint(request: PipelineRequest): Promise<RunResult> {
  const resp = await fetch('/studio/run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Metered to this visitor, not to the service that forwards the run.
      'X-AIMarket-Sandbox-Visitor': visitorId(),
    },
    body: JSON.stringify(request),
  });
  // A refusal carries a reason worth showing verbatim — "executor not configured" is a
  // deployment fact, not a user error, and hiding it behind "run failed" wastes an hour.
  const body = (await resp.json().catch(() => ({}))) as RunResult;
  if (!resp.ok && !body.error) body.error = `HTTP ${resp.status}`;
  return body;
}
