#!/usr/bin/env node
// A stand-in for Claude Code in the Relay e2e (e2e/relay.e2e.ts). It runs the hooks of the
// settings file it is started with, the way the real CLI would, writes the handoff the scenario
// asks for and then sits at its prompt, so the relay sees what a real session does.
//
// The scenario lives in <cwd>/.fake-relay.json:
//   { "legs": { "T002": ["continue", "done"], "T003": [{ "outcome": "blocked" }] },
//     "plan": { "T004": "questions" }, "context": { "T005": [170000, 20000] },
//     "delay": { "T006": 8000 }, "proposal": { ... } }
// A task with no entry finishes in one leg with outcome done and tests passed. "context" is the
// context each leg of a task reports in its transcript; a leg the guard speaks to hands off with
// outcome continue, as a real agent told to would.
// Everything it does is appended to <cwd>/.fake-relay.log (one JSON object per line).
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const LOG = path.join(process.cwd(), '.fake-relay.log');

function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {
    // Missing or broken input reads as none.
  }
}

function scenario() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), '.fake-relay.json'), 'utf8'));
  } catch {
    return {};
  }
}

if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

const HEADLESS = args.includes('-p');

if (HEADLESS) {
  // A headless run: the planner. Its prompt arrives on stdin.
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    log({ kind: 'headless', args, length: input.length });
    const proposal = scenario().proposal;
    if (proposal && /only the JSON/.test(input)) {
      process.stdout.write(`${JSON.stringify(proposal)}\n`);
    } else {
      process.stdout.write('feat: e2e change\n');
    }
    process.exit(0);
  });
}

// Claude Code's options as its own parser reads them: the list flags take every word up to the
// next flag, so a prompt placed straight after one of them is lost, exactly as in the real CLI.
const LIST_FLAGS = new Set([
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--mcp-config',
  '--add-dir',
  '--betas',
]);
const VALUE_FLAGS = new Set([
  '--settings',
  '--permission-mode',
  '--model',
  '--effort',
  '--fallback-model',
  '--append-system-prompt',
  '--session-id',
  '--resume',
  '-r',
]);

function parseArgs(list) {
  const options = {};
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (LIST_FLAGS.has(arg)) {
      const values = [];
      while (i + 1 < list.length && !list[i + 1].startsWith('-')) values.push(list[++i]);
      options[arg] = values;
    } else if (VALUE_FLAGS.has(arg)) {
      options[arg] = list[++i];
    } else if (arg.startsWith('-')) {
      options[arg] = true;
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

const parsed = parseArgs(args);
const settingsPath = parsed.options['--settings'];
let mode = parsed.options['--permission-mode'] ?? 'default';
const prompt = parsed.positional.join(' ');
const sessionId = `fake-${process.pid}-${Date.now()}`;
const transcriptPath = path.join(os.tmpdir(), `fake-relay-${sessionId}.jsonl`);

let hooks = {};
try {
  hooks = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks ?? {};
} catch {
  // Missing or broken input reads as none.
}

const taskId = /task (T\d+)/.exec(prompt)?.[1] ?? null;
const legNo = Number(/session (\d+)/.exec(prompt)?.[1] ?? 1);
const handoffPath = /(\S+\/handoffs\/T\d+\.md)/.exec(prompt)?.[1] ?? null;

/** Runs every hook command registered for an event (and tool), returning their parsed outputs. */
function runHooks(event, extra = {}) {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  const outputs = [];
  for (const group of groups) {
    if (
      group.matcher &&
      extra.tool_name &&
      !new RegExp(`^(${group.matcher})$`).test(extra.tool_name)
    ) {
      continue;
    }
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command') continue;
      const payload = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: process.cwd(),
        permission_mode: mode,
        hook_event_name: event,
        ...extra,
      };
      const result = spawnSync(hook.command, {
        shell: true,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: (hook.timeout ?? 60) * 1000,
        windowsHide: true,
      });
      const text = (result.stdout ?? '').trim();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Missing or broken input reads as none.
        }
      }
      outputs.push(parsed);
      if (result.status !== 0 || result.stderr) {
        log({ kind: 'hook-error', event, status: result.status, stderr: result.stderr });
      }
    }
  }
  log({ kind: 'hook', event, tool: extra.tool_name, outputs });
  return outputs;
}

function writeTranscript(tokens) {
  const line = {
    type: 'assistant',
    message: {
      id: `msg-${Date.now()}`,
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: tokens - 12,
        cache_creation_input_tokens: 0,
      },
    },
  };
  fs.appendFileSync(transcriptPath, `${JSON.stringify(line)}\n`);
}

function legPlan(script) {
  const legs = script.legs?.[taskId];
  const raw = Array.isArray(legs) ? legs[Math.min(legNo, legs.length) - 1] : 'done';
  const leg = typeof raw === 'string' ? { outcome: raw } : (raw ?? { outcome: 'done' });
  return {
    outcome: leg.outcome ?? 'done',
    tests: leg.tests ?? (leg.outcome === 'blocked' ? 'not-run' : 'passed'),
  };
}

function writeHandoff(leg) {
  if (!handoffPath) return;
  const file = path.join(process.cwd(), handoffPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next =
    leg.outcome === 'continue'
      ? `Pick up step ${legNo + 1} of the work.`
      : leg.outcome === 'blocked'
        ? 'Waiting on a decision about the database.'
        : 'Nothing left; the task is done.';
  fs.writeFileSync(
    file,
    [
      '---',
      `outcome: ${leg.outcome}`,
      `tests: ${leg.tests}`,
      `leg: ${legNo}`,
      `updated: ${new Date().toISOString()}`,
      '---',
      '',
      '## Purpose',
      `Deliver ${taskId}.`,
      '',
      '## Done so far',
      `- Session ${legNo} did its part.`,
      '',
      '## Decisions',
      '- Kept it small.',
      '',
      '## Tried and rejected',
      '- Nothing yet.',
      '',
      '## Next step',
      next,
      '',
    ].join('\n'),
  );
  log({ kind: 'handoff', taskId, legNo, outcome: leg.outcome });
}

let waitingForPlanKey = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a leg's transcript reports before it has read anything. */
const STARTING_CONTEXT = 20_000;

async function execute() {
  const script = scenario();
  const contexts = script.context?.[taskId];
  const tokens = Array.isArray(contexts) ? contexts[Math.min(legNo, contexts.length) - 1] : null;
  let note = null;
  if (typeof tokens === 'number') {
    writeTranscript(tokens);
    // The first tool call lets AgentMate measure the transcript and arm the guard, the next ones
    // are where the guard speaks (PostToolUse), the way it reaches a real session mid-work.
    for (let call = 0; call < 20 && !note; call += 1) {
      const outputs = runHooks('PostToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      });
      note = outputs.find((out) => out?.hookSpecificOutput?.additionalContext) ?? null;
      if (!note) await sleep(700);
    }
  } else {
    runHooks('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  }
  if (note) log({ kind: 'guard', text: note.hookSpecificOutput.additionalContext });

  const delay = script.delay?.[taskId];
  if (typeof delay === 'number') await sleep(delay);
  const leg = legPlan(script);
  if (note && leg.outcome === 'done') leg.outcome = 'continue';
  writeHandoff(leg);
  runHooks('PostToolUse', { tool_name: 'Write', tool_input: { file_path: handoffPath } });
  stop(false);
}

function stop(active) {
  process.stdout.write('\r\nDone.\r\n');
  const outputs = runHooks('Stop', { stop_hook_active: active });
  const block = outputs.find((out) => out?.decision === 'block');
  if (block && !active) {
    log({ kind: 'stop-blocked', reason: block.reason });
    writeHandoff(legPlan(scenario()));
    stop(true);
    return;
  }
  idle();
}

function idle() {
  process.stdout.write('\r\n> ');
}

function plan() {
  const script = scenario();
  const questions = script.plan?.[taskId] === 'questions';
  const planText = [
    `# Plan for ${taskId}`,
    '',
    '1. Write the failing tests.',
    '2. Make them pass.',
    '',
    '## Open questions',
    '',
    // A clean plan reads the way real ones do: the heading kept, with "None" and a reason.
    questions
      ? '- Which database should this use?'
      : 'None. The input format is not specified, so I will not validate it.',
  ].join('\n');
  const toolInput = {
    plan: planText,
    planFilePath: path.join(os.tmpdir(), `${sessionId}-plan.md`),
  };
  runHooks('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: toolInput });
  process.stdout.write(
    '\r\nWould you like to proceed?\r\n\r\n> 1. Yes, and use auto mode\r\n  2. Yes, and manually approve edits\r\n  3. No, keep planning\r\n',
  );
  const outputs = runHooks('PermissionRequest', {
    tool_name: 'ExitPlanMode',
    tool_input: toolInput,
  });
  const decision = outputs.find((out) => out?.hookSpecificOutput?.decision)?.hookSpecificOutput
    .decision;
  const setMode = decision?.updatedPermissions?.find((entry) => entry.type === 'setMode');
  if (decision?.behavior === 'allow' && setMode) {
    mode = setMode.mode;
    log({ kind: 'plan-approved', by: 'hook', mode });
    runHooks('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: toolInput });
    void execute();
    return;
  }
  log({ kind: 'plan-waiting' });
  runHooks('Notification', {
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use ExitPlanMode',
  });
  waitingForPlanKey = true;
}

function start() {
  log({
    kind: 'launch',
    args,
    taskId,
    legNo,
    mode,
    session: process.env.AGENTMATE_SESSION_ID ?? null,
  });
  process.stdout.write('Fake Claude Code 9.9.9\r\n');
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (waitingForPlanKey && chunk.includes('1')) {
      waitingForPlanKey = false;
      mode = 'auto';
      log({ kind: 'plan-approved', by: 'key', mode });
      void execute();
    }
  });

  runHooks('SessionStart', { source: 'startup' });
  if (!prompt) {
    idle();
  } else {
    // A real session starts well under its budget (system prompt and tools) and grows from there.
    if (Array.isArray(scenario().context?.[taskId])) writeTranscript(STARTING_CONTEXT);
    runHooks('UserPromptSubmit', { prompt });
    if (mode === 'plan') plan();
    else void execute();
  }
}

if (!HEADLESS) start();
