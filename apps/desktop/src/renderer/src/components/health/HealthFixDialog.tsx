import type { Project } from '@runova/core';
import type { HealthTargetSummary } from '@shared/healthTypes';
import { useQuery } from '@tanstack/react-query';
import { FixWithAiDialog } from '@/components/workspace/FixWithAiDialog';
import { queryKeys } from '@/lib/queryKeys';

/** The fix prompt's query key, nested under the target so a change refreshes it too. */
export function healthFixPromptKey(targetId: string) {
  return [...queryKeys.healthTarget(targetId), 'fix-prompt'] as const;
}

/**
 * Fix with AI for a failing health target: the main process builds the prompt from the last
 * (redacted) report and incident, then the shared dialog hands it to the project's agent.
 */
export function HealthFixDialog({
  project,
  target,
  open,
  onOpenChange,
}: {
  project: Project;
  target: HealthTargetSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const prompt = useQuery({
    queryKey: healthFixPromptKey(target.id),
    queryFn: async () => (await window.runova.health.fixPrompt(target.id)) ?? null,
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentLoading: true },
  });

  const nothingToFix = prompt.isSuccess && prompt.data === null;
  return (
    <FixWithAiDialog
      project={project}
      open={open}
      onOpenChange={onOpenChange}
      title={`Fix ${target.name} with AI`}
      description={[project.name, target.serverLabel].filter(Boolean).join(' · ')}
      jobKey={`health-fix:${target.id}:${target.openIncident?.id ?? 'none'}`}
      source={{
        prompt: prompt.data ?? null,
        loadingLabel: 'Collecting the errors from the last check…',
        error: prompt.isError
          ? `Could not build the fix prompt: ${prompt.error.message}`
          : nothingToFix
            ? 'Nothing is failing right now, so there is nothing to fix.'
            : null,
        retry: () => void prompt.refetch(),
      }}
    />
  );
}
