import type { RunAssessment } from '@runova/core';
import { DEFAULT_TARGET_AI } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  beginPromptTask,
  cancelPromptTask,
  cancelRunAssessment,
  EMPTY_RUN_JOB,
  finishPromptTask,
  isCurrentPromptTask,
  projectPromptJobKey,
  startRunAssessment,
  usePromptJobsStore,
} from './promptJobsStore';

function state() {
  return usePromptJobsStore.getState();
}

function run(key: string) {
  return state().runs[key] ?? EMPTY_RUN_JOB;
}

const assessment: RunAssessment = {
  score: 70,
  complexity: 'complex',
  signals: [],
  summary: 'Touches several packages.',
  modelId: 'opus',
  effort: 'high',
};

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installRunovaBridge();
  usePromptJobsStore.setState({ tasks: {}, runs: {}, visible: {} });
});

describe('projectPromptJobKey', () => {
  it('names the form that owns a job', () => {
    expect(projectPromptJobKey('p1')).toBe('project:p1');
  });
});

describe('the initial state', () => {
  it('has no jobs at all', () => {
    expect(state()).toMatchObject({ tasks: {}, runs: {}, visible: {} });
  });
});

describe('setTask, setVisible and patchRun', () => {
  it('records a task under its key and clears it again', () => {
    state().setTask('k', { kind: 'generate', id: 'a' });
    expect(state().tasks.k).toEqual({ kind: 'generate', id: 'a' });
    state().setTask('k', null);
    expect(state().tasks.k).toBeUndefined();
  });

  it('tracks which forms are on screen', () => {
    state().setVisible('k', true);
    expect(state().visible.k).toBe(true);
    state().setVisible('k', false);
    expect(state().visible.k).toBe(false);
  });

  it('patches a run onto the empty job, keeping the rest', () => {
    state().patchRun('k', { status: 'analyzing' });
    expect(run('k')).toEqual({ ...EMPTY_RUN_JOB, status: 'analyzing' });
    state().patchRun('k', { error: 'nope' });
    expect(run('k')).toMatchObject({ status: 'analyzing', error: 'nope' });
  });

  it('keeps each form is job separate', () => {
    state().setTask('a', { kind: 'generate', id: '1' });
    state().setTask('b', { kind: 'translate', id: '2' });
    expect(state().tasks.a?.kind).toBe('generate');
    expect(state().tasks.b?.kind).toBe('translate');
  });
});

describe('beginPromptTask', () => {
  it('registers the work and hands back the task', () => {
    const task = beginPromptTask('k', 'generate', 'req-1');
    expect(task).toMatchObject({ kind: 'generate', requestId: 'req-1' });
    expect(state().tasks.k).toBe(task);
  });

  it('refuses a second job for the same form', () => {
    beginPromptTask('k', 'generate');
    expect(beginPromptTask('k', 'translate')).toBeNull();
  });

  it('gives each task an id of its own', () => {
    const first = beginPromptTask('a', 'generate');
    const second = beginPromptTask('b', 'generate');
    expect(first?.id).not.toBe(second?.id);
  });
});

describe('isCurrentPromptTask and finishPromptTask', () => {
  it('knows its own task, and not one that replaced it', () => {
    const task = beginPromptTask('k', 'generate');
    if (!task) throw new Error('the task should have started');
    expect(isCurrentPromptTask('k', task)).toBe(true);
    state().setTask('k', { kind: 'translate', id: 'other' });
    expect(isCurrentPromptTask('k', task)).toBe(false);
  });

  it('clears the form when its own task finishes', () => {
    const task = beginPromptTask('k', 'generate');
    if (!task) throw new Error('the task should have started');
    finishPromptTask('k', task);
    expect(state().tasks.k).toBeUndefined();
  });

  it('leaves a newer task alone when an old one finishes late', () => {
    // A closed dialog or a Clear can replace the job while the request is still in flight.
    const task = beginPromptTask('k', 'generate');
    if (!task) throw new Error('the task should have started');
    const newer = { kind: 'translate' as const, id: 'newer' };
    state().setTask('k', newer);
    finishPromptTask('k', task);
    expect(state().tasks.k).toBe(newer);
  });
});

describe('cancelPromptTask', () => {
  it('drops the job and aborts the AI request behind it', () => {
    beginPromptTask('k', 'generate', 'req-1');
    cancelPromptTask('k');
    expect(state().tasks.k).toBeUndefined();
    expect(bridge.$fn('ai.cancel')).toHaveBeenCalledWith('req-1');
  });

  it('stops a translation through the translate bridge, not the AI one', () => {
    beginPromptTask('k', 'translate', 'req-2');
    cancelPromptTask('k');
    expect(state().tasks.k).toBeUndefined();
    expect(bridge.$fn('translate.cancel')).toHaveBeenCalledWith('req-2');
    expect(() => bridge.$fn('ai.cancel')).toThrow();
  });

  it('drops a job that has nothing to abort', () => {
    beginPromptTask('k', 'translate');
    cancelPromptTask('k');
    expect(state().tasks.k).toBeUndefined();
  });

  it('does nothing when no job is running', () => {
    expect(() => cancelPromptTask('k')).not.toThrow();
  });
});

describe('startRunAssessment', () => {
  it('does nothing for an empty prompt', () => {
    startRunAssessment('k', { prompt: '   ', targetAI: DEFAULT_TARGET_AI });
    expect(state().runs.k).toBeUndefined();
  });

  it('shows the sizing as running and sends the prompt off', () => {
    startRunAssessment('k', {
      prompt: 'Do a thing',
      targetAI: DEFAULT_TARGET_AI,
      promptType: 'Full Stack',
    });
    expect(run('k').status).toBe('analyzing');
    const [payload] = bridge.$fn('ai.assessRun').mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({
      prompt: 'Do a thing',
      targetAI: DEFAULT_TARGET_AI,
      promptType: 'Full Stack',
    });
    expect(payload.requestId).toBe(run('k').requestId);
  });

  it('stores the recommendation with the exact text that was sized', async () => {
    // The panel compares that text against the generated prompt to tell when it has moved on.
    installRunovaBridge({
      'ai.assessRun': async () => ({ ok: true, assessment, cliName: 'Claude Code' }),
    });
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    await vi.waitFor(() => expect(run('k').status).toBe('ready'));
    expect(run('k').analysis).toMatchObject({ prompt: 'Do a thing', cliName: 'Claude Code' });
    expect(run('k').analysis?.recommendation.assessment).toEqual(assessment);
    expect(run('k').requestId).toBeNull();
  });

  it('clears an override once a fresh recommendation lands', async () => {
    installRunovaBridge({
      'ai.assessRun': async () => ({ ok: true, assessment, cliName: null }),
    });
    state().patchRun('k', { override: { modelId: 'haiku', effort: 'low' } });
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    await vi.waitFor(() => expect(run('k').status).toBe('ready'));
    expect(run('k').override).toBeNull();
  });

  it('reports what went wrong when the CLI could not size it', async () => {
    installRunovaBridge({ 'ai.assessRun': async () => ({ ok: false, error: 'no CLI' }) });
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    await vi.waitFor(() => expect(run('k').status).toBe('error'));
    expect(run('k').error).toBe('no CLI');
  });

  it('falls back to its own wording when the failure has no message', async () => {
    installRunovaBridge({ 'ai.assessRun': async () => ({ ok: false }) });
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    await vi.waitFor(() => expect(run('k').status).toBe('error'));
    expect(run('k').error).toBe('The AI CLI could not size this prompt.');
  });

  it('reports a rejected request as an error', async () => {
    installRunovaBridge({
      'ai.assessRun': async () => {
        throw new Error('the pipe closed');
      },
    });
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    await vi.waitFor(() => expect(run('k').status).toBe('error'));
    expect(run('k').error).toBe('the pipe closed');
  });

  it('goes back to idle when the sizing was cancelled', async () => {
    installRunovaBridge({ 'ai.assessRun': async () => ({ ok: false, cancelled: true }) });
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    await vi.waitFor(() => expect(run('k').status).toBe('idle'));
    // Any earlier result stays on screen; the panel shows whichever one exists.
    expect(run('k').error).toBeNull();
  });

  it('aborts the sizing already running for that form', () => {
    startRunAssessment('k', { prompt: 'First', targetAI: DEFAULT_TARGET_AI });
    const first = run('k').requestId;
    startRunAssessment('k', { prompt: 'Second', targetAI: DEFAULT_TARGET_AI });
    expect(bridge.$fn('ai.cancelAssessRun')).toHaveBeenCalledWith(first);
    expect(run('k').requestId).not.toBe(first);
  });

  it('throws away the answer to a request that was superseded', async () => {
    // Held in an object so the assignment inside the promise is visible to the type checker,
    // which otherwise keeps a plain `let` narrowed to null.
    const pending: { settle: ((value: unknown) => void) | null } = { settle: null };
    installRunovaBridge({
      'ai.assessRun': () =>
        new Promise((resolve) => {
          pending.settle = resolve;
        }),
    });
    startRunAssessment('k', { prompt: 'First', targetAI: DEFAULT_TARGET_AI });
    const stale = pending.settle;
    startRunAssessment('k', { prompt: 'Second', targetAI: DEFAULT_TARGET_AI });
    stale?.({ ok: true, assessment, cliName: 'stale' });
    await Promise.resolve();
    expect(run('k').analysis).toBeNull();
    expect(run('k').status).toBe('analyzing');
  });
});

describe('cancelRunAssessment', () => {
  it('aborts the request and stops showing it as running', () => {
    startRunAssessment('k', { prompt: 'Do a thing', targetAI: DEFAULT_TARGET_AI });
    const requestId = run('k').requestId;
    cancelRunAssessment('k');
    expect(bridge.$fn('ai.cancelAssessRun')).toHaveBeenCalledWith(requestId);
    expect(run('k')).toMatchObject({ requestId: null, status: 'idle' });
  });

  it('keeps a result already on screen while aborting a later request', () => {
    state().patchRun('k', { status: 'ready', requestId: 'req-2' });
    cancelRunAssessment('k');
    expect(run('k').status).toBe('ready');
  });

  it('does nothing when nothing is in flight', () => {
    state().patchRun('k', { status: 'ready' });
    cancelRunAssessment('k');
    expect(() => bridge.$fn('ai.cancelAssessRun')).toThrow();
  });
});
