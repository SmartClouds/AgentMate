import type { Project } from '@runova/core';
import type { GithubActionsRunErrorInput } from '@shared/apiTypes';
import { buildFixRunPrompt } from '@shared/pipelineFixPrompt';
import { useRunFailure } from '@/components/pipelines/useRunFailure';
import { FixWithAiDialog } from '../FixWithAiDialog';

/** Fix with AI for a failed pipeline run: fetches the failure, then hands off to the shared dialog. */
export function FixRunDialog({
  project,
  run,
  open,
  onOpenChange,
}: {
  project: Project;
  run: GithubActionsRunErrorInput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const failure = useRunFailure(run, open);

  return (
    <FixWithAiDialog
      project={project}
      open={open}
      onOpenChange={onOpenChange}
      title={`Fix ${run.workflowName ?? 'this run'} with AI`}
      description={[
        run.headBranch,
        run.runNumber ? `run #${run.runNumber}` : null,
        run.displayTitle,
      ]
        .filter(Boolean)
        .join(' · ')}
      jobKey={`pipeline-fix:${run.repo}:${run.runId}`}
      source={{
        prompt: failure.data ? buildFixRunPrompt(run, failure.data) : null,
        loadingLabel: 'Reading the failure from GitHub…',
        error: failure.isError
          ? `Could not read this run's failure: ${failure.error.message}`
          : null,
        retry: () => void failure.refetch(),
      }}
    />
  );
}
