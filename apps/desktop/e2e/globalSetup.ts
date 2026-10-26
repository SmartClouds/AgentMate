import { execSync } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, E2E_OUT_DIR, MAIN_LOG_DIR } from './paths';

/**
 * Builds the app into its own folder so a running `electron-vite dev` (which owns `out/`) is left
 * alone. Set RUNOVA_E2E_SKIP_BUILD=1 to reuse the last build while iterating on a test.
 */

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A rename Windows can refuse for a moment. Removing a folder there only marks it for deletion
 * while a scanner, a file watcher or a just-closed process still holds a handle, and the rename
 * onto that name then fails with EPERM. Retrying gets past it; copying is the fallback, since a
 * copy does not need the old name released.
 */
function moveDirectory(from: string, to: string): void {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(to, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!retryable.has(code)) throw error;
      sleepSync(250);
    }
  }

  cpSync(from, to, { recursive: true, force: true });
  rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export default function globalSetup(): void {
  // Playwright only sweeps its own output folder, so last run's app logs are cleared here.
  rmSync(MAIN_LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (process.env.RUNOVA_E2E_SKIP_BUILD === '1' && existsSync(join(E2E_OUT_DIR, 'main'))) {
    return;
  }
  rmSync(E2E_OUT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  execSync('pnpm exec electron-vite build --outDir out-e2e', { cwd: APP_ROOT, stdio: 'inherit' });

  // The renderer's root is src/renderer, so its outDir resolves under there. Main loads it from
  // ../renderer next to itself, which is where it has to end up.
  const rendererBuild = join(APP_ROOT, 'src', 'renderer', 'out-e2e');
  if (existsSync(join(rendererBuild, 'renderer'))) {
    moveDirectory(join(rendererBuild, 'renderer'), join(E2E_OUT_DIR, 'renderer'));
  }
  rmSync(rendererBuild, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (!existsSync(join(E2E_OUT_DIR, 'renderer', 'index.html'))) {
    throw new Error('e2e build has no renderer/index.html');
  }
}
