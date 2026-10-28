// Points TMPDIR (and TMP, TEMP) at a new folder for this job, which post.mjs deletes when the job
// ends. Tests make temp folders all the time, and a test that fails, times out or is cancelled
// leaves its folders behind. On the Mac this also keeps them out of its user's own temp folder.

import { appendFileSync, mkdtempSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_TEMP_PREFIX,
  removeTree,
  skipReason,
  TEMP_PREFIX,
  TEMP_ROOT,
  warn,
} from './shared.mjs';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const skip = skipReason();

// pnpm's store has to live somewhere that survives the job. pnpm/action-setup sets PNPM_HOME to
// <dest>/node_modules/.bin, which puts pnpm's default store inside <dest>, and it deletes <dest>
// before every install. So every job started with an empty store and downloaded all ~1,400
// packages again (about 1 GB on the Mac), and one slow registry response stalled the whole job.
// The tool cache is per runner, so two runners on one machine never share a store. The extra
// fetch retries are for the cold store after a runner is set up again, when everything downloads.
if (!skip) {
  try {
    const store = join(process.env.RUNNER_TOOL_CACHE, 'pnpm-store');
    appendFileSync(
      process.env.GITHUB_ENV,
      `pnpm_config_store_dir=${store}\npnpm_config_fetch_retries=5\n`,
    );
    console.log(`pnpm's store is ${store}.`);
  } catch (error) {
    warn(`Could not move pnpm's store out of the setup folder: ${error.message}`);
  }
}

try {
  if (skip) {
    console.log(`Nothing to do: ${skip}`);
  } else {
    const root = realpathSync(TEMP_ROOT);

    // A job whose runner died never ran its post step. No job runs this long, so a folder this
    // old cannot belong to a job that is still running on another runner of the same machine.
    for (const name of readdirSync(root)) {
      if (!name.startsWith(TEMP_PREFIX) && !name.startsWith(LEGACY_TEMP_PREFIX)) continue;
      const path = join(root, name);
      try {
        const stats = statSync(path);
        if (stats.uid !== process.getuid()) continue;
        if (Date.now() - stats.mtimeMs < STALE_AFTER_MS) continue;
      } catch {
        continue;
      }
      if (removeTree(path)) console.log(`Deleted ${path}, left behind by an earlier job.`);
    }

    const tmp = mkdtempSync(join(root, TEMP_PREFIX));
    appendFileSync(process.env.GITHUB_ENV, `TMPDIR=${tmp}\nTMP=${tmp}\nTEMP=${tmp}\n`);
    appendFileSync(process.env.GITHUB_STATE, `tmpdir=${tmp}\n`);
    console.log(`This job's temp folder is ${tmp}.`);
  }
} catch (error) {
  // The job runs fine on the default temp folder, it only leaves more behind.
  warn(`Could not give the job its own temp folder: ${error.message}`);
}
