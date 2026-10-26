import type { BlueprintStepId } from '@runova/core';
import { BLUEPRINT_STEPS } from '@runova/core';
import { Blocks, Bolt, Cpu, LayoutDashboard, Package, Shield, Sparkles } from '@/components/icons';

/** The six sections plus the Review step, which edits the blueprint rather than a section. */
export type BlueprintWizardStep = BlueprintStepId | 'review';

/**
 * Icons live here rather than in `@runova/core`, which has no business knowing
 * what the app draws. Everything else about a step comes from `BLUEPRINT_STEPS`.
 */
const STEP_ICONS: Record<BlueprintStepId, typeof Bolt> = {
  idea: Bolt,
  architecture: Blocks,
  backend: Cpu,
  frontend: LayoutDashboard,
  cicd: Package,
  quality: Shield,
};

export interface BlueprintWizardStepMeta {
  id: BlueprintWizardStep;
  label: string;
  hint: string;
  icon: typeof Bolt;
}

export const BLUEPRINT_WIZARD_STEPS: BlueprintWizardStepMeta[] = [
  ...BLUEPRINT_STEPS.map((step) => ({
    id: step.id as BlueprintWizardStep,
    label: step.label,
    hint: step.hint,
    icon: STEP_ICONS[step.id],
  })),
  { id: 'review', label: 'Review', hint: 'Write the prompt', icon: Sparkles },
];

export function wizardStepIndex(step: BlueprintWizardStep): number {
  return BLUEPRINT_WIZARD_STEPS.findIndex((entry) => entry.id === step);
}
