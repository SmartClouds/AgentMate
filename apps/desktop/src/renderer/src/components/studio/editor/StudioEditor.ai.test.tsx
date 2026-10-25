import type { EditResponse, GenerationView, StudioEvent } from '@agentmat/studio';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { usePendingScenario } from '../ai/runSettings';
import { detail, generation, proposal } from '../testing/aiFixtures';
import { document, opened, status, video, withScenes } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { StudioEditor } = await import('./StudioEditor');

const ID = video().id;

/** The editor with a scripted service: its AI runs, and a way to send it Studio events. */
function renderEditor(
  options: {
    runs?: GenerationView[];
    open?: () => unknown;
    overrides?: Record<string, unknown>;
  } = {},
) {
  const runs = { current: options.runs ?? [] };
  const listeners: ((event: StudioEvent) => void)[] = [];
  const view = renderWithProviders(
    <StudioEditor videoId={ID} onBack={vi.fn()} onOpenDevSetup={vi.fn()} />,
    {
      bridge: {
        'studio.open': options.open ?? (async () => opened()),
        'studio.history': async () => [],
        'studio.onEvent': (listener: (event: StudioEvent) => void) => {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
        'studioAi.generations': async () => runs.current,
        ...options.overrides,
      },
    },
  );
  const emit = (event: StudioEvent) => act(() => listeners.forEach((l) => l(event)));
  return { ...view, runs, emit };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  usePendingScenario.setState({ pending: null });
  window.localStorage.clear();
});

describe('StudioEditor with AI', () => {
  it('writes a scenario from the brief on an empty video and shows the run while it works', async () => {
    const running = generation();
    const { user, bridge, runs, emit } = renderEditor({
      overrides: {
        'studioAi.startScenario': async () => {
          runs.current = [running];
          return running;
        },
      },
    });
    const brief = await screen.findByLabelText('What is the video about?');
    expect(screen.queryByRole('form', { name: 'Ask AI' })).not.toBeInTheDocument();
    await user.type(brief, 'یک ویدیو درباره‌ی آب');
    await user.click(screen.getByRole('button', { name: /Write scenario/ }));
    await waitFor(() =>
      expect(bridge.$fn('studioAi.startScenario')).toHaveBeenCalledWith({
        videoId: ID,
        brief: 'یک ویدیو درباره‌ی آب',
        targetSeconds: 60,
        styleId: null,
        run: { cliId: null, model: null, effort: null },
      }),
    );
    const card = await screen.findByRole('region', { name: 'AI run' });
    emit({
      type: 'generation-output',
      videoId: ID,
      generationId: running.id,
      lines: ['Reading request.md'],
    });
    expect(await within(card).findByText('Reading request.md')).toBeInTheDocument();
    // Output for another video is not this card's business.
    emit({
      type: 'generation-output',
      videoId: 'other',
      generationId: running.id,
      lines: ['nope'],
    });
    expect(within(card).queryByText('nope')).not.toBeInTheDocument();
  });

  it('shows the scenario once it lands, and says so', async () => {
    const running = generation();
    let doc = document();
    let st = status();
    const { runs, emit, bridge } = renderEditor({
      runs: [running],
      open: async () => opened(doc, st),
    });
    expect(await screen.findByRole('region', { name: 'AI run' })).toBeInTheDocument();

    doc = withScenes('Hook', 'Close');
    st = status({ seq: 2, canUndo: true, undoLabel: 'AI wrote the scenario' });
    runs.current = [{ ...running, status: 'done', resultSeq: 2, finishedAt: Date.now() }];
    emit({ type: 'video-changed', videoId: ID, seq: 2 });
    emit({ type: 'generation-changed', videoId: ID, generationId: running.id });

    expect(await screen.findByRole('region', { name: 'Scene 2' })).toBeInTheDocument();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/scenario is written/)),
    );
    expect(screen.queryByRole('region', { name: 'AI run' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Rewrite the scenario with AI/ }),
    ).toBeInTheDocument();
    // A change the editor already has is not fetched again.
    const opens = bridge.$fn('studio.open').mock.calls.length;
    emit({ type: 'video-changed', videoId: ID, seq: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.$fn('studio.open').mock.calls.length).toBe(opens);
  });

  it('starts the scenario asked for in the New video dialog once the video is open', async () => {
    usePendingScenario.getState().set(ID, {
      brief: 'From the dialog',
      targetSeconds: 30,
      styleId: 'hud',
      run: { cliId: 'claude-code', model: 'opus', effort: null },
    });
    const { bridge } = renderEditor({
      overrides: { 'studioAi.startScenario': async () => generation() },
    });
    await waitFor(() =>
      expect(bridge.$fn('studioAi.startScenario')).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: ID, brief: 'From the dialog', styleId: 'hud' }),
      ),
    );
    expect(bridge.$fn('studioAi.startScenario')).toHaveBeenCalledTimes(1);
  });

  it('asks AI for a change, then applies the proposal it comes back with', async () => {
    const doc = withScenes('Hook', 'Close');
    const proposed = generation({
      id: 'g2',
      stage: 'edit',
      status: 'proposed',
      instruction: 'shorter',
      proposal: proposal(),
    });
    const after = withScenes('Punchy hook', 'Close');
    const applied: EditResponse = {
      seq: 3,
      document: after,
      status: status({ seq: 3, canUndo: true }),
    };
    const { user, bridge, runs } = renderEditor({
      open: async () => opened(doc),
      overrides: {
        'studioAi.startEdit': async () => {
          runs.current = [proposed];
          return proposed;
        },
        'studioAi.applyProposal': async () => {
          runs.current = [{ ...proposed, status: 'applied', resultSeq: 3 }];
          return applied;
        },
      },
    });
    await user.type(await screen.findByLabelText('What should change'), 'shorter{Enter}');
    await waitFor(() =>
      expect(bridge.$fn('studioAi.startEdit')).toHaveBeenCalledWith({
        videoId: ID,
        instruction: 'shorter',
        run: { cliId: null, model: null, effort: null },
      }),
    );
    const card = await screen.findByRole('region', { name: 'AI proposal' });
    await user.click(within(card).getByRole('button', { name: /Apply/ }));
    expect(bridge.$fn('studioAi.applyProposal')).toHaveBeenCalledWith(ID, 'g2');
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Scene 1' })).getByLabelText('Scene 1 title'),
      ).toHaveValue('Punchy hook'),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'AI proposal' })).not.toBeInTheDocument(),
    );
  });

  it('discards a proposal', async () => {
    const proposed = generation({
      id: 'g2',
      stage: 'edit',
      status: 'proposed',
      proposal: proposal(),
    });
    const { user, bridge, runs } = renderEditor({
      runs: [proposed],
      open: async () => opened(withScenes('A')),
      overrides: {
        'studioAi.discardProposal': async () => {
          runs.current = [{ ...proposed, status: 'discarded' }];
        },
      },
    });
    const card = await screen.findByRole('region', { name: 'AI proposal' });
    await user.click(within(card).getByRole('button', { name: /Discard/ }));
    expect(bridge.$fn('studioAi.discardProposal')).toHaveBeenCalledWith(ID, 'g2');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'AI proposal' })).not.toBeInTheDocument(),
    );
  });

  it('offers to try a failed run again, and hides it when dismissed', async () => {
    const failed = generation({ status: 'failed', error: 'Claude Code failed: not logged in' });
    const { user, bridge } = renderEditor({
      runs: [failed],
      overrides: { 'studioAi.retry': async () => generation({ id: 'g3' }) },
    });
    expect(await screen.findByText('Claude Code failed: not logged in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(bridge.$fn('studioAi.retry')).toHaveBeenCalledWith(ID, failed.id);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Claude Code failed: not logged in')).not.toBeInTheDocument();
  });

  it('says what went wrong when a run could not start', async () => {
    const { user } = renderEditor({
      overrides: {
        'studioAi.startScenario': async () => {
          throw new Error(
            "Error invoking remote method 'studioAi:startScenario': Error: An AI run is already working on this video.",
          );
        },
      },
    });
    await user.type(await screen.findByLabelText('What is the video about?'), 'x');
    await user.click(screen.getByRole('button', { name: /Write scenario/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('An AI run is already working on this video.'),
    );
  });

  it('lists the AI runs in the History panel and opens one with what was asked', async () => {
    const done = generation({ status: 'done', finishedAt: Date.now() });
    const { user } = renderEditor({
      runs: [done],
      overrides: { 'studioAi.generationDetail': async () => detail() },
    });
    await user.click(await screen.findByRole('tab', { name: 'AI runs' }));
    const list = await screen.findByRole('list', { name: 'AI runs' });
    await user.click(within(list).getByRole('button', { name: /Details/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('First try')).toBeInTheDocument();
  });
});
