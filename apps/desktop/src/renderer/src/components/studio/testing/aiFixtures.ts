import type { GenerationDetail, GenerationView, StoredProposal } from '@agentmat/studio';
import { NOW } from './fixtures';

/** Builders for Studio's AI runs in renderer tests. */

export function generation(overrides: Partial<GenerationView> = {}): GenerationView {
  return {
    id: 'g1aaaaaaaaaaaaaa',
    parentId: null,
    stage: 'scenario',
    status: 'running',
    cliId: 'claude-code',
    cliName: 'Claude Code',
    model: 'opus',
    effort: 'high',
    instruction: 'یک ویدیو درباره‌ی صرفه‌جویی آب',
    params: { targetSeconds: 60, styleId: 'flat-vector' },
    attempts: [
      {
        requestHash: 'a'.repeat(64),
        outputHash: null,
        logHash: null,
        startedAt: NOW - 30_000,
        finishedAt: null,
        issues: [],
        error: null,
      },
    ],
    proposal: null,
    resultSeq: null,
    error: null,
    startedAt: NOW - 30_000,
    finishedAt: null,
    ...overrides,
  };
}

export function proposal(overrides: Partial<StoredProposal> = {}): StoredProposal {
  return {
    summary: 'Shortened the opening and added a hook.',
    ops: [{ op: 'scenario.set', patch: { tone: 'warm' } }],
    changes: [
      { kind: 'title', before: 'Water', after: 'Every drop' },
      {
        kind: 'scenario',
        changes: [{ field: 'tone', label: 'Tone', before: '', after: 'warm' }],
      },
      {
        kind: 'scene-added',
        sceneId: 'n1',
        position: 1,
        title: 'Hook',
        narration: 'Did you know?',
      },
      { kind: 'scene-removed', sceneId: 's3', position: 3, title: 'Outro' },
      { kind: 'scene-moved', sceneId: 's2', title: 'Middle', from: 2, to: 3 },
      {
        kind: 'scene-changed',
        sceneId: 's1',
        position: 2,
        title: 'Open',
        changes: [{ field: 'durationSeconds', label: 'Length', before: '5 s', after: '3 s' }],
      },
    ],
    baseSeq: 4,
    ...overrides,
  };
}

export function detail(overrides: Partial<GenerationDetail> = {}): GenerationDetail {
  const base = generation({
    status: 'done',
    finishedAt: NOW,
    resultSeq: 5,
    attempts: [
      {
        requestHash: 'a'.repeat(64),
        outputHash: 'b'.repeat(64),
        logHash: 'c'.repeat(64),
        startedAt: NOW - 30_000,
        finishedAt: NOW - 20_000,
        issues: ['scenes[0].title: Too small'],
        error: null,
      },
      {
        requestHash: 'd'.repeat(64),
        outputHash: 'e'.repeat(64),
        logHash: null,
        startedAt: NOW - 20_000,
        finishedAt: NOW,
        issues: [],
        error: null,
      },
    ],
  });
  return {
    ...base,
    texts: [
      { request: '# Write a video scenario', output: '{"bad": true}', log: 'Reading request.md' },
      { request: '# Fix your previous answer', output: '{"logline": "ok"}', log: null },
    ],
    ...overrides,
  };
}
