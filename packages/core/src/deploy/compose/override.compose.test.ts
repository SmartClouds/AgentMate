import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderComposeEnv } from '../env/composeEnv.js';
import { renderLoopbackOverride } from './override.js';
import { parseComposeFile } from './parse.js';

/**
 * The override applied by Compose itself. Skipped where Docker Compose is not installed.
 * `docker compose config` merges the files exactly as `up` would, without starting anything.
 */
const compose =
  spawnSync('docker', ['compose', 'version', '--short'], {
    encoding: 'utf8',
    timeout: 30_000,
  }).status === 0;

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

interface PortOut {
  host_ip?: string;
  target: number;
  published?: string;
  protocol: string;
}

function merged(files: Record<string, string>): Record<string, { ports?: PortOut[] }> {
  const folder = mkdtempSync(join(tmpdir(), 'runova-e07-override-'));
  folders.push(folder);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('COMPOSE_') && name !== 'WEB_PORT') env[name] = value;
  }
  const args = ['compose', '--project-name', 'e07-override'];
  for (const name of Object.keys(files).filter((file) => file.endsWith('.yaml')))
    args.push('-f', name);
  const output = execFileSync('docker', [...args, 'config', '--format', 'json'], {
    cwd: folder,
    encoding: 'utf8',
    env,
    timeout: 90_000,
  });
  return JSON.parse(output).services;
}

const FILE = [
  'services:',
  '  web:',
  '    image: nginx:1.27',
  '    ports:',
  '      - "8080:80"',
  '      - "9000-9001:9000-9001/udp"',
  '      - target: 443',
  '        published: "8443"',
  '        host_ip: 0.0.0.0',
  '  db:',
  '    image: postgres:16',
  '    ports: ["5432:5432"]',
].join('\n');

describe.runIf(compose)('the loopback override, applied by Docker Compose', () => {
  const parsed = parseComposeFile(FILE);
  if (!parsed.ok) throw new Error(parsed.reason);
  const result = renderLoopbackOverride(parsed.project, ['web']);
  if (!result.ok) throw new Error(result.reason);
  const { text } = result.override;

  it('leaves a proxied service bound to 127.0.0.1 only', { timeout: 120_000 }, () => {
    const services = merged({ 'compose.yaml': FILE, 'override.yaml': text });
    expect(services.web.ports).toEqual([
      expect.objectContaining({
        host_ip: '127.0.0.1',
        target: 80,
        published: '8080',
        protocol: 'tcp',
      }),
      expect.objectContaining({
        host_ip: '127.0.0.1',
        target: 9000,
        published: '9000',
        protocol: 'udp',
      }),
      expect.objectContaining({
        host_ip: '127.0.0.1',
        target: 9001,
        published: '9001',
        protocol: 'udp',
      }),
      expect.objectContaining({
        host_ip: '127.0.0.1',
        target: 443,
        published: '8443',
        protocol: 'tcp',
      }),
    ]);
    expect(services.db.ports).toEqual([
      expect.objectContaining({ target: 5432, published: '5432' }),
    ]);
    expect(services.db.ports?.[0].host_ip).toBeUndefined();
  });

  it('needs !override: a plain override would add to the ports and keep the public ones', {
    timeout: 120_000,
  }, () => {
    const plain = text.replace('ports: !override', 'ports:');
    expect(plain).not.toContain('ports: !override');
    const ports = merged({ 'compose.yaml': FILE, 'override.yaml': plain }).web.ports ?? [];
    expect(ports.some((port) => port.host_ip === undefined || port.host_ip === '0.0.0.0')).toBe(
      true,
    );
    expect(ports.length).toBeGreaterThan(4);
  });

  it('binds the port the stack environment resolves to', { timeout: 120_000 }, () => {
    const file = 'services:\n  web:\n    image: nginx:1.27\n    ports: ["${WEB_PORT:-8080}:80"]\n';
    const environment = { WEB_PORT: '9090' };
    const withEnv = parseComposeFile(file, { environment });
    if (!withEnv.ok) throw new Error(withEnv.reason);
    const rebind = renderLoopbackOverride(withEnv.project, ['web']);
    const dotenv = renderComposeEnv(
      Object.entries(environment).map(([key, value]) => ({ key, value })),
    );
    if (!rebind.ok || !dotenv.ok) throw new Error('could not render the files');
    const services = merged({
      'compose.yaml': file,
      'override.yaml': rebind.override.text,
      '.env': dotenv.text,
    });
    expect(services.web.ports).toEqual([
      expect.objectContaining({ host_ip: '127.0.0.1', target: 80, published: '9090' }),
    ]);
  });
});
