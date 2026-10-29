import { describe, expect, it } from 'vitest';
import { buildFixRunPrompt } from './pipelineFixPrompt';

/**
 * The same prompt goes to an agent whether the user starts the fix or auto-fix does, so the
 * auto-fix variant only adds what changes when nobody is watching: who commits, and which try
 * this is.
 */

const run = {
  repo: 'acme/shop',
  runId: 42,
  workflowName: 'CI',
  displayTitle: 'Add cart totals',
  runNumber: 7,
  headBranch: 'main',
};

describe('buildFixRunPrompt', () => {
  it('names the workflow, branch and run, and pastes the failure underneath', () => {
    const prompt = buildFixRunPrompt(run, '  npm test exited with 1\n');
    expect(prompt).toContain('The GitHub Actions workflow "CI" failed on main (run #7).');
    expect(prompt).toContain('It ran for the commit "Add cart totals".');
    expect(prompt).toContain('Find the root cause and fix it in this repository.');
    expect(prompt.endsWith('```\nnpm test exited with 1\n```')).toBe(true);
  });

  it('falls back to CI and leaves out what the run does not say', () => {
    const prompt = buildFixRunPrompt({ repo: 'acme/shop', runId: 1 }, 'boom');
    expect(prompt.startsWith('The GitHub Actions workflow "CI" failed.')).toBe(true);
    expect(prompt).not.toContain('It ran for the commit');
  });

  it('says nothing about committing when the user runs the fix', () => {
    expect(buildFixRunPrompt(run, 'boom')).not.toMatch(/commit or push/);
  });

  it('tells an auto-fix agent that Runova commits and pushes, not the agent', () => {
    const prompt = buildFixRunPrompt(run, 'boom', { attempt: 1, maxAttempts: 3 });
    expect(prompt).toContain(
      'Runova commits and pushes your change when you finish, so do not commit, push or switch branches yourself.',
    );
    expect(prompt).not.toContain('previous fix');
  });

  it('tells a later attempt that the previous fix did not make the run pass', () => {
    const prompt = buildFixRunPrompt(run, 'boom', { attempt: 2, maxAttempts: 3 });
    expect(prompt).toContain(
      'This is attempt 2 of 3: the previous fix was pushed, but the run still failed.',
    );
  });
});
