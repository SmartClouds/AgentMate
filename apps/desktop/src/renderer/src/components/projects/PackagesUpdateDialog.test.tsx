import type { PackageInfo, PackageManagerSection } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { project } from '../health/testing/fixtures';

const launchPromptTab = vi.fn((..._args: unknown[]) => 'tab-1');
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: (...args: unknown[]) => launchPromptTab(...args),
  projectCliId: () => 'claude-code',
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { PackagesUpdateDialog } = await import('./PackagesUpdateDialog');

function pkg(overrides: Partial<PackageInfo>): PackageInfo {
  return {
    name: 'left-pad',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    isOutdated: true,
    isDev: false,
    isInstalled: true,
    manifestPath: 'C:\\work\\storefront\\package.json',
    projectLabel: 'storefront',
    ...overrides,
  };
}

const react = pkg({ name: 'react', currentVersion: '18.3.1', latestVersion: '19.1.0' });
const zod = pkg({ name: 'zod', currentVersion: '3.22.0', latestVersion: '3.24.1' });
const vite = pkg({ name: 'vite', currentVersion: '6.0.0', latestVersion: '6.0.3', isDev: true });
const current = pkg({
  name: 'clsx',
  currentVersion: '2.1.1',
  latestVersion: '2.1.1',
  isOutdated: false,
});

const section: PackageManagerSection = {
  ecosystem: 'node',
  manager: 'pnpm',
  status: 'ok',
  message: null,
  packages: [react, zod, vite, current],
  runtimes: [],
  toolchain: 'node',
};

function renderDialog(
  selectedPackages: PackageInfo[] = [],
  shown: PackageManagerSection = section,
) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <PackagesUpdateDialog
      open
      onOpenChange={onOpenChange}
      project={project()}
      section={shown}
      sectionLabel="pnpm"
      selectedPackages={selectedPackages}
    />,
  );
  return { ...view, onOpenChange };
}

function prompt(): string {
  return screen.getByRole('region', { name: 'Prompt for your agent' }).textContent ?? '';
}

describe('PackagesUpdateDialog', () => {
  it('lists every outdated package when nothing is selected', async () => {
    renderDialog();
    await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
    expect(screen.queryByRole('button', { name: /Selected/ })).not.toBeInTheDocument();
    expect(prompt()).toContain('Update 3 outdated pnpm packages');
    expect(prompt()).toContain('- react: 18.3.1 -> 19.1.0 (major)');
    expect(prompt()).toContain('- vite: 6.0.0 -> 6.0.3 (patch, dev)');
    expect(prompt()).not.toContain('clsx');
  });

  it('starts from the selection and can widen to every outdated package', async () => {
    const { user } = renderDialog([zod]);
    await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
    expect(screen.getByRole('button', { name: 'Selected (1)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(prompt()).toContain('Update 1 outdated pnpm package ');
    expect(prompt()).not.toContain('react');

    await user.click(screen.getByRole('button', { name: 'All outdated (3)' }));
    expect(prompt()).toContain('Update 3 outdated pnpm packages');
  });

  it('puts the options into the prompt', async () => {
    const { user } = renderDialog();
    await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
    expect(prompt()).toContain('run the typecheck, lint, tests, and build');
    expect(prompt()).not.toMatch(/commit/i);

    await user.click(screen.getByRole('switch', { name: 'Skip major bumps' }));
    expect(prompt()).not.toContain('react');
    expect(prompt()).toContain('1 outdated package was left off the list');

    await user.click(screen.getByRole('switch', { name: "Run the project's checks" }));
    expect(prompt()).not.toContain('run the typecheck');

    await user.click(screen.getByRole('button', { name: 'Per package' }));
    expect(prompt()).toContain('Commit each package on its own');

    await user.type(
      screen.getByLabelText('Notes for the agent'),
      'Leave the lockfile format alone',
    );
    expect(prompt()).toContain('Also keep this in mind:\nLeave the lockfile format alone');
  });

  it('says so when skipping majors leaves nothing to update', async () => {
    const { user } = renderDialog([react]);
    await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
    await user.click(screen.getByRole('switch', { name: 'Skip major bumps' }));
    expect(screen.queryByRole('region', { name: 'Prompt for your agent' })).not.toBeInTheDocument();
    expect(screen.getByText(/Every package here is a major bump/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Claude Code' })).toBeDisabled();
  });

  it('sends the prompt to the project agent and closes', async () => {
    const { user, onOpenChange } = renderDialog();
    await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
    await user.click(screen.getByRole('button', { name: 'Send to Claude Code' }));
    expect(launchPromptTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({
        cliId: 'claude-code',
        prompt: expect.stringMatching(/^Update 3 outdated pnpm packages[\s\S]*- zod: 3\.22\.0/),
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('with an outdated runtime', () => {
    const withRuntime: PackageManagerSection = {
      ...section,
      manager: 'bun',
      runtimes: [
        {
          kind: 'bun',
          source: 'packageManager',
          declared: 'bun@1.1.0',
          currentVersion: '1.1.0',
          latestVersion: '1.3.2',
          isOutdated: true,
          nextDeclared: 'bun@1.3.2',
          requires: null,
          manifestPath: 'C:\work\storefront\package.json',
          projectLabel: 'storefront',
        },
      ],
      toolchain: 'bun',
    };

    it('includes the runtime by default and can leave it out', async () => {
      const { user } = renderDialog([], withRuntime);
      await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
      const toggle = screen.getByRole('switch', { name: 'Include the runtime upgrade' });
      expect(toggle).toBeChecked();
      expect(screen.getByText('Bun (packageManager) bun@1.1.0 to bun@1.3.2')).toBeInTheDocument();
      expect(prompt()).toContain('Runtime (current -> target):');
      expect(prompt()).toContain('bun@1.1.0 -> bun@1.3.2');
      expect(
        screen.getByText(/3 packages and 1 runtime setting in the prompt/),
      ).toBeInTheDocument();

      await user.click(toggle);
      expect(prompt()).not.toContain('Runtime (current -> target):');
      expect(screen.getByText(/3 packages in the prompt/)).toBeInTheDocument();
    });

    it('can send a prompt for the runtime alone', async () => {
      const runtimeOnly = { ...withRuntime, packages: [current] };
      const { user } = renderDialog([], runtimeOnly);
      await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
      expect(prompt()).toContain('Move this project to the latest Bun (packageManager).');
      expect(prompt()).not.toContain('Packages (current -> latest)');

      await user.click(screen.getByRole('switch', { name: 'Include the runtime upgrade' }));
      expect(screen.getByText(/Turn on "Include the runtime upgrade"/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to Claude Code' })).toBeDisabled();
    });

    it('has no runtime switch when the runtime is current', async () => {
      renderDialog();
      await screen.findByRole('dialog', { name: 'Update pnpm packages with AI' });
      expect(
        screen.queryByRole('switch', { name: 'Include the runtime upgrade' }),
      ).not.toBeInTheDocument();
    });
  });
});
