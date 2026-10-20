import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRunningClisStore } from '@/stores/runningClisStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RunningClisDialog } from './RunningClisDialog';

/**
 * Which drawer tabs the running shells dialog lists. A file manager tab (E25) has no shell, so
 * it is never listed, and never as a shell that ended.
 */

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [
      { id: 's1', kind: 'local', title: 'Build shell', shell: 'powershell.exe' },
      { id: 'f1', kind: 'sftp', title: 'prod files', sftpServerId: 'srv-1' },
    ],
    activeSessionId: 's1',
  });
  useRunningClisStore.getState().setOpen(true);
});

afterEach(() => {
  useRunningClisStore.getState().setOpen(false);
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

describe('RunningClisDialog drawer tabs', () => {
  it('lists the shell tabs and leaves the file manager tab out', async () => {
    renderWithProviders(<RunningClisDialog />, {
      bridge: {
        'terminal.usage': { available: true, cpuReady: false, sampledAt: 1, sessions: [] },
        'projects.list': [],
      },
    });

    expect(await screen.findByText('Build shell')).toBeInTheDocument();
    expect(screen.queryByText('prod files')).toBeNull();
  });
});
