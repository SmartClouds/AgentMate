import type { Project } from '@runova/core';
import type { ErrorIssueSummary } from '@shared/errorTrackingTypes';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { FixWithAiDialog } from '@/components/workspace/FixWithAiDialog';
import { useErrorFixPrompt } from './useErrorTracking';

/**
 * Fix with AI for an error tracker issue (E24): the main process builds the prompt from the
 * issue's latest (redacted) event, then the shared dialog hands it to the project's agent.
 */
export function ErrorFixDialog({
  project,
  issue,
  open,
  onOpenChange,
}: {
  project: Project;
  issue: ErrorIssueSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const ref = { connectionId: issue.connectionId, issueId: issue.id };
  const prompt = useErrorFixPrompt(ref, open);

  return (
    <FixWithAiDialog
      project={project}
      open={open}
      onOpenChange={onOpenChange}
      title={`Fix ${issue.shortId} with AI`}
      description={[project.name, issue.title].join(' · ')}
      jobKey={`error-fix:${issue.connectionId}:${issue.id}`}
      promptType="Bug Fix"
      promptLabel="Fix prompt"
      source={{
        prompt: prompt.data?.prompt ?? null,
        loadingLabel: 'Reading the latest event from Sentry…',
        error: prompt.isError
          ? `Could not build the fix prompt: ${ipcErrorMessage(prompt.error, 'Something went wrong.')}`
          : prompt.isSuccess && !prompt.data
            ? 'Sentry has no event for this issue, so there is nothing to build a prompt from.'
            : null,
        retry: () => void prompt.refetch(),
      }}
    />
  );
}
