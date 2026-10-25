import type { ApplyResult, EditResponse, StudioDocument } from '@agentmat/studio';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { document, NOW, opened, status, video, withScenes } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { StudioEditor } = await import('./StudioEditor');

const ID = video().id;

/** An apply that answers like the service: the next version, one entry later. */
function applying(next: (doc: StudioDocument) => StudioDocument) {
  let seq = 1;
  return async ({ baseSeq }: { baseSeq: number }): Promise<ApplyResult> => {
    if (baseSeq !== seq)
      return { ok: false, reason: 'stale', seq, document: document(), status: status({ seq }) };
    seq += 1;
    return {
      ok: true,
      seq,
      document: next(document()),
      status: status({ seq, canUndo: true, undoLabel: 'x' }),
    };
  };
}

function renderEditor(overrides: Record<string, unknown> = {}) {
  const onBack = vi.fn();
  const view = renderWithProviders(<StudioEditor videoId={ID} onBack={onBack} />, {
    bridge: {
      'studio.open': async () => opened(),
      'studio.history': async () => [],
      ...overrides,
    },
  });
  return { ...view, onBack };
}

beforeEach(() => {
  toast.info.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
  confirm.mockResolvedValue(true);
});

describe('StudioEditor opening', () => {
  it('shimmers while the video opens', () => {
    renderEditor({ 'studio.open': () => new Promise(() => undefined) });
    expect(screen.getByLabelText('Opening the video')).toHaveAttribute('aria-busy', 'true');
  });

  it('says another AgentMate has it, and offers to take over only when that one went quiet', async () => {
    const holder = { appId: 'AgentMate Dev', host: 'laptop', pid: 9, heartbeatAt: NOW - 120_000 };
    const { user, bridge } = renderEditor({
      'studio.open': async () => ({ state: 'locked', holder, stale: true }),
      'studio.takeOver': async () => opened(),
    });
    expect(await screen.findByText('Open in another AgentMate')).toBeInTheDocument();
    expect(screen.getByText(/AgentMate Dev on laptop has this video open/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByLabelText('Video title')).toHaveValue('Launch film');
    expect(bridge.$fn('studio.takeOver')).toHaveBeenCalledWith(ID);
  });

  it('offers no take over while the other copy still answers', async () => {
    const holder = { appId: 'AgentMate', host: 'desk', pid: 9, heartbeatAt: NOW };
    renderEditor({ 'studio.open': async () => ({ state: 'locked', holder, stale: false }) });
    expect(await screen.findByText('Open in another AgentMate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
  });

  it('explains a video whose folder is gone', async () => {
    const { user, onBack } = renderEditor({
      'studio.open': async () => ({ state: 'missing', video: video({ missing: true }) }),
    });
    expect(await screen.findByText("This video's folder is gone")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to Studio' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows why it did not open, and tries again', async () => {
    let calls = 0;
    const { user } = renderEditor({
      'studio.open': async () => {
        calls += 1;
        return calls === 1
          ? { state: 'error', message: 'The history file of this video is damaged.' }
          : opened();
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('damaged');
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByLabelText('Video title')).toBeInTheDocument();
  });

  it('closes the video when the editor goes away, freeing its folder', async () => {
    const { unmount, bridge } = renderEditor();
    await screen.findByLabelText('Video title');
    unmount();
    expect(bridge.$fn('studio.close')).toHaveBeenCalledWith(ID);
  });
});

describe('StudioEditor editing', () => {
  it('renames the video when the title field is left', async () => {
    const { user, bridge } = renderEditor({
      'studio.applyEdits': applying((d) => ({ ...d, title: 'New name' })),
    });
    const field = await screen.findByLabelText('Video title');
    await user.clear(field);
    await user.type(field, 'New name{Enter}');
    await waitFor(() =>
      expect(bridge.$fn('studio.applyEdits')).toHaveBeenCalledWith({
        videoId: ID,
        baseSeq: 1,
        ops: [{ op: 'doc.set', field: 'title', value: 'New name' }],
        label: 'Renamed the video',
      }),
    );
  });

  it('puts the old title back when the field is emptied', async () => {
    const { user, bridge } = renderEditor();
    const field = await screen.findByLabelText('Video title');
    await user.clear(field);
    field.blur();
    await waitFor(() => expect(field).toHaveValue('Launch film'));
    expect(() => bridge.$fn('studio.applyEdits')).toThrow();
  });

  it('adds scenes one after another, each against the version the last one made', async () => {
    const { user, bridge } = renderEditor({ 'studio.applyEdits': applying((d) => d) });
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await waitFor(() => expect(bridge.$fn('studio.applyEdits')).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Add scene/ }));
    await waitFor(() => expect(bridge.$fn('studio.applyEdits')).toHaveBeenCalledTimes(2));
    expect(
      bridge.$fn('studio.applyEdits').mock.calls.map((c) => (c[0] as { baseSeq: number }).baseSeq),
    ).toEqual([1, 2]);
  });

  it('tells the user when the video changed under them and keeps the newer version', async () => {
    const { user } = renderEditor({
      'studio.applyEdits': async (): Promise<ApplyResult> => ({
        ok: false,
        reason: 'stale',
        seq: 5,
        document: withScenes('From the AI'),
        status: status({ seq: 5 }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    expect(await screen.findByDisplayValue('From the AI')).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalled();
  });

  it('shows an edit the service refused', async () => {
    const { user } = renderEditor({
      'studio.applyEdits': async () => {
        throw new Error('That edit would break the video.');
      },
    });
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That edit would break the video.'),
    );
  });
});

describe('StudioEditor undo and history', () => {
  const undone: EditResponse = {
    seq: 3,
    document: document(),
    status: status({ seq: 3, canRedo: true, redoLabel: 'Added scene 1' }),
  };

  it('undoes and redoes from the toolbar, naming what it will undo', async () => {
    const { user, bridge } = renderEditor({
      'studio.open': async () =>
        opened(withScenes('Hook'), status({ seq: 2, canUndo: true, undoLabel: 'Added scene 1' })),
      'studio.undo': async () => undone,
      'studio.redo': async () => ({ ...undone, seq: 4, status: status({ seq: 4, canUndo: true }) }),
    });
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await user.click(undo);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled());
    expect(screen.queryByDisplayValue('Hook')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(bridge.$fn('studio.redo')).toHaveBeenCalledWith(ID));
  });

  it('undoes with Ctrl+Z outside text fields, and leaves a field its own undo', async () => {
    const { bridge } = renderEditor({
      'studio.open': async () =>
        opened(withScenes('Hook'), status({ seq: 2, canUndo: true, canRedo: true })),
      'studio.undo': async () => undone,
      'studio.redo': async () => undone,
    });
    const title = await screen.findByLabelText('Video title');
    fireEvent.keyDown(title, { key: 'z', ctrlKey: true });
    expect(() => bridge.$fn('studio.undo')).toThrow();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(bridge.$fn('studio.undo')).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    await waitFor(() => expect(bridge.$fn('studio.redo')).toHaveBeenCalled());
  });

  it('lists the history and restores an older version after asking', async () => {
    const { user, bridge } = renderEditor({
      'studio.open': async () => opened(withScenes('Hook'), status({ seq: 2 })),
      'studio.history': async () => [
        {
          seq: 2,
          at: NOW,
          kind: 'edit',
          actor: 'ai',
          label: 'Wrote the scenario',
          generationId: 'g1',
          opCount: 3,
        },
        {
          seq: 1,
          at: NOW - 60_000,
          kind: 'mark',
          actor: 'system',
          label: 'Video created',
          generationId: null,
          opCount: 0,
        },
      ],
      'studio.restore': async () => ({ seq: 3, document: document(), status: status({ seq: 3 }) }),
    });
    const history = await screen.findByRole('complementary', { name: 'History' });
    const created = (await within(history).findByText('Video created')).closest(
      'li',
    ) as HTMLElement;
    expect(within(history).getByText('AI')).toBeInTheDocument();
    expect(within(history).getByText('Current')).toBeInTheDocument();
    await user.click(within(created).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(bridge.$fn('studio.restore')).toHaveBeenCalledWith(ID, 1));
  });

  it('hides the history panel on request', async () => {
    const { user } = renderEditor();
    await screen.findByRole('complementary', { name: 'History' });
    await user.click(screen.getByRole('button', { name: /History/ }));
    expect(screen.queryByRole('complementary', { name: 'History' })).not.toBeInTheDocument();
  });

  it("opens the video's folder", async () => {
    const { user, bridge } = renderEditor();
    await user.click(await screen.findByRole('button', { name: "Open the video's folder" }));
    expect(bridge.$fn('studio.revealVideo')).toHaveBeenCalledWith(ID);
  });
});
