import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EditResponse,
  GenerationDetail,
  GenerationView,
  OpenVideoResult,
  RecipeView,
  VideoSummary,
} from '@runova/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog, setElectronPath } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Studio's AI channels (E32) against the real service and the real desktop host, with only the
 * CLI itself scripted: what reaches the CLI, what comes back into the video, and what is refused.
 */

const replies: { text: string }[] = [];
const runs: { prompt: string; options: Record<string, unknown> }[] = [];

vi.mock('../cli/headlessStream', () => ({
  streamHeadlessCliPrompt: vi.fn(
    async (prompt: string, _cwd: string, options: Record<string, unknown>) => {
      runs.push({ prompt, options });
      const reply = replies.shift();
      return reply
        ? { ok: true, text: reply.text, log: 'log', cliName: 'Claude Code' }
        : { ok: false, text: '', cliName: 'Claude Code', error: 'no reply scripted' };
    },
  ),
}));

const userData = useTempUserData();
expectChannelsCovered(IPC.studioAi);

const allowed = { value: true };

beforeEach(async () => {
  replies.length = 0;
  runs.length = 0;
  setElectronPath('videos', join(userData.dir, 'Videos'));
  allowed.value = true;
  await loadIpc(
    () => import('./studio'),
    (m) => m.registerStudioHandlers({ guard: () => allowed.value }),
  );
});

afterEach(async () => {
  const { shutdownStudio } = await import('../studio');
  await shutdownStudio();
});

const SCENARIO = {
  logline: 'A short film about water.',
  scenes: [
    { title: 'Open', narration: 'Every drop counts.', durationSeconds: 5 },
    { title: 'Close', narration: 'Start today.', durationSeconds: 4 },
  ],
};

const run = { cliId: 'claude-code', model: 'opus', effort: 'high' };

async function openVideo() {
  const video = await invoke<VideoSummary>(IPC.studio.create, {
    title: 'Untitled video',
    projectId: null,
    language: 'en',
    aspect: '16:9',
  });
  const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  return video;
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

describe('scenario and edit runs', () => {
  it('writes a scenario through the picked CLI, then edits it from a typed request', async () => {
    const video = await openVideo();
    replies.push({ text: JSON.stringify(SCENARIO) });
    const started = await invoke<GenerationView>(IPC.studioAi.startScenario, {
      videoId: video.id,
      brief: 'A film about saving water',
      targetSeconds: 10,
      styleId: 'line-art',
      run,
    });
    expect((await settled(video.id, started.id)).status).toBe('done');
    expect(runs[0]?.prompt).toContain('A film about saving water');
    expect(runs[0]?.options).toMatchObject({ preferredCliId: 'claude-code', strictCli: true });
    expect(runs[0]?.options.pointerPrompt).toContain('request.md');

    const detail = await invoke<GenerationDetail>(IPC.studioAi.generationDetail, {
      videoId: video.id,
      generationId: started.id,
    });
    expect(detail.texts[0]?.output).toContain('Every drop counts.');

    const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
    if (opened.state !== 'open') throw new Error('not open');
    const firstScene = opened.session.document.scenario.scenes[0]?.id;
    replies.push({
      text: JSON.stringify({
        summary: 'Retitled the opening.',
        ops: [{ op: 'scene.update', sceneId: firstScene, patch: { title: 'Hook' } }],
      }),
    });
    const edit = await invoke<GenerationView>(IPC.studioAi.startEdit, {
      videoId: video.id,
      instruction: 'Call the first scene Hook',
      run,
    });
    expect((await settled(video.id, edit.id)).status).toBe('proposed');
    const applied = await invoke<EditResponse>(IPC.studioAi.applyProposal, {
      videoId: video.id,
      generationId: edit.id,
    });
    expect(applied.document.scenario.scenes[0]?.title).toBe('Hook');
    expect(applied.status.canUndo).toBe(true);
  });

  it('discards a proposal, cancels nothing that is not running, and retries a failed run', async () => {
    const video = await openVideo();
    const failed = await invoke<GenerationView>(IPC.studioAi.startScenario, {
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    expect((await settled(video.id, failed.id)).error).toBe('no reply scripted');
    await invoke(IPC.studioAi.cancel, { videoId: video.id, generationId: failed.id });

    replies.push({ text: JSON.stringify(SCENARIO) });
    const again = await invoke<GenerationView>(IPC.studioAi.retry, {
      videoId: video.id,
      generationId: failed.id,
    });
    expect(again.parentId).toBe(failed.id);
    expect((await settled(video.id, again.id)).status).toBe('done');

    replies.push({
      text: JSON.stringify({
        summary: 'x',
        ops: [{ op: 'scenario.set', patch: { tone: 'warm' } }],
      }),
    });
    const edit = await invoke<GenerationView>(IPC.studioAi.startEdit, {
      videoId: video.id,
      instruction: 'warmer',
      run,
    });
    await settled(video.id, edit.id);
    await invoke(IPC.studioAi.discardProposal, { videoId: video.id, generationId: edit.id });
    expect((await settled(video.id, edit.id)).status).toBe('discarded');
  });

  it('refuses a style it does not offer and an empty brief before the service sees them', async () => {
    const video = await openVideo();
    await expect(
      invoke(IPC.studioAi.startScenario, {
        videoId: video.id,
        brief: 'x',
        targetSeconds: 10,
        styleId: 'nope',
        run,
      }),
    ).rejects.toThrow(/styleId/);
    await expect(
      invoke(IPC.studioAi.startScenario, {
        videoId: video.id,
        brief: '  ',
        targetSeconds: 10,
        styleId: null,
        run,
      }),
    ).rejects.toThrow(/brief/);
    await expect(
      invoke(IPC.studioAi.startEdit, {
        videoId: video.id,
        instruction: 'x',
        run: { ...run, effort: 'huge' },
      }),
    ).rejects.toThrow(/effort/);
  });
});

describe('recipes', () => {
  it('saves, lists and deletes a recipe', async () => {
    const saved = await invoke<RecipeView>(IPC.studioAi.saveRecipe, {
      name: 'Explainer',
      brief: 'Explain {topic} in 45 seconds',
      styleId: 'flat-vector',
      language: 'fa',
      aspect: '9:16',
      targetSeconds: 45,
      scenario: run,
    });
    expect(await invoke<RecipeView[]>(IPC.studioAi.recipes)).toEqual([saved]);
    await invoke(IPC.studioAi.deleteRecipe, { recipeId: saved.id });
    expect(await invoke<RecipeView[]>(IPC.studioAi.recipes)).toEqual([]);
  });

  it('refuses a recipe in a language Studio does not offer', async () => {
    await expect(
      invoke(IPC.studioAi.saveRecipe, {
        name: 'x',
        brief: 'y',
        styleId: null,
        language: 'zh',
        aspect: '16:9',
        targetSeconds: 30,
        scenario: run,
      }),
    ).rejects.toThrow(/language/);
  });
});

it('answers only the main window', async () => {
  allowed.value = false;
  await expect(invokeFrom(fakeWebContents(), IPC.studioAi.recipes)).rejects.toThrow(/main window/);
});

describe('recipe versions and files (E39)', () => {
  it('keeps each save as a version, exports it to a file and imports it back', async () => {
    const recipe = {
      name: 'Explainer',
      brief: 'Explain {topic}',
      styleId: null,
      language: 'en',
      aspect: '16:9',
      targetSeconds: 45,
      scenario: run,
    };
    const first = await invoke<RecipeView>(IPC.studioAi.saveRecipe, recipe);
    const second = await invoke<RecipeView>(IPC.studioAi.saveRecipe, {
      ...recipe,
      id: first.id,
      targetSeconds: 60,
      voiceRef: 'openai:marin',
      render: { resolution: '720p', fps: 24, quality: 'draft', codec: 'h264' },
    });
    expect(second).toMatchObject({ version: 2, versions: 2, voiceRef: 'openai:marin' });
    const versions = await invoke<RecipeView[]>(IPC.studioAi.recipeVersions, {
      recipeId: first.id,
    });
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(
      await invoke(IPC.studioAi.recipeVersion, { recipeId: first.id, version: 1 }),
    ).toMatchObject({ targetSeconds: 45 });

    const file = join(userData.dir, 'Explainer.amrecipe.json');
    queueDialog('showSaveDialog', { canceled: true });
    expect(await invoke(IPC.studioAi.exportRecipe, { recipeId: first.id })).toBeNull();
    queueDialog('showSaveDialog', { canceled: false, filePath: file });
    expect(await invoke(IPC.studioAi.exportRecipe, { recipeId: first.id })).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      format: 'runova-studio-recipe',
    });

    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke(IPC.studioAi.importRecipe)).toBeNull();
    queueDialog('showOpenDialog', { canceled: false, filePaths: [file] });
    const imported = await invoke<RecipeView>(IPC.studioAi.importRecipe);
    expect(imported).toMatchObject({ name: 'Explainer', versions: 2 });
    expect(imported.id).not.toBe(first.id);
    writeFileSync(file, 'not a recipe');
    queueDialog('showOpenDialog', { canceled: false, filePaths: [file] });
    await expect(invoke(IPC.studioAi.importRecipe)).rejects.toThrow(
      'That is not a Studio recipe file, or it is damaged.',
    );
  });
});
