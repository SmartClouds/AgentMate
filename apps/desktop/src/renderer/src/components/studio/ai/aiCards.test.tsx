import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { generation, proposal } from '../testing/aiFixtures';
import { document } from '../testing/fixtures';
import { AiRunsList } from './AiRunsList';
import { AskAiBar } from './AskAiBar';
import { BriefCard } from './BriefCard';
import { GenerationCard } from './GenerationCard';
import { ProposalCard } from './ProposalCard';
import { runLabel, usePendingScenario, useRunSettings } from './runSettings';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  window.localStorage.clear();
});

describe('runLabel', () => {
  it('names the CLI, model and effort, or the default CLI', () => {
    expect(runLabel({ cliId: 'claude-code', model: 'opus', effort: 'high' })).toMatch(
      /^Claude Code · .+/,
    );
    expect(runLabel({ cliId: 'claude-code' })).toBe('Claude Code');
    expect(runLabel({ cliId: null })).toBe('Default CLI');
    expect(runLabel({ cliId: null, cliName: 'Codex' })).toBe('Codex (default CLI)');
  });
});

describe('usePendingScenario', () => {
  it('hands a request over once, and only for its own video', () => {
    const request = { brief: 'x', targetSeconds: 30, styleId: null, run: { cliId: null } };
    usePendingScenario.getState().set('v1', request);
    expect(usePendingScenario.getState().take('v2')).toBeNull();
    expect(usePendingScenario.getState().take('v1')).toEqual(request);
    expect(usePendingScenario.getState().take('v1')).toBeNull();
  });
});

describe('useRunSettings', () => {
  function Probe({ stage }: { stage: 'scenario' | 'edit' }) {
    const [value, set] = useRunSettings(stage);
    return (
      <button type="button" onClick={() => set({ cliId: 'codex-cli', model: 'gpt' })}>
        {value.cliId ?? 'none'}
      </button>
    );
  }

  it('remembers the pick per stage on this computer', async () => {
    const { user, unmount } = renderWithProviders(<Probe stage="edit" />);
    await user.click(screen.getByRole('button', { name: 'none' }));
    expect(screen.getByRole('button', { name: 'codex-cli' })).toBeInTheDocument();
    unmount();
    renderWithProviders(<Probe stage="edit" />);
    expect(screen.getByRole('button', { name: 'codex-cli' })).toBeInTheDocument();
  });

  it('still works when storage throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user } = renderWithProviders(<Probe stage="scenario" />);
    await user.click(screen.getByRole('button', { name: 'none' }));
    expect(screen.getByRole('button', { name: 'codex-cli' })).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('GenerationCard', () => {
  const handlers = () => ({
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onDetails: vi.fn(),
    onDismiss: vi.fn(),
  });

  it('shows a running scenario with its AI, time so far and the latest output, and cancels it', async () => {
    const h = handlers();
    const lines = ['one', 'two', 'three', 'four', 'five', 'six'];
    const { user } = renderWithProviders(
      <GenerationCard generation={generation()} output={lines} {...h} />,
    );
    const card = screen.getByRole('region', { name: 'AI run' });
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(within(card).getByText('Writing the scenario')).toBeInTheDocument();
    expect(within(card).getByText(/^Claude Code/)).toBeInTheDocument();
    expect(within(card).getByLabelText('Time so far').textContent).toMatch(/^0:3\d$/);
    const output = within(card).getByRole('list', { name: 'CLI output' });
    expect(
      within(output)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['three', 'four', 'five', 'six']);
    await user.click(within(card).getByRole('button', { name: 'Show all 6 lines' }));
    expect(within(output).getAllByRole('listitem')).toHaveLength(6);
    await user.click(within(card).getByRole('button', { name: /Cancel/ }));
    expect(h.onCancel).toHaveBeenCalled();
  });

  it('says when an answer was sent back for repair', () => {
    const g = generation({ attempts: [generation().attempts[0]!, generation().attempts[0]!] });
    renderWithProviders(<GenerationCard generation={g} output={[]} {...handlers()} />);
    expect(screen.getByText(/round 1 of 2/)).toBeInTheDocument();
  });

  it('explains a failure and offers details, a retry and dismissing it', async () => {
    const h = handlers();
    const { user } = renderWithProviders(
      <GenerationCard
        generation={generation({ status: 'failed', error: 'Claude Code failed: not logged in' })}
        output={[]}
        {...h}
      />,
    );
    expect(screen.getByText('The scenario was not written.')).toBeInTheDocument();
    expect(screen.getByText('Claude Code failed: not logged in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Details/ }));
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(h.onDetails).toHaveBeenCalled();
    expect(h.onRetry).toHaveBeenCalled();
    expect(h.onDismiss).toHaveBeenCalled();
  });

  it('says an interrupted run cannot resume, and shows nothing for a cancelled one', () => {
    const { rerender } = renderWithProviders(
      <GenerationCard
        generation={generation({ status: 'interrupted', stage: 'edit' })}
        output={[]}
        {...handlers()}
      />,
    );
    expect(screen.getByText(/cannot pick up where it stopped/)).toBeInTheDocument();
    rerender(
      <GenerationCard
        generation={generation({ status: 'cancelled' })}
        output={[]}
        {...handlers()}
      />,
    );
    expect(screen.queryByText(/cannot pick up/)).not.toBeInTheDocument();
  });

  it('words a failed edit as a change not made', () => {
    renderWithProviders(
      <GenerationCard
        generation={generation({ status: 'failed', stage: 'edit' })}
        output={[]}
        {...handlers()}
      />,
    );
    expect(screen.getByText('The change was not made.')).toBeInTheDocument();
    expect(screen.getByText('The CLI did not answer.')).toBeInTheDocument();
  });
});

describe('ProposalCard', () => {
  it('spells out every change before and after, then applies or discards it', async () => {
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    const g = generation({
      stage: 'edit',
      status: 'proposed',
      instruction: 'Make it punchier',
      proposal: proposal(),
    });
    const { user } = renderWithProviders(
      <ProposalCard generation={g} applying={false} onApply={onApply} onDiscard={onDiscard} />,
    );
    const card = screen.getByRole('region', { name: 'AI proposal' });
    expect(within(card).getByText('Shortened the opening and added a hook.')).toBeInTheDocument();
    expect(within(card).getByText('Make it punchier')).toBeInTheDocument();
    expect(within(card).getByText('Every drop')).toBeInTheDocument();
    expect(within(card).getByText(/New scene 1:/)).toBeInTheDocument();
    expect(within(card).getByText(/Remove scene 3:/)).toBeInTheDocument();
    expect(within(card).getByText(/Move scene 2/)).toHaveTextContent(
      'Move scene 2 (Middle) to position 3',
    );
    expect(within(card).getByText('5 s')).toBeInTheDocument();
    expect(within(card).getByText('3 s')).toBeInTheDocument();
    expect(within(card).getAllByText('Before').length).toBeGreaterThan(0);
    expect(within(card).getAllByText('After').length).toBeGreaterThan(0);
    // An empty field says so rather than showing nothing.
    expect(within(card).getByText('empty')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Apply/ }));
    await user.click(within(card).getByRole('button', { name: /Discard/ }));
    expect(onApply).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
  });

  it('disables both buttons while applying, and renders nothing without a proposal', () => {
    const g = generation({ stage: 'edit', status: 'proposed', proposal: proposal() });
    const { rerender } = renderWithProviders(
      <ProposalCard generation={g} applying onApply={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Applying/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Discard/ })).toBeDisabled();
    rerender(
      <ProposalCard
        generation={generation()}
        applying={false}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'AI proposal' })).not.toBeInTheDocument();
  });
});

describe('AskAiBar', () => {
  it('sends what to change and clears the field once it is on its way', async () => {
    const onAsk = vi.fn(async () => true);
    const { user } = renderWithProviders(
      <AskAiBar run={{ cliId: 'claude-code' }} onRunChange={vi.fn()} busy={false} onAsk={onAsk} />,
    );
    const field = screen.getByLabelText('What should change');
    await user.type(field, 'صحنه‌ی اول را کوتاه‌تر کن{Enter}');
    expect(onAsk).toHaveBeenCalledWith('صحنه‌ی اول را کوتاه‌تر کن');
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('keeps the text when the request did not go out, and waits while AI is busy', async () => {
    const onAsk = vi.fn(async () => false);
    const { user, rerender } = renderWithProviders(
      <AskAiBar run={{}} onRunChange={vi.fn()} busy={false} onAsk={onAsk} />,
    );
    await user.type(screen.getByLabelText('What should change'), 'shorter{Enter}');
    expect(screen.getByLabelText('What should change')).toHaveValue('shorter');
    rerender(<AskAiBar run={{}} onRunChange={vi.fn()} busy onAsk={onAsk} />);
    expect(screen.getByRole('button', { name: /AI is busy/ })).toBeDisabled();
  });

  it('shows which AI makes the change and lets the user pick another', async () => {
    const { user } = renderWithProviders(
      <AskAiBar run={{}} onRunChange={vi.fn()} busy={false} onAsk={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /Default CLI/ }));
    expect(await screen.findByText('Which AI makes the change')).toBeInTheDocument();
    expect(screen.getByText('CLI')).toBeInTheDocument();
  });
});

describe('BriefCard', () => {
  const initial = { brief: '', targetSeconds: 60, styleId: null, run: { cliId: 'claude-code' } };

  it('writes a scenario from the brief, length and style', async () => {
    const onStart = vi.fn(async () => true);
    const { user } = renderWithProviders(
      <BriefCard
        aspect="16:9"
        rewriting={false}
        busy={false}
        initial={initial}
        onStart={onStart}
      />,
    );
    expect(screen.getByRole('button', { name: /Write scenario/ })).toBeDisabled();
    await user.type(screen.getByLabelText('What is the video about?'), 'A film about water');
    await user.click(screen.getByRole('radio', { name: '1.5 min' }));
    await user.click(screen.getByRole('button', { name: /Write scenario/ }));
    expect(onStart).toHaveBeenCalledWith(
      {
        brief: 'A film about water',
        targetSeconds: 90,
        styleId: null,
        run: { cliId: 'claude-code', model: null, effort: null },
      },
      expect.objectContaining({ targetSeconds: 90 }),
    );
  });

  it('stays folded over existing scenes until opened, and folds again once a rewrite starts', async () => {
    const onStart = vi.fn(async () => true);
    const { user } = renderWithProviders(
      <BriefCard
        aspect="9:16"
        rewriting
        busy={false}
        initial={{ ...initial, brief: 'Old brief' }}
        onStart={onStart}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Rewrite the scenario with AI/ }));
    expect(screen.getByLabelText('What is the video about?')).toHaveValue('Old brief');
    expect(screen.getByText(/Undo brings them back/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rewrite scenario' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('What is the video about?')).not.toBeInTheDocument(),
    );
  });

  it('points out the styles made for the format and shows the chosen one', async () => {
    const { user } = renderWithProviders(
      <BriefCard
        aspect="9:16"
        rewriting={false}
        busy={false}
        initial={initial}
        onStart={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Style' }));
    await user.click(await screen.findByRole('option', { name: 'Bold captions (made for 9:16)' }));
    expect(screen.getByText(/Big punchy captions/)).toBeInTheDocument();
  });

  it('waits while another run is busy', () => {
    renderWithProviders(
      <BriefCard
        aspect="16:9"
        rewriting={false}
        busy
        initial={{ ...initial, brief: 'x' }}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /AI is busy/ })).toBeDisabled();
  });
});

describe('AiRunsList', () => {
  const handlers = () => ({ onDetails: vi.fn(), onRetry: vi.fn(), onSaveRecipe: vi.fn() });

  it('lists every run with what was asked, how it ended and which AI, with the actions that fit', async () => {
    const h = handlers();
    const done = generation({ id: 'g-done', status: 'done' });
    const failed = generation({
      id: 'g-failed',
      status: 'failed',
      stage: 'edit',
      instruction: 'shorter',
    });
    const { user } = renderWithProviders(
      <AiRunsList generations={[failed, done]} loading={false} {...h} />,
    );
    const rows = within(screen.getByRole('list', { name: 'AI runs' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Failed')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Edit by typing')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Written')).toBeInTheDocument();
    expect(
      within(rows[0]!).queryByRole('button', { name: /Save as recipe/ }),
    ).not.toBeInTheDocument();
    await user.click(within(rows[0]!).getByRole('button', { name: /Try again/ }));
    expect(h.onRetry).toHaveBeenCalledWith('g-failed');
    expect(within(rows[1]!).queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
    await user.click(within(rows[1]!).getByRole('button', { name: /Save as recipe/ }));
    expect(h.onSaveRecipe).toHaveBeenCalledWith(done);
    await user.click(within(rows[1]!).getByRole('button', { name: /Details/ }));
    expect(h.onDetails).toHaveBeenCalledWith('g-done');
  });

  it('shimmers while loading and explains an empty list', () => {
    const { rerender, container } = renderWithProviders(
      <AiRunsList generations={[]} loading {...handlers()} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    rerender(<AiRunsList generations={[]} loading={false} {...handlers()} />);
    expect(screen.getByText('No AI runs yet')).toBeInTheDocument();
  });
});

it('a fixture document is a plain Persian video', () => {
  expect(document().language).toBe('fa');
});
