import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installAgentmatBridge } from '../../test/renderer/agentmatBridge';

/**
 * A routing test, not a page test. Every path the router knows has to land on its own page with
 * the shell around it (or, for the standalone window routes, without it), and none of them may
 * fall through to the app-wide error boundary.
 *
 * The pages themselves are stubbed: what is being checked is which one the router picks, and
 * the real ones would each drag in their own data loading for no gain here.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  }),
);
/** The toaster stands for the app chrome: it is drawn only around the shell's pages. */
vi.mock('sonner', () => ({ toast, Toaster: () => <div data-testid="app-toaster" /> }));

/** A stand-in page that just says which route rendered it. */
function stub(name: string) {
  return { default: () => <div data-testid="page">{name}</div> };
}

vi.mock('./pages/DashboardPage', () => stub('Dashboard'));
vi.mock('./pages/CliManagerPage', () => stub('CLI Manager'));
vi.mock('./pages/PromptBuilderPage', () => stub('Prompt Builder'));
vi.mock('./pages/PromptHistoryPage', () => stub('Prompt History'));
vi.mock('./pages/ProjectsPage', () => stub('Projects'));
vi.mock('./pages/ProjectDetailPage', () => stub('Project Detail'));
vi.mock('./pages/PipelinesPage', () => stub('Pipelines'));
vi.mock('./pages/SkillsPage', () => stub('Skills'));
vi.mock('./pages/McpPage', () => stub('MCP'));
vi.mock('./pages/ToolsPage', () => stub('Tools'));
vi.mock('./pages/DockerPage', () => stub('Docker'));
vi.mock('./pages/AndroidPage', () => stub('Android'));
vi.mock('./pages/VaultPage', () => stub('Vault'));
vi.mock('./pages/UsagePage', () => stub('Usage'));
vi.mock('./pages/AskAiPage', () => stub('Ask AI'));
vi.mock('./pages/RemotePage', () => stub('Remote'));
vi.mock('./pages/RemoteFileManagerPage', () => stub('Remote Files'));
vi.mock('./pages/SettingsPage', () => stub('Settings'));
vi.mock('./components/workspace/WorkspaceRoute', () => stub('Workspace'));
vi.mock('./components/usage/WidgetRoute', () => stub('Usage Widget'));
vi.mock('./components/projects/PromptBuildWidgetRoute', () => stub('Prompt Build Widget'));
vi.mock('./components/pet/DesktopPetRoute', () => stub('Desktop Pet'));
vi.mock('./components/remote/RemoteSessionRoute', () => stub('Remote Session'));
vi.mock('./components/rdp/RdpSessionRoute', () => stub('RDP Session'));
vi.mock('./components/sftp/SftpWindowRoute', () => stub('SFTP Window'));

/** The shell, reduced to what a routing test needs: a marker and the slot the page goes in. */
vi.mock('./components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => (
      <div>
        <span data-testid="shell">shell</span>
        <Outlet />
      </div>
    ),
  };
});

// The writing menu listens on every text box app-wide and the image viewer hooks the terminal;
// neither has anything to do with routing.
vi.mock('./components/grammar/WritingMenuHost', () => ({ WritingMenuHost: () => null }));
vi.mock('./components/terminal/ImageViewerHost', () => ({ ImageViewerHost: () => null }));

/**
 * Captured before App is imported: importing it installs the toast history capture, which
 * replaces these helpers with wrappers that call the originals.
 */
const toastWarning = toast.warning;

const { default: App } = await import('./App');

/**
 * App boots the stores the shell needs (theme, CLI defaults, terminal look, ping targets,
 * dashboard layout, remote). They read settings and the remote state on mount, so the bridge has
 * to answer those or the boot rejects in the background.
 */
function installBootBridge(): FakeBridge {
  return installAgentmatBridge({
    'settings.get': async () => ({
      theme: 'dark',
      defaultCliId: null,
      cliArgs: {},
      cliLaunchDefaults: {},
      workspaceTerminalCustomBackground: false,
      workspaceTerminalBackgroundColor: null,
      pingTargets: ['1.1.1.1'],
      dashboardChartCards: [],
      dashboardIntroducedCharts: [],
      dashboardUsageCards: [],
    }),
    'agents.lastRunInfoByCli': async () => ({}),
    // The approval dialog asks for pending suggestions on mount, and listens for new ones.
    'runProposals.list': async () => [],
    'runProposals.onChanged': () => () => undefined,
    'remote.getState': async () => ({
      deviceName: 'Workbench',
      hosting: false,
      hostIp: null,
      hostPort: 7900,
      inputSupported: true,
      pairing: null,
      peers: [],
      interfaces: [],
      connection: { status: 'idle', remoteDeviceName: null, remoteScreen: null, intent: null },
    }),
  });
}

function renderAt(path: string) {
  window.location.hash = `#${path}`;
  return render(<App />);
}

async function pageAt(path: string): Promise<string> {
  renderAt(path);
  const page = await screen.findByTestId('page');
  return page.textContent ?? '';
}

let bridge: FakeBridge;

beforeEach(() => {
  window.location.hash = '';
  bridge = installBootBridge();
});

afterEach(() => {
  // Nothing in this suite is allowed to fall back to the app-wide error card.
  expect(screen.queryByText('Something broke')).toBeNull();
});

describe('App routes inside the shell', () => {
  const routes: [string, string][] = [
    ['/', 'Dashboard'],
    ['/cli-manager', 'CLI Manager'],
    ['/prompt-builder', 'Prompt Builder'],
    ['/prompt-history', 'Prompt History'],
    ['/projects', 'Projects'],
    ['/projects/abc', 'Project Detail'],
    ['/workspace', 'Workspace'],
    ['/workspace/abc', 'Workspace'],
    ['/pipelines', 'Pipelines'],
    ['/skills', 'Skills'],
    ['/mcp', 'MCP'],
    ['/tools', 'Tools'],
    ['/docker', 'Docker'],
    ['/android', 'Android'],
    ['/vault', 'Vault'],
    ['/usage', 'Usage'],
    ['/ask-ai', 'Ask AI'],
    ['/remote', 'Remote'],
    ['/remote-files', 'Remote Files'],
    ['/settings', 'Settings'],
  ];

  for (const [path, page] of routes) {
    it(`shows ${page} at ${path}`, async () => {
      expect(await pageAt(path)).toBe(page);
      expect(screen.getByTestId('shell')).toBeTruthy();
    });
  }

  it('sends the old notifications route to Pipelines', async () => {
    expect(await pageAt('/notifications')).toBe('Pipelines');
  });

  it('keeps a query string out of the route match', async () => {
    expect(await pageAt('/tools?tab=security')).toBe('Tools');
  });
});

describe('App standalone windows', () => {
  const routes: [string, string][] = [
    ['/widget/usage-1', 'Usage Widget'],
    ['/widget/prompt-build/build-1', 'Prompt Build Widget'],
    ['/desktop-pet', 'Desktop Pet'],
    ['/remote-session', 'Remote Session'],
    ['/rdp-session', 'RDP Session'],
    ['/sftp-window', 'SFTP Window'],
  ];

  for (const [path, page] of routes) {
    it(`shows ${page} at ${path}, outside the shell`, async () => {
      expect(await pageAt(path)).toBe(page);
      expect(screen.queryByTestId('shell')).toBeNull();
    });
  }

  it('leaves the app chrome to the file manager window, which mounts its own', async () => {
    expect(await pageAt('/sftp-window?server=srv-1&theme=dark')).toBe('SFTP Window');
    expect(screen.queryByTestId('app-toaster')).toBeNull();
  });

  it('draws the app chrome around the shell pages', async () => {
    expect(await pageAt('/remote')).toBe('Remote');
    expect(screen.getByTestId('app-toaster')).toBeTruthy();
  });
});

describe('App wiring', () => {
  it('listens for update status and usage alerts while it is mounted', async () => {
    const { unmount } = renderAt('/');
    await screen.findByTestId('page');

    expect(bridge.$listenerCount('app.onUpdateStatus')).toBe(1);
    expect(bridge.$listenerCount('usage.onThresholdAlert')).toBe(1);

    unmount();

    expect(bridge.$listenerCount('app.onUpdateStatus')).toBe(0);
    expect(bridge.$listenerCount('usage.onThresholdAlert')).toBe(0);
  });

  it('warns about a usage threshold with a way to see it', async () => {
    renderAt('/');
    await screen.findByTestId('page');

    bridge.$emit('usage.onThresholdAlert', {
      title: 'Claude at 90%',
      body: 'Under the monthly budget.',
      providerId: 'claude',
    });

    expect(toastWarning).toHaveBeenCalledWith(
      'Claude at 90%',
      expect.objectContaining({ description: 'Under the monthly budget.' }),
    );
  });
});
