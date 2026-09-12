/**
 * Canonical types for a HEPHAESTUS blueprint.
 *
 * A blueprint is a graph of real catalogue rows, so a node references a capability by the
 * pair the hub actually keys on — `product_id` + `capability_id` — never by a display
 * label and never by a locally invented id. The whole point of the studio is that what you
 * draw is what the pipeline executor can be asked to run.
 */

export type JsonSchema = Record<string, unknown>;

/** `trigger` and `output` are local markers; `capability` is a paid catalogue row. */
export type NodeKind = 'trigger' | 'capability' | 'output';

export interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  /** Declared default, when the capability publishes one. */
  default?: unknown;
}

/** How much evidence stands behind a capability's published reputation. */
export type ReputationBasis = 'measured' | 'unobserved' | 'unknown';

export interface Reputation {
  basis: ReputationBasis;
  observations: number;
  /**
   * Only ever a number when `basis === 'measured'`. A hub publishes a neutral placeholder
   * for rows nothing has invoked; rendering that as a score is the defect this field
   * exists to prevent, so the value is dropped rather than passed on.
   */
  successRate: number | null;
  trustScore: number | null;
}

export interface Capability {
  /** `${productId}::${capabilityId}` — stable reference used by blueprint nodes. */
  key: string;
  productId: string;
  capabilityId: string;
  name: string;
  description: string;
  sourceHub: string;
  sourceHubName: string;
  /** `null` when the manifest carries no price — never coerced to 0. */
  priceUsd: number | null;
  routedPriceUsd: number | null;
  p50LatencyMs: number | null;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  inputFields: FieldSpec[];
  outputFields: string[];
  reputation: Reputation;
  /**
   * Whether this row can be wired at all. A capability whose input schema declares no
   * `properties` object, or whose output schema is empty, cannot be connected to anything
   * — it is discoverable and priced but not composable, and the studio has to say so
   * instead of drawing a port that leads nowhere.
   */
  composable: {
    inputDeclared: boolean;
    outputDeclared: boolean;
    /** Declared and genuinely empty: the capability takes no input. Not the same as unknown. */
    takesNoInput: boolean;
  };
}

export interface BlueprintNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Required for `kind === 'capability'`; absent for local trigger/output markers. */
  capabilityKey?: string;
  input: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Marks the edge whose upstream result is fed to the target as `context`.
   * A node may have several parents but only one of them supplies its data, because that
   * is exactly what the executor's `input_from` expresses. Leaving every edge unmarked is
   * legal — it means ordering only, no data hand-off.
   */
  carriesData?: boolean;
}

export interface Blueprint {
  name: string;
  description: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

/** The wire shape of `POST /ai-market/pipelines`. */
export interface PipelineRequestNode {
  id: string;
  product_id: string;
  capability_id: string;
  input: Record<string, unknown>;
  depends_on: string[];
  input_from?: string;
  /** Which hub sells this row, so the executor routes a federated hop to the right peer. */
  source_hub?: string;
}

export interface PipelineRequest {
  nodes: PipelineRequestNode[];
  channel_id?: string;
}

/** The executor caps a pipeline at sixteen nodes; the studio must not promise more. */
export const PIPELINE_MAX_NODES = 16;
