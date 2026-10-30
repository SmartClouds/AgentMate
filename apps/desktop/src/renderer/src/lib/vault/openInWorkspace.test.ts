import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { openLoginInWorkspace } from './openInWorkspace';

/** The browser runtime as the helper sees it: a tab's webview attaches some time after it opens. */
function runtime() {
  const ids = new Map<string, number | null>();
  return {
    attach(tabId: string, id: number) {
      ids.set(tabId, id);
    },
    state: (tabId: string) => ({ webContentsId: ids.get(tabId) ?? null }),
  };
}

let fillGuest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fillGuest = vi.fn(async () => ({ ok: true, clearsAt: null }));
  Object.assign(window, { runova: { ...window.runova, vault: { fillGuest } } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openLoginInWorkspace', () => {
  it('opens the site in a browser tab of the project, shows it, then fills it', async () => {
    const navigate = vi.fn();
    const rt = runtime();
    const done = openLoginInWorkspace({
      entryId: 'gh',
      url: 'https://github.com/login',
      projectId: 'p1',
      navigate,
      runtime: rt,
    });

    const ws = useWorkspaceStore.getState().workspaces.p1;
    const tab = Object.values(ws?.tabs ?? {}).find((t) => t.kind === 'browser');
    expect(tab).toMatchObject({ kind: 'browser', url: 'https://github.com/login' });
    expect(navigate).toHaveBeenCalledWith(`/workspace/p1?session=${tab?.id}`);
    expect(fillGuest).not.toHaveBeenCalled();

    rt.attach(tab?.id ?? '', 31);
    await vi.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toEqual({ ok: true, clearsAt: null });
    expect(fillGuest).toHaveBeenCalledWith('gh', 31);
  });

  it('gives up when the tab never gets a page', async () => {
    const done = openLoginInWorkspace({
      entryId: 'gh',
      url: 'https://github.com/login',
      projectId: 'p1',
      navigate: vi.fn(),
      runtime: runtime(),
      timeoutMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toEqual({ ok: false, reason: 'no-guest' });
    expect(fillGuest).not.toHaveBeenCalled();
  });
});
