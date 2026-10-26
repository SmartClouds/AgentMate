import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELAY_MCP_TOOLS, relayBridgeScriptSource } from './bridgeScript';

/** The Relay MCP server, started as a CLI starts it: node speaking MCP over stdio. */

const TOKEN = 'relay-token';
let dir: string;
let script: string;
let portFile: string;
let server: Server;
let requests: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-mcp-'));
  requests = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push({ path: req.url, ...parsed });
      const answer =
        parsed.tool === 'finish_leg'
          ? { ok: false, error: 'The handoff has no Next step.' }
          : parsed.tool === 'list_tasks'
            ? { ok: true, data: [{ id: 'T001', status: 'done' }] }
            : { ok: true, text: `answer for ${String(parsed.tool)}` };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  portFile = join(dir, 'hook-server.json');
  writeFileSync(portFile, JSON.stringify({ port, token: TOKEN }));
  script = join(dir, 'relay-mcp.cjs');
  writeFileSync(script, relayBridgeScriptSource({ portFile }));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function talk(messages: unknown[], sessionId = 'tab-1'): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      RUNOVA_SESSION_ID: sessionId,
    };
    if (!sessionId) delete env.RUNOVA_SESSION_ID;
    // The script also reads the name from before the rename to Runova; a test run inside such a
    // terminal must not hand it a real session.
    delete env.AGENTMATE_SESSION_ID; // legacy-name
    const child = spawn(process.execPath, [script], { env });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', () =>
      resolve(
        stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ),
    );
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

function text(line: Record<string, unknown>): { text: string; isError: boolean } {
  const result = line.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0].text, isError: Boolean(result.isError) };
}

describe('relay MCP bridge', () => {
  it('handshakes and lists its tools', async () => {
    const lines = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(lines[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'runova_relay' } },
    });
    const tools = (lines[1].result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toEqual([...RELAY_MCP_TOOLS]);
  });

  it('answers server/discover and other unknown methods with an error', async () => {
    const lines = await talk([{ jsonrpc: '2.0', id: 3, method: 'server/discover' }]);
    expect(lines).toEqual([expect.objectContaining({ id: 3, error: expect.anything() })]);
  });

  it('sends a tool call with the session and the token', async () => {
    const lines = await talk([call(4, 'finish_leg', { outcome: 'done', tests: 'passed' })]);
    expect(text(lines[0])).toEqual({ text: 'The handoff has no Next step.', isError: true });
    expect(requests[0]).toEqual({
      path: '/relay',
      token: TOKEN,
      sessionId: 'tab-1',
      tool: 'finish_leg',
      args: { outcome: 'done', tests: 'passed' },
    });
  });

  it('returns data as JSON and text as it is', async () => {
    const lines = await talk([call(5, 'list_tasks'), call(6, 'context_status')]);
    const byId = new Map(lines.map((line) => [line.id, line]));
    expect(JSON.parse(text(byId.get(5)!).text)).toEqual([{ id: 'T001', status: 'done' }]);
    expect(text(byId.get(6)!).text).toBe('answer for context_status');
  });

  it('refuses outside a session Runova started, without asking', async () => {
    const lines = await talk([call(7, 'current_leg')], '');
    expect(text(lines[0]).isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('says Runova is not running when the port file is gone', async () => {
    rmSync(portFile);
    const lines = await talk([call(8, 'current_leg')]);
    expect(text(lines[0])).toEqual({ text: 'Runova is not running.', isError: true });
  });
});
