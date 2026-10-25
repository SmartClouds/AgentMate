import type { Project } from '@agentmat/core';
import type { GithubActionsRunErrorInput } from '@shared/apiTypes';
import { useRunFailure } from '@/components/pipelines/useRunFailure';
import { FixWithAiDialog } from '../FixWithAiDialog';

/** What an agent is asked to do about a failed run, with the failure pasted underneath. */
export function buildFixRunPrompt(run: GithubActionsRunErrorInput, failure: string): string {
  const where = [
    run.headBranch ? `on ${run.headBranch}` : null,
    run.runNumber ? `(run #${run.runNumber})` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return [
    `The GitHub Actions workflow "${run.workflowName ?? 'CI'}" failed${where ? ` ${where}` : ''}.`,
    run.displayTitle ? `It ran for the commit "${run.displayTitle}".` : null,
    '',
    'Find the root cause and fix it in this repository. Run the same checks the workflow runs to reproduce the failure where you can, keep the change focused on this failure, and confirm the checks pass afterwards. When you are done, explain the cause and what you changed.',
    '',
    'Failure output from the run:',
    '```',
    failure.trim(),
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

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
