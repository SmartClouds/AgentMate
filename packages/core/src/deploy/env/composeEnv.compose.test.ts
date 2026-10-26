import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderComposeEnv } from './composeEnv.js';

/**
 * The rendered .env read back by Compose itself, both as a service's env_file and as the
 * project's interpolation file. Skipped where Docker Compose is not installed.
 */
const compose = (() => {
  const probe = spawnSync('docker', ['compose', 'version', '--short'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return probe.status === 0;
})();

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** The environment Compose runs with: ours, minus anything that could change what it reads. */
function composeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('COMPOSE_') && !name.startsWith('E07_')) env[name] = value;
  }
  return env;
}

const TRICKY = [
  'plain',
  '',
  ' leading and trailing ',
  'with $dollar, $${braced} and ${HOME} and a lone $',
  `quote " single ' backtick \` and back\\slash`,
  'line1\nline2\r\nline3',
  'tab\there',
  'trailing backslash\\',
  '\\n is two characters here',
  '\\"',
  '\u0001\u001b[31mred\u007f',
  'ünïcødé 🚀',
  '#not a comment',
  'a # b',
  '\\0123 and \\x41 stay as written',
  '  \u0085',
  "it's \\' tricky",
  '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
];

describe.runIf(compose)('Compose reads a rendered .env back exactly', () => {
  it('as env_file and as interpolation values', { timeout: 120_000 }, () => {
    let state = 7;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const alphabet = [...'aZ09 =#\'"`$\\{}:;-_', '\n', '\r', '\t', '\u0002', 'é', '例', '🚀'];
    const values = [...TRICKY];
    for (let i = 0; i < 150; i++) {
      const length = Math.floor(random() * 24);
      values.push(
        Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join(''),
      );
    }
    const entries = values.map((value, index) => ({ key: `E07_V${index}`, value }));
    const result = renderComposeEnv(entries);
    if (!result.ok) throw new Error(result.reason);

    const folder = mkdtempSync(join(tmpdir(), 'runova-e07-env-'));
    folders.push(folder);
    writeFileSync(join(folder, '.env'), result.text);
    const environment = entries.map(({ key }) => `      I_${key}: "\${${key}}"`).join('\n');
    writeFileSync(
      join(folder, 'compose.yaml'),
      `services:\n  probe:\n    image: busybox\n    env_file: [.env]\n    environment:\n${environment}\n`,
    );

    const output = execFileSync(
      'docker',
      ['compose', '--project-name', 'e07-env', 'config', '--format', 'json'],
      { cwd: folder, encoding: 'utf8', env: composeEnvironment(), timeout: 90_000 },
    );
    const seen: Record<string, string> = JSON.parse(output).services.probe.environment;
    // `config` writes every $ as $$ so that its output is itself a valid compose file.
    const undouble = (text: string | undefined) => text?.replaceAll('$$', '$');
    for (const { key, value } of entries) {
      expect(undouble(seen[key]), `env_file ${key} ${JSON.stringify(value)}`).toBe(value);
      expect(undouble(seen[`I_${key}`]), `interpolated ${key} ${JSON.stringify(value)}`).toBe(
        value,
      );
    }
  });
});
