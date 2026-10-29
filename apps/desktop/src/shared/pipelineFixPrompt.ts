import type { GithubActionsRunErrorInput } from './apiTypes';

/** Set when auto-fix sends the prompt, so the agent knows nobody is there to commit or retry. */
export interface AutoFixPromptAttempt {
  attempt: number;
  maxAttempts: number;
}

/**
 * What an agent is asked to do about a failed run, with the failure pasted underneath. Used by
 * Fix with AI in the renderer and by auto-fix in main, so both ask for the same thing.
 */
export function buildFixRunPrompt(
  run: GithubActionsRunErrorInput,
  failure: string,
  autoFix?: AutoFixPromptAttempt,
): string {
  const where = [
    run.headBranch ? `on ${run.headBranch}` : null,
    run.runNumber ? `(run #${run.runNumber})` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return [
    `The GitHub Actions workflow "${run.workflowName ?? 'CI'}" failed${where ? ` ${where}` : ''}.`,
    run.displayTitle ? `It ran for the commit "${run.displayTitle}".` : null,
    autoFix && autoFix.attempt > 1
      ? `This is attempt ${autoFix.attempt} of ${autoFix.maxAttempts}: the previous fix was pushed, but the run still failed.`
      : null,
    '',
    'Find the root cause and fix it in this repository. Run the same checks the workflow runs to reproduce the failure where you can, keep the change focused on this failure, and confirm the checks pass afterwards. When you are done, explain the cause and what you changed.',
    autoFix
      ? 'Runova commits and pushes your change when you finish, so do not commit, push or switch branches yourself.'
      : null,
    '',
    'Failure output from the run:',
    '```',
    failure.trim(),
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n');
}
