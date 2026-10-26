import {
  buildChecklist,
  type DevDetection,
  type DevItemJob,
  type DevSetupEnvironment,
  getDevItem,
} from '@runova/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DevItemRow } from './DevItemRow';
import { describeRow } from './devSetupView';

/**
 * One row of the checklist. These check what a person sees and can do in each state: that a row
 * still being checked never says "Not installed", that every button can be found by a screen
 * reader and says which tool it is for, and that a disabled button explains itself.
 */

const win: DevSetupEnvironment = { os: 'win32', arch: 'x64', packageManagers: ['winget'] };
const found = (version: string | null): DevDetection => ({
  state: 'found',
  version,
  path: null,
  onPath: true,
});
const absent: DevDetection = { state: 'absent' };

function renderRow(
  id: string,
  detections: Record<string, DevDetection | undefined>,
  options: { job?: DevItemJob; inAppInstall?: boolean } = {},
) {
  const checklist = buildChecklist({
    stacks: ['essentials', 'flutter', 'docker'],
    environment: win,
    detections,
    jobs: options.job ? { [id]: options.job } : {},
  });
  const row = checklist.rows.find((one) => one.item.id === id);
  if (!row) throw new Error(`no row ${id}`);
  const view = describeRow(row, {
    os: 'win32',
    inAppInstall: options.inAppInstall ?? true,
    nameOf: (one) => getDevItem(one)?.name ?? one,
  });
  const handlers = {
    onAction: vi.fn(),
    onTerminal: vi.fn(),
    onCopy: vi.fn(),
    onShowLog: vi.fn(),
  };
  const view$ = renderWithProviders(
    <ul>
      <DevItemRow row={row} view={view} {...handlers} />
    </ul>,
  );
  return { ...view$, ...handlers, row, view };
}

describe('DevItemRow: looking', () => {
  it('shows the name, but no verdict, while the check is still running', () => {
    renderRow('gh', {});

    expect(screen.getByText('GitHub CLI')).toBeTruthy();
    expect(screen.queryByText(/not installed/i)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status', { name: 'Checking GitHub CLI' })).toBeTruthy();
  });
});

describe('DevItemRow: installed', () => {
  it('shows the version and nothing to click', () => {
    renderRow('node', { node: found('22.12.0') });

    expect(screen.getByText('Node.js')).toBeTruthy();
    expect(screen.getByText('Version 22.12.0')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the description out of the way once the tool is in place', () => {
    renderRow('node', { node: found('22.12.0') });

    expect(screen.queryByText(/Runs JavaScript outside the browser/)).toBeNull();
  });

  it('warns when the tool is not on the PATH', () => {
    renderRow('git', { git: { state: 'found', version: '2.55.0', path: 'C:\\x', onPath: false } });

    expect(screen.getByText('Not on your PATH')).toBeTruthy();
  });
});

describe('DevItemRow: not installed', () => {
  it('explains what the tool is and why it matters, since the person is being asked to install it', () => {
    renderRow('gh', { git: found('2.55.0'), gh: absent });

    expect(screen.getByText('Not installed. Needs 2.40 or newer.')).toBeTruthy();
    expect(screen.getByText(/Opens pull requests, reads issues/)).toBeTruthy();
  });

  it('leads with one button that names the tool', async () => {
    const { user, onAction, view } = renderRow('gh', { git: found('2.55.0'), gh: absent });

    await user.click(screen.getByRole('button', { name: 'Install GitHub CLI' }));

    expect(onAction).toHaveBeenCalledWith(view.action);
  });

  it('offers the terminal and the clipboard as quieter options, each naming the tool', async () => {
    const { user, onTerminal, onCopy } = renderRow('gh', { git: found('2.55.0'), gh: absent });

    await user.click(
      screen.getByRole('button', { name: 'Open the GitHub CLI install in a terminal' }),
    );
    await user.click(screen.getByRole('button', { name: 'Copy the GitHub CLI install command' }));

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('shows what the terminal and clipboard buttons do on hover', async () => {
    const { user } = renderRow('gh', { git: found('2.55.0'), gh: absent });

    await user.hover(
      screen.getByRole('button', { name: 'Open the GitHub CLI install in a terminal' }),
    );

    expect((await screen.findAllByText('Open in terminal')).length).toBeGreaterThan(0);
  });

  it('has no terminal or clipboard buttons for an install the app does by itself', () => {
    renderRow('flutter', { git: found('2.55.0'), flutter: absent });

    expect(screen.getByRole('button', { name: 'Install Flutter SDK' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /terminal/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });

  it('marks an optional tool as optional', () => {
    renderRow('pnpm', { npm: found('10.9.0'), pnpm: absent });

    expect(screen.getByText('Optional')).toBeTruthy();
  });
});

describe('DevItemRow: waiting on something else', () => {
  it('disables the button and says why when hovered', async () => {
    const { user } = renderRow('flutter', { git: absent, flutter: absent });

    const button = screen.getByRole('button', { name: 'Install Flutter SDK' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Waiting for Git')).toBeTruthy();

    await user.hover(button.parentElement as HTMLElement);
    expect(
      (await screen.findAllByText('Install Git first. Install all missing handles the order.'))
        .length,
    ).toBeGreaterThan(0);
  });

  it('has no button for something that comes with another tool', () => {
    renderRow('npm', { node: absent, npm: absent });

    expect(screen.getByText('Comes with Node.js')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('DevItemRow: working', () => {
  it('shows a progress bar with the amount done, and a way to cancel', async () => {
    const { user, onAction, view } = renderRow(
      'gh',
      { git: found('2.55.0'), gh: absent },
      {
        job: { status: 'installing', phase: 'downloading', fraction: 0.4, detail: '31 of 78 MB' },
      },
    );

    const bar = screen.getByRole('progressbar', { name: 'GitHub CLI: Downloading 31 of 78 MB' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');

    await user.click(screen.getByRole('button', { name: 'Cancel installing GitHub CLI' }));
    expect(onAction).toHaveBeenCalledWith(view.action);
  });

  it('shows an indeterminate bar when the installer gives no percentage', () => {
    renderRow(
      'gh',
      { git: found('2.55.0'), gh: absent },
      {
        job: { status: 'installing', phase: 'installing' },
      },
    );

    const bar = screen.getByRole('progressbar', { name: 'GitHub CLI: Installing' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('offers the log while an install runs', async () => {
    const { user, onShowLog } = renderRow(
      'gh',
      { git: found('2.55.0'), gh: absent },
      {
        job: { status: 'installing', phase: 'installing' },
      },
    );

    await user.click(screen.getByRole('button', { name: 'Show the GitHub CLI install log' }));

    expect(onShowLog).toHaveBeenCalledTimes(1);
  });
});

describe('DevItemRow: trouble', () => {
  it('says what went wrong and offers every way forward', async () => {
    const { user, onAction, onShowLog } = renderRow(
      'gh',
      { git: found('2.55.0'), gh: absent },
      {
        job: { status: 'failed', message: 'winget could not finish (code 1603).', exitCode: 1603 },
      },
    );

    expect(screen.getByText('winget could not finish (code 1603).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retry' }));
    expect(
      screen.getByRole('button', { name: 'Open the GitHub CLI install in a terminal' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Copy the GitHub CLI install command' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show the GitHub CLI install log' }));
    expect(onShowLog).toHaveBeenCalled();
  });

  it('offers the download page when the package manager is missing', async () => {
    const noWinget: DevSetupEnvironment = { ...win, packageManagers: [] };
    const checklist = buildChecklist({
      stacks: ['essentials'],
      environment: noWinget,
      detections: { git: absent },
    });
    const row = checklist.rows.find((one) => one.item.id === 'git');
    if (!row) throw new Error('no row');
    const view = describeRow(row, { os: 'win32', inAppInstall: true, nameOf: (one) => one });
    const onAction = vi.fn();
    const { user } = renderWithProviders(
      <ul>
        <DevItemRow
          row={row}
          view={view}
          onAction={onAction}
          onTerminal={vi.fn()}
          onCopy={vi.fn()}
        />
      </ul>,
    );

    await user.click(screen.getByRole('button', { name: 'Open download page' }));

    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'open-link', url: 'https://git-scm.com/downloads' }),
    );
  });
});

describe('DevItemRow: structure', () => {
  it('is a list item, so a list of them reads as a list', () => {
    renderRow('node', { node: found('22.12.0') });

    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Node.js')).toBeTruthy();
  });

  it('never uses the native title attribute for hints', () => {
    const { container } = renderRow('gh', { git: found('2.55.0'), gh: absent });

    // A DOM title attribute is a native browser tooltip, which the project does not allow.
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });
});
