import type { SshSavedServer } from '@shared/apiTypes';
import type { SftpListing, SftpRemoteEntry, SftpSessionInfo } from '@shared/sftpTypes';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSftpStore, useSftpStore } from '@/stores/sftpStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { FilePane } from './FilePane';

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

/**
 * The parts of a pane that only show with many rows: a queue snapshot (every 100 ms while
 * something transfers) must not redraw the rows, and the keyboard's row is only announced
 * while it is drawn.
 */

/** Every row draws its Modified cell through this, so its calls count row renders. */
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/sftp/entries', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/sftp/entries')>();
  return {
    ...real,
    formatFullDate: (ms: number) => {
      rowRenders.count += 1;
      return real.formatFullDate(ms);
    },
  };
});

/** The drawn window, which jsdom (with no layout) would otherwise make the whole list. */
const drawn = vi.hoisted(() => ({ end: Number.POSITIVE_INFINITY }));
vi.mock('@/hooks/useVirtualRows', () => ({
  useVirtualRows: (count: number) => ({
    containerRef: () => undefined,
    onScroll: () => undefined,
    start: 0,
    end: Math.min(count, drawn.end),
    padTop: 0,
    padBottom: 0,
    scrollToIndex: () => undefined,
  }),
}));

const SERVER: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

const SESSION: SftpSessionInfo = {
  sessionId: 'sess-1',
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  home: '/home/deploy',
};

const ENTRIES: SftpRemoteEntry[] = Array.from({ length: 6 }, (_, i) => ({
  name: `f${i}.txt`,
  path: `/home/deploy/f${i}.txt`,
  kind: 'file',
  isDirectory: false,
  isSymlink: false,
  size: 10,
  mtimeMs: 1_700_000_000_000,
  mode: 0o644,
  owner: 'deploy',
  group: 'deploy',
}));

async function setup() {
  const view = renderWithProviders(<FilePane serverId="srv-1" side="remote" />, {
    bridge: {
      'ssh.listServers': [SERVER],
      'sftp.open': SESSION,
      'sftp.queue': { sessionId: 'sess-1', batches: [], conflict: null, pendingConflicts: 0 },
      'sftp.list': async (_s: string, path: string): Promise<SftpListing<SftpRemoteEntry>> => ({
        path,
        parent: '/home',
        entries: ENTRIES,
      }),
    },
  });
  await act(async () => {
    await useSftpStore.getState().connect('srv-1');
  });
  const grid = await screen.findByRole('grid', { name: 'Files on prod' });
  await waitFor(() => expect(grid.querySelector('[data-sftp-row="f0.txt"]')).toBeTruthy());
  return { ...view, grid };
}

beforeEach(() => {
  resetSftpStore();
  rowRenders.count = 0;
  drawn.end = Number.POSITIVE_INFINITY;
});

describe('FilePane with many rows', () => {
  it('does not redraw the rows when only the queue changes', async () => {
    const { bridge } = await setup();
    const before = rowRenders.count;
    act(() => {
      bridge.$emit('sftp.onQueue', {
        sessionId: 'sess-1',
        batches: [{ batchId: 'b1', state: 'running', label: 'site' }],
        conflict: null,
        pendingConflicts: 0,
      });
    });
    act(() => {
      bridge.$emit('sftp.onQueue', {
        sessionId: 'sess-1',
        batches: [{ batchId: 'b1', state: 'running', label: 'site', transferredBytes: 5 }],
        conflict: null,
        pendingConflicts: 0,
      });
    });
    expect(rowRenders.count).toBe(before);
  });

  it('redraws only the rows whose selection changed', async () => {
    const { grid } = await setup();
    const before = rowRenders.count;
    fireEvent.click(grid.querySelector('[data-sftp-row="f2.txt"]') as HTMLElement);
    expect(rowRenders.count - before).toBeLessThanOrEqual(2);
  });

  it('names the keyboard row as active only while it is drawn', async () => {
    drawn.end = 3;
    const { grid } = await setup();
    act(() =>
      useSftpStore.getState().setSelection('srv-1', 'remote', {
        selected: ['f4.txt'],
        focus: 'f4.txt',
        anchor: 'f4.txt',
      }),
    );
    expect(grid.getAttribute('aria-activedescendant')).toBeNull();
    act(() =>
      useSftpStore.getState().setSelection('srv-1', 'remote', {
        selected: ['f1.txt'],
        focus: 'f1.txt',
        anchor: 'f1.txt',
      }),
    );
    const active = grid.getAttribute('aria-activedescendant');
    expect(active && document.getElementById(active)?.getAttribute('data-sftp-row')).toBe('f1.txt');
  });
});
