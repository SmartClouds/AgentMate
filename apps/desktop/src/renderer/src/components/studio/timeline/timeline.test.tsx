import {
  type Clip,
  createDocument,
  createScene,
  type EditOp,
  type MediaView,
  type StudioDocument,
  secondsToFlicks,
} from '@agentmat/studio';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { Inspector } from './Inspector';
import { MediaPanel } from './MediaPanel';
import { audibleTracks, fadeAt, ProgramPreview } from './ProgramPreview';
import { TIMELINE_MEDIA, Timeline, WaveBars } from './Timeline';
import { TimelineView } from './TimelineView';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

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

const s = secondsToFlicks;
const VIDEO_ID = 'v1aaaaaaaaaaaaaa';
const CLIP_HASH = 'c'.repeat(64);
const SONG_HASH = 'd'.repeat(64);
const STILL_HASH = 'e'.repeat(64);

function file(
  hash: string,
  kind: MediaView['kind'],
  name: string,
  seconds: number | null,
): MediaView {
  return {
    hash,
    name,
    kind,
    duration: seconds === null ? null : s(seconds),
    width: kind === 'audio' ? null : 1280,
    height: kind === 'audio' ? null : 720,
    fps: kind === 'video' ? 30 : null,
    hasAudio: kind !== 'image',
    bytes: 1000,
    importedAt: 1,
    ready: {
      proxy: true,
      poster: kind !== 'audio',
      sprite: kind === 'video',
      peaks: kind !== 'image',
    },
    preparing: false,
    problem: null,
  };
}

const MEDIA = [
  file(CLIP_HASH, 'video', 'beach.mp4', 8),
  file(SONG_HASH, 'audio', 'song.mp3', 30),
  file(STILL_HASH, 'image', 'logo.png', null),
];

function clip(
  id: string,
  trackId: string,
  source: Clip['source'],
  start: number,
  length: number,
): Clip {
  return {
    id,
    trackId,
    start: s(start),
    duration: s(length),
    source,
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function video(edit?: (doc: StudioDocument) => void): StudioDocument {
  const doc = createDocument({ id: VIDEO_ID, title: 'Launch', language: 'fa' });
  doc.scenario.scenes = [
    createScene({
      id: 's1',
      title: 'شروع',
      narration: 'سلام. این یک ویدیو است.',
      targetDuration: s(4),
      code: { treeHash: 'a'.repeat(64) },
    }),
    createScene({ id: 's2', title: 'پایان', targetDuration: s(3) }),
  ];
  doc.timeline.clips = [
    clip('v', 'track-video', { type: 'media', hash: CLIP_HASH, in: 0, out: s(2) }, 1, 2),
    clip('m', 'track-music', { type: 'media', hash: SONG_HASH, in: 0, out: s(5) }, 0, 5),
    clip('t', 'track-text', { type: 'text', text: 'سلام دنیا', lang: 'fa', dir: 'auto' }, 0.5, 1),
  ];
  edit?.(doc);
  return doc;
}

function renderTimeline(doc = video(), extra: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const apply = vi.fn(async (_ops: EditOp[], _label: string) => true);
  const onSelect = vi.fn();
  const onSeek = vi.fn();
  const onDropMedia = vi.fn();
  const view = renderWithProviders(
    <Timeline
      videoId={VIDEO_ID}
      document={doc}
      media={MEDIA}
      playhead={0}
      onSeek={onSeek}
      selected={null}
      onSelect={onSelect}
      apply={apply}
      onDropMedia={onDropMedia}
      {...extra}
    />,
    { bridge: {} },
  );
  return { ...view, apply, onSelect, onSeek, onDropMedia };
}

/** Holds a button and moves it sideways by `dx` pixels, as a mouse drag would. */
function drag(target: Element, dx: number, dy = 0) {
  fireEvent.pointerDown(target, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(target, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
}

describe('Timeline', () => {
  it('draws the scenes, the tracks and their clips', () => {
    renderTimeline();
    expect(screen.getByRole('button', { name: 'Scene 1: شروع' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'beach.mp4, 1.0 s to 3.0 s' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'song.mp3, 0.0 s to 5.0 s' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'سلام دنیا, 0.5 s to 1.5 s' })).toBeTruthy();
    expect(screen.getByLabelText('Music track')).toBeTruthy();
  });

  it('selects a clip or a scene on a click without a drag', () => {
    const { onSelect } = renderTimeline();
    drag(screen.getByRole('button', { name: 'beach.mp4, 1.0 s to 3.0 s' }), 0);
    expect(onSelect).toHaveBeenLastCalledWith('v');
    drag(screen.getByRole('button', { name: 'Scene 2: پایان' }), 1);
    expect(onSelect).toHaveBeenLastCalledWith('scene:s2');
  });

  it('moves a clip by dragging, snapping to the edge of a scene', async () => {
    const { apply } = renderTimeline();
    // Fitted to 800 px over 7 s plus room: about 105 px a second. A drag of about 3 s lands near
    // 4 s, the end of scene 1, and snaps there.
    drag(screen.getByRole('button', { name: 'beach.mp4, 1.0 s to 3.0 s' }), 315);
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0]).toEqual([
      [{ op: 'clip.update', clipId: 'v', patch: { start: s(4) } }],
      'Moved a clip',
    ]);
  });

  it('trims a clip by its edge and changes a scene length by its right edge', async () => {
    const { apply, container } = renderTimeline();
    const clipButton = screen.getByRole('button', { name: 'song.mp3, 0.0 s to 5.0 s' });
    const [, right] = clipButton.querySelectorAll('span[aria-hidden]');
    drag(right as Element, -105);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[1]).toBe('Trimmed a clip');
    const sceneEdge = within(screen.getByRole('button', { name: 'Scene 2: پایان' }))
      .getAllByText('', { selector: 'span[aria-hidden]' })
      .at(-1);
    drag(sceneEdge as Element, 105);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]?.[1]).toBe('Changed the length of scene 2');
    expect(container).toBeTruthy();
  });

  it('reorders scenes by dragging one past another', async () => {
    const { apply } = renderTimeline();
    drag(screen.getByRole('button', { name: 'Scene 1: شروع' }), 500);
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0]).toEqual([
      [{ op: 'scene.move', sceneId: 's1', index: 1 }],
      'Moved scene 1',
    ]);
  });

  it('says why a move cannot be done', async () => {
    const doc = video((d) => {
      d.timeline.clips.push(
        clip('w', 'track-video', { type: 'media', hash: CLIP_HASH, in: 0, out: s(2) }, 5, 2),
      );
    });
    const { apply } = renderTimeline(doc);
    drag(screen.getByRole('button', { name: 'beach.mp4, 5.0 s to 7.0 s' }), -380);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Another clip is already there on that track.'),
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('mutes and solos tracks, and seeks from the ruler', async () => {
    const { apply, onSeek } = renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: 'Mute Music' }));
    fireEvent.click(screen.getByRole('button', { name: 'Solo Voice' }));
    expect(apply.mock.calls).toEqual([
      [[{ op: 'track.update', trackId: 'track-music', patch: { muted: true } }], 'Muted Music'],
      [[{ op: 'track.update', trackId: 'track-voice', patch: { solo: true } }], 'Soloed Voice'],
    ]);
    fireEvent.pointerDown(screen.getByLabelText('Time ruler'), { clientX: 210, pointerId: 1 });
    expect(onSeek).toHaveBeenCalled();
  });

  it('takes a file dropped from the media list onto a track', () => {
    const { onDropMedia } = renderTimeline();
    const row = screen.getByLabelText('Music clips');
    const data = { types: [TIMELINE_MEDIA], getData: () => SONG_HASH };
    fireEvent.dragOver(row, { dataTransfer: data });
    fireEvent.drop(row, { dataTransfer: data, clientX: 210 });
    expect(onDropMedia).toHaveBeenCalledWith(SONG_HASH, 'track-music', expect.any(Number));
  });

  it('draws only the clips in view, however many there are', () => {
    const doc = video((d) => {
      d.scenario.scenes = [
        createScene({ id: 's1', targetDuration: s(600), code: { treeHash: 'a'.repeat(64) } }),
      ];
      d.timeline.clips = Array.from({ length: 500 }, (_, i) =>
        clip(
          `c${i}`,
          'track-text',
          { type: 'text', text: `line ${i}`, lang: 'fa', dir: 'auto' },
          i,
          1,
        ),
      );
    });
    renderTimeline(doc);
    const shown = screen.getAllByRole('button', { name: /^line \d+,/ });
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThan(150);
  });

  it('fetches a sound clip waveform once its peaks are made, and draws it', async () => {
    const fetchPeaks = vi.fn(
      async () => new Response(JSON.stringify({ perSecond: 10, peaks: Array(300).fill(100) })),
    );
    vi.stubGlobal('fetch', fetchPeaks);
    const { container } = renderTimeline();
    await waitFor(() => expect(container.querySelectorAll('rect').length).toBeGreaterThan(0));
    expect(fetchPeaks).toHaveBeenCalledWith(`studio-media://m/${VIDEO_ID}/${SONG_HASH}/peaks`);
    vi.unstubAllGlobals();
  });

  it('draws no waveform when the peaks cannot be read', async () => {
    const fetchPeaks = vi.fn(async () => new Response('gone', { status: 404 }));
    vi.stubGlobal('fetch', fetchPeaks);
    const { container } = renderTimeline();
    await waitFor(() => expect(fetchPeaks).toHaveBeenCalled());
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('draws a waveform from the loudest peaks of the part that plays', () => {
    const { container } = renderWithProviders(
      <WaveBars
        peaks={{ perSecond: 10, peaks: Array.from({ length: 50 }, (_, i) => i) }}
        from={s(1)}
        to={s(2)}
      />,
      { bridge: {} },
    );
    expect(container.querySelectorAll('rect')).toHaveLength(10);
  });
});

describe('ProgramPreview', () => {
  it('shows the scene at the playhead, with the caption and pictures over it', () => {
    const doc = video((d) => {
      d.timeline.clips.push(
        clip('i', 'track-image', { type: 'media', hash: STILL_HASH, in: 0, out: s(1) }, 0.5, 1),
      );
    });
    const { container } = renderWithProviders(
      <ProgramPreview
        videoId={VIDEO_ID}
        document={doc}
        media={MEDIA}
        playhead={s(0.75)}
        playing={false}
      />,
      { bridge: {} },
    );
    const frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute('src')).toMatch(/^studio-scene:\/\/t-a{64}\//);
    const caption = screen.getByText('سلام دنیا');
    expect(caption.getAttribute('dir')).toBe('rtl');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `studio-media://m/${VIDEO_ID}/${STILL_HASH}/proxy`,
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      `studio-media://m/${VIDEO_ID}/${SONG_HASH}/proxy`,
    );
  });

  it('says a scene is not animated yet, and hides muted tracks', () => {
    const doc = video((d) => {
      d.timeline.tracks.find((t) => t.id === 'track-video')!.muted = true;
    });
    renderWithProviders(
      <ProgramPreview
        videoId={VIDEO_ID}
        document={doc}
        media={MEDIA}
        playhead={s(5)}
        playing={false}
      />,
      {
        bridge: {},
      },
    );
    expect(screen.getByText('Scene 2 is not animated yet.')).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
  });

  it('fades clips in and out, and hears only soloed tracks when one is soloed', () => {
    const faded: Clip = {
      ...clip('x', 't', { type: 'text', text: 'x', lang: 'en', dir: 'auto' }, 0, 4),
      fadeIn: s(1),
      fadeOut: s(2),
    };
    expect(fadeAt(faded, s(0.5))).toBe(0.5);
    expect(fadeAt(faded, s(2))).toBe(1);
    expect(fadeAt(faded, s(3))).toBe(0.5);
    const tracks = video().timeline.tracks;
    expect(audibleTracks(tracks).has('track-music')).toBe(true);
    tracks.find((t) => t.id === 'track-voice')!.solo = true;
    expect([...audibleTracks(tracks)]).toEqual(['track-voice']);
  });
});

describe('MediaPanel', () => {
  it('imports through the dialog and reports what was skipped', async () => {
    const { user, bridge } = renderWithProviders(
      <MediaPanel videoId={VIDEO_ID} media={[]} loading={false} onAdd={vi.fn()} aspect="16:9" />,
      {
        bridge: {
          'studioMedia.pickAndImport': async () => ({
            imported: [MEDIA[0]],
            skipped: [
              { path: 'C:\\x\\notes.txt', reason: 'Studio does not take this kind of file.' },
            ],
          }),
        },
      },
    );
    expect(screen.getByText(/Import video, sound or pictures/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported beach.mp4.'));
    expect(toast.error).toHaveBeenCalledWith(
      'notes.txt was not imported: Studio does not take this kind of file.',
    );
    expect(bridge.$fn('studioMedia.pickAndImport')).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('imports files dropped onto it', async () => {
    const { bridge } = renderWithProviders(
      <MediaPanel videoId={VIDEO_ID} media={[]} loading={false} onAdd={vi.fn()} aspect="16:9" />,
      {
        bridge: {
          'shell.pathForFile': (f: File) => `C:\\drop\\${f.name}`,
          'studioMedia.importFiles': async () => ({ imported: [MEDIA[0], MEDIA[1]], skipped: [] }),
        },
      },
    );
    const files = [new File(['x'], 'a.mp4'), new File(['y'], 'b.mp3')];
    fireEvent.drop(screen.getByRole('region', { name: 'Media' }), {
      dataTransfer: { types: ['Files'], files },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 2 files.'));
    expect(bridge.$fn('studioMedia.importFiles')).toHaveBeenCalledWith(VIDEO_ID, [
      'C:\\drop\\a.mp4',
      'C:\\drop\\b.mp3',
    ]);
  });

  it('lists files with their kind and length, adds one at the playhead, and lets one be dragged', async () => {
    const onAdd = vi.fn();
    const preparing = {
      ...MEDIA[0]!,
      preparing: true,
      problem: 'The sprite preview could not be made.',
    };
    const { user } = renderWithProviders(
      <MediaPanel
        videoId={VIDEO_ID}
        media={[preparing, MEDIA[1]!]}
        loading={false}
        onAdd={onAdd}
        aspect="16:9"
      />,
      {
        bridge: {},
      },
    );
    expect(screen.getByText('Video, 0:08')).toBeTruthy();
    expect(screen.getByText('Sound, 0:30')).toBeTruthy();
    expect(screen.getByText('Preparing')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Preview problem' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add song.mp3 at the playhead' }));
    expect(onAdd).toHaveBeenCalledWith(MEDIA[1]);
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole('listitem', { name: 'beach.mp4' }), {
      dataTransfer: { setData },
    });
    expect(setData).toHaveBeenCalledWith(TIMELINE_MEDIA, CLIP_HASH);
  });

  it('shimmers while it loads', () => {
    renderWithProviders(
      <MediaPanel videoId={VIDEO_ID} media={undefined} loading onAdd={vi.fn()} aspect="16:9" />,
      { bridge: {} },
    );
    expect(screen.getByLabelText('Loading media').getAttribute('aria-busy')).toBe('true');
  });
});

describe('Inspector', () => {
  function renderInspector(selected: string | null, doc = video()) {
    const apply = vi.fn(async () => undefined);
    const props = { onSplit: vi.fn(), onDelete: vi.fn(), onCaptionScene: vi.fn() };
    const view = renderWithProviders(
      <Inspector document={doc} media={MEDIA} selected={selected} apply={apply} {...props} />,
      {
        bridge: {},
      },
    );
    return { ...view, apply, ...props };
  }

  it('changes a caption on leaving the field, and fades', async () => {
    const { user, apply } = renderInspector('t');
    const words = screen.getByLabelText('Words');
    await user.clear(words);
    await user.type(words, 'خداحافظ');
    fireEvent.blur(words);
    expect(apply).toHaveBeenLastCalledWith({
      ops: [
        {
          op: 'clip.update',
          clipId: 't',
          patch: { source: { type: 'text', text: 'خداحافظ', lang: 'fa', dir: 'auto' } },
        },
      ],
      label: 'Edited a caption',
    });
    const fade = screen.getByLabelText('Fade in (s)');
    await user.clear(fade);
    await user.type(fade, '0.25');
    fireEvent.blur(fade);
    expect(apply).toHaveBeenLastCalledWith({
      ops: [{ op: 'clip.update', clipId: 't', patch: { fadeIn: s(0.25) } }],
      label: 'Changed a fade',
    });
  });

  it('sets the volume of a sound when the slider is let go, and splits or deletes', async () => {
    const { user, apply, onSplit, onDelete } = renderInspector('m');
    const slider = screen.getByLabelText('Volume: 100%');
    fireEvent.change(slider, { target: { value: '50' } });
    fireEvent.pointerUp(slider);
    expect(apply).toHaveBeenLastCalledWith({
      ops: [{ op: 'clip.update', clipId: 'm', patch: { gain: 0.5 } }],
      label: 'Changed the volume',
    });
    await user.click(screen.getByRole('button', { name: 'Split at playhead' }));
    await user.click(screen.getByRole('button', { name: 'Delete and close the gap' }));
    expect(onSplit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith(true);
  });

  it('offers captions from a scene narration, and a hint with nothing selected', async () => {
    const { user, onCaptionScene, unmount } = renderInspector('scene:s1');
    await user.click(screen.getByRole('button', { name: 'Captions from its narration' }));
    expect(onCaptionScene).toHaveBeenCalledWith('s1');
    unmount();
    renderInspector(null);
    expect(screen.getByText(/Select a clip or a scene on the timeline/)).toBeTruthy();
  });
});

describe('TimelineView', () => {
  function renderView(doc = video()) {
    const apply = vi.fn(async (_ops: EditOp[], _label: string) => true);
    const view = renderWithProviders(
      <TimelineView videoId={VIDEO_ID} document={doc} apply={apply} />,
      {
        bridge: { 'studioMedia.list': async () => MEDIA },
      },
    );
    return { ...view, apply };
  }

  it('adds a caption at the playhead and captions the scene there', async () => {
    const { user, apply } = renderView(
      video((d) => {
        d.timeline.clips = [];
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Caption' }));
    expect(apply.mock.calls[0]?.[1]).toBe('Added a caption');
    expect(apply.mock.calls[0]?.[0][0]).toMatchObject({
      op: 'clip.add',
      clip: { trackId: 'track-text', start: 0, duration: s(5), source: { text: 'زیرنویس تازه' } },
    });
    // Near the end of the 7 s video, a caption runs to the end instead of past it.
    fireEvent.keyDown(window, { key: 'End' });
    for (let i = 0; i < 2; i++) fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    await user.click(screen.getByRole('button', { name: 'Caption' }));
    expect(apply.mock.calls[1]?.[0][0]).toMatchObject({ clip: { start: s(5), duration: s(2) } });
  });

  it('captions a scene from its narration in one step', async () => {
    const { user, apply } = renderView(
      video((d) => {
        d.timeline.clips = [];
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Caption scene 1' }));
    expect(apply).toHaveBeenCalledWith(
      [expect.objectContaining({ op: 'clip.add' }), expect.objectContaining({ op: 'clip.add' })],
      'Added captions to scene 1',
    );
  });

  it('splits and deletes the selected clip from the keyboard, and adds media at the playhead', async () => {
    const { user, apply } = renderView();
    await screen.findByRole('listitem', { name: 'beach.mp4' });
    drag(screen.getByRole('button', { name: 'song.mp3, 0.0 s to 5.0 s' }), 0);
    // Step forward a second, then split there.
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(apply.mock.calls.at(-1)?.[1]).toBe('Split a clip'));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(apply.mock.calls.at(-1)?.[1]).toBe('Deleted a clip'));
    await user.click(screen.getByRole('button', { name: 'Add logo.png at the playhead' }));
    await waitFor(() => expect(apply.mock.calls.at(-1)?.[1]).toBe('Added logo.png'));
    expect(screen.getByLabelText('Playhead').textContent).toMatch(/^00:00:01:00/);
  });

  it('plays and pauses with Space, and leaves keys typed into a field alone', async () => {
    renderView();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    const input = document.createElement('input');
    document.body.append(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    input.remove();
  });
});
