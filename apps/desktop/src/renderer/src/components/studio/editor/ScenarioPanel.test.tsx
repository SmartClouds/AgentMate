import { secondsToFlicks } from '@agentmat/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { document, withScenes } from '../testing/fixtures';

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { ScenarioPanel } = await import('./ScenarioPanel');

function renderPanel(doc = withScenes('Hook', 'Problem', 'Answer')) {
  const apply = vi.fn(async () => true);
  return { ...renderWithProviders(<ScenarioPanel document={doc} apply={apply} />), apply };
}

const scene = (n: number) => screen.getByRole('region', { name: `Scene ${n}` });

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
});

describe('ScenarioPanel', () => {
  it('starts with an empty state that adds the first scene', async () => {
    const { user, apply } = renderPanel(document());
    expect(screen.getByText('No scenes yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add scene/ }));
    expect(apply).toHaveBeenCalledWith(
      [expect.objectContaining({ op: 'scene.add', index: 0 })],
      'Added scene 1',
    );
  });

  it('saves what the video is about when the field is left', async () => {
    const { user, apply } = renderPanel();
    await user.type(screen.getByLabelText('What the video is about'), 'A short about a shop');
    await user.tab();
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scenario.set', patch: { logline: 'A short about a shop' } }],
      'Edited what the video is about',
    );
  });

  it('saves a scene title and narration as separate, named changes', async () => {
    const { user, apply } = renderPanel();
    const first = scene(1);
    const title = within(first).getByLabelText('Scene 1 title');
    await user.clear(title);
    await user.type(title, 'Opening');
    await user.type(within(first).getByLabelText('Narration'), 'سلام');
    await user.tab();
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.update', sceneId: 's1', patch: { title: 'Opening' } }],
      'Renamed scene 1',
    );
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.update', sceneId: 's1', patch: { narration: 'سلام' } }],
      'Edited the narration of scene 1',
    );
  });

  it('saves nothing when a field is left unchanged', async () => {
    const { user, apply } = renderPanel();
    await user.click(within(scene(1)).getByLabelText('Scene 1 title'));
    await user.tab();
    expect(apply).not.toHaveBeenCalled();
  });

  it('takes a length in seconds, and refuses one it cannot use', async () => {
    const { user, apply } = renderPanel();
    const length = within(scene(2)).getByLabelText('Length (seconds)');
    await user.clear(length);
    await user.type(length, '0');
    expect(
      within(scene(2)).getByText('Enter a length from 0.5 to 600 seconds.'),
    ).toBeInTheDocument();
    await user.tab();
    expect(apply).not.toHaveBeenCalled();
    await user.clear(length);
    await user.type(length, '7.5');
    await user.tab();
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.update', sceneId: 's2', patch: { targetDuration: secondsToFlicks(7.5) } }],
      'Changed the length of scene 2',
    );
  });

  it('moves scenes, and offers no move past either end', async () => {
    const { user, apply } = renderPanel();
    expect(within(scene(1)).getByRole('button', { name: 'Move scene 1 up' })).toBeDisabled();
    expect(within(scene(3)).getByRole('button', { name: 'Move scene 3 down' })).toBeDisabled();
    await user.click(within(scene(2)).getByRole('button', { name: 'Move scene 2 up' }));
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.move', sceneId: 's2', index: 0 }],
      'Moved scene 2 up',
    );
    await user.click(within(scene(2)).getByRole('button', { name: 'Move scene 2 down' }));
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.move', sceneId: 's2', index: 2 }],
      'Moved scene 2 down',
    );
  });

  it('deletes a scene only after asking', async () => {
    const { user, apply } = renderPanel();
    confirm.mockResolvedValueOnce(false);
    await user.click(within(scene(3)).getByRole('button', { name: 'Delete scene 3' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(apply).not.toHaveBeenCalled();
    await user.click(within(scene(3)).getByRole('button', { name: 'Delete scene 3' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(
        [{ op: 'scene.remove', sceneId: 's3' }],
        'Deleted scene 3',
      ),
    );
  });

  it('shows a change made elsewhere, such as an undo', async () => {
    function Harness() {
      const [doc, setDoc] = useState(withScenes('Hook'));
      return (
        <>
          <button type="button" onClick={() => setDoc(withScenes('Changed by undo'))}>
            Undo elsewhere
          </button>
          <ScenarioPanel document={doc} apply={vi.fn(async () => true)} />
        </>
      );
    }
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Undo elsewhere' }));
    expect(screen.getByDisplayValue('Changed by undo')).toBeInTheDocument();
  });
});

describe('ScenarioPanel scene details', () => {
  it('saves the on-screen lines one per line, dropping blank ones', async () => {
    const { user, apply } = renderPanel();
    const field = within(scene(1)).getByLabelText('On screen');
    await user.type(field, 'هر قطره مهم است{Enter}{Enter}  ۳۰۰۰ لیتر  ');
    await user.tab();
    expect(apply).toHaveBeenCalledWith(
      [
        {
          op: 'scene.update',
          sceneId: 's1',
          patch: { onScreenText: ['هر قطره مهم است', '۳۰۰۰ لیتر'] },
        },
      ],
      'Edited the on-screen text of scene 1',
    );
  });

  it('saves what the viewer sees', async () => {
    const { user, apply } = renderPanel();
    await user.type(within(scene(2)).getByLabelText('What the viewer sees'), 'A drop falls');
    await user.tab();
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.update', sceneId: 's2', patch: { visualBrief: 'A drop falls' } }],
      'Edited what scene 2 shows',
    );
  });

  it('changes how a scene hands over, on a frame of the video, and offers none on the last scene', async () => {
    const { user, apply } = renderPanel();
    await user.click(within(scene(1)).getByRole('combobox', { name: 'How scene 1 hands over' }));
    await user.click(await screen.findByRole('option', { name: 'Fade through black' }));
    expect(apply).toHaveBeenCalledWith(
      [
        {
          op: 'scene.update',
          sceneId: 's1',
          patch: { transitionOut: { kind: 'fadeblack', duration: secondsToFlicks(0.5) } },
        },
      ],
      'Changed how scene 1 hands over',
    );
    expect(
      within(scene(3)).queryByRole('combobox', { name: /hands over/ }),
    ).not.toBeInTheDocument();
  });

  it('goes back to a plain cut', async () => {
    const doc = withScenes('A', 'B');
    doc.scenario.scenes[0]!.transitionOut = { kind: 'fade', duration: secondsToFlicks(0.5) };
    const { user, apply } = renderPanel(doc);
    await user.click(within(scene(1)).getByRole('combobox', { name: 'How scene 1 hands over' }));
    await user.click(await screen.findByRole('option', { name: 'Cut' }));
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'scene.update', sceneId: 's1', patch: { transitionOut: null } }],
      'Changed how scene 1 hands over',
    );
  });
});
