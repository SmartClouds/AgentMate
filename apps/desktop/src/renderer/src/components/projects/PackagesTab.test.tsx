import type { PackageInfo, PackageManagerSection, RuntimeTarget } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { project } from '../health/testing/fixtures';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { PackagesTab } = await import('./PackagesTab');

/**
 * BitIronPlatform's shape: a bun web app with no root lockfile, and a Flutter app whose Dart
 * constraint is behind. The tab has to name the manager each section really uses and show the
 * runtime rows next to the packages.
 */

function pkg(overrides: Partial<PackageInfo>): PackageInfo {
  return {
    name: 'next',
    currentVersion: '16.0.0',
    latestVersion: '16.0.0',
    isOutdated: false,
    isDev: false,
    isInstalled: true,
    manifestPath: 'C:\\work\\bitiron\\web\\package.json',
    projectLabel: 'bitiron-web',
    ...overrides,
  };
}

const dartSdk: RuntimeTarget = {
  kind: 'dart',
  source: 'pubspec-sdk',
  declared: '^3.11.5',
  currentVersion: '3.11.5',
  latestVersion: '3.13.5',
  isOutdated: true,
  nextDeclared: '^3.13.5',
  requires: { toolchain: 'flutter', minVersion: '3.47.7' },
  manifestPath: 'C:\\work\\bitiron\\app\\pubspec.yaml',
  projectLabel: 'app',
};

const bunSection: PackageManagerSection = {
  ecosystem: 'node',
  manager: 'bun',
  status: 'ok',
  message: null,
  packages: [pkg({})],
  runtimes: [],
  toolchain: 'bun',
};

const dartSection: PackageManagerSection = {
  ecosystem: 'dart',
  manager: 'pub',
  status: 'ok',
  message: null,
  packages: [
    pkg({
      name: 'http',
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
      manifestPath: dartSdk.manifestPath,
      projectLabel: 'app',
    }),
  ],
  runtimes: [dartSdk],
  toolchain: 'flutter',
};

function renderTab() {
  return renderWithProviders(<PackagesTab project={project()} />, {
    bridge: {
      'packages.list': { projectId: 'p1', sections: [bunSection, dartSection] },
      'devSetup.detect': async (id: string) =>
        id === 'flutter'
          ? { state: 'found', version: '3.47.7', path: 'x', onPath: true }
          : { state: 'found', version: '1.3.2', path: 'x', onPath: true },
      'devSetup.updates': async (ids: string[]) =>
        Object.fromEntries(ids.map((id) => [id, { state: 'current' }])),
    },
  });
}

function sectionOf(heading: string): HTMLElement {
  const title = screen.getByText(heading, { selector: 'p' });
  return title.closest('.glass') as HTMLElement;
}

describe('PackagesTab', () => {
  it('labels the web app section Bun and shows its toolchain', async () => {
    renderTab();

    await screen.findByText('Bun', { selector: 'p' });
    const bun = sectionOf('Bun');
    expect(within(bun).getByText('Runtime')).toBeInTheDocument();
    expect(await within(bun).findByText('installed on this machine')).toBeInTheDocument();
    expect(screen.queryByText('npm', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('counts an outdated runtime as outdated, and lets the AI dialog open for it', async () => {
    const { user } = renderTab();

    await screen.findByText('pub (Dart / Flutter)', { selector: 'p' });
    const dart = sectionOf('pub (Dart / Flutter)');
    expect(within(dart).getByText('1 outdated')).toBeInTheDocument();
    expect(within(dart).getByText('Dart SDK')).toBeInTheDocument();
    // The toolbar adds it to the project total too.
    expect(screen.getAllByText('1 outdated')).toHaveLength(2);

    const ai = within(dart).getByRole('button', { name: 'Update with AI' });
    expect(ai).toBeEnabled();
    await user.click(ai);
    expect(
      await screen.findByRole('switch', { name: 'Include the runtime upgrade' }),
    ).toBeChecked();
  });

  it('keeps the runtime rows under the Outdated filter and hides them while searching', async () => {
    const { user } = renderTab();
    await screen.findByText('Dart SDK');

    await user.click(screen.getByRole('radio', { name: /Outdated/ }));
    expect(screen.getByText('Dart SDK')).toBeInTheDocument();
    // The bun section has nothing outdated, so it drops out.
    expect(screen.queryByText('Bun', { selector: 'p' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'All' }));
    await user.type(screen.getByRole('textbox', { name: 'Search packages' }), 'http');
    expect(screen.queryByText('Dart SDK')).not.toBeInTheDocument();
  });
});
