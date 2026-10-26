import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeScriptSource } from './bridgeScript';

/**
 * The generated bridge is what Claude Code starts, so these tests start it the same way: a node
 * process that speaks MCP over stdin and stdout. A small HTTP server stands in for Runova.
 */

const TOKEN = 'secret-token';

let dir: string;
let scriptPath: string;
let portFile: string;
let server: Server;
let requests: Record<string, unknown>[];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => resolve(body));
  });
}

function answer(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  scriptPath = join(dir, 'bridge.cjs');
  portFile = join(dir, 'hook-server.json');
  requests = [];
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    requests.push(body);
    if (body.token !== TOKEN) return answer(res, 401, { ok: false, error: 'Not allowed.' });
    if (body.action === 'list') {
      return answer(res, 200, { ok: true, commands: [{ label: 'dev', command: 'pnpm dev' }] });
    }
    if (body.command === 'rejected') {
      return answer(res, 400, { ok: false, error: 'The command is empty.' });
    }
    return answer(res, 200, { ok: true, id: 'p1', message: 'Suggested it.' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  writeFileSync(portFile, JSON.stringify({ port, token: TOKEN }));
  writeFileSync(scriptPath, bridgeScriptSource({ portFile, projectId: 'project-1' }));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Sends the messages as Claude Code would, closing stdin right after, and returns what came back. */
function talk(messages: unknown[]): Promise<{ lines: Record<string, unknown>[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', () => {
      const lines = stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ lines, stderr });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function textOf(line: Record<string, unknown> | undefined): { text: string; isError: boolean } {
  const result = line?.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0].text, isError: Boolean(result.isError) };
}

describe('run suggestion bridge', () => {
  it('answers initialize with the protocol version the client asked for, and offers tools', async () => {
    const { lines } = await talk([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      },
    ]);

    expect(lines[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
    });
  });

  it('lists its two tools, and sends nothing back for a notification', async () => {
    const { lines } = await talk([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);

    expect(lines).toHaveLength(1);
    const tools = (lines[0].result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toEqual(['list_run_commands', 'propose_run_command']);
  });

  it('forwards a suggestion with the project and the token, and returns what Runova said', async () => {
    const { lines } = await talk([
      call(3, 'propose_run_command', { label: 'android dev', command: 'flutter run' }),
    ]);

    expect(textOf(lines[0])).toEqual({ text: 'Suggested it.', isError: false });
    expect(requests).toEqual([
      {
        token: TOKEN,
        projectId: 'project-1',
        action: 'propose',
        label: 'android dev',
        command: 'flutter run',
      },
    ]);
  });

  it('reports a refusal from Runova as a tool error', async () => {
    const { lines } = await talk([call(4, 'propose_run_command', { command: 'rejected' })]);

    expect(textOf(lines[0])).toEqual({ text: 'The command is empty.', isError: true });
  });

  it('lists the run commands the project has, as JSON', async () => {
    const { lines } = await talk([call(5, 'list_run_commands')]);

    expect(JSON.parse(textOf(lines[0]).text)).toEqual([{ label: 'dev', command: 'pnpm dev' }]);
  });

  it('says Runova is not running when there is no port file', async () => {
    rmSync(portFile);

    const { lines } = await talk([call(6, 'list_run_commands')]);

    expect(textOf(lines[0])).toEqual({ text: 'Runova is not running.', isError: true });
  });

  it('answers an unknown method with a JSON-RPC error, and writes nothing else to stdout', async () => {
    const { lines } = await talk([{ jsonrpc: '2.0', id: 7, method: 'resources/list' }]);

    expect(lines[0]).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(lines).toHaveLength(1);
  });
});
