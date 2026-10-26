import { worktreeScopeId } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * Every main handler that takes a project id looks the project up through this resolver, so a
 * worktree's workspace (keyed by a scope id) lands in the worktree's folder instead of the
 * main checkout, without each handler knowing worktrees exist.
 */

const userData = useTempUserData();

const PROJECT = { id: 'p1', name: 'App', folderPath: 'C:/code/app', createdAt: '2026-01-01' };
const RECORD = {
  id: 'wt-1',
  projectId: 'p1',
  path: 'C:/code/app.worktrees/feat',
  branch: 'feat',
  baseBranch: 'main',
  createdAt: '2026-09-25T00:00:00.000Z',
  createdByApp: true,
};

async function load() {
  userData.writeData('projects.json', [PROJECT]);
  userData.writeData('worktrees.json', [RECORD]);
  return import('./resolve');
}

describe('findProjectScope', () => {
  it('returns a project as it is for its own id', async () => {
    const { findProjectScope } = await load();
    const scoped = await findProjectScope('p1');
    expect(scoped).toMatchObject({ id: 'p1', folderPath: 'C:/code/app', parentId: 'p1' });
    expect(scoped?.worktree).toBeNull();
  });

  it('points a worktree scope at the worktree folder, keeping the rest of the project', async () => {
    const { findProjectScope } = await load();
    const scope = worktreeScopeId('p1', 'wt-1');
    expect(await findProjectScope(scope)).toMatchObject({
      id: scope,
      name: 'App',
      folderPath: 'C:/code/app.worktrees/feat',
      parentId: 'p1',
      worktree: RECORD,
    });
  });

  it('returns null for an unknown project or worktree', async () => {
    const { findProjectScope } = await load();
    expect(await findProjectScope('nope')).toBeNull();
    expect(await findProjectScope(worktreeScopeId('p1', 'wt-gone'))).toBeNull();
    expect(await findProjectScope(worktreeScopeId('nope', 'wt-1'))).toBeNull();
  });

  it('never lets a worktree record point a scope at another project', async () => {
    userData.writeData('projects.json', [PROJECT, { ...PROJECT, id: 'p2' }]);
    userData.writeData('worktrees.json', [RECORD]);
    const { findProjectScope } = await import('./resolve');
    expect(await findProjectScope(worktreeScopeId('p2', 'wt-1'))).toBeNull();
  });

  it('lists every worktree folder, for the file system allowlist', async () => {
    const { knownWorktreePaths } = await load();
    expect(await knownWorktreePaths()).toEqual(['C:/code/app.worktrees/feat']);
  });
});

describe('scopeDisplayName', () => {
  it('names a project by itself and a worktree by project and branch', async () => {
    const { scopeDisplayName } = await load();
    expect(await scopeDisplayName('p1')).toBe('App');
    expect(await scopeDisplayName(worktreeScopeId('p1', 'wt-1'))).toBe('App (feat)');
    expect(await scopeDisplayName('nope')).toBeNull();
  });
});
