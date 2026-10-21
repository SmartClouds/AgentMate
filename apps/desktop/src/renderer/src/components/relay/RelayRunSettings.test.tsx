import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayRunSettingsForm } from './RelayRunSettings';
import { board } from './testing/fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const settings = board().settings;

function renderForm(props: Partial<Parameters<typeof RelayRunSettingsForm>[0]> = {}) {
  return renderWithProviders(
    <RelayRunSettingsForm projectId="p1" project={null} settings={settings} {...props} />,
    {
      bridge: {
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
        'relay.saveSettings': async () => settings,
      },
    },
  );
}

describe('RelayRunSettingsForm', () => {
  it('saves each relay option as it changes', async () => {
    const { user, bridge } = renderForm();
    await user.click(screen.getByRole('switch', { name: 'Commit when done' }));
    expect(bridge.$fn('relay.saveSettings')).toHaveBeenLastCalledWith('p1', {
      options: { commitPerTask: false },
    });

    await user.click(screen.getByRole('radio', { name: '400K' }));
    expect(bridge.$fn('relay.saveSettings')).toHaveBeenLastCalledWith('p1', {
      options: { defaultBudget: 400_000 },
    });

    await user.click(screen.getByRole('radio', { name: 'Keep going' }));
    expect(bridge.$fn('relay.saveSettings')).toHaveBeenLastCalledWith('p1', {
      options: { whenStuck: 'continue' },
    });
  });

  it('turns plan first on for every task', async () => {
    const { user, bridge } = renderForm();
    await user.click(screen.getByRole('switch', { name: 'Plan first' }));
    expect(bridge.$fn('relay.saveSettings')).toHaveBeenLastCalledWith('p1', {
      options: { planFirst: true },
    });
  });

  it('offers the after-plan mode only for a CLI that can switch by itself', () => {
    renderForm();
    expect(screen.getByRole('radiogroup', { name: 'After the plan' })).toBeInTheDocument();
  });

  it('keeps plan first off for a CLI with no plan mode, and says why without a native title', () => {
    const { container } = renderForm({
      settings: {
        ...settings,
        defaults: { ...settings.defaults, cliId: 'codex-cli', model: null },
      },
    });
    expect(screen.getByRole('switch', { name: 'Plan first' })).toBeDisabled();
    expect(screen.queryByRole('radiogroup', { name: 'After the plan' })).toBeNull();
    const list = screen.getByRole('list', { name: /What the relay can do with Codex/ });
    expect(within(list).getAllByLabelText('Not available').length).toBeGreaterThan(1);
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('gives one task its own choice and can hand it back to the defaults', async () => {
    const { user, bridge } = renderForm({ taskId: 'T002' });
    expect(screen.getByText('Run settings for T002')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Commit when done' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Plan first' }));
    expect(bridge.$fn('relay.saveSettings')).toHaveBeenLastCalledWith('p1', {
      overrides: { T002: { planFirst: true } },
    });
  });

  it('removes a task override', async () => {
    const { user, bridge } = renderForm({
      taskId: 'T002',
      settings: { ...settings, overrides: { T002: { model: 'sonnet' } } },
    });
    await user.click(screen.getByRole('button', { name: 'Use the relay defaults' }));
    expect(bridge.$fn('relay.saveSettings')).toHaveBeenLastCalledWith('p1', { overrides: {} });
  });
});
