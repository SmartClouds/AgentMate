import { join, sep } from 'node:path';
import { utilityProcess } from 'electron';
import type { HostProcess } from './hostClient';

/**
 * Only what a request needs from the environment. The process runs scripts from collections the
 * user imported, and those should not find API keys or tokens the app was started with.
 */
const PASSED_ENV = [
  'PATH',
  'Path',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
];

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function entryPath(): string {
  // Loaded from inside the archive in packaged builds: unlike a worker thread, a utility process
  // reads asar, and staying inside it is what lets the runtime find its node_modules.
  const bundled = join(__dirname, 'apiRunnerHost.mjs');
  return bundled.replace(`app.asar.unpacked${sep}`, `app.asar${sep}`);
}

export function spawnRunnerHost(): HostProcess {
  return utilityProcess.fork(entryPath(), [], {
    serviceName: 'Runova API Client',
    env: scrubbedEnv(),
    execArgv: ['--no-deprecation'],
    stdio: 'ignore',
  });
}
