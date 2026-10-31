import type { PackageManagerSection, RuntimeTarget } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { RuntimeBlock } = await import('./RuntimeBlock');

const PUBSPEC = 'C:\\work\\app\\pubspec.yaml';

function target(overrides: Partial<RuntimeTarget> = {}): RuntimeTarget {
  return {
    kind: 'dart',
    source: 'pubspec-sdk',
    declared: '^3.11.5',
    currentVersion: '3.11.5',
    latestVersion: '3.13.5',
    isOutdated: true,
    nextDeclared: '^3.13.5',
    requires: { toolchain: 'flutter', minVersion: '3.47.7' },
    manifestPath: PUBSPEC,
    projectLabel: 'app',
    ...overrides,
  };
}

function section(overrides: Partial<PackageManagerSection> = {}): PackageManagerSection {
  return {
    ecosystem: 'dart',
    manager: 'pub',
    status: 'ok',
    message: null,
    packages: [],
    runtimes: [target()],
    toolchain: 'flutter',
    ...overrides,
  };
}

const found = (version: string) => ({ state: 'found', version, path: 'x', onPath: true });

interface Machine {
  detections?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  installOrder?: string[];
  runtimeResult?: { ok: boolean; message: string };
}

function renderBlock(shown: PackageManagerSection, machine: Machine = {}, onlyOutdated = false) {
  return renderWithProviders(
    <RuntimeBlock projectId="p1" section={shown} onlyOutdated={onlyOutdated} />,
    {
      bridge: {
        'devSetup.detect': async (id: string) => machine.detections?.[id] ?? { state: 'absent' },
        'devSetup.updates': async (ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, machine.updates?.[id] ?? { state: 'current' }])),
        'devSetup.install': async () => ({
          jobId: 'j1',
          running: true,
          items: {},
          order: machine.installOrder ?? [],
          completed: [],
          logs: {},
          current: null,
          restartAdvised: false,
        }),
        'packages.updateRuntime': async () =>
          machine.runtimeResult ?? { ok: true, message: 'Updated ^3.11.5 to ^3.13.5.' },
      },
    },
  );
}

beforeEach(() => {
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('the toolchain row', () => {
  it('shows the installed version and upgrades it through Dev Setup', async () => {
    const { user, bridge } = renderBlock(section({ runtimes: [] }), {
      detections: { flutter: found('3.38.1') },
      updates: { flutter: { state: 'update', latest: '3.47.7', installed: '3.38.1' } },
      installOrder: ['flutter'],
    });

    expect(await screen.findByText('3.47.7 available')).toBeInTheDocument();
    expect(screen.getByText('3.38.1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Upgrade Flutter' }));
    expect(bridge.$fn('devSetup.install')).toHaveBeenCalledWith({
      ids: ['flutter'],
      intent: 'update',
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Upgrade Flutter' })).not.toBeInTheDocument(),
    );

    bridge.$emit('devSetup.onEvent', {
      type: 'finished',
      jobId: 'j1',
      itemId: 'flutter',
      result: 'installed',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Flutter is up to date.'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reports an upgrade that failed', async () => {
    const { user, bridge } = renderBlock(section({ runtimes: [] }), {
      detections: { flutter: found('3.38.1') },
      updates: { flutter: { state: 'update', latest: '3.47.7', installed: '3.38.1' } },
      installOrder: ['flutter'],
    });
    await user.click(await screen.findByRole('button', { name: 'Upgrade Flutter' }));

    bridge.$emit('devSetup.onEvent', {
      type: 'finished',
      jobId: 'j1',
      itemId: 'flutter',
      result: 'failed',
      message: 'disk full',
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Flutter did not update: disk full'),
    );
  });

  it('opens Dev Setup when the update has to run there', async () => {
    const { user } = renderBlock(section({ toolchain: 'dotnet-sdk', runtimes: [] }), {
      detections: { 'dotnet-sdk': found('8.0.404') },
      updates: { 'dotnet-sdk': { state: 'update', latest: '10.0.100', installed: '8.0.404' } },
      installOrder: [],
    });

    await user.click(await screen.findByRole('button', { name: 'Upgrade .NET SDK' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tools?tab=dev-setup&stack=dotnet'));
  });

  it('sends a missing tool to Dev Setup to install', async () => {
    const { user } = renderBlock(section({ toolchain: 'bun', runtimes: [] }));

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dev Setup' }));
    expect(navigate).toHaveBeenCalledWith('/tools?tab=dev-setup&stack=essentials');
  });

  it('offers Dev Setup when it cannot tell whether there is an update', async () => {
    renderBlock(section({ toolchain: 'bun', runtimes: [] }), {
      detections: { bun: found('1.3.0') },
      updates: { bun: { state: 'unknown' } },
    });

    expect(await screen.findByRole('button', { name: 'Dev Setup' })).toBeInTheDocument();
    expect(screen.getByText('1.3.0')).toBeInTheDocument();
  });

  it('says the tool is current', async () => {
    renderBlock(section({ toolchain: 'node', runtimes: [] }), {
      detections: { node: found('24.11.1') },
    });

    expect(await screen.findByText('Current')).toBeInTheDocument();
  });
});

describe('a runtime target row', () => {
  it('rewrites the value when the installed toolchain can take it', async () => {
    const { user, bridge } = renderBlock(section(), {
      detections: { flutter: found('3.47.7') },
    });

    const button = await screen.findByRole('button', { name: 'Update Dart SDK' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText('^3.11.5')).toBeInTheDocument();
    expect(screen.getByText('^3.13.5')).toBeInTheDocument();
    await user.click(button);

    await waitFor(() =>
      expect(bridge.$fn('packages.updateRuntime')).toHaveBeenCalledWith('p1', {
        ecosystem: 'dart',
        source: 'pubspec-sdk',
        kind: 'dart',
        manifestPath: PUBSPEC,
        targetVersion: '3.13.5',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Updated ^3.11.5 to ^3.13.5.'));
  });

  it('shows the reason when main refuses the update', async () => {
    const { user } = renderBlock(section(), {
      detections: { flutter: found('3.47.7') },
      runtimeResult: {
        ok: false,
        message: 'The file changed since it was read. Refresh the list.',
      },
    });

    const button = await screen.findByRole('button', { name: 'Update Dart SDK' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The file changed since it was read. Refresh the list.',
      ),
    );
  });

  it('is off, with the reason, while the installed toolchain is too old', async () => {
    const { user } = renderBlock(section(), {
      detections: { flutter: found('3.38.1') },
    });

    const button = await screen.findByRole('button', { name: 'Update Dart SDK' });
    await waitFor(() => expect(button).toBeDisabled());
    await user.hover(button.parentElement as HTMLElement);
    expect(
      (await screen.findAllByText(/Needs Flutter 3\.47\.7 or newer, and 3\.38\.1 is installed/))
        .length,
    ).toBeGreaterThan(0);
  });

  it('is off for a value Runova does not rewrite', async () => {
    renderBlock(
      section({
        runtimes: [target({ source: 'engines', kind: 'node', nextDeclared: null, requires: null })],
        toolchain: 'node',
        ecosystem: 'node',
        manager: 'npm',
      }),
    );

    expect(await screen.findByRole('button', { name: 'Update Node.js (engines)' })).toBeDisabled();
  });

  it('marks a current value and one whose latest version is unknown', async () => {
    renderBlock(
      section({
        toolchain: null,
        runtimes: [
          target({
            isOutdated: false,
            nextDeclared: null,
            requires: null,
            latestVersion: '3.11.5',
          }),
          target({
            source: 'pubspec-flutter',
            kind: 'flutter',
            declared: "'>=3.38.0'",
            latestVersion: null,
            isOutdated: false,
            nextDeclared: null,
            requires: null,
          }),
        ],
      }),
    );

    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Latest unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Update/ })).not.toBeInTheDocument();
  });

  it('names the sub-project when the section has several', async () => {
    renderBlock(
      section({
        toolchain: null,
        runtimes: [target(), target({ projectLabel: 'flutter_vless_android' })],
      }),
    );

    expect(await screen.findByText('flutter_vless_android')).toBeInTheDocument();
    expect(screen.getByText('app')).toBeInTheDocument();
  });
});

describe('the Outdated filter', () => {
  it('shows only outdated settings and leaves the toolchain out', async () => {
    renderBlock(
      section({
        runtimes: [
          target(),
          target({
            source: 'pubspec-flutter',
            kind: 'flutter',
            isOutdated: false,
            nextDeclared: null,
          }),
        ],
      }),
      { detections: { flutter: found('3.47.7') } },
      true,
    );

    expect(await screen.findByText('Dart SDK')).toBeInTheDocument();
    expect(screen.queryByText('Flutter SDK')).not.toBeInTheDocument();
    expect(screen.queryByText('installed on this machine')).not.toBeInTheDocument();
  });

  it('renders nothing when there is nothing outdated', () => {
    const { container } = renderBlock(
      section({ runtimes: [target({ isOutdated: false, nextDeclared: null })] }),
      {},
      true,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
