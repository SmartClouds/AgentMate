import { describe, expect, it } from 'vitest';
import {
  AUTO_PAUSE_RESUME_DELAY_MS,
  type AutoPauseAgent,
  type AutoPauseMemory,
  type AutoPauseRun,
  agentCoversRun,
  emptyAutoPauseMemory,
  planAgentRunPause,
} from './autoPause.js';

const DELAY = AUTO_PAUSE_RESUME_DELAY_MS;

function run(overrides: Partial<AutoPauseRun> = {}): AutoPauseRun {
  return {
    id: 'run-1',
    cwd: '/home/me/app',
    active: true,
    paused: null,
    pending: false,
    ...overrides,
  };
}

function agent(overrides: Partial<AutoPauseAgent> = {}): AutoPauseAgent {
  return { id: 'agent-1', cwd: '/home/me/app', working: true, ...overrides };
}

function plan(
  runs: AutoPauseRun[],
  agents: AutoPauseAgent[],
  { memory = emptyAutoPauseMemory(), now = 1_000_000, enabled = true } = {},
) {
  return planAgentRunPause({ runs, agents, memory, now, enabled });
}

describe('agentCoversRun', () => {
  it.each([
    ['/home/me/app', '/home/me/app'],
    ['/home/me/app/', '/home/me/app'],
    ['/home/me/app/packages/web', '/home/me/app'],
    ['/home/me/app', '/home/me/app/packages/web'],
    ['C:\\Users\\Me\\App', 'c:/users/me/app'],
    ['C:\\Users\\Me\\App\\src', 'C:\\Users\\Me\\App'],
  ])('an agent in %s covers a run in %s', (agentCwd, runCwd) => {
    expect(agentCoversRun(agentCwd, runCwd)).toBe(true);
  });

  it.each([
    ['/home/me/app', '/home/me/app-two'],
    ['/home/me/other', '/home/me/app'],
    ['', '/home/me/app'],
    ['/home/me/app', ''],
  ])('an agent in %s does not cover a run in %s', (agentCwd, runCwd) => {
    expect(agentCoversRun(agentCwd, runCwd)).toBe(false);
  });

  it('keeps case on posix paths, where two folders can differ only by case', () => {
    expect(agentCoversRun('/home/me/App', '/home/me/app')).toBe(false);
  });
});

describe('planAgentRunPause', () => {
  it('pauses an active run while an agent works in its folder', () => {
    const result = plan([run()], [agent()]);
    expect(result.pause).toEqual(['run-1']);
    expect(result.resume).toEqual([]);
  });

  it('leaves runs alone while no agent works', () => {
    const result = plan([run()], [agent({ working: false })]);
    expect(result).toMatchObject({ pause: [], resume: [] });
  });

  it('leaves a run in another folder alone', () => {
    expect(plan([run({ cwd: '/home/me/other' })], [agent()]).pause).toEqual([]);
  });

  it('does not pause a run whose command already finished', () => {
    expect(plan([run({ active: false })], [agent()]).pause).toEqual([]);
  });

  it('does not pause a run that is already paused or mid-change', () => {
    expect(plan([run({ paused: 'user' })], [agent()]).pause).toEqual([]);
    expect(plan([run({ paused: 'agent' })], [agent()]).pause).toEqual([]);
    expect(plan([run({ pending: true })], [agent()]).pause).toEqual([]);
  });

  it('does nothing at all while turned off, except resuming what it paused', () => {
    const result = plan([run(), run({ id: 'run-2', paused: 'agent' })], [agent()], {
      enabled: false,
    });
    expect(result.pause).toEqual([]);
    expect(result.resume).toEqual(['run-2']);
  });

  it('never resumes a run the user paused, even when turned off', () => {
    const result = plan([run({ paused: 'user' })], [], { enabled: false });
    expect(result.resume).toEqual([]);
  });

  it('resumes only after no agent has covered the run for the whole delay', () => {
    const start = 1_000_000;
    let memory: AutoPauseMemory = plan([run()], [agent()], { now: start }).memory;
    const paused = run({ paused: 'agent' });

    // The agent stops: a short gap between tool calls must not resume the run yet.
    let result = plan([paused], [agent({ working: false })], { memory, now: start + DELAY - 1 });
    expect(result.resume).toEqual([]);
    memory = result.memory;

    result = plan([paused], [agent({ working: false })], { memory, now: start + DELAY });
    expect(result.resume).toEqual(['run-1']);
  });

  it('restarts the delay when the agent goes back to work', () => {
    const start = 1_000_000;
    let memory = plan([run()], [agent()], { now: start }).memory;
    const paused = run({ paused: 'agent' });
    memory = plan([paused], [agent({ working: false })], { memory, now: start + 1000 }).memory;
    memory = plan([paused], [agent()], { memory, now: start + 2000 }).memory;
    const result = plan([paused], [agent({ working: false })], {
      memory,
      now: start + 2000 + DELAY - 1,
    });
    expect(result.resume).toEqual([]);
  });

  it('counts an agent waiting for input as not working', () => {
    const start = 1_000_000;
    const memory = plan([run()], [agent()], { now: start }).memory;
    // The caller maps needs-input, done, idle and exited to working: false.
    const result = plan([run({ paused: 'agent' })], [agent({ working: false })], {
      memory,
      now: start + DELAY,
    });
    expect(result.resume).toEqual(['run-1']);
  });

  it('gives a run paused before a reload the full delay before resuming it', () => {
    // After a window reload the memory is empty, but main still says the agent paused it.
    const first = plan([run({ paused: 'agent' })], [], { now: 5000 });
    expect(first.resume).toEqual([]);
    const later = plan([run({ paused: 'agent' })], [], { memory: first.memory, now: 5000 + DELAY });
    expect(later.resume).toEqual(['run-1']);
  });

  it('keeps a run the user resumed by hand running until the agent is done', () => {
    const start = 1_000_000;
    let memory = plan([run()], [agent()], { now: start }).memory;
    memory = plan([run({ paused: 'agent' })], [agent()], { memory, now: start + 100 }).memory;

    // The user resumes it while the agent is still working.
    let result = plan([run()], [agent()], { memory, now: start + 200 });
    expect(result.pause).toEqual([]);
    memory = result.memory;
    result = plan([run()], [agent()], { memory, now: start + 60_000 });
    expect(result.pause).toEqual([]);
    memory = result.memory;

    // The agent finishes and stays done for the delay: the next spell pauses again.
    memory = plan([run()], [agent({ working: false })], { memory, now: start + 61_000 }).memory;
    memory = plan([run()], [agent({ working: false })], {
      memory,
      now: start + 61_000 + DELAY,
    }).memory;
    result = plan([run()], [agent()], { memory, now: start + 70_000 });
    expect(result.pause).toEqual(['run-1']);
  });

  it('stops managing a run the user paused by hand', () => {
    const start = 1_000_000;
    let memory = plan([run()], [agent()], { now: start }).memory;
    memory = plan([run({ paused: 'user' })], [agent()], { memory, now: start + 100 }).memory;
    const result = plan([run({ paused: 'user' })], [], { memory, now: start + 100 + DELAY });
    expect(result.resume).toEqual([]);
  });

  it('does not mistake a pause still on its way for a hand resume', () => {
    const start = 1_000_000;
    let memory = plan([run()], [agent()], { now: start }).memory;
    memory = plan([run({ pending: true })], [agent()], { memory, now: start + 50 }).memory;
    // The pause landed.
    const result = plan([run({ paused: 'agent' })], [agent()], { memory, now: start + 100 });
    expect(result.memory.overridden).toEqual([]);
  });

  it('forgets runs that are gone', () => {
    const memory = plan([run()], [agent()]).memory;
    const result = plan([], [agent()], { memory });
    expect(result.memory).toEqual(emptyAutoPauseMemory());
  });

  it('handles several runs and agents at once', () => {
    const result = plan(
      [
        run({ id: 'web', cwd: '/w/app/web' }),
        run({ id: 'api', cwd: '/w/app/api' }),
        run({ id: 'site', cwd: '/w/site' }),
      ],
      [agent({ cwd: '/w/app' }), agent({ id: 'idle', cwd: '/w/site', working: false })],
    );
    expect(result.pause).toEqual(['web', 'api']);
  });
});
