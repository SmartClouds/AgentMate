import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type ListeningSocket,
  parseLsofListening,
  parseNetstatListening,
  parseSsListening,
} from '@runova/core';

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // lsof exits 1 when nothing matches but still prints what it found.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

async function readListening(): Promise<ListeningSocket[]> {
  if (process.platform === 'win32') {
    return parseNetstatListening(await run('netstat', ['-ano']));
  }
  if (process.platform === 'darwin') {
    return parseLsofListening(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']));
  }
  return parseSsListening(await run('ss', ['-ltnpH']));
}

let inflight: Promise<Map<number, number[]>> | null = null;

/**
 * Every TCP port being listened on, by the pid that owns it, sorted. Never throws: a machine
 * without the tool gives an empty map. Callers asking at the same time share one read.
 */
export function sampleListeningPorts(): Promise<Map<number, number[]>> {
  inflight ??= readListening()
    .then((sockets) => {
      const byPid = new Map<number, number[]>();
      for (const { pid, port } of sockets) {
        const ports = byPid.get(pid);
        if (ports) {
          if (!ports.includes(port)) ports.push(port);
        } else {
          byPid.set(pid, [port]);
        }
      }
      for (const ports of byPid.values()) ports.sort((a, b) => a - b);
      return byPid;
    })
    .catch(() => new Map<number, number[]>())
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
