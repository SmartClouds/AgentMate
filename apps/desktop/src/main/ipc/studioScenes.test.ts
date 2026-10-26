import { join } from 'node:path';
import type {
  EditResponse,
  GenerationView,
  OpenVideoResult,
  SceneCheckView,
  SceneCodeView,
  VideoSummary,
} from '@runova/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { setElectronPath } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Studio's scene channels (E33) against the real service and desktop host, with the CLI scripted
 * and the offscreen window replaced by frames made up here: animate a scene, read its code, edit
 * it by hand, go back to an earlier version, check it, and get its thumbnail.
 */

const replies: string[] = [];
vi.mock('../cli/headlessStream', () => ({
  streamHeadlessCliPrompt: vi.fn(async () => {
    const text = replies.shift();
    return text
      ? { ok: true, text, log: '', cliName: 'Claude Code CLI' }
      : { ok: false, text: '', cliName: null, error: 'no reply scripted' };
  }),
}));

/** Frames that change with time, unless the scene is told to stay blank. */
const blank = { value: false };
vi.mock('../studio/capture/offscreenSource', () => ({
  createOffscreenSource: () => ({
    open: async () => undefined,
    waitReady: async () => true,
    frame: async (t: number) => {
      const bitmap = new Uint8Array(8 * 8 * 4).fill(20);
      if (!blank.value) bitmap.set([Math.round(t * 40) + 60, 0, 0, 255], 0);
      return { width: 8, height: 8, bitmap };
    },
    problems: () => [],
    close: async () => undefined,
  }),
}));

const userData = useTempUserData();
expectChannelsCovered(IPC.studioScenes);

const allowed = { value: true };

beforeEach(async () => {
  replies.length = 0;
  blank.value = false;
  allowed.value = true;
  setElectronPath('videos', join(userData.dir, 'Videos'));
  await loadIpc(
    () => import('./studio'),
    (m) => m.registerStudioHandlers({ guard: () => allowed.value }),
  );
});

afterEach(async () => {
  const { shutdownStudio } = await import('../studio');
  await shutdownStudio();
});

const run = { cliId: 'claude-code', model: null, effort: null };
const SCENE_FILES =
  '```html file:index.html\n<p>سلام</p>\n```\n```js file:scene.js\nStudio.scene({ render() {} });\n```';

async function videoWithScene() {
  const video = await invoke<VideoSummary>(IPC.studio.create, {
    title: 'Untitled video',
    projectId: null,
    language: 'fa',
    aspect: '16:9',
  });
  const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  replies.push(
    JSON.stringify({
      logline: 'یک فیلم کوتاه.',
      scenes: [{ title: 'شروع', narration: 'سلام.', durationSeconds: 4 }],
    }),
  );
  const g = await invoke<GenerationView>(IPC.studioAi.startScenario, {
    videoId: video.id,
    brief: 'x',
    targetSeconds: 10,
    styleId: null,
    run,
  });
  await settled(video.id, g.id);
  const again = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (again.state !== 'open') throw new Error('not open');
  return { videoId: video.id, sceneId: again.session.document.scenario.scenes[0]?.id ?? '' };
}

async function settled(videoId: string, generationId: string) {
  await vi.waitFor(async () => {
    const [latest] = await invoke<GenerationView[]>(IPC.studioAi.generations, {
      videoId,
      limit: 1,
    });
    expect(latest?.id).toBe(generationId);
    expect(latest?.status).not.toBe('running');
  });
  const [latest] = await invoke<GenerationView[]>(IPC.studioAi.generations, { videoId, limit: 1 });
  return latest as GenerationView;
}

describe('scene code', () => {
  it('animates a scene, checks it in the offscreen window, and keeps a thumbnail', async () => {
    const { videoId, sceneId } = await videoWithScene();
    replies.push(SCENE_FILES);
    const g = await invoke<GenerationView>(IPC.studioScenes.animate, { videoId, sceneId, run });
    expect((await settled(videoId, g.id)).status).toBe('done');

    const code = await invoke<SceneCodeView>(IPC.studioScenes.code, { videoId, sceneId });
    expect(code.files.map((f) => f.path)).toEqual(['index.html', 'scene.js']);
    expect(code.revisions[0]?.author).toBe('ai');
    const thumb = await invoke<string | null>(IPC.studioScenes.thumbnail, {
      videoId,
      treeHash: code.treeHash,
    });
    expect(thumb).toBe('data:image/png;base64,iVBORw==');
  });

  it('saves hand edits, checks them, and goes back to the AI version', async () => {
    const { videoId, sceneId } = await videoWithScene();
    replies.push(SCENE_FILES);
    const g = await invoke<GenerationView>(IPC.studioScenes.animate, { videoId, sceneId, run });
    await settled(videoId, g.id);
    const first = await invoke<SceneCodeView>(IPC.studioScenes.code, { videoId, sceneId });

    const saved = await invoke<EditResponse>(IPC.studioScenes.saveFiles, {
      videoId,
      sceneId,
      files: [{ path: 'index.html', content: '<p>خداحافظ</p>' }],
    });
    expect(saved.status.undoLabel).toBe('Edited the code of scene 1');
    blank.value = true;
    const check = await invoke<SceneCheckView>(IPC.studioScenes.check, { videoId, sceneId });
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/blank/);

    const back = await invoke<EditResponse>(IPC.studioScenes.useRevision, {
      videoId,
      sceneId,
      revisionId: first.revisions[0]?.id,
    });
    expect(back.document.scenario.scenes[0]?.code.treeHash).toBe(first.treeHash);
  });

  it('previews and checks a style reference scene', async () => {
    const reference = await invoke<{ url: string; treeHash: string }>(
      IPC.studioScenes.styleReference,
      {
        styleId: 'liquid',
        aspect: '16:9',
        language: 'fa',
      },
    );
    expect(reference.url).toMatch(/^studio-scene:\/\/t-/);
    const check = await invoke<SceneCheckView>(IPC.studioScenes.checkStyle, {
      styleId: 'liquid',
      aspect: '16:9',
      language: 'fa',
    });
    expect(check.ok).toBe(true);
    await expect(
      invoke(IPC.studioScenes.checkStyle, { styleId: 'nope', aspect: '16:9', language: 'fa' }),
    ).rejects.toThrow(/styleId/);
  });

  it('refuses a malformed request before the service sees it', async () => {
    await expect(
      invoke(IPC.studioScenes.thumbnail, { videoId: 'v1', treeHash: '../studio.db' }),
    ).rejects.toThrow(/treeHash/);
    await expect(
      invoke(IPC.studioScenes.saveFiles, { videoId: 'v1', sceneId: 's1', files: [] }),
    ).rejects.toThrow(/files/);
  });
});

it('answers only the main window', async () => {
  allowed.value = false;
  await expect(
    invokeFrom(fakeWebContents(), IPC.studioScenes.code, { videoId: 'v', sceneId: 's' }),
  ).rejects.toThrow(/main window/);
});
