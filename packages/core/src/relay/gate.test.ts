import { describe, expect, it } from 'vitest';
import {
  decideRelayGate,
  type GateLegView,
  guardThreshold,
  hasOpenQuestions,
  isHandoffFresh,
} from './gate.js';

function leg(overrides: Partial<GateLegView> = {}): GateLegView {
  return {
    taskId: 'T003',
    legNo: 2,
    phase: 'executing',
    planFirst: false,
    afterPlanMode: 'auto',
    openQuestions: 0,
    guardDue: false,
    contextPercent: null,
    stopBlocks: 0,
    handoffRelPath: 'docs/tasks/handoffs/T003.md',
    ...overrides,
  };
}

const PLAN = '# Plan\n\n1. Add the column.\n2. Test it.\n';
const PLAN_FILE = 'C:/Users/me/.claude/plans/board.md';

function planInput(plan: string | undefined) {
  return plan === undefined ? {} : { plan, planFilePath: PLAN_FILE };
}

describe('decideRelayGate', () => {
  it('answers nothing for a session that is not a relay leg', () => {
    expect(
      decideRelayGate(null, { event: 'Stop', stopHookActive: false, handoffFresh: false }),
    ).toEqual({ output: null, observations: [] });
  });

  it('reports the permission mode it sees', () => {
    const decision = decideRelayGate(leg(), {
      event: 'PostToolUse',
      tool: 'Read',
      permissionMode: 'acceptEdits',
    });
    expect(decision.observations).toContainEqual({ type: 'modeObserved', mode: 'acceptEdits' });
  });

  describe('questions', () => {
    it('counts a question the agent asks and leaves it to the user', () => {
      const decision = decideRelayGate(leg({ phase: 'planning' }), {
        event: 'PreToolUse',
        tool: 'AskUserQuestion',
      });
      expect(decision).toEqual({ output: null, observations: [{ type: 'hookQuestion' }] });
    });

    it('counts the answer once the tool returns', () => {
      const decision = decideRelayGate(leg(), { event: 'PostToolUse', tool: 'AskUserQuestion' });
      expect(decision).toEqual({ output: null, observations: [{ type: 'questionAnswered' }] });
    });
  });

  describe('the plan gate', () => {
    const planning = leg({ phase: 'planning', planFirst: true, legNo: 1 });

    it('reports a presented plan on PreToolUse without deciding', () => {
      const decision = decideRelayGate(planning, {
        event: 'PreToolUse',
        tool: 'ExitPlanMode',
        toolInput: planInput(PLAN),
      });
      expect(decision).toEqual({
        output: null,
        observations: [{ type: 'planPresented', approvable: true }],
      });
    });

    it('approves a clean plan and switches to the after-plan mode', () => {
      const decision = decideRelayGate(planning, {
        event: 'PermissionRequest',
        tool: 'ExitPlanMode',
        toolInput: planInput(PLAN),
        permissionMode: 'plan',
      });
      expect(decision.output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: { plan: PLAN, planFilePath: PLAN_FILE },
            updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
          },
        },
      });
      expect(decision.observations).toContainEqual({ type: 'planApproved', mode: 'auto' });
    });

    it('switches to acceptEdits when that is the chosen mode', () => {
      const decision = decideRelayGate(
        { ...planning, afterPlanMode: 'acceptEdits' },
        { event: 'PermissionRequest', tool: 'ExitPlanMode', toolInput: planInput(PLAN) },
      );
      expect(decision.observations).toContainEqual({ type: 'planApproved', mode: 'acceptEdits' });
    });

    it.each([
      ['plan first is off', leg({ phase: 'planning', planFirst: false }), PLAN, false],
      ['the leg is not planning', leg({ phase: 'executing', planFirst: true }), PLAN, false],
      ['a question is still open', { ...planning, openQuestions: 1 }, PLAN, false],
      ['the plan is missing', planning, undefined, false],
      ['the plan was cut short', planning, PLAN, true],
      [
        'the plan lists open questions',
        planning,
        `${PLAN}\n## Open questions\n\n- Which db?\n`,
        false,
      ],
    ])('leaves the menu to the user when %s', (_label, view, plan, truncated) => {
      const decision = decideRelayGate(view, {
        event: 'PermissionRequest',
        tool: 'ExitPlanMode',
        toolInput: planInput(plan),
        planTruncated: truncated,
      });
      expect(decision.output).toBeNull();
      expect(decision.observations.some((item) => item.type === 'planApproved')).toBe(false);
    });

    it('marks a plan with open questions as not approvable', () => {
      const decision = decideRelayGate(planning, {
        event: 'PreToolUse',
        tool: 'ExitPlanMode',
        toolInput: planInput(`${PLAN}\n**Open questions:** should T4 wait?`),
      });
      expect(decision.observations).toEqual([{ type: 'planPresented', approvable: false }]);
    });

    it('refuses to approve without the tool input to echo back', () => {
      const decision = decideRelayGate(planning, {
        event: 'PermissionRequest',
        tool: 'ExitPlanMode',
        toolInput: { planFilePath: PLAN_FILE },
      });
      expect(decision.output).toBeNull();
    });

    it('leaves a question to the user even when it asks for permission', () => {
      const decision = decideRelayGate(planning, {
        event: 'PermissionRequest',
        tool: 'AskUserQuestion',
      });
      expect(decision).toEqual({ output: null, observations: [] });
    });

    it('never answers a permission request for another tool', () => {
      const decision = decideRelayGate(planning, { event: 'PermissionRequest', tool: 'Bash' });
      expect(decision.output).toBeNull();
    });
  });

  describe('the context guard', () => {
    it('tells the agent to hand off once the guard is due', () => {
      const decision = decideRelayGate(leg({ guardDue: true, contextPercent: 81 }), {
        event: 'PostToolUse',
        tool: 'Bash',
      });
      const context = (decision.output as { hookSpecificOutput: Record<string, string> })
        .hookSpecificOutput;
      expect(context.hookEventName).toBe('PostToolUse');
      expect(context.additionalContext).toContain('81%');
      expect(context.additionalContext).toContain('docs/tasks/handoffs/T003.md');
      expect(context.additionalContext).toContain('outcome: continue');
      expect(context.additionalContext).toContain('leg: 2');
      expect(decision.observations).toContainEqual({ type: 'guardSent' });
    });

    it('stays quiet before the guard is due and while planning', () => {
      expect(decideRelayGate(leg(), { event: 'PostToolUse', tool: 'Bash' }).output).toBeNull();
      expect(
        decideRelayGate(leg({ guardDue: true, phase: 'planning' }), {
          event: 'PostToolUse',
          tool: 'Bash',
        }).output,
      ).toBeNull();
    });
  });

  describe('the stop gate', () => {
    it('holds a session that is stopping without its handoff, once', () => {
      const decision = decideRelayGate(leg(), {
        event: 'Stop',
        stopHookActive: false,
        handoffFresh: false,
        permissionMode: 'auto',
      });
      expect(decision.output).toEqual({
        decision: 'block',
        reason: expect.stringContaining('docs/tasks/handoffs/T003.md'),
      });
      expect(decision.observations).toContainEqual({ type: 'stopBlocked' });
    });

    it('asks a session that needs the user to say so in the handoff', () => {
      const decision = decideRelayGate(leg(), {
        event: 'Stop',
        stopHookActive: false,
        handoffFresh: false,
      });
      expect((decision.output as { reason: string }).reason).toContain('outcome: blocked');
    });

    it.each([
      ['the handoff is fresh', leg(), { handoffFresh: true }],
      ['Claude is already continuing for a stop hook', leg(), { stopHookActive: true }],
      ['it already held this leg once', leg({ stopBlocks: 1 }), {}],
      ['the session is still in plan mode', leg(), { permissionMode: 'plan' as const }],
      ['the leg is waiting on its plan', leg({ phase: 'planning' }), {}],
    ])('lets the session stop when %s', (_label, view, input) => {
      const decision = decideRelayGate(view, {
        event: 'Stop',
        stopHookActive: false,
        handoffFresh: false,
        ...input,
      });
      expect(decision.output).toBeNull();
      expect(decision.observations).toContainEqual({ type: 'stopAllowed' });
    });
  });
});

describe('hasOpenQuestions', () => {
  it('finds a questions section with something in it', () => {
    expect(hasOpenQuestions('## Open questions\n\n- Which database?')).toBe(true);
    expect(hasOpenQuestions('### Questions for you\n1. Keep the old API?')).toBe(true);
    expect(hasOpenQuestions('**Unresolved questions:** the port')).toBe(true);
  });

  it('ignores an empty, answered or none section', () => {
    expect(hasOpenQuestions(PLAN)).toBe(false);
    expect(hasOpenQuestions('## Open questions\n\nNone.\n\n## Steps\n1. Go')).toBe(false);
    expect(hasOpenQuestions('## Open questions\n\n- N/A')).toBe(false);
    expect(hasOpenQuestions('## Open questions\n\n- Resolved: use Postgres')).toBe(false);
    expect(hasOpenQuestions('## Open questions\n\n- ~~Which db?~~')).toBe(false);
    expect(hasOpenQuestions('**Open questions:** none')).toBe(false);
  });

  it('reads a section that opens with None as settled, whatever explains it', () => {
    // What Claude Code (Sonnet 5.5) wrote in a real plan-first leg.
    const plan = [
      '## Open questions',
      '',
      'None. The behavior for non-array or non-numeric input is not specified, so I will not add validation (out of scope).',
      '',
      '## Steps (test-first)',
      '1. Red: create src/math.test.js',
    ].join('\n');
    expect(hasOpenQuestions(plan)).toBe(false);
    expect(hasOpenQuestions('## Open questions\n\nNone.\n\nI assumed ESM throughout.')).toBe(false);
    expect(hasOpenQuestions('## Open questions\n\n- None, the spec covers it.')).toBe(false);
    expect(
      hasOpenQuestions('## Open questions\n\nNo open questions: the task is fully specified.'),
    ).toBe(false);
  });

  it('still sees a question asked after a None', () => {
    expect(hasOpenQuestions('## Open questions\n\nNone. But should T002 keep the old API?')).toBe(
      true,
    );
    expect(hasOpenQuestions('## Open questions\n\n- None of the ports work; which one now?')).toBe(
      true,
    );
  });

  it('does not mistake a step that mentions questions for a section', () => {
    expect(hasOpenQuestions('1. Answer the questions in the issue tracker')).toBe(false);
  });
});

describe('isHandoffFresh', () => {
  it('needs a handoff written after the leg started', () => {
    expect(isHandoffFresh(null, 1000)).toBe(false);
    expect(isHandoffFresh({ mtimeMs: 900 }, 1000)).toBe(false);
    expect(isHandoffFresh({ mtimeMs: 1000 }, 1000)).toBe(false);
    expect(isHandoffFresh({ mtimeMs: 1001 }, 1000)).toBe(true);
    expect(isHandoffFresh({ mtimeMs: 5 }, null)).toBe(true);
  });
});

describe('guardThreshold', () => {
  it('is a share of the budget', () => {
    expect(guardThreshold({ budget: 200_000, share: 0.8, window: null })).toBe(160_000);
  });

  it('stays under the model window when the budget is larger', () => {
    expect(guardThreshold({ budget: 1_000_000, share: 0.8, window: 200_000 })).toBe(160_000);
  });
});
