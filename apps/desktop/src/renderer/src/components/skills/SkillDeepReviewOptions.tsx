import { CLI_REGISTRY } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from '@/components/icons';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';

/** Falls back to whatever Settings picked as the default CLI. */
export const DEFAULT_CLI_VALUE = '__default__';

/** What a caller passes to runAudit once the user has set these. */
export interface DeepReviewSettings {
  deepReview: boolean;
  cliId: string | null;
}

export function deepReviewInput(enabled: boolean, cliId: string): DeepReviewSettings {
  return { deepReview: enabled, cliId: cliId === DEFAULT_CLI_VALUE ? null : cliId };
}

/**
 * The deep-review switch and CLI picker, shared by every place a check can start: one skill from
 * a card, a whole location, or a project's skills. Setting it once next to the button that runs
 * the batch is the point, since being asked per skill would be worse than not offering it.
 */
export function SkillDeepReviewOptions({
  enabled,
  onEnabledChange,
  cliId,
  onCliIdChange,
  disabled,
  /** Extra line under the switch, e.g. how long a batch will take with it on. */
  batchHint,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  cliId: string;
  onCliIdChange: (cliId: string) => void;
  disabled?: boolean;
  batchHint?: string;
}): React.JSX.Element {
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });

  // CLIs that can answer a one-shot prompt and are actually installed here.
  const installedPromptClis = CLI_REGISTRY.filter(
    (cli) => cli.promptCommand && cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5" /> Deep review with an agent CLI
          </span>
          <span className="text-xs text-muted-foreground">
            Sends the skill's text to an installed CLI for a second opinion. Slower, and it can only
            make the verdict stricter.
          </span>
          {enabled && batchHint && <span className="mt-0.5 text-xs text-warning">{batchHint}</span>}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={disabled}
          className="mt-0.5 shrink-0"
        />
      </label>

      {enabled && (
        <div className="space-y-1.5">
          <Label>CLI</Label>
          <Combobox
            className="w-full"
            value={cliId}
            onChange={onCliIdChange}
            disabled={disabled}
            placeholder="Choose a CLI"
            options={[
              { value: DEFAULT_CLI_VALUE, label: 'Default CLI (from Settings)' },
              ...installedPromptClis.map((cli) => ({ value: cli.id, label: cli.label })),
            ]}
          />
          {cliQuery.isFetched && installedPromptClis.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No CLI with a non-interactive mode was detected. Install one from CLI Manager, or
              leave the deep review off and rely on the static scan.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
