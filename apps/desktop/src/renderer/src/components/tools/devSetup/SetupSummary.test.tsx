import type { SetupSummary as Summary } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SetupSummary } from './SetupSummary';

/**
 * The card at the top of the checklist: how far along the machine is, and the buttons that act on
 * all of it at once.
 */

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  total: 11,
  ready: 6,
  checking: 0,
  missing: 5,
  updates: 0,
  stacks: [],
  complete: false,
  ...overrides,
});

describe('SetupSummary', () => {
  it('says how many are ready and how many are left', () => {
    renderWithProviders(<SetupSummary summary={summary()} onRecheckAll={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '6 of 11 ready' })).toBeTruthy();
    expect(screen.getByText('5 still to install.')).toBeTruthy();
  });

  it('draws the progress as a labelled bar a screen reader can read out', () => {
    renderWithProviders(<SetupSummary summary={summary()} onRecheckAll={vi.fn()} />);

    const bar = screen.getByRole('progressbar', { name: 'Dev setup progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '6');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '11');
    expect(bar).toHaveAttribute('aria-valuetext', '6 of 11 ready');
  });

  it('says it is still looking before anything has answered, with an empty bar', () => {
    renderWithProviders(
      <SetupSummary
        summary={summary({ ready: 0, checking: 11, missing: 0 })}
        onRecheckAll={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Checking your tools' })).toBeTruthy();
    expect(screen.getByText('Still checking 11 tools.')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('celebrates when everything is ready', () => {
    renderWithProviders(
      <SetupSummary
        summary={summary({ ready: 11, missing: 0, complete: true })}
        onRecheckAll={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Everything is ready' })).toBeTruthy();
    expect(screen.getByText('Your machine has everything on this list.')).toBeTruthy();
  });

  it('shows no bar when there is nothing on the list', () => {
    renderWithProviders(
      <SetupSummary summary={summary({ total: 0, ready: 0, missing: 0 })} onRecheckAll={vi.fn()} />,
    );

    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('checks everything again on request', async () => {
    const onRecheckAll = vi.fn();
    const { user } = renderWithProviders(
      <SetupSummary summary={summary()} onRecheckAll={onRecheckAll} />,
    );

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(onRecheckAll).toHaveBeenCalledTimes(1);
  });

  it('has no Install all button unless it is given one', () => {
    renderWithProviders(<SetupSummary summary={summary()} onRecheckAll={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Install all/ })).toBeNull();
  });

  it('shows the Install all button with its count, and runs it', async () => {
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <SetupSummary
        summary={summary()}
        onRecheckAll={vi.fn()}
        installAll={{ label: 'Install all missing (5)', onClick }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Install all missing (5)' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables Install all, and says why on hover, when there is nothing it can do', async () => {
    const { user } = renderWithProviders(
      <SetupSummary
        summary={summary()}
        onRecheckAll={vi.fn()}
        installAll={{
          label: 'Install all missing',
          onClick: vi.fn(),
          disabled: true,
          hint: 'Everything left needs a terminal or a download. Use the buttons on each row.',
        }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Install all missing' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement as HTMLElement);
    expect(
      (await screen.findAllByText(/Everything left needs a terminal or a download/)).length,
    ).toBeGreaterThan(0);
  });
});

describe('SetupSummary while installing', () => {
  const run = (overrides = {}) => ({
    headline: 'Installing 2 of 5: Node.js',
    subline: '1 done, 4 to go.',
    fraction: 0.4,
    onCancel: vi.fn(),
    ...overrides,
  });

  it('speaks of the run instead of the totals', () => {
    renderWithProviders(<SetupSummary summary={summary()} onRecheckAll={vi.fn()} run={run()} />);

    expect(screen.getByRole('heading', { name: 'Installing 2 of 5: Node.js' })).toBeTruthy();
    expect(screen.getByText('1 done, 4 to go.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '6 of 11 ready' })).toBeNull();
  });

  it('draws how far through the run it is', () => {
    renderWithProviders(<SetupSummary summary={summary()} onRecheckAll={vi.fn()} run={run()} />);

    const bar = screen.getByRole('progressbar', { name: 'Dev setup progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', 'Installing 2 of 5: Node.js');
  });

  it('offers Cancel in place of Install all, and Cancel stops the run', async () => {
    const onCancel = vi.fn();
    const { user } = renderWithProviders(
      <SetupSummary
        summary={summary()}
        onRecheckAll={vi.fn()}
        installAll={{ label: 'Install all missing (5)', onClick: vi.fn() }}
        run={run({ onCancel })}
      />,
    );

    expect(screen.queryByRole('button', { name: /Install all/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel install' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not check again in the middle of an install', () => {
    renderWithProviders(<SetupSummary summary={summary()} onRecheckAll={vi.fn()} run={run()} />);

    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
  });

  it('keeps the bar inside its track for a fraction that is out of range', () => {
    renderWithProviders(
      <SetupSummary summary={summary()} onRecheckAll={vi.fn()} run={run({ fraction: 1.7 })} />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('SetupSummary: what Install all leaves out', () => {
  it('says so under the button', () => {
    renderWithProviders(
      <SetupSummary
        summary={summary()}
        onRecheckAll={vi.fn()}
        installAll={{
          label: 'Install all missing (3)',
          onClick: vi.fn(),
          note: '1 more step needs a terminal or a download.',
        }}
      />,
    );

    expect(screen.getByText('1 more step needs a terminal or a download.')).toBeTruthy();
  });
});

describe('SetupSummary and updates', () => {
  const ready = summary({ ready: 11, missing: 0, complete: true });

  it('says how many updates there are, without touching how many are ready', () => {
    renderWithProviders(
      <SetupSummary
        summary={{ ...ready, updates: 2 }}
        onRecheckAll={vi.fn()}
        updatesStatus="done"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Everything is ready' })).toBeTruthy();
    expect(
      screen.getByText('Your machine has everything on this list. 2 updates available.'),
    ).toBeTruthy();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '11');
  });

  it('shows a spinner and says it is looking while the update check runs', () => {
    renderWithProviders(
      <SetupSummary summary={ready} onRecheckAll={vi.fn()} updatesStatus="checking" />,
    );

    expect(
      screen.getByText('Your machine has everything on this list. Checking for updates.'),
    ).toBeTruthy();
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows no spinner once the check is over', () => {
    renderWithProviders(
      <SetupSummary summary={ready} onRecheckAll={vi.fn()} updatesStatus="done" />,
    );

    expect(document.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByText(/Everything is up to date\./)).toBeTruthy();
  });

  it('shows Update all with its count, and runs it', async () => {
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <SetupSummary
        summary={{ ...ready, updates: 2 }}
        onRecheckAll={vi.fn()}
        updateAll={{ label: 'Update all (2)', onClick }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Update all (2)' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has no Update all button unless it is given one', () => {
    renderWithProviders(<SetupSummary summary={ready} onRecheckAll={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull();
  });

  it('keeps Install all as the main button when both are there', () => {
    renderWithProviders(
      <SetupSummary
        summary={summary({ updates: 1 })}
        onRecheckAll={vi.fn()}
        installAll={{ label: 'Install all missing (5)', onClick: vi.fn() }}
        updateAll={{ label: 'Update all (1)', onClick: vi.fn() }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Install all missing (5)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeTruthy();
  });

  it('disables Update all, and says why on hover, when the rest needs a terminal', async () => {
    const { user } = renderWithProviders(
      <SetupSummary
        summary={ready}
        onRecheckAll={vi.fn()}
        updateAll={{
          label: 'Update all',
          onClick: vi.fn(),
          disabled: true,
          hint: 'These updates need a terminal. Use the button on each row.',
        }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Update all' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement as HTMLElement);
    expect((await screen.findAllByText(/These updates need a terminal/)).length).toBeGreaterThan(0);
  });

  it('says what Update all leaves for the person, next to what Install all leaves', () => {
    renderWithProviders(
      <SetupSummary
        summary={ready}
        onRecheckAll={vi.fn()}
        updateAll={{
          label: 'Update all (2)',
          onClick: vi.fn(),
          note: '1 more update needs a terminal.',
        }}
      />,
    );

    expect(screen.getByText('1 more update needs a terminal.')).toBeTruthy();
  });

  it('offers a cancel in the words of an update while one runs', async () => {
    const onCancel = vi.fn();
    const { user } = renderWithProviders(
      <SetupSummary
        summary={ready}
        onRecheckAll={vi.fn()}
        updateAll={{ label: 'Update all (2)', onClick: vi.fn() }}
        run={{
          headline: 'Updating 1 of 2: Node.js',
          subline: '0 done, 2 to go.',
          fraction: 0.2,
          onCancel,
          cancelLabel: 'Cancel update',
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel update' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
