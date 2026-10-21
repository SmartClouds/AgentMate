import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_PLAN_LIMIT, relayGateScriptSource } from './gateScript';

/**
 * The gate script runs inside Claude Code as a hook, so it is run here the same way: a node
 * process given the hook's JSON on stdin, against a small server standing in for AgentMate.
 */

const TOKEN = 'gate-token';
let dir: string;
let script: string;
let armedDir: string;
let server: Server;
let reply: { status: number; body: unknown } = { status: 204, body: null };
let received: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-gate-'));
  armedDir = join(dir, 'armed');
  mkdirSync(armedDir);
  received = [];
  reply = { status: 204, body: null };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      received.push({ path: req.url, ...(JSON.parse(body) as Record<string, unknown>) });
      if (reply.status === 204) return res.writeHead(204).end();
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const portFile = join(dir, 'hook-server.json');
  writeFileSync(portFile, JSON.stringify({ port, token: TOKEN }));
  script = join(dir, 'relay-gate.cjs');
  writeFileSync(script, relayGateScriptSource({ portFile, armedDir }));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function runHook(
  payload: Record<string, unknown>,
  sessionId = 'tab-1',
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, AGENTMATE_SESSION_ID: sessionId },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const PLAN_INPUT = { plan: '# Plan\n1. Go', planFilePath: 'C:/p.md' };

const APPROVAL = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'allow',
      updatedInput: { plan: 'cut', planFilePath: 'C:/p.md' },
      updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
    },
  },
};

describe('relay gate hook', () => {
  it('leaves at once on a tool call while the guard is not armed', async () => {
    const result = await runHook({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
    expect(result).toEqual({ stdout: '', code: 0 });
    expect(received).toEqual([]);
  });

  it('reports a tool call once armed, and prints the guard text it gets back', async () => {
    writeFileSync(join(armedDir, 'tab-1'), '');
    reply = {
      status: 200,
      body: {
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Hand off.' },
      },
    };
    const result = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      permission_mode: 'auto',
    });
    expect(JSON.parse(result.stdout)).toEqual(reply.body);
    expect(received[0]).toMatchObject({
      path: '/relay-gate',
      token: TOKEN,
      sessionId: 'tab-1',
      event: 'PostToolUse',
      tool: 'Bash',
      permissionMode: 'auto',
    });
  });

  it('always reports the answer to a question, armed or not', async () => {
    await runHook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
    expect(received).toHaveLength(1);
  });

  it('approves a plan with the input Claude Code sent, not the copy that was cut', async () => {
    reply = { status: 200, body: APPROVAL };
    const result = await runHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: PLAN_INPUT,
    });
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.decision.updatedInput).toEqual(PLAN_INPUT);
    expect(received[0].toolInput).toEqual(PLAN_INPUT);
  });

  it('sends a long plan cut short and says so', async () => {
    const plan = 'x'.repeat(GATE_PLAN_LIMIT + 10);
    await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan, planFilePath: 'C:/p.md' },
    });
    expect(received[0]).toMatchObject({ planTruncated: true });
    expect((received[0].toolInput as { plan: string }).plan).toHaveLength(GATE_PLAN_LIMIT);
  });

  it.each([
    ['an approval for another tool', 'PermissionRequest', 'Bash', APPROVAL],
    [
      'a mode it never grants',
      'PermissionRequest',
      'ExitPlanMode',
      {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: {},
            updatedPermissions: [
              { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
            ],
          },
        },
      },
    ],
    ['a Stop reply that is not a block', 'Stop', '', { decision: 'approve', reason: 'x' }],
    [
      'guard text that is too long',
      'PostToolUse',
      'AskUserQuestion',
      { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'x'.repeat(3000) } },
    ],
    ['an answer for another event', 'Stop', '', APPROVAL],
  ])('prints nothing for %s', async (_label, event, tool, body) => {
    reply = { status: 200, body };
    const result = await runHook({
      hook_event_name: event,
      tool_name: tool,
      tool_input: PLAN_INPUT,
    });
    expect(result).toEqual({ stdout: '', code: 0 });
  });

  it('holds a stop with the reason it is given', async () => {
    reply = { status: 200, body: { decision: 'block', reason: 'Write the handoff.' } };
    const result = await runHook({ hook_event_name: 'Stop', stop_hook_active: false });
    expect(JSON.parse(result.stdout)).toEqual(reply.body);
    expect(received[0]).toMatchObject({ event: 'Stop', stopHookActive: false });
  });

  it('exits quietly when AgentMate answers nothing, garbage or is gone', async () => {
    expect(await runHook({ hook_event_name: 'Stop' })).toEqual({ stdout: '', code: 0 });
    reply = { status: 200, body: '{not json' };
    expect(await runHook({ hook_event_name: 'Stop' })).toEqual({ stdout: '', code: 0 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(await runHook({ hook_event_name: 'Stop' })).toEqual({ stdout: '', code: 0 });
  });

  it('does nothing outside a tab AgentMate started', async () => {
    const result = await runHook({ hook_event_name: 'Stop' }, '../../etc');
    expect(result).toEqual({ stdout: '', code: 0 });
    expect(received).toEqual([]);
  });
});
