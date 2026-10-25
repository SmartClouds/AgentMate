import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../api.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { createStudioService, type StudioHost, type StudioService } from '../service.js';
import type { AiRunRequest, AiRunResult } from './studioAi.js';

const tempDir = useTempDirs();
const services: StudioService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

type Reply = (
  req: AiRunRequest,
  signal: AbortSignal,
  onLine: (l: string) => void,
) => Promise<AiRunResult> | AiRunResult;

const SCENARIO = {
  title: 'آب، زندگی',
  logline: 'یک ویدیوی کوتاه درباره‌ی صرفه‌جویی در آب.',
  scenes: [
    { title: 'شروع', narration: 'هر قطره مهم است.', durationSeconds: 5 },
    { title: 'پایان', narration: 'از امروز شروع کنیم.', durationSeconds: 4, transition: 'fade' },
  ],
};

const answer = (text: string, over: Partial<AiRunResult> = {}): AiRunResult => ({
  ok: true,
  text,
  log: 'thinking...',
  cliName: 'Claude Code',
  ...over,
});

/** Waits until a run ends without being cancelled, for a reply that should block. */
const hang: Reply = (_req, signal) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () =>
      resolve({ ok: false, text: '', log: '', cliName: 'Claude Code', cancelled: true }),
    );
  });

async function setup(replies: Reply[], over: Partial<StudioHost> = {}) {
  const root = await tempDir();
  const events: StudioEvent[] = [];
  const requests: AiRunRequest[] = [];
  let clock = 1_700_000_000_000;
  const host: StudioHost = {
    dataDir: join(root, 'userData', 'studio'),
    defaultLibraryRoot: join(root, 'Videos', 'AgentMate Studio'),
    defaultCacheDir: join(root, 'cache'),
    appDir: join(root, 'app'),
    appId: 'AgentMate',
    openDb: openNodeSqlite,
    projects: { get: () => null },
    notify: (event) => events.push(event),
    now: () => clock++,
    pid: process.pid,
    hostname: 'laptop',
    ai: {
      run: async (req, signal, onLine) => {
        requests.push(req);
        const reply = replies.shift();
        if (!reply) throw new Error('no scripted reply left');
        return reply(req, signal, onLine);
      },
    },
    ...over,
  };
  const service = createStudioService(host);
  services.push(service);
  const video = await service.create({
    title: 'Untitled video',
    projectId: null,
    language: 'fa',
    aspect: '16:9',
  });
  const opened = await service.open({ videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  return { service, video, events, requests, host, root };
}

const run = { cliId: 'claude-code', model: 'opus', effort: 'high' as const };

async function settle(service: StudioService, videoId: string, generationId: string) {
  await vi.waitFor(async () => {
    const g = (await service.generations({ videoId, limit: 10 })).find(
      (x) => x.id === generationId,
    );
    expect(g?.status).not.toBe('running');
  });
  return (await service.generations({ videoId, limit: 10 })).find((x) => x.id === generationId)!;
}

describe('writing a scenario with AI', () => {
  it('writes the scenario into the video as one AI entry that one undo takes back', async () => {
    const { service, video, events, requests } = await setup([
      (_req, _signal, onLine) => {
        onLine('Reading request.md');
        return answer(`\`\`\`json\n${JSON.stringify(SCENARIO)}\n\`\`\``);
      },
    ]);
    const started = await service.startScenario({
      videoId: video.id,
      brief: 'ویدیو درباره‌ی صرفه‌جویی آب',
      targetSeconds: 10,
      styleId: 'flat-vector',
      run,
    });
    expect(started.status).toBe('running');
    const done = await settle(service, video.id, started.id);

    expect(done).toMatchObject({
      stage: 'scenario',
      status: 'done',
      cliId: 'claude-code',
      cliName: 'Claude Code',
      model: 'opus',
      effort: 'high',
      instruction: 'ویدیو درباره‌ی صرفه‌جویی آب',
      params: { targetSeconds: 10, styleId: 'flat-vector' },
      error: null,
    });
    expect(done.attempts).toHaveLength(1);
    expect(requests[0]).toMatchObject({ cliId: 'claude-code', model: 'opus', effort: 'high' });
    expect(requests[0]?.prompt).toContain('ویدیو درباره‌ی صرفه‌جویی آب');
    expect(requests[0]?.pointerPrompt).toContain('request.md');
    // Scenario runs get ten minutes, half again for high effort.
    expect(requests[0]?.timeoutMs).toBe(15 * 60_000);

    const session = await service.open({ videoId: video.id });
    if (session.state !== 'open') throw new Error('closed');
    const doc = session.session.document;
    expect(doc.title).toBe('آب، زندگی');
    expect(doc.styleId).toBe('flat-vector');
    expect(doc.scenario.scenes.map((s) => s.title)).toEqual(['شروع', 'پایان']);
    expect(done.resultSeq).toBe(session.session.status.seq);

    const [entry] = await service.history({ videoId: video.id, limit: 1 });
    expect(entry).toMatchObject({
      actor: 'ai',
      generationId: started.id,
      label: 'AI wrote the scenario',
    });

    const undone = await service.undo({ videoId: video.id });
    expect(undone?.document.scenario.scenes).toEqual([]);
    expect(undone?.document.title).toBe('Untitled video');

    expect(events).toContainEqual({
      type: 'generation-output',
      videoId: video.id,
      generationId: started.id,
      lines: ['Reading request.md'],
    });
    expect(events).toContainEqual({
      type: 'generation-changed',
      videoId: video.id,
      generationId: started.id,
    });
  });

  it('keeps a title the user typed', async () => {
    const { service, video } = await setup([() => answer(JSON.stringify(SCENARIO))]);
    await service.apply({
      videoId: video.id,
      baseSeq: 1,
      ops: [{ op: 'doc.set', field: 'title', value: 'My film' }],
      label: 'Renamed',
    });
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await settle(service, video.id, g.id);
    const opened = await service.open({ videoId: video.id });
    if (opened.state !== 'open') throw new Error('closed');
    expect(opened.session.document.title).toBe('My film');
  });

  it('repairs a broken answer by sending the problems back', async () => {
    const { service, video, requests } = await setup([
      () => answer('{"logline": "x", "scenes": [{"title": "a"'),
      () => answer(JSON.stringify(SCENARIO)),
    ]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    const done = await settle(service, video.id, g.id);
    expect(done.status).toBe('done');
    expect(done.attempts).toHaveLength(2);
    expect(done.attempts[0]?.issues[0]).toMatch(/not valid JSON/);
    expect(requests[1]?.prompt).toContain('# Fix your previous answer');
    expect(requests[1]?.prompt).toContain('{"logline": "x", "scenes": [{"title": "a"');

    const detail = await service.generationDetail({ videoId: video.id, generationId: g.id });
    expect(detail.texts).toHaveLength(2);
    expect(detail.texts[1]?.request).toContain('# Fix your previous answer');
    expect(detail.texts[0]?.output).toContain('"logline"');
    expect(detail.texts[0]?.log).toBe('thinking...');
  });

  it('gives up after two repair rounds, keeps the work folder and leaves the video alone', async () => {
    const english = JSON.stringify({
      logline: 'x',
      scenes: [{ title: 'a', narration: 'English', durationSeconds: 3 }],
    });
    const { service, video, root } = await setup([
      () => answer(english),
      () => answer(english),
      () => answer(english),
    ]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    const done = await settle(service, video.id, g.id);
    expect(done.status).toBe('failed');
    expect(done.attempts).toHaveLength(3);
    expect(done.error).toMatch(/still did not fit after 2 repair rounds.*Persian/);
    const opened = await service.open({ videoId: video.id });
    if (opened.state !== 'open') throw new Error('closed');
    expect(opened.session.document.scenario.scenes).toEqual([]);
    const work = join(video.folder, 'work', g.id, 'request.md');
    await expect(access(work)).resolves.toBeUndefined();
    expect(root).toBeTruthy();
  });

  it('reports a CLI failure with its log and does not try to repair it', async () => {
    const { service, video, requests } = await setup([
      () => ({
        ok: false,
        text: '',
        log: 'Error: not logged in',
        cliName: 'Claude Code',
        error: 'Claude Code failed: not logged in',
      }),
    ]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    const done = await settle(service, video.id, g.id);
    expect(done).toMatchObject({ status: 'failed', error: 'Claude Code failed: not logged in' });
    expect(requests).toHaveLength(1);
    const detail = await service.generationDetail({ videoId: video.id, generationId: g.id });
    expect(detail.texts[0]?.log).toBe('Error: not logged in');
  });

  it('removes the work folder after a good answer', async () => {
    const { service, video } = await setup([() => answer(JSON.stringify(SCENARIO))]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await settle(service, video.id, g.id);
    expect(await readdir(join(video.folder, 'work'))).toEqual([]);
  });

  it('cancels a run and leaves the video alone', async () => {
    const { service, video } = await setup([hang]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await service.cancelGeneration({ videoId: video.id, generationId: g.id });
    const done = await settle(service, video.id, g.id);
    expect(done.status).toBe('cancelled');
  });

  it('runs one AI job per video at a time', async () => {
    const { service, video } = await setup([hang]);
    await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await expect(
      service.startScenario({
        videoId: video.id,
        brief: 'y',
        targetSeconds: 10,
        styleId: null,
        run,
      }),
    ).rejects.toThrow(/already working on this video/);
  });

  it('keeps the video open until its run finishes when the editor closes it', async () => {
    let finish: (r: AiRunResult) => void = () => undefined;
    const { service, video, requests } = await setup([
      () =>
        new Promise<AiRunResult>((resolve) => {
          finish = resolve;
        }),
    ]);
    await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await service.close({ videoId: video.id });
    // Still open: the run goes on and can be watched.
    expect((await service.generations({ videoId: video.id, limit: 1 }))[0]?.status).toBe('running');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    finish(answer(JSON.stringify(SCENARIO)));
    await vi.waitFor(async () => {
      await expect(service.generations({ videoId: video.id, limit: 1 })).rejects.toThrow(
        /not open/,
      );
    });
  });

  it('cancels the pending close when the video is opened again', async () => {
    let finish: (r: AiRunResult) => void = () => undefined;
    const { service, video, requests } = await setup([
      () =>
        new Promise<AiRunResult>((resolve) => {
          finish = resolve;
        }),
    ]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await service.close({ videoId: video.id });
    expect((await service.open({ videoId: video.id })).state).toBe('open');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    finish(answer(JSON.stringify(SCENARIO)));
    expect((await settle(service, video.id, g.id)).status).toBe('done');
    expect((await service.generations({ videoId: video.id, limit: 1 }))[0]?.status).toBe('done');
  });

  it('marks a run interrupted when Studio shuts down, and retries it as a new generation', async () => {
    const { service, video, requests, host } = await setup([
      hang,
      () => answer(JSON.stringify(SCENARIO)),
    ]);
    const g = await service.startScenario({
      videoId: video.id,
      brief: 'the brief',
      targetSeconds: 20,
      styleId: null,
      run,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await service.shutdown();
    const next = createStudioService(host);
    services.push(next);
    await next.open({ videoId: video.id });
    const [first] = await next.generations({ videoId: video.id, limit: 10 });
    expect(first).toMatchObject({ id: g.id, status: 'interrupted' });

    const again = await next.retryGeneration({ videoId: video.id, generationId: g.id });
    expect(again).toMatchObject({
      parentId: g.id,
      instruction: 'the brief',
      params: { targetSeconds: 20 },
    });
    expect((await settle(next, video.id, again.id)).status).toBe('done');
    expect(requests[1]).toMatchObject({ cliId: 'claude-code', model: 'opus', effort: 'high' });
  });

  it('marks a run cut off by a crash as interrupted when the video opens again', async () => {
    const { service, video, host } = await setup([hang]);
    await service.startScenario({
      videoId: video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    service.abandonForTest(video.id);
    const next = createStudioService(host);
    services.push(next);
    const opened = await next.open({ videoId: video.id });
    expect(opened.state).toBe('open');
    const [g] = await next.generations({ videoId: video.id, limit: 1 });
    expect(g?.status).toBe('interrupted');
  });

  it('says so when this host cannot run AI', async () => {
    const { service, video } = await setup([], { ai: undefined });
    await expect(
      service.startScenario({
        videoId: video.id,
        brief: 'x',
        targetSeconds: 10,
        styleId: null,
        run,
      }),
    ).rejects.toThrow(/cannot run AI/);
  });
});

describe('editing by typing', () => {
  async function withScenario(replies: Reply[]) {
    const s = await setup([() => answer(JSON.stringify(SCENARIO)), ...replies]);
    const g = await s.service.startScenario({
      videoId: s.video.id,
      brief: 'x',
      targetSeconds: 10,
      styleId: null,
      run,
    });
    await settle(s.service, s.video.id, g.id);
    const opened = await s.service.open({ videoId: s.video.id });
    if (opened.state !== 'open') throw new Error('closed');
    return { ...s, doc: opened.session.document, seq: opened.session.status.seq };
  }

  it('proposes a change, then applies it as one undo step', async () => {
    let sceneId = '';
    const s = await withScenario([
      () =>
        answer(
          JSON.stringify({
            summary: 'Shortened the first scene.',
            ops: [{ op: 'scene.update', sceneId, patch: { durationSeconds: 3 } }],
          }),
        ),
    ]);
    sceneId = s.doc.scenario.scenes[0]!.id;
    const g = await s.service.startEdit({
      videoId: s.video.id,
      instruction: 'صحنه‌ی اول را کوتاه کن',
      run,
    });
    const proposed = await settle(s.service, s.video.id, g.id);
    expect(proposed.status).toBe('proposed');
    expect(proposed.proposal).toMatchObject({
      summary: 'Shortened the first scene.',
      baseSeq: s.seq,
    });
    expect(proposed.proposal?.changes[0]).toMatchObject({ kind: 'scene-changed', position: 1 });
    expect(s.requests.at(-1)?.prompt).toContain(sceneId);
    // Edits get five minutes, half again for high effort.
    expect(s.requests.at(-1)?.timeoutMs).toBe(7.5 * 60_000);

    const applied = await s.service.applyProposal({ videoId: s.video.id, generationId: g.id });
    expect(applied.seq).toBe(s.seq + 1);
    const [entry] = await s.service.history({ videoId: s.video.id, limit: 1 });
    expect(entry).toMatchObject({
      actor: 'ai',
      label: 'AI: Shortened the first scene.',
      generationId: g.id,
    });
    const after = (await s.service.generations({ videoId: s.video.id, limit: 1 }))[0];
    expect(after).toMatchObject({ status: 'applied', resultSeq: applied.seq });

    const undone = await s.service.undo({ videoId: s.video.id });
    expect(undone?.document).toEqual(s.doc);
    await expect(
      s.service.applyProposal({ videoId: s.video.id, generationId: g.id }),
    ).rejects.toThrow(/no longer waiting/);
  });

  it('refuses a proposal that no longer fits the video', async () => {
    let sceneId = '';
    const s = await withScenario([
      () =>
        answer(
          JSON.stringify({
            summary: 'x',
            ops: [{ op: 'scene.update', sceneId, patch: { title: 'New' } }],
          }),
        ),
    ]);
    sceneId = s.doc.scenario.scenes[0]!.id;
    const g = await s.service.startEdit({ videoId: s.video.id, instruction: 'rename', run });
    await settle(s.service, s.video.id, g.id);
    await s.service.apply({
      videoId: s.video.id,
      baseSeq: s.seq,
      ops: [{ op: 'scene.remove', sceneId }],
      label: 'Removed',
    });
    await expect(
      s.service.applyProposal({ videoId: s.video.id, generationId: g.id }),
    ).rejects.toThrow(/changed since/);
  });

  it('discards a proposal', async () => {
    let sceneId = '';
    const s = await withScenario([
      () => answer(JSON.stringify({ summary: 'x', ops: [{ op: 'scene.remove', sceneId }] })),
    ]);
    sceneId = s.doc.scenario.scenes[0]!.id;
    const g = await s.service.startEdit({ videoId: s.video.id, instruction: 'drop it', run });
    await settle(s.service, s.video.id, g.id);
    await s.service.discardProposal({ videoId: s.video.id, generationId: g.id });
    expect((await s.service.generations({ videoId: s.video.id, limit: 1 }))[0]?.status).toBe(
      'discarded',
    );
    const opened = await s.service.open({ videoId: s.video.id });
    if (opened.state !== 'open') throw new Error('closed');
    expect(opened.session.document).toEqual(s.doc);
  });
});
