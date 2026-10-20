import type { SftpConflict, SftpQueueSnapshot, SftpSessionInfo } from '@shared/sftpTypes';
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { ConflictDialogProps } from './contracts';
import { SftpConflictHost } from './SftpConflictHost';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/** The dialog has tests of its own; here only which conflict the host hands it counts. */
const seen = vi.hoisted(() => ({ dialogs: [] as ConflictDialogProps[] }));
vi.mock('./ConflictDialog', () => ({
  ConflictDialog: (props: ConflictDialogProps) => {
    seen.dialogs.push(props);
    return props.conflict ? (
      <div
        role="dialog"
        aria-label="This file already exists"
        data-conflict={props.conflict.name}
      />
    ) : null;
  },
}));

/**
 * One conflict dialog per window (E25): the host sits in the app shell, so a page and a docked
 * panel on the same server never stack two. It opens by itself only where the user can see that
 * server's files, so a question never lands on a page about something else (where Enter in a
 * terminal could answer it). Elsewhere a toast and the status bar say a server waits, and their
 * Answer opens the dialog.
 */

function conflict(name: string, conflictId = `c-${name}`): SftpConflict {
  return {
    conflictId,
    batchId: `b-${name}`,
    itemId: 'i1',
    direction: 'upload',
    name,
    relPath: name,
    targetDir: '/srv',
    source: { size: 1, mtimeMs: 1 },
    target: { size: 2, mtimeMs: 2, isDirectory: false },
    renameTo: `${name} (1)`,
    remainingInBatch: 0,
  };
}

function session(serverId: string, nickname = serverId): SftpSessionInfo {
  return {
    sessionId: `sess-${serverId}`,
    serverId,
    nickname,
    host: `${serverId}.example`,
    port: 22,
    username: 'deploy',
    home: '/home/deploy',
  };
}

/**
 * Puts a ready server with this conflict (or none) in the store, as a snapshot would. `visible`
 * is how many views of it this window shows; left out, it stays as it was.
 */
function serverWith(
  serverId: string,
  value: SftpConflict | null,
  options: { visible?: number; nickname?: string } = {},
): void {
  const queue: SftpQueueSnapshot = {
    sessionId: `sess-${serverId}`,
    batches: [],
    conflict: value,
    pendingConflicts: 0,
  };
  useSftpStore.setState((state) => {
    const files = serverFiles(state, serverId);
    return {
      servers: {
        ...state.servers,
        [serverId]: {
          ...files,
          session: session(serverId, options.nickname),
          status: 'ready',
          queue,
          visible: options.visible ?? files.visible,
        },
      },
    };
  });
}

const lastDialog = (): ConflictDialogProps => {
  const last = seen.dialogs.at(-1);
  if (!last) throw new Error('The host rendered no dialog');
  return last;
};

/** The toast shown for a conflict id, with its options. */
function toastFor(conflictId: string) {
  const call = toast.warning.mock.calls.find(
    ([, options]) => (options as { id?: string } | undefined)?.id === `sftp-conflict-${conflictId}`,
  );
  if (!call) throw new Error(`No toast for ${conflictId}`);
  return {
    title: call[0] as string,
    options: call[1] as {
      id: string;
      description?: string;
      duration?: number;
      action: { label: string; onClick: () => void };
    },
  };
}

beforeEach(() => {
  resetSftpStore();
  seen.dialogs.length = 0;
  toast.warning.mockClear();
  toast.dismiss.mockClear();
});

describe('SftpConflictHost', () => {
  it('renders nothing while no server waits on a conflict', () => {
    serverWith('a', null, { visible: 1 });
    const { container } = renderWithProviders(<SftpConflictHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.textContent).toBe('');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('opens no modal on a page without a view of that server, and toasts instead', () => {
    renderWithProviders(<SftpConflictHost />);
    act(() => serverWith('web', conflict('index.html'), { nickname: 'Production' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(seen.dialogs).toHaveLength(0);

    const shown = toastFor('c-index.html');
    expect(shown.title).toBe('Production needs your answer');
    expect(shown.options.description).toBe('index.html is already in /srv.');
    expect(shown.options.duration).toBe(Number.POSITIVE_INFINITY);
    expect(shown.options.action.label).toBe('Answer');
  });

  it("opens the dialog from the toast's Answer", () => {
    serverWith('web', conflict('index.html'));
    renderWithProviders(<SftpConflictHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => toastFor('c-index.html').options.action.onClick());
    expect(useSftpStore.getState().conflictFocus).toBe('web');
    expect(screen.getByRole('dialog', { name: 'This file already exists' })).toBeTruthy();
    expect(lastDialog().conflict?.name).toBe('index.html');
    // The question is now in the dialog, so its toast goes.
    expect(toast.dismiss).toHaveBeenCalledWith('sftp-conflict-c-index.html');
  });

  it('opens the dialog straight away where a view of the server is shown', () => {
    renderWithProviders(<SftpConflictHost />);
    act(() => serverWith('web', conflict('index.html'), { visible: 1 }));
    expect(screen.getByRole('dialog', { name: 'This file already exists' })).toBeTruthy();
    expect(lastDialog().conflict?.name).toBe('index.html');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('shows one toast per conflict, not one per snapshot', () => {
    renderWithProviders(<SftpConflictHost />);
    act(() => serverWith('web', conflict('a.txt')));
    act(() => serverWith('web', conflict('a.txt')));
    act(() => serverWith('web', conflict('a.txt')));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // The next question is a new toast.
    act(() => serverWith('web', conflict('b.txt')));
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.dismiss).toHaveBeenCalledWith('sftp-conflict-c-a.txt');
  });

  it('dismisses the toast once its conflict is gone', () => {
    renderWithProviders(<SftpConflictHost />);
    act(() => serverWith('web', conflict('a.txt')));
    expect(toast.dismiss).not.toHaveBeenCalled();
    act(() => serverWith('web', null));
    expect(toast.dismiss).toHaveBeenCalledWith('sftp-conflict-c-a.txt');
  });

  it('dismisses its toasts when it goes away', () => {
    const { unmount } = renderWithProviders(<SftpConflictHost />);
    act(() => serverWith('web', conflict('a.txt')));
    unmount();
    expect(toast.dismiss).toHaveBeenCalledWith('sftp-conflict-c-a.txt');
  });

  it('shows one dialog when two shown servers wait, the first by id', () => {
    serverWith('zed', conflict('z.txt'), { visible: 1 });
    serverWith('alpha', conflict('a.txt'), { visible: 1 });
    renderWithProviders(<SftpConflictHost />);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(lastDialog().conflict?.name).toBe('a.txt');
  });

  it('asks about a shown server first, and toasts for the one out of sight', () => {
    serverWith('alpha', conflict('a.txt'));
    serverWith('zed', conflict('z.txt'), { visible: 1 });
    renderWithProviders(<SftpConflictHost />);
    expect(lastDialog().conflict?.name).toBe('z.txt');
    expect(toastFor('c-a.txt').title).toBe('alpha needs your answer');
    expect(() => toastFor('c-z.txt')).toThrow();
  });

  it('asks about the server the user picked to answer', () => {
    serverWith('alpha', conflict('a.txt'), { visible: 1 });
    serverWith('zed', conflict('z.txt'), { visible: 1 });
    renderWithProviders(<SftpConflictHost />);
    act(() => useSftpStore.getState().requestAnswer('zed'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(lastDialog().conflict?.name).toBe('z.txt');
    // Once that server has no conflict left, the other one is asked about again (the store
    // lets go of the focus then too; sftpStore.test covers that through a snapshot).
    act(() => serverWith('zed', null));
    expect(lastDialog().conflict?.name).toBe('a.txt');
  });

  it("sends the answer and the batch cancel to the store for the conflict's server", async () => {
    serverWith('alpha', conflict('a.txt'), { visible: 1 });
    serverWith('zed', conflict('z.txt'));
    const resolveConflict = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    useSftpStore.setState({ resolveConflict, cancel });
    renderWithProviders(<SftpConflictHost />);
    act(() => useSftpStore.getState().requestAnswer('zed'));

    await act(async () => {
      await lastDialog().onResolve({ action: 'rename', applyToAll: true });
      await lastDialog().onCancelBatch('b-z.txt');
    });
    expect(resolveConflict).toHaveBeenCalledWith('zed', 'c-z.txt', {
      action: 'rename',
      applyToAll: true,
    });
    expect(cancel).toHaveBeenCalledWith('zed', { batchId: 'b-z.txt' });
  });

  it("rejects with the store's error, so the dialog tells it and unlocks", async () => {
    serverWith('a', conflict('index.html'), { visible: 1 });
    useSftpStore.setState({
      resolveConflict: async () => {
        throw new Error('[files:invalidInput] Unknown conflict');
      },
      cancel: async () => {
        throw new Error('[files:server] No such batch');
      },
    });
    renderWithProviders(<SftpConflictHost />);
    await expect(
      Promise.resolve(lastDialog().onResolve({ action: 'skip', applyToAll: false })),
    ).rejects.toThrow('Unknown conflict');
    await expect(Promise.resolve(lastDialog().onCancelBatch('b1'))).rejects.toThrow(
      'No such batch',
    );
  });

  it('tells the dialog which server asks, by its nickname', () => {
    serverWith('alpha', conflict('a.txt'), { visible: 1, nickname: 'Production' });
    renderWithProviders(<SftpConflictHost />);
    expect(lastDialog().serverName).toBe('Production');
  });

  it("falls back to the saved server's nickname, then to its id", () => {
    serverWith('alpha', conflict('a.txt'), { visible: 1 });
    const files = serverFiles(useSftpStore.getState(), 'alpha');
    useSftpStore.setState({
      servers: {
        alpha: {
          ...files,
          session: null,
          server: { nickname: 'Staging', host: 'h', port: 22, username: 'u' },
        },
      },
    });
    const { unmount } = renderWithProviders(<SftpConflictHost />);
    expect(lastDialog().serverName).toBe('Staging');
    unmount();
    useSftpStore.setState({ servers: { alpha: { ...files, session: null, server: null } } });
    renderWithProviders(<SftpConflictHost />);
    expect(lastDialog().serverName).toBe('alpha');
  });

  it('answers nothing once the conflict is gone by the time the answer comes', async () => {
    serverWith('a', conflict('index.html'), { visible: 1 });
    const resolveConflict = vi.fn(async () => undefined);
    useSftpStore.setState({ resolveConflict });
    renderWithProviders(<SftpConflictHost />);
    const answer = lastDialog().onResolve;
    act(() => serverWith('a', null));
    await act(async () => {
      await answer({ action: 'skip', applyToAll: false });
    });
    expect(resolveConflict).not.toHaveBeenCalled();
  });
});
