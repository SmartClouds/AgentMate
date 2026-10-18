import { describe, expect, it } from 'vitest';
import type { FilesReview } from '@/stores/deployFilesRunStore';
import {
  allowedPaths,
  buildDeployInput,
  canContinue,
  deletesIn,
  needsReview,
  reviewConflicts,
  selectedTotals,
  siteInputFrom,
} from './deployPlan';
import { fileSite, pending, plan, planChange, snapshot } from './testing/fixtures';

/**
 * Turning a review into the deploy call: only the plan's paths that are ticked go, every conflict
 * among them carries a choice, and the review is skipped when nothing in it needs one.
 */

function review(overrides: Partial<FilesReview> = {}): FilesReview {
  return {
    plan: plan(),
    conflicts: {},
    firstDeploy: null,
    reupload: [],
    only: null,
    ...overrides,
  };
}

const CONFLICTED = plan({
  changes: [
    planChange('index.html'),
    planChange('about.html', { action: 'conflict', conflict: 'changedOnServer' }),
    planChange('old.html', {
      local: 'deleted',
      action: 'conflict',
      conflict: 'changedOnServer',
    }),
    planChange('gone.png', { local: 'deleted' }),
  ],
});

describe('allowedPaths and selectedTotals', () => {
  it('takes the ticked files, or only the retried ones', () => {
    const files = snapshot().files;
    expect([...allowedPaths(review(), files, new Set(['img/old.png']))]).toEqual([
      'index.html',
      'css/site.css',
    ]);
    expect([...allowedPaths(review({ only: ['index.html'] }), files, new Set())]).toEqual([
      'index.html',
    ]);
  });

  it('counts the ticked files and the bytes they send', () => {
    const files = [
      pending('a', 'added', 100),
      pending('b', 'modified', 50),
      pending('c', 'deleted', 999),
    ];
    expect(selectedTotals(files, new Set())).toEqual({ count: 3, bytes: 150 });
    expect(selectedTotals(files, new Set(['a']))).toEqual({ count: 2, bytes: 50 });
  });
});

describe('reviewConflicts and deletesIn', () => {
  it('lists only the conflicts among the paths that go', () => {
    const allowed = new Set(['index.html', 'about.html']);
    expect(reviewConflicts(review({ plan: CONFLICTED }), allowed).map((c) => c.path)).toEqual([
      'about.html',
    ]);
  });

  it('lists the files a deploy deletes, counting a deleted file whose conflict is overwritten', () => {
    const allowed = new Set(['index.html', 'about.html', 'old.html', 'gone.png']);
    expect(deletesIn(review({ plan: CONFLICTED }), allowed)).toEqual(['gone.png']);
    expect(
      deletesIn(review({ plan: CONFLICTED, conflicts: { 'old.html': 'overwrite' } }), allowed),
    ).toEqual(['old.html', 'gone.png']);
    expect(deletesIn(review({ plan: CONFLICTED }), new Set(['index.html']))).toEqual([]);
  });
});

describe('needsReview', () => {
  const allowed = new Set(['index.html', 'css/site.css', 'img/old.png']);

  it('goes straight on when nothing needs a choice', () => {
    expect(needsReview(review(), allowed)).toBe(false);
    expect(
      needsReview(
        review({ plan: plan({ notices: ['notAtomic', 'sizeOnly'], serverOnlyDrift: ['x'] }) }),
        allowed,
      ),
    ).toBe(false);
  });

  it('stops for conflicts, a first deploy, a mass delete, missing files or a clock shift', () => {
    expect(needsReview(review({ plan: CONFLICTED }), new Set(['about.html']))).toBe(true);
    expect(
      needsReview(review({ plan: plan({ firstDeploy: { existing: 4, sameSize: 2 } }) }), allowed),
    ).toBe(true);
    expect(needsReview(review({ plan: plan({ massDelete: true }) }), allowed)).toBe(true);
    expect(needsReview(review({ plan: plan({ missingOnServer: ['a.txt'] }) }), allowed)).toBe(true);
    expect(needsReview(review({ plan: plan({ clockShiftHours: 1 }) }), allowed)).toBe(true);
    expect(needsReview(review({ plan: plan({ notices: ['clockShift'] }) }), allowed)).toBe(true);
  });
});

describe('canContinue', () => {
  it('waits until every conflict that goes has a choice', () => {
    const allowed = new Set(['about.html', 'old.html']);
    expect(canContinue(review({ plan: CONFLICTED }), allowed)).toBe(false);
    expect(
      canContinue(review({ plan: CONFLICTED, conflicts: { 'about.html': 'skip' } }), allowed),
    ).toBe(false);
    expect(
      canContinue(
        review({ plan: CONFLICTED, conflicts: { 'about.html': 'skip', 'old.html': 'overwrite' } }),
        allowed,
      ),
    ).toBe(true);
  });

  it('needs a first deploy choice when the plan asks for one', () => {
    const first = plan({ firstDeploy: { existing: 4, sameSize: 2 } });
    expect(canContinue(review({ plan: first }), new Set())).toBe(false);
    expect(canContinue(review({ plan: first, firstDeploy: 'overwrite' }), new Set())).toBe(true);
  });
});

describe('buildDeployInput', () => {
  it('sends the ticked plan paths with a choice for each conflict among them', () => {
    const input = buildDeployInput(
      review({
        plan: CONFLICTED,
        conflicts: { 'about.html': 'skip', 'old.html': 'overwrite' },
        reupload: ['lost.css', 'not-offered.css'],
      }),
      new Set(['index.html', 'about.html', 'not-in-plan.html']),
    );
    expect(input).toEqual({
      siteId: 'fs-1',
      planId: 'plan-1',
      paths: ['index.html', 'about.html'],
      conflicts: { 'about.html': 'skip' },
      firstDeploy: null,
      reupload: [],
    });
  });

  it('carries the first deploy choice and the files to upload again', () => {
    const input = buildDeployInput(
      review({
        plan: plan({ firstDeploy: { existing: 9, sameSize: 3 }, missingOnServer: ['lost.css'] }),
        firstDeploy: 'adoptSameSize',
        reupload: ['lost.css'],
      }),
      new Set(['index.html']),
    );
    expect(input.firstDeploy).toBe('adoptSameSize');
    expect(input.reupload).toEqual(['lost.css']);
    expect(input.paths).toEqual(['index.html']);
  });
});

describe('siteInputFrom', () => {
  it('turns a saved site into the update input, with no secret flag and no secret', () => {
    const input = siteInputFrom(fileSite({ ignorePatterns: ['*.map'] }), {
      ignorePatterns: ['dist/'],
    });
    expect(input.ignorePatterns).toEqual(['dist/']);
    expect(input.connection).toEqual({
      kind: 'custom',
      host: 'files.example',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: 'ab'.repeat(32),
      tlsPin: null,
      tlsServername: null,
    });
    expect('hasSecret' in input.connection).toBe(false);
    expect('secret' in input.connection).toBe(false);
  });

  it('keeps a saved server login as its id', () => {
    const input = siteInputFrom(fileSite({ connection: { kind: 'saved', sshServerId: 'srv-1' } }));
    expect(input.connection).toEqual({ kind: 'saved', sshServerId: 'srv-1' });
    expect(input.label).toBe('Bakery static');
  });
});
