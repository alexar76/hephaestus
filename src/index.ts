/**
 * HEPHAESTUS core — the framework-free half of the studio.
 *
 * Deliberately dependency-free and DOM-free: the same module has to serve the studio page
 * the hub renders and any other surface that needs to cost or convert a blueprint, so it
 * cannot carry a UI framework's opinions with it.
 */

export * from './types';
export { catalogFromManifest, capabilityKey, findCapability, reputationLabel } from './catalog';
export type { CatalogResult } from './catalog';
export { validateBlueprint, toPipelineRequest } from './blueprint';
export type { ValidationResult, ConversionResult } from './blueprint';
export { estimateBlueprint, formatEstimate } from './estimate';
export { exampleBlueprint, isReference, referencedHops } from './example';
export type { ExampleResult } from './example';
export type { Estimate } from './estimate';
export { WIZARDS, planWizard, planWizards } from './wizards';
export type { Wizard, WizardRole, WizardPick, WizardPlan } from './wizards';
