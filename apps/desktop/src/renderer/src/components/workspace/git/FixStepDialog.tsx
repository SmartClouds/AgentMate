import type { Project } from '@runova/core';
import type { GithubStepLog } from '@shared/apiTypes';
import { stepFixExcerpt } from '@/components/pipelines/stepLog';
import { FixWithAiDialog } from '../FixWithAiDialog';

/** Which step of which run a fix is about. */
export interface StepFixTarget {
  repo: string;
  jobId: number;
  jobName: string;
  stepNumber: number;
  stepName: string;
  workflowName?: string;
  displayTitle?: string;
  runNumber?: number;
  headBranch?: string | null;
}

/** What an agent is asked to do about one step, with the step's output pasted underneath. */
export function buildFixStepPrompt(
  target: StepFixTarget,
  excerpt: string,
  kind: 'failure' | 'warnings',
): string {
  const where = [
    target.headBranch ? `on ${target.headBranch}` : null,
    target.runNumber ? `(run #${target.runNumber})` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const what = kind === 'failure' ? 'failed' : 'printed warnings';
  return [
    `The step "${target.stepName}" of the job "${target.jobName}" ${what} in the GitHub Actions workflow "${target.workflowName ?? 'CI'}"${where ? ` ${where}` : ''}.`,
    target.displayTitle ? `It ran for the commit "${target.displayTitle}".` : null,
    '',
    kind === 'failure'
      ? 'Find the root cause and fix it in this repository. Run the same command the step runs to reproduce the failure where you can, keep the change focused on this failure, and confirm it passes afterwards. When you are done, explain the cause and what you changed.'
      : 'Clear these warnings in this repository without changing what the code does. Where a warning comes from a dependency or an action version, update it to a version that no longer warns. When you are done, explain what each warning meant and what you changed.',
    '',
    'Output from the step:',
    '```',
    excerpt.trim(),
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Fix with AI for one step of a run, built from that step's own log. */
export function FixStepDialog({
  project,
  target,
  log,
  failed,
  open,
  onOpenChange,
}: {
  project: Project;
  target: StepFixTarget;
  log: GithubStepLog;
  /** The step failed. Otherwise it passed and the fix is about its warnings. */
  failed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const kind = failed || log.errors > 0 ? 'failure' : 'warnings';

  return (
    <FixWithAiDialog
      project={project}
      open={open}
      onOpenChange={onOpenChange}
      title={
        kind === 'failure'
          ? `Fix ${target.stepName} with AI`
          : `Fix the warnings in ${target.stepName} with AI`
      }
      description={[
        target.jobName,
        target.headBranch,
        target.runNumber ? `run #${target.runNumber}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      jobKey={`pipeline-step-fix:${target.repo}:${target.jobId}:${target.stepNumber}`}
      source={{ prompt: buildFixStepPrompt(target, stepFixExcerpt(log), kind) }}
    />
  );
}
