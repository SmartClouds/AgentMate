import type { BlueprintPreset, BlueprintStepId } from '@runova/core';
import { useNavigate } from 'react-router-dom';
import { Check, Plus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The snippets defined in Settings, for this step only. Clicking one appends it
 * rather than replacing what is there: a step usually takes two or three of them
 * plus a sentence of its own.
 */
export function BlueprintPresetChips({
  stepId,
  presets,
  text,
  onApply,
}: {
  stepId: BlueprintStepId;
  presets: BlueprintPreset[];
  /** The step's current draft, used to show which presets are already in. */
  text: string;
  onApply: (preset: BlueprintPreset) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const forStep = presets.filter((preset) => preset.stepId === stepId);

  if (forStep.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No presets for this step yet.{' '}
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          onClick={() => navigate('/settings?tab=general')}
        >
          Add some in Settings
        </button>{' '}
        and they show up here.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {forStep.map((preset) => {
        const applied = text.includes(preset.text.trim());
        return (
          <SimpleTooltip key={preset.id} label={preset.text} wrapTrigger={applied}>
            <Button
              type="button"
              variant="soft"
              size="sm"
              disabled={applied}
              onClick={() => onApply(preset)}
              className={cn(
                'gap-1.5 px-2.5 font-normal',
                applied && 'opacity-60 disabled:pointer-events-none',
              )}
            >
              {applied ? <Check className="h-3 w-3 text-primary" /> : <Plus className="h-3 w-3" />}
              {preset.label}
            </Button>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}
