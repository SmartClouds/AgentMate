import type {
  EditOp,
  RenderEstimateView,
  RenderJobView,
  RenderToolsView,
  StudioDocument,
} from '@agentmat/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { StudioSetupCard } from '../home/StudioSetupCard';
import { NOW, withScenes } from '../testing/fixtures';
import { RenderDialog } from './RenderDialog';
import { RenderJobRow } from './RenderJobRow';
import { RenderStrip } from './RenderStrip';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

const NOT_INSTALLED =
  'ffmpeg is not installed. Install it from Agent Tools, Dev Setup (Studio), then try again.';

function tools(overrides: Partial<RenderToolsView> = {}): RenderToolsView {
  return {
    ffmpeg: { found: true, version: '9.0.2' },
    ffprobe: { found: true },
    codecs: { h264: null, h265: null, vp9: null },
    ...overrides,
  };
}

const ESTIMATE: RenderEstimateView = {
  ok: true,
  width: 1920,
  height: 1080,
  frames: 450,
  durationSeconds: 15,
  outputBytes: 9_400_000,
  cacheBytes: 900_000_000,
  seconds: 40,
  warnings: [],
  fileName: 'Launch-16x9-1080p',
  extension: 'mp4',
};

function job(overrides: Partial<RenderJobView> = {}): RenderJobView {
  const doc = withScenes('One');
  return {
    id: 'j1',
    videoId: 'v1',
    title: 'Launch',
    fileName: 'Launch-16x9-1080p.mp4',
    status: 'done',
    phase: null,
    done: 450,
    total: 450,
    settings: doc.renderSettings,
    width: 1920,
    height: 1080,
    frames: 450,
    durationSeconds: 15,
    output: 'C:\\Videos\\Launch\\renders\\Launch-16x9-1080p.mp4',
    error: null,
    createdAt: NOW - 120_000,
    startedAt: NOW - 120_000,
    endedAt: NOW - 60_000,
    resumed: false,
    reusedChunks: 0,
    capturedChunks: 8,
    hardware: null,
    ...overrides,
  };
}

function renderDialog(
  options: {
    tools?: RenderToolsView;
    estimate?: RenderEstimateView;
    jobs?: RenderJobView[];
    document?: StudioDocument;
    settings?: { hwEncode: boolean };
  } = {},
) {
  const apply = vi.fn(async () => true);
  const onOpenDevSetup = vi.fn();
  const doc = options.document ?? withScenes('One', 'Two');
  const view = renderWithProviders(
    <RenderDialog
      videoId="v1"
      document={doc}
      seq={3}
      open
      onOpenChange={vi.fn()}
      apply={apply}
      onOpenDevSetup={onOpenDevSetup}
    />,
    {
      bridge: {
        'studio.settings': async () => options.settings ?? { hwEncode: true },
        'studioRender.tools': async () => options.tools ?? tools(),
        'studioRender.estimate': async () => options.estimate ?? ESTIMATE,
        'studioRender.jobs': async () => options.jobs ?? [],
        'studioRender.start': async (input: { fileName?: string }) =>
          job({ status: 'queued', fileName: `${input.fileName ?? 'Launch-16x9-1080p'}.mp4` }),
      },
    },
  );
  return { ...view, apply, onOpenDevSetup, doc };
}

describe('RenderDialog', () => {
  it('says what the render makes and starts it with the file name typed', async () => {
    const { user, bridge } = renderDialog();
    expect(
      await screen.findByText(
        '15 s long, 1920x1080, 450 frames. About 9.0 MB, and about 40 s to render.',
      ),
    ).toBeTruthy();
    const name = screen.getByLabelText('File name');
    expect(name.getAttribute('placeholder')).toBe('Launch-16x9-1080p');
    expect(screen.getByText('.mp4')).toBeTruthy();
    await user.type(name, 'Teaser');
    await user.click(screen.getByRole('button', { name: 'Render' }));
    await waitFor(() =>
      expect(bridge.$fn('studioRender.start')).toHaveBeenCalledWith({
        videoId: 'v1',
        fileName: 'Teaser',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Queued Teaser.mp4.');
  });

  it('saves each choice to the video as an edit that can be undone', async () => {
    const { user, apply } = renderDialog();
    await screen.findByText(/450 frames/);
    await user.click(screen.getByRole('radio', { name: '4K' }));
    await user.click(screen.getByRole('radio', { name: '60 fps' }));
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await user.click(screen.getByRole('radio', { name: 'VP9' }));
    await user.click(screen.getByLabelText('Encode on the graphics card when it can'));
    expect(apply.mock.calls).toEqual([
      [[{ op: 'render.set', patch: { resolution: '2160p' } }], 'Changed the render size'],
      [[{ op: 'render.set', patch: { fps: 60 } }], 'Changed the frame rate'],
      [[{ op: 'render.set', patch: { quality: 'high' } }], 'Changed the render quality'],
      [[{ op: 'render.set', patch: { codec: 'vp9' } }], 'Changed the codec'],
      [[{ op: 'render.set', patch: { hwEncode: false } }], 'Turned off graphics card encoding'],
    ]);
  });

  it('shows graphics card encoding as off when Settings turns it off for every video', async () => {
    renderDialog({ settings: { hwEncode: false } });
    const gpu = await screen.findByRole('switch', {
      name: 'Encode on the graphics card when it can',
    });
    await screen.findByText('Turned off for every video in Settings');
    expect(gpu.getAttribute('aria-checked')).toBe('false');
    expect((gpu as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not pick a codec this ffmpeg lacks, and says why on the one already chosen', async () => {
    const reason = 'This ffmpeg has no libx265 encoder, so H265 is not available.';
    const doc = withScenes('One');
    doc.renderSettings.codec = 'h265';
    const { user, apply } = renderDialog({
      tools: tools({ codecs: { h264: null, h265: reason, vp9: null } }),
      document: doc,
    });
    expect(await screen.findByText(reason)).toBeTruthy();
    const h265 = screen.getByRole('radio', { name: 'H.265' });
    expect(h265.getAttribute('aria-disabled')).toBe('true');
    await user.click(h265);
    expect(apply).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Render' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('sends the user to Dev Setup when ffmpeg is missing, and will not render', async () => {
    const { user, onOpenDevSetup } = renderDialog({
      tools: tools({
        ffmpeg: { found: false, version: null },
        ffprobe: { found: false },
        codecs: { h264: NOT_INSTALLED, h265: NOT_INSTALLED, vp9: NOT_INSTALLED },
      }),
    });
    await screen.findByText(/Rendering needs ffmpeg/);
    await user.click(screen.getByRole('button', { name: 'Open Dev Setup' }));
    expect(onOpenDevSetup).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Render' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // The codecs are not marked one by one: the notice says it for all of them.
    expect(screen.getByRole('radio', { name: 'H.265' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('lists what keeps the video from rendering', async () => {
    renderDialog({
      estimate: {
        ok: false,
        problems: ['Scene 2 has no animation yet. Animate it, or remove it.'],
      },
    });
    expect(await screen.findByText('This video cannot render yet:')).toBeTruthy();
    expect(
      screen.getByText('Scene 2 has no animation yet. Animate it, or remove it.'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Render' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('passes on space warnings, and says 4K takes longer', async () => {
    const doc = withScenes('One');
    doc.renderSettings.resolution = '2160p';
    renderDialog({
      document: doc,
      estimate: { ...ESTIMATE, warnings: ['The cache folder may run out of space.'] },
    });
    expect(await screen.findByText('The cache folder may run out of space.')).toBeTruthy();
    expect(screen.getByText(/4K draws each frame at four times the pixels/)).toBeTruthy();
  });

  it('warns that scenes lay out again when the format changes', async () => {
    function Harness() {
      const [doc, setDoc] = useState(withScenes('One'));
      const apply = async (ops: EditOp[]) => {
        for (const op of ops) {
          if (op.op === 'render.set') {
            setDoc((d) => ({ ...d, renderSettings: { ...d.renderSettings, ...op.patch } }));
          }
        }
        return true;
      };
      return (
        <RenderDialog
          videoId="v1"
          document={doc}
          seq={3}
          open
          onOpenChange={vi.fn()}
          apply={apply}
          onOpenDevSetup={vi.fn()}
        />
      );
    }
    const { user } = renderWithProviders(<Harness />, {
      bridge: {
        'studioRender.tools': async () => tools(),
        'studioRender.estimate': async () => ESTIMATE,
        'studioRender.jobs': async () => [],
      },
    });
    await screen.findByText(/450 frames/);
    expect(screen.queryByText(/Scenes lay out again/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Vertical 9:16' }));
    expect(await screen.findByText(/Scenes lay out again at the new shape/)).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Landscape 16:9' }));
    await waitFor(() => expect(screen.queryByText(/Scenes lay out again/)).toBeNull());
  });

  it("shows the video's renders below", async () => {
    renderDialog({
      jobs: [job(), job({ id: 'j2', fileName: 'Older.mp4', status: 'failed', error: 'Boom.' })],
    });
    const list = await screen.findByRole('region', { name: 'Renders of this video' });
    expect(within(list).getByText('Launch-16x9-1080p.mp4')).toBeTruthy();
    expect(within(list).getByText('Boom.')).toBeTruthy();
  });
});

describe('RenderJobRow', () => {
  function row(value: RenderJobView) {
    return renderWithProviders(
      <ul>
        <RenderJobRow job={value} />
      </ul>,
      {
        bridge: {
          'studioRender.cancel': async () => undefined,
          'studioRender.retry': async () => value,
          'studioRender.remove': async () => undefined,
          'studioRender.reveal': async () => undefined,
          'studioRender.openFile': async () => {
            throw new Error(
              "Error invoking remote method 'studioRender:openFile': Error: No player",
            );
          },
        },
      },
    );
  }

  it('shows a running render with its progress, and cancels it', async () => {
    const { user, bridge } = row(
      job({ status: 'running', phase: 'capture', done: 90, total: 450, output: null }),
    );
    expect(screen.getByText('Rendering')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Drawing frames: 90 of 450' });
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
    expect(screen.queryByRole('button', { name: 'Remove from the list' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel the render' }));
    expect(bridge.$fn('studioRender.cancel')).toHaveBeenCalledWith('j1');
  });

  it('says a waiting render waits, and an encoding one encodes', () => {
    const waiting = row(job({ status: 'queued', done: 0, output: null }));
    expect(screen.getByText('Waiting for the render before it to finish')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    waiting.unmount();
    row(job({ status: 'running', phase: 'encode', done: 100, total: 420, output: null }));
    expect(screen.getByText('Encoding: 100 of 420 frames')).toBeTruthy();
  });

  it('plays, shows and removes a finished render, and says what it reused', async () => {
    const { user, bridge } = row(
      job({ reusedChunks: 5, capturedChunks: 3, hardware: 'h264_nvenc' }),
    );
    expect(screen.getByText(/Reused 5 of 8 parts from earlier renders/)).toBeTruthy();
    expect(screen.getByText(/Encoded on the graphics card/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show the file in its folder' }));
    expect(bridge.$fn('studioRender.reveal')).toHaveBeenCalledWith('j1');
    await user.click(screen.getByRole('button', { name: 'Play the video' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No player'));
    await user.click(screen.getByRole('button', { name: 'Remove from the list' }));
    expect(bridge.$fn('studioRender.remove')).toHaveBeenCalledWith('j1');
  });

  it('offers to resume a stopped render and to retry a failed one', async () => {
    const stopped = row(job({ status: 'interrupted', resumed: false, output: null }));
    expect(screen.getByText('Stopped')).toBeTruthy();
    await stopped.user.click(screen.getByRole('button', { name: 'Resume the render' }));
    expect(stopped.bridge.$fn('studioRender.retry')).toHaveBeenCalledWith('j1');
    stopped.unmount();
    row(
      job({ status: 'failed', error: 'Scene 2 could not be drawn.', resumed: true, output: null }),
    );
    expect(screen.getByText('Scene 2 could not be drawn.')).toBeTruthy();
    expect(screen.getByText('Resumed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the render again' })).toBeTruthy();
  });
});

describe('RenderStrip', () => {
  it("shows the video's render under way, with how many wait behind it", async () => {
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<RenderStrip videoId="v1" onOpen={onOpen} />, {
      bridge: {
        'studioRender.jobs': async () => [
          job({ id: 'j3', status: 'queued', fileName: 'Next.mp4', output: null }),
          job({
            id: 'j2',
            status: 'running',
            phase: 'capture',
            done: 10,
            total: 100,
            output: null,
          }),
          job({ id: 'j1', status: 'done' }),
        ],
      },
    });
    const strip = await screen.findByRole('region', { name: 'Render under way' });
    expect(within(strip).getByText('Launch-16x9-1080p.mp4')).toBeTruthy();
    expect(within(strip).getByText(', and 1 more waiting')).toBeTruthy();
    await user.click(within(strip).getByRole('button', { name: 'Renders' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('shows nothing when no render is waiting or under way', async () => {
    const { bridge } = renderWithProviders(<RenderStrip videoId="v1" onOpen={vi.fn()} />, {
      bridge: { 'studioRender.jobs': async () => [job()] },
    });
    await waitFor(() => expect(bridge.$fn('studioRender.jobs')).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Render under way' })).toBeNull();
  });
});

describe('StudioSetupCard', () => {
  it('points to Dev Setup when ffmpeg is missing', async () => {
    const onOpenDevSetup = vi.fn();
    const { user } = renderWithProviders(<StudioSetupCard onOpenDevSetup={onOpenDevSetup} />, {
      bridge: {
        'studioRender.tools': async () =>
          tools({ ffmpeg: { found: true, version: '9.0.2' }, ffprobe: { found: false } }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Open Dev Setup' }));
    expect(onOpenDevSetup).toHaveBeenCalled();
  });

  it('stays out of the way once ffmpeg is there', async () => {
    const { bridge } = renderWithProviders(<StudioSetupCard onOpenDevSetup={vi.fn()} />, {
      bridge: { 'studioRender.tools': async () => tools() },
    });
    await waitFor(() => expect(bridge.$fn('studioRender.tools')).toHaveBeenCalled());
    expect(screen.queryByText(/Studio renders videos with ffmpeg/)).toBeNull();
  });
});
