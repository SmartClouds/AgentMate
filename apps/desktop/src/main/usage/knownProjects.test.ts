import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ getProjects: vi.fn(), getWorktrees: vi.fn() }));
vi.mock('../store', () => ({ store }));

const { loadKnownProjects } = await import('./knownProjects');

describe('loadKnownProjects', () => {
  it('keeps only the fields that name a folder, and no icons', async () => {
    store.getProjects.mockResolvedValue([
      {
        id: 'p1',
        name: 'Runova',
        folderPath: 'E:\\Runova',
        iconDataUrl: 'data:image/png;base64,AAAA',
        archived: false,
      },
    ]);
    store.getWorktrees.mockResolvedValue([{ projectId: 'p1', path: 'C:\\wt\\x', branch: 'main' }]);

    await expect(loadKnownProjects()).resolves.toEqual({
      projects: [{ id: 'p1', name: 'Runova', folderPath: 'E:\\Runova' }],
      worktrees: [{ projectId: 'p1', path: 'C:\\wt\\x' }],
    });
  });

  it('rejects when the store cannot be read, leaving the caller to decide', async () => {
    store.getProjects.mockRejectedValue(new Error('disk gone'));
    store.getWorktrees.mockResolvedValue([]);

    await expect(loadKnownProjects()).rejects.toThrow('disk gone');
  });
});
