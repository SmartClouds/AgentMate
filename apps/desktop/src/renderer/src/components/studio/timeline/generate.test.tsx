import type { GenJobView } from '@runova/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { NOW } from '../testing/fixtures';
import { GenerateDialog } from './GenerateDialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  toast.success.mockClear();
});

function job(overrides: Partial<GenJobView> = {}): GenJobView {
  return {
    id: 'g1',
    videoId: 'v1',
    kind: 'image',
    engine: 'gemini',
    model: 'gemini-nano-banana-2.1',
    prompt: 'A red bicycle',
    status: 'done',
    stage: null,
    estimateUsd: 0.0336,
    mediaHash: 'h1',
    mediaName: 'Generated picture 1.png',
    error: null,
    createdAt: NOW,
    endedAt: NOW,
    resumed: false,
    ...overrides,
  };
}

function renderDialog(jobs: GenJobView[] = []) {
  return renderWithProviders(
    <GenerateDialog videoId="v1" open onOpenChange={vi.fn()} aspect="16:9" />,
    {
      bridge: {
        'studioGen.estimate': async (input: { kind: string; engine: string; quality?: string }) =>
          input.kind === 'video'
            ? {
                usd: 0.8,
                model: 'gemini-omni-1.1-flash',
                label: 'Google Gemini Omni',
                basis: 'About 8 seconds.',
              }
            : input.engine === 'openai'
              ? { usd: 0.053, model: 'gpt-image-2.5-flare', label: 'OpenAI', basis: 'An estimate.' }
              : {
                  usd: 0.0336,
                  model: 'gemini-nano-banana-2.1',
                  label: 'Google Gemini',
                  basis: '$0.0336 for one 1K picture.',
                },
        'studioGen.jobs': async () => jobs,
        'studioGen.start': async () => job({ status: 'running', stage: 'request' }),
        'studioGen.cancel': async () => undefined,
      },
    },
  );
}

describe('GenerateDialog', () => {
  it('shows the price, asks once more, and starts with the price that was agreed (AC3)', async () => {
    const { user, bridge } = renderDialog();
    expect(await screen.findByText('Costs about $0.03. $0.0336 for one 1K picture.')).toBeTruthy();
    await user.type(screen.getByLabelText('What to make'), 'A red bicycle');
    confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Make this with Google Gemini?',
        description: expect.stringMatching(
          /^This bills your Google Gemini account about \$0\.03\./,
        ),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() =>
      expect(bridge.$fn('studioGen.start')).toHaveBeenCalledWith({
        kind: 'image',
        engine: 'gemini',
        prompt: 'A red bicycle',
        size: '1K',
        aspectRatio: '16:9',
        videoId: 'v1',
        confirmedUsd: 0.0336,
      }),
    );
    // Declined once, so the only start is the agreed one.
    expect(bridge.$fn('studioGen.start')).toHaveBeenCalledTimes(1);
  });

  it('makes a clip with Gemini Omni in the video shape, and OpenAI pictures by quality', async () => {
    const { user, bridge } = renderDialog();
    await user.click(await screen.findByRole('radio', { name: 'Clip' }));
    expect(screen.getByText('Google Gemini Omni')).toBeTruthy();
    expect(await screen.findByText('Costs about $0.80. About 8 seconds.')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Picture' }));
    await user.click(screen.getByRole('radio', { name: 'OpenAI' }));
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await waitFor(() =>
      expect(bridge.$fn('studioGen.estimate')).toHaveBeenLastCalledWith(
        expect.objectContaining({ engine: 'openai', quality: 'high', size: '1536x1024' }),
      ),
    );
  });

  it('lists what was made, declined or is under way, and sums what was spent', async () => {
    const { user, bridge } = renderDialog([
      job({
        id: 'g3',
        prompt: 'Waves',
        kind: 'video',
        status: 'running',
        stage: 'waiting',
        estimateUsd: 0.8,
      }),
      job({
        id: 'g2',
        prompt: 'Something rude',
        status: 'refused',
        error: 'OpenAI declined this prompt: rejected.',
        mediaName: null,
      }),
      job(),
    ]);
    const waves = await screen.findByRole('listitem', { name: 'Waves' });
    expect(within(waves).getByText(/The provider is making the clip/)).toBeTruthy();
    expect(
      within(screen.getByRole('listitem', { name: 'Something rude' })).getByText('Declined'),
    ).toBeTruthy();
    expect(screen.getByText(/OpenAI declined this prompt: rejected\./)).toBeTruthy();
    expect(screen.getByLabelText('Spent').textContent).toBe('Spent: $0.03 at list prices');
    await user.click(within(waves).getByRole('button', { name: 'Cancel' }));
    expect(bridge.$fn('studioGen.cancel')).toHaveBeenCalledWith('g3');
  });
});
