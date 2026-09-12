/**
 * Wizards — a goal, turned into a real graph over whatever the catalogue sells today.
 *
 * The studio opens on a working example, which answers "what does this page do". It does
 * not answer "how do I get the thing I came for". Seventy-six rows with ids like
 * `gaia.verify@v1` are a catalogue, not an intent: a person who wants a reading they can
 * defend in an argument has to already know that a reading and a verifier are two separate
 * purchases and that one feeds the other.
 *
 * A wizard states the goal in a sentence and works backwards to the rows that satisfy it.
 * Roles are matched by what a capability DECLARES — the fields it produces, the fields it
 * requires, the shape of its id — never by a hard-coded product id. That matters twice
 * over: the wizard keeps working when the catalogue changes, and it can never offer a
 * capability that is not on sale, which is the failure mode of every curated recipe list.
 *
 * When no row can fill a role, the wizard says which role and stays unavailable. A wizard
 * that quietly drops a step would hand the visitor a chain that does something other than
 * what its title promises, and they would pay for it before finding out.
 */

import type { Blueprint, BlueprintEdge, BlueprintNode, Capability, FieldSpec } from './types';

/** One step of a wizard's goal, expressed as a predicate over the live catalogue. */
export interface WizardRole {
  /** Hop id in the produced blueprint, and what `${…}` references point at. */
  id: string;
  /** What this step is for, in the missing-role message. */
  label: string;
  match: (capability: Capability) => boolean;
  /** Wired from the previous role's output, by declared field name. */
  fedByPrevious?: boolean;
  /**
   * At least one wired field has to match this, or the candidate is refused.
   *
   * Matching a role by id and then accepting ANY shared field name builds chains that
   * satisfy the code and not the title. The real catalogue does exactly this: a draw
   * echoes its own `num_bytes` parameter in its output, and a beacon accepts `num_bytes`
   * as a parameter, so the two wire up cleanly and audit nothing. A hop that consumes the
   * previous hop's *parameters* is not consuming its *result*.
   */
  consumes?: RegExp;
  /**
   * The candidate must come from the same product as the previous hop.
   *
   * For cryptographic material this is not a preference, it is correctness. `proof` is a
   * field name, not a format: the live catalogue paired a VRF draw with an unrelated VDF
   * verifier because both spell it `proof`, and that chain bills the visitor for the draw
   * and then fails on a proof the verifier cannot parse. Plain data — a reading, a
   * location — is different, and there a second opinion from a DIFFERENT provider is worth
   * more than one from the same one, so this stays off by default.
   */
  sameProductAsPrevious?: boolean;
}

export interface Wizard {
  id: string;
  /** Imperative, in the visitor's terms — not the capability's terms. */
  title: string;
  /** What you end up holding, and why it is worth the money. */
  goal: string;
  roles: WizardRole[];
}

export interface WizardPick {
  roleId: string;
  capability: Capability;
  /** Fields wired from the previous hop. */
  wired: string[];
  /** Required fields left for the visitor: nothing declared a default and nothing feeds them. */
  toFill: string[];
}

export type WizardPlan =
  | {
      wizard: Wizard;
      available: true;
      blueprint: Blueprint;
      picks: WizardPick[];
      /** One line for the UI: what flows where, and what still needs filling in. */
      note: string;
    }
  | {
      wizard: Wizard;
      available: false;
      /** The first role this catalogue cannot fill. */
      missingRole: string;
      /** Stated in terms of the catalogue, so the visitor knows it is not their mistake. */
      reason: string;
    };

const priceOf = (capability: Capability): number =>
  capability.routedPriceUsd ?? capability.priceUsd ?? Number.POSITIVE_INFINITY;

const defaultsFor = (capability: Capability): Record<string, unknown> =>
  Object.fromEntries(
    capability.inputFields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]),
  );

/** Fields of `consumer` that `producer` declares it produces, matched by name. */
function wirableFields(producer: Capability, consumer: Capability): FieldSpec[] {
  const produced = new Set(producer.outputFields);
  return consumer.inputFields.filter((f) => produced.has(f.name));
}

// ---------------------------------------------------------------------------
// Matchers over declared data. A wizard is only as honest as these are.
// ---------------------------------------------------------------------------

const idLike = (pattern: RegExp) => (c: Capability) => pattern.test(c.capabilityId);
const produces = (pattern: RegExp) => (c: Capability) => c.outputFields.some((f) => pattern.test(f));
const requires = (pattern: RegExp) => (c: Capability) =>
  c.inputFields.some((f) => f.required && pattern.test(f.name));
const all =
  (...tests: Array<(c: Capability) => boolean>) =>
  (c: Capability) =>
    tests.every((t) => t(c));

/**
 * The wizards themselves.
 *
 * Each one is a goal somebody actually arrives with. They are deliberately few: a menu of
 * twenty intents is another catalogue to read, and the point of a wizard is to spare the
 * visitor exactly that.
 */
export const WIZARDS: Wizard[] = [
  {
    id: 'prove-a-reading',
    title: 'Get a measurement you can defend',
    goal:
      'Buy a reading, then buy an independent verdict on whether it is plausible. You end ' +
      'up holding the number and a signed second opinion on it.',
    roles: [
      {
        id: 'read',
        label: 'something that produces a measurement',
        match: produces(/reading|measurement|observation|value|sample/i),
      },
      {
        id: 'verify',
        label: 'a verifier that accepts a measurement',
        fedByPrevious: true,
        consumes: /reading|measurement|observation|value|claim/i,
        match: all(
          idLike(/verif|attest|plausib|validate|check/i),
          requires(/reading|measurement|observation|value|claim/i),
        ),
      },
    ],
  },
  {
    id: 'random-you-can-audit',
    title: 'Draw a number nobody has to be trusted for',
    goal:
      'Buy a draw, then buy the check that the draw was not steered. Useful when the ' +
      'result decides something and the people it decides for do not trust you.',
    roles: [
      {
        id: 'draw',
        label: 'a source of randomness',
        match: idLike(/random|entropy|draw|beacon|lottery|dice/i),
      },
      {
        id: 'audit',
        label: 'a check, from the same provider, that accepts the draw or its proof',
        fedByPrevious: true,
        consumes: /proof|signature|random|entropy|commit|reveal|draw|value/i,
        sameProductAsPrevious: true,
        match: idLike(/verif|proof|attest|beacon|commit|reveal/i),
      },
    ],
  },
  {
    id: 'brief-a-place',
    title: 'Turn a place into a briefing',
    goal:
      'Locate the thing you care about, then buy a written situation over it. The second ' +
      'hop reads the first, so you are not retyping coordinates between purchases.',
    roles: [
      {
        id: 'locate',
        label: 'something that produces a location',
        match: produces(/point|location|position|nearest|lat|coord|place/i),
      },
      {
        id: 'brief',
        label: 'a briefing that accepts a location',
        fedByPrevious: true,
        consumes: /point|location|position|lat|lon|coord|place|coordinates/i,
        match: idLike(/brief|situation|summar|report|digest|assess/i),
      },
    ],
  },
  {
    id: 'try-before-you-buy',
    title: 'Try one capability before you build on it',
    goal:
      'A single priced hop with its defaults filled in, chosen from rows this hub has ' +
      'actually seen invoked. Cheapest way to find out whether a row is worth wiring into ' +
      'anything larger.',
    roles: [
      {
        id: 'trial',
        label: 'a priced capability with observed calls behind it',
        // Priced above zero on purpose: the goal is to find out whether a row is worth
        // paying for, and a free row answers a different question.
        match: (c) =>
          c.reputation.basis === 'measured' && c.outputFields.length > 0 && priceOf(c) > 0,
      },
    ],
  },
];

interface Candidate {
  capability: Capability;
  wired: FieldSpec[];
}

/** Required fields with nothing to fill them: no default, and nothing wired in. */
function unfilled(capability: Capability, wired: FieldSpec[]): string[] {
  const supplied = new Set(wired.map((f) => f.name));
  return capability.inputFields
    .filter((f) => f.required && f.default === undefined && !supplied.has(f.name))
    .map((f) => f.name);
}

/**
 * Pick one capability per role.
 *
 * Ranked in this order: how much data the hop threads from the one before it, then how
 * little is left for the visitor to type, then whether there is measured evidence behind
 * the row, then price. Threading comes first because a chain that does not carry data is
 * two separate purchases wearing a wizard's title; price comes last because the cheapest
 * chain that does not do the job is not a saving.
 */
function chooseChain(roles: WizardRole[], catalog: Capability[]): WizardPick[] | { missing: WizardRole } {
  const picks: WizardPick[] = [];
  let previous: Capability | null = null;

  for (const role of roles) {
    const candidates: Candidate[] = [];
    for (const capability of catalog) {
      if (!capability.composable.outputDeclared) continue;
      if (picks.some((p) => p.capability.key === capability.key)) continue;
      if (!role.match(capability)) continue;
      if (role.fedByPrevious) {
        if (!previous) continue;
        const wired = wirableFields(previous, capability);
        if (wired.length === 0) continue; // a role fed by nothing is not this role
        if (role.consumes && !wired.some((f) => role.consumes!.test(f.name))) continue;
        if (role.sameProductAsPrevious && capability.productId !== previous.productId) continue;
        candidates.push({ capability, wired });
      } else {
        candidates.push({ capability, wired: [] });
      }
    }

    if (candidates.length === 0) return { missing: role };

    candidates.sort((a, b) => {
      if (a.wired.length !== b.wired.length) return b.wired.length - a.wired.length;
      const fill = unfilled(a.capability, a.wired).length - unfilled(b.capability, b.wired).length;
      if (fill !== 0) return fill;
      const measured =
        Number(b.capability.reputation.basis === 'measured') -
        Number(a.capability.reputation.basis === 'measured');
      if (measured !== 0) return measured;
      return priceOf(a.capability) - priceOf(b.capability);
    });

    const chosen = candidates[0]!;
    picks.push({
      roleId: role.id,
      capability: chosen.capability,
      wired: chosen.wired.map((f) => f.name),
      toFill: unfilled(chosen.capability, chosen.wired),
    });
    previous = chosen.capability;
  }

  return picks;
}

const LANE_X = 60;
const LANE_STEP = 150;

/** Turn the chosen chain into a blueprint: trigger, the hops, output. */
function blueprintFrom(wizard: Wizard, picks: WizardPick[]): Blueprint {
  const nodes: BlueprintNode[] = [
    { id: 'trigger', kind: 'trigger', label: 'Start', input: {}, position: { x: LANE_X, y: 40 } },
  ];
  const edges: BlueprintEdge[] = [];
  let previousId = 'trigger';

  picks.forEach((pick, index) => {
    const input: Record<string, unknown> = { ...defaultsFor(pick.capability) };
    for (const field of pick.wired) input[field] = `\${${previousId}.${field}}`;
    nodes.push({
      id: pick.roleId,
      kind: 'capability',
      label: pick.capability.capabilityId,
      capabilityKey: pick.capability.key,
      input,
      position: { x: LANE_X, y: 40 + LANE_STEP * (index + 1) },
    });
    edges.push({
      id: `e${edges.length + 1}`,
      source: previousId,
      target: pick.roleId,
      carriesData: pick.wired.length > 0 ? true : undefined,
    });
    previousId = pick.roleId;
  });

  nodes.push({
    id: 'output',
    kind: 'output',
    label: 'Result',
    input: {},
    position: { x: LANE_X, y: 40 + LANE_STEP * (picks.length + 1) },
  });
  edges.push({ id: `e${edges.length + 1}`, source: previousId, target: 'output' });

  return {
    name: wizard.id,
    description: picks.map((p) => p.capability.capabilityId).join(' → '),
    nodes,
    edges,
  };
}

function noteFor(picks: WizardPick[]): string {
  const parts: string[] = [];
  const threaded = picks.filter((p) => p.wired.length > 0);
  for (const pick of threaded) {
    parts.push(`${pick.wired.join(', ')} flows into ${pick.capability.capabilityId}`);
  }
  const toFill = picks.flatMap((p) => p.toFill.map((f) => `${p.roleId}.${f}`));
  if (toFill.length > 0) parts.push(`fill in ${toFill.join(', ')} before running`);
  if (parts.length === 0) parts.push('one priced hop, defaults already filled in');
  return parts.join(' · ');
}

/** Plan one wizard against a catalogue. Never throws; unavailability is a result. */
export function planWizard(wizard: Wizard, catalog: Capability[]): WizardPlan {
  const chain = chooseChain(wizard.roles, catalog);
  if ('missing' in chain) {
    return {
      wizard,
      available: false,
      missingRole: chain.missing.id,
      reason: `nothing on sale here fills the "${chain.missing.label}" step`,
    };
  }
  return {
    wizard,
    available: true,
    blueprint: blueprintFrom(wizard, chain),
    picks: chain,
    note: noteFor(chain),
  };
}

/**
 * Plan every wizard, available ones first.
 *
 * The unavailable ones are still returned, with their reason: a wizard that vanishes from
 * the menu tells the visitor nothing, while "nothing on sale here fills the verifier step"
 * tells them something true about the marketplace.
 */
export function planWizards(catalog: Capability[]): WizardPlan[] {
  const plans = WIZARDS.map((wizard) => planWizard(wizard, catalog));
  return [...plans.filter((p) => p.available), ...plans.filter((p) => !p.available)];
}
