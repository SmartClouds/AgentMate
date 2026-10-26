import type { SceneCodeView } from '@runova/studio';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { NOW, status, withScenes } from '../testing/fixtures';
import { SceneCodeDialog } from './SceneCodeDialog';
import { SceneMotion } from './SceneMotion';
import { ScenePreview } from './ScenePreview';
import { StylesDialog } from './StylesDialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea aria-label="Code" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

const TREE = 'a'.repeat(64);

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = () => undefined;
      disconnect = () => undefined;
    },
  );
});

/** Answers the preview's seek requests the way the runtime in the iframe does. */
function answerSeeks(frame: HTMLIFrameElement, errors: string[] = []) {
  const win = frame.contentWindow as Window;
  const seen: number[] = [];
  vi.spyOn(win, 'postMessage').mockImplementation((data: unknown) => {
    const message = data as { type: string; t: number; id: number };
    seen.push(message.t);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'studio:frame', id: message.id, t: message.t, errors },
        source: win,
      }),
    );
  });
  return seen;
}

describe('ScenePreview', () => {
  it('asks the sandboxed page for the moment the user scrubs to, and shows what it reports', async () => {
    renderWithProviders(
      <ScenePreview
        url="studio-scene://t-x/index.html"
        width={1920}
        height={1080}
        duration={5}
        label="Scene 1 preview"
      />,
    );
    const frame = screen.getByTitle('Scene 1 preview') as HTMLIFrameElement;
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    const seen = answerSeeks(frame, ['Blocked connect-src: https://example.com/']);
    fireEvent.load(frame);
    expect(seen).toEqual([0]);
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '2.5' } });
    expect(seen.at(-1)).toBe(2.5);
    expect(screen.getByText('2.5 s')).toBeInTheDocument();
    expect(await screen.findByText('1 problem')).toBeInTheDocument();
  });

  it('sends only the latest moment while a frame is still being drawn', () => {
    renderWithProviders(
      <ScenePreview
        url="studio-scene://t-x/index.html"
        width={100}
        height={100}
        duration={5}
        label="p"
      />,
    );
    const frame = screen.getByTitle('p') as HTMLIFrameElement;
    const win = frame.contentWindow as Window;
    const sent: number[] = [];
    let reply: (() => void) | null = null;
    vi.spyOn(win, 'postMessage').mockImplementation((data: unknown) => {
      const m = data as { t: number; id: number };
      sent.push(m.t);
      reply = () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'studio:frame', id: m.id, t: m.t, errors: [] },
            source: win,
          }),
        );
    });
    fireEvent.load(frame);
    const slider = screen.getByLabelText('Time');
    fireEvent.change(slider, { target: { value: '1' } });
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.change(slider, { target: { value: '3' } });
    expect(sent).toEqual([0]);
    act(() => reply?.());
    expect(sent).toEqual([0, 3]);
  });

  it('plays and pauses', async () => {
    const { user } = renderWithProviders(
      <ScenePreview
        url="studio-scene://t-x/index.html"
        width={100}
        height={100}
        duration={5}
        label="p"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });
});

describe('SceneMotion', () => {
  const doc = withScenes('Hook');
  const base = {
    videoId: 'v1',
    document: doc,
    index: 0,
    busy: false,
    run: { cliId: 'claude-code' },
    onRunChange: vi.fn(),
    onOpenCode: vi.fn(),
  };

  it('offers to animate a scene that has no code yet', async () => {
    const onAnimate = vi.fn(async () => true);
    const { user } = renderWithProviders(
      <SceneMotion {...base} scene={doc.scenario.scenes[0]!} onAnimate={onAnimate} />,
    );
    expect(screen.getByText('No animation yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Animate scene 1 with AI' }));
    expect(onAnimate).toHaveBeenCalledWith();
  });

  it('waits while AI is busy', () => {
    renderWithProviders(
      <SceneMotion {...base} busy scene={doc.scenario.scenes[0]!} onAnimate={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Animate scene 1 with AI' })).toBeDisabled();
  });

  it('shows the thumbnail, previews, asks for a change, opens the code and checks', async () => {
    const scene = { ...doc.scenario.scenes[0]!, code: { treeHash: TREE } };
    const onAnimate = vi.fn(async () => true);
    const onOpenCode = vi.fn();
    const { user, bridge } = renderWithProviders(
      <SceneMotion {...base} scene={scene} onAnimate={onAnimate} onOpenCode={onOpenCode} />,
      {
        bridge: {
          'studioScenes.thumbnail': async () => 'data:image/png;base64,AAAA',
          'studioScenes.check': async () => ({
            ok: false,
            problems: ['The frame at 0 s is blank: nothing is drawn.'],
            notes: [],
          }),
        },
      },
    );
    expect(await screen.findByRole('img', { name: 'Scene 1 animation' })).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA',
    );
    expect(bridge.$fn('studioScenes.thumbnail')).toHaveBeenCalledWith('v1', TREE);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = screen.getByTitle('Scene 1 preview');
    expect(frame.getAttribute('src')).toMatch(
      new RegExp(`^studio-scene://t-${TREE}/index.html\\?c=`),
    );

    await user.click(screen.getByRole('button', { name: /Change/ }));
    await user.type(
      screen.getByLabelText("What to change in scene 1's animation"),
      'Bigger title{Enter}',
    );
    expect(onAnimate).toHaveBeenCalledWith('Bigger title');

    await user.click(screen.getByRole('button', { name: /Code/ }));
    expect(onOpenCode).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(
      await screen.findByText('The frame at 0 s is blank: nothing is drawn.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Fix with AI/ }));
    expect(onAnimate).toHaveBeenLastCalledWith(
      'Fix these problems:\n- The frame at 0 s is blank: nothing is drawn.',
    );
  });

  it('says when the scene passes, and shows why a check could not run', async () => {
    const scene = { ...doc.scenario.scenes[0]!, code: { treeHash: TREE } };
    let fail = false;
    const { user } = renderWithProviders(
      <SceneMotion {...base} scene={scene} onAnimate={vi.fn()} />,
      {
        bridge: {
          'studioScenes.thumbnail': async () => null,
          'studioScenes.check': async () => {
            if (fail)
              throw new Error(
                "Error invoking remote method 'studioScenes:check': Error: The window crashed.",
              );
            return { ok: true, problems: [], notes: [] };
          },
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Checks pass')).toBeInTheDocument();
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('The window crashed.')).toBeInTheDocument();
  });
});

describe('SceneCodeDialog', () => {
  const code: SceneCodeView = {
    sceneId: 's1',
    treeHash: TREE,
    files: [
      { path: 'index.html', size: 10, text: '<p>سلام</p>' },
      { path: 'scene.js', size: 10, text: 'Studio.scene({ render() {} });' },
      { path: 'logo.png', size: 99, text: null },
    ],
    revisions: [
      {
        id: 2,
        treeHash: TREE,
        author: 'user',
        label: 'Edited the code of scene 1',
        generationId: null,
        at: NOW,
      },
      {
        id: 1,
        treeHash: 'b'.repeat(64),
        author: 'ai',
        label: 'AI animated scene 1',
        generationId: 'g1',
        at: NOW - 60_000,
      },
    ],
  };
  const response = { seq: 5, document: withScenes('Hook'), status: status({ seq: 5 }) };

  it('edits a file and saves it as a new version, with Ctrl+S too', async () => {
    const onChanged = vi.fn();
    const { user, bridge } = renderWithProviders(
      <SceneCodeDialog
        videoId="v1"
        sceneId="s1"
        sceneNumber={1}
        onOpenChange={vi.fn()}
        onChanged={onChanged}
      />,
      {
        bridge: {
          'studioScenes.code': async () => code,
          'studioScenes.saveFiles': async () => response,
        },
      },
    );
    const tabs = await screen.findByRole('tablist', { name: 'Files' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['index.html', 'scene.js']);
    await user.click(within(tabs).getByRole('tab', { name: 'scene.js' }));
    const editor = await screen.findByLabelText('Code');
    expect(editor).toHaveValue('Studio.scene({ render() {} });');
    await user.clear(editor);
    await user.type(editor, 'x');
    expect(within(tabs).getByRole('tab', { name: 'scene.js *' })).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(bridge.$fn('studioScenes.saveFiles')).toHaveBeenCalledWith({
        videoId: 'v1',
        sceneId: 's1',
        files: [{ path: 'scene.js', content: 'x' }],
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(response);
    expect(toast.success).toHaveBeenCalled();
  });

  it('goes back to an earlier version and checks the current one', async () => {
    const onChanged = vi.fn();
    const { user, bridge } = renderWithProviders(
      <SceneCodeDialog
        videoId="v1"
        sceneId="s1"
        sceneNumber={1}
        onOpenChange={vi.fn()}
        onChanged={onChanged}
      />,
      {
        bridge: {
          'studioScenes.code': async () => code,
          'studioScenes.useRevision': async () => response,
          'studioScenes.check': async () => ({ ok: true, problems: [], notes: [] }),
        },
      },
    );
    const versions = await screen.findByRole('complementary', { name: 'Versions' });
    expect(within(versions).getByText('Current')).toBeInTheDocument();
    await user.click(within(versions).getByRole('button', { name: 'Use this version' }));
    expect(bridge.$fn('studioScenes.useRevision')).toHaveBeenCalledWith('v1', 's1', 1);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(response));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('The scene passes its checks.')).toBeInTheDocument();
  });

  it('says why a save failed', async () => {
    const { user } = renderWithProviders(
      <SceneCodeDialog
        videoId="v1"
        sceneId="s1"
        sceneNumber={1}
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />,
      {
        bridge: {
          'studioScenes.code': async () => code,
          'studioScenes.saveFiles': async () => {
            throw new Error(
              "Error invoking remote method 'studioScenes:saveFiles': Error: Not saved: run.exe",
            );
          },
        },
      },
    );
    const editor = await screen.findByLabelText('Code');
    await user.type(editor, '!');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not saved: run.exe'));
  });
});

describe('StylesDialog', () => {
  it('plays the picked style in the video language and format, and uses it', async () => {
    const onPick = vi.fn();
    const { user, bridge } = renderWithProviders(
      <StylesDialog
        open
        onOpenChange={vi.fn()}
        value={null}
        aspect="9:16"
        language="fa"
        onPick={onPick}
      />,
      {
        bridge: {
          'studioScenes.styleReference': async (input: { styleId: string }) => ({
            styleId: input.styleId,
            treeHash: TREE,
            url: `studio-scene://t-${TREE}/index.html?c=${input.styleId}`,
          }),
        },
      },
    );
    const list = screen.getByRole('list', { name: 'Styles' });
    expect(within(list).getAllByRole('button')).toHaveLength(15);
    await user.click(within(list).getByRole('button', { name: /Bold captions/ }));
    await waitFor(() =>
      expect(bridge.$fn('studioScenes.styleReference')).toHaveBeenLastCalledWith({
        styleId: 'variety-captions',
        aspect: '9:16',
        language: 'fa',
      }),
    );
    expect(await screen.findByTitle('Bold captions example')).toHaveAttribute(
      'src',
      `studio-scene://t-${TREE}/index.html?c=variety-captions`,
    );
    expect(within(list).getAllByText('Made for 9:16').length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: 'Use Bold captions' }));
    expect(onPick).toHaveBeenCalledWith('variety-captions');
  });
});
