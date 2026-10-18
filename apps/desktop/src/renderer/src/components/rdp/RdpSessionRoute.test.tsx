import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeProxyFailure } from '@/lib/rdp/failure';
import { useRdpAgentStore } from '@/stores/rdpAgentStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { RdpPhase } from './useRdpSession';

const hook = vi.hoisted(() => ({
  phase: { kind: 'connecting' } as RdpPhase,
  reconnect: vi.fn(),
  reviewCertificate: vi.fn(),
}));

vi.mock('./useRdpSession', () => ({
  useRdpSession: () => ({
    phase: hook.phase,
    nickname: 'Office PC',
    options: null,
    certificate: null,
    remoteFiles: [],
    transfers: [],
    notice: null,
    scale: 'fit',
    reconnect: hook.reconnect,
    reviewCertificate: hook.reviewCertificate,
    dismissNotice: vi.fn(),
    clearFinishedTransfers: vi.fn(),
    respondCertificate: vi.fn(),
    setScale: vi.fn(),
    ctrlAltDel: vi.fn(),
    focusRemote: vi.fn(),
    agentTargets: { getSession: () => null, getBackend: () => null, getCanvas: () => null },
    getRemoteElement: () => null,
    pickAndSendFiles: vi.fn(),
    dropFiles: vi.fn(),
    saveRemoteFiles: vi.fn(),
  }),
}));

const { default: RdpSessionRoute } = await import('./RdpSessionRoute');

const bridge = {
  'rdpWindow.getState': { isMaximized: false, isFullScreen: false },
  'cli.detectAll': [{ id: 'claude-code', installed: true }],
};

function renderRoute() {
  return renderWithProviders(<RdpSessionRoute />, { route: '/?session=s1', bridge });
}

beforeEach(() => {
  hook.phase = { kind: 'connecting' };
  hook.reconnect.mockClear();
  hook.reviewCertificate.mockClear();
});

describe('RdpSessionRoute Ask AI', () => {
  it('keeps Ask AI off until the session is connected', () => {
    renderRoute();
    expect(screen.getByRole('button', { name: /Ask AI/ })).toBeDisabled();
  });

  it('opens the Ask AI dialog once connected', async () => {
    hook.phase = { kind: 'connected' };
    const { user } = renderRoute();
    await user.click(screen.getByRole('button', { name: /Ask AI/ }));
    expect(
      await screen.findByRole('dialog', { name: /Ask AI to do something on this desktop/ }),
    ).toBeInTheDocument();
  });

  it('answers the AI task for this session', () => {
    const { bridge: fake } = renderRoute();
    expect(fake.$listenerCount('rdpAgent.onRequest')).toBe(1);
    expect(fake.$listenerCount('rdpAgent.onProgress')).toBe(1);
  });

  it('shows the status bar and the overlay while a task runs, and the history from it', async () => {
    hook.phase = { kind: 'connected' };
    useRdpAgentStore.setState({
      sessions: { s1: { mode: 'autonomous', phase: 'acting', step: 2, action: 'CLICK 1 2' } },
    });
    const { user, bridge: fake } = renderRoute();
    expect(screen.getByText('CLICK 1 2')).toBeInTheDocument();
    expect(screen.getByTestId('rdp-agent-overlay')).toBeInTheDocument();

    fake.$set('rdpAgent.history', []);
    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('AI task history')).toBeInTheDocument();
    await waitFor(() => expect(fake.$fn('rdpAgent.history')).toHaveBeenCalledWith('s1'));
  });

  it('opens the history from the toolbar with no task running, even before connecting', async () => {
    useRdpAgentStore.setState({ sessions: {} });
    const { user, bridge: fake } = renderRoute();
    fake.$set('rdpAgent.history', []);

    await user.click(screen.getByRole('button', { name: /AI history/ }));
    expect(await screen.findByText('AI task history')).toBeInTheDocument();
    await waitFor(() => expect(fake.$fn('rdpAgent.history')).toHaveBeenCalledWith('s1'));
  });
});

describe('RdpSessionRoute when the connection fails', () => {
  const keyUsage = describeProxyFailure({
    code: 'tls-key-usage',
    message:
      "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
    detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
  });

  it('shows what happened and what to try instead of the library error', () => {
    hook.phase = { kind: 'failed', ...keyUsage };
    renderRoute();

    expect(screen.getByRole('alert')).toHaveTextContent("The server's certificate can't be used");
    expect(screen.getByText('What you can try')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /error:1|OPENSSL_internal|boringssl|ssl_cert|third_party/i,
    );
  });

  it('reconnects from the failed screen', async () => {
    hook.phase = { kind: 'failed', ...keyUsage };
    const { user } = renderRoute();

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));

    expect(hook.reconnect).toHaveBeenCalledOnce();
  });

  it('reopens the certificate prompt from the failed screen when the certificate changed', async () => {
    hook.phase = {
      kind: 'failed',
      ...describeProxyFailure({
        code: 'certificate-changed',
        message: '176.9.22.106 is presenting a different certificate than the one AgentMate saved.',
      }),
    };
    const { user } = renderRoute();

    await user.click(screen.getByRole('button', { name: 'Review certificate' }));

    expect(hook.reviewCertificate).toHaveBeenCalledOnce();
  });

  it('keeps the plain screen for a session that ended', () => {
    hook.phase = { kind: 'ended', reason: 'You signed out of the server.' };
    renderRoute();

    // The status badge and the screen's heading.
    expect(screen.getAllByText('Disconnected')).toHaveLength(2);
    expect(screen.getByText('You signed out of the server.')).toBeInTheDocument();
    expect(screen.queryByText('What you can try')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('shows no actions while still connecting', () => {
    renderRoute();

    expect(screen.getByText('Connecting to Office PC…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });
});
