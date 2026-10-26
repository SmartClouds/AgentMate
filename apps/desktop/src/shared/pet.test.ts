import { describe, expect, it } from 'vitest';
import type { PetPipelineRunRef } from './pet';
import {
  PET_BOX,
  PET_SNOOZE_MAX_MINUTES,
  PET_SNOOZE_OPTIONS,
  pipelineRunRoute,
  workspacePipelinesRoute,
} from './pet';

/**
 * The companion overlay is a transparent, click-through window: these numbers
 * decide where it can be clicked, and the route is what a click on a failure
 * bubble opens in the main window.
 */

describe('pipelineRunRoute', () => {
  it('points at the Pipelines page with the run selected', () => {
    expect(pipelineRunRoute({ runId: 1234, repo: 'runova/runova' })).toBe(
      '/pipelines?run=1234&repo=runova%2Frunova',
    );
  });

  it('escapes the repo, which always contains a slash', () => {
    // An unescaped "owner/repo" would end the query value at the slash on some
    // routers and lose the repo.
    const route = pipelineRunRoute({ runId: 7, repo: 'owner/repo name' });
    expect(route).not.toContain('owner/repo');
    expect(route).toContain('repo=owner%2Frepo+name');
  });

  it('round trips through URLSearchParams', () => {
    // The Pipelines page parses these back out, so the pair has to survive.
    const run: PetPipelineRunRef = { runId: 987654321, repo: 'Some-Org/weird repo&name' };
    const params = new URLSearchParams(pipelineRunRoute(run).split('?')[1]);
    expect(params.get('run')).toBe(String(run.runId));
    expect(params.get('repo')).toBe(run.repo);
  });

  it("opens the project's workspace Pipelines section when the ref asks for it", () => {
    const run: PetPipelineRunRef = { runId: 1234, repo: 'a/b', workspaceProjectId: 'proj-1' };

    expect(pipelineRunRoute(run)).toBe('/workspace/proj-1?panel=pipelines');
    expect(pipelineRunRoute(run)).toBe(workspacePipelinesRoute('proj-1'));
  });

  it('escapes the project id so it cannot add a query of its own', () => {
    const route = workspacePipelinesRoute('a/b?panel=explorer');

    expect(route).toBe('/workspace/a%2Fb%3Fpanel%3Dexplorer?panel=pipelines');
    expect(new URLSearchParams(route.split('?').slice(1).join('?')).get('panel')).toBe('pipelines');
  });

  it('keeps large run ids intact as text', () => {
    // GitHub run ids are well past 2^32; formatting them through a number type
    // must not go exponential or lose digits.
    expect(pipelineRunRoute({ runId: 12345678901234, repo: 'a/b' })).toContain(
      'run=12345678901234',
    );
  });
});

describe('snooze options', () => {
  it('offers durations in increasing order', () => {
    const minutes = PET_SNOOZE_OPTIONS.map((option) => option.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it('keeps every offered duration within the hard cap', () => {
    // The main process clamps a requested snooze to PET_SNOOZE_MAX_MINUTES, so
    // an option above it would silently come back early and look like a bug.
    for (const option of PET_SNOOZE_OPTIONS) {
      expect(option.minutes).toBeGreaterThan(0);
      expect(option.minutes).toBeLessThanOrEqual(PET_SNOOZE_MAX_MINUTES);
    }
  });

  it('labels each duration once', () => {
    expect(new Set(PET_SNOOZE_OPTIONS.map((option) => option.label)).size).toBe(
      PET_SNOOZE_OPTIONS.length,
    );
    expect(new Set(PET_SNOOZE_OPTIONS.map((option) => option.minutes)).size).toBe(
      PET_SNOOZE_OPTIONS.length,
    );
  });

  it('caps a hide at one day', () => {
    // A bad or hostile value must never park the companion for good.
    expect(PET_SNOOZE_MAX_MINUTES).toBe(24 * 60);
  });
});

describe('PET_BOX', () => {
  it('is a positive hit box, since the overlay is otherwise click-through', () => {
    expect(PET_BOX).toBeGreaterThan(0);
    expect(Number.isInteger(PET_BOX)).toBe(true);
  });
});
