import { afterEach, vi } from 'vitest';
import { resetElectronMock } from './electronMock';
import { resetInvokedChannels } from './ipcHarness';

/** Runs before every main-process test file. Keeps state from leaking between them. */

// The better-sqlite3 shim runs on node:sqlite, and Node 22 (what CI runs) prints an
// ExperimentalWarning for it once per worker. That is expected here, so only that one is dropped.
// This file runs again for every test file in the same process, hence the flag.
const sqliteWarningFiltered = Symbol.for('runova.test.sqliteWarningFiltered');
const marked = process as unknown as Record<symbol, boolean>;
if (!marked[sqliteWarningFiltered]) {
  marked[sqliteWarningFiltered] = true;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const first = rest[0];
    const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && String(warning).startsWith('SQLite')) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}

afterEach(() => {
  resetElectronMock();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The channel coverage record is per file, not per test.
resetInvokedChannels();
