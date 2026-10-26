import type { GenerationDetail, GenerationView, HistoryEntryView } from '@agentmat/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { generation } from '../testing/aiFixtures';
import { NOW, video } from '../testing/fixtures';

/** The history browser (E39): comparing versions and their code, branching, and comparing AI runs. */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  MonacoDiffEditor: ({
    path,
    original,
    modified,
  }: {
    path: string;
    original: string;
    modified: string;
  }) => (
    <pre data-testid="diff">
      {path}: {original} =&gt; {modified}
    </pre>
  ),
}));

const { HistoryPanel } = await import('./HistoryPanel');

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  toast.success.mockClear();
});

const entry = (seq: number, label: string): HistoryEntryView => ({
  seq,
  label,
  actor: 'user',
  at: NOW,
  generationId: null,
  kind: 'edit',
  opCount: 1,
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function renderPanel(generations: GenerationView[] = []) {
  const onRestore = vi.fn();
  const onOpenVideo = vi.fn();
  const view = renderWithProviders(
    <HistoryPanel
      videoId="v1"
      currentSeq={3}
      onRestore={onRestore}
      onOpenVideo={onOpenVideo}
      ai={{
        generations,
        loading: false,
        onDetails: vi.fn(),
        onRetry: vi.fn(),
        onSaveRecipe: vi.fn(),
      }}
    />,
    {
      bridge: {
        'studio.history': async () => [
          entry(3, 'Renamed'),
          entry(2, 'Scene code'),
          entry(1, 'Created'),
        ],
        'studio.compareVersions': async () => [
          { kind: 'title', before: 'Launch', after: 'Launch day' },
          {
            kind: 'scene-changed',
            sceneId: 'a',
            position: 1,
            title: 'Hello',
            changes: [{ field: 'code', label: 'Animation', before: A, after: B }],
          },
        ],
        'studio.treeFiles': async (_videoId: string, tree: string) => [
          { path: 'index.html', text: tree === A ? '<p>old</p>' : '<p>new</p>' },
          { path: 'logo.png', text: null },
        ],
        'studio.branch': async () =>
          video({ id: 'v2bbbbbbbbbbbbbb', title: 'Launch (from version 1)' }),
        'studioAi.generationDetail': async (_videoId: string, id: string) =>
          ({
            ...generation({ id, status: 'done' }),
            instruction: id === 'g1' ? 'Make it short' : 'Make it warm',
            model: id === 'g1' ? 'opus' : 'sonnet',
            startedAt: id === 'g1' ? NOW - 1000 : NOW,
            texts: [{ request: `request for ${id}`, output: null, log: null }],
          }) as GenerationDetail,
      },
    },
  );
  return { ...view, onRestore, onOpenVideo };
}

describe('comparing versions', () => {
  it('lists what changed since a version, and compares the code of a changed scene', async () => {
    const { user, bridge } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Compare version 1 with now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Version 1 and version 3' });
    expect(bridge.$fn('studio.compareVersions')).toHaveBeenCalledWith('v1', 1, 3);
    expect(await within(dialog).findByText('Launch day')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Code of Scene 1: Hello' }));
    expect(await within(dialog).findByTestId('diff', {}, { timeout: 3000 })).toHaveTextContent(
      'index.html: <p>old</p> => <p>new</p>',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Back to the changes' }));
    expect(within(dialog).getByRole('list', { name: 'Changes' })).toBeTruthy();
  });

  it('restores the older version after asking, or starts a new video from it', async () => {
    const restoring = renderPanel();
    await restoring.user.click(
      await screen.findByRole('button', { name: 'Compare version 1 with now' }),
    );
    await restoring.user.click(await screen.findByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(restoring.onRestore).toHaveBeenCalledWith(1));
    restoring.unmount();

    const branching = renderPanel();
    await branching.user.click(
      await screen.findByRole('button', { name: 'Compare version 1 with now' }),
    );
    await branching.user.click(
      await screen.findByRole('button', { name: 'Start a new video from version 1' }),
    );
    await waitFor(() => expect(branching.onOpenVideo).toHaveBeenCalledWith('v2bbbbbbbbbbbbbb'));
    expect(branching.bridge.$fn('studio.branch')).toHaveBeenCalledWith('v1', 1);
    expect(toast.success).toHaveBeenCalledWith('Started "Launch (from version 1)" from version 1.');
  });
});

describe('comparing AI runs (AC2)', () => {
  it('shows how two runs differed, and what each was asked', async () => {
    const { user } = renderPanel([
      generation({ id: 'g2', status: 'done', startedAt: NOW }),
      generation({ id: 'g1', status: 'done', startedAt: NOW - 1000 }),
    ]);
    await user.click(await screen.findByRole('tab', { name: 'AI runs' }));
    const [first] = screen.getAllByRole('button', { name: 'Compare' });
    await user.click(first as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Compare with this' }));
    const dialog = await screen.findByRole('dialog', { name: 'Two AI runs' });
    const table = await within(dialog).findByRole('table', { name: 'The two runs' });
    expect(within(table).getByText('CLI, model and effort').closest('tr')?.textContent).toMatch(
      /Opus.*Sonnet|opus.*sonnet/i,
    );
    expect(await within(dialog).findByTestId('diff', {}, { timeout: 3000 })).toHaveTextContent(
      'instruction.txt: Make it short => Make it warm',
    );
    await user.click(within(dialog).getByRole('radio', { name: 'The full request' }));
    expect(await within(dialog).findByTestId('diff', {}, { timeout: 3000 })).toHaveTextContent(
      'request.md: request for g1 => request for g2',
    );
  });
});
