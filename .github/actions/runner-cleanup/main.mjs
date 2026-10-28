// Points TMPDIR (and TMP, TEMP) at a new folder for this job, which post.mjs deletes when the job
// ends. Tests make temp folders all the time, and a test that fails, times out or is cancelled
// leaves its folders behind. On the Mac this also keeps them out of its user's own temp folder.
//
// Also moves pnpm's store out of the folder pnpm/action-setup installs pnpm into. The action
// deletes that whole folder before every install, and pnpm keeps its store in $PNPM_HOME/store,
// which the action points inside it. So every job started with an empty store, downloaded all
// 1,370 packages again and spent minutes deleting the last job's copy first. That was enough to
// time out the install on a runner with a slow disk.

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

try {
  const skip = skipReason();
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

if (!skipReason()) {
  try {
    // Beside setup-pnpm in this runner's own tool cache, so each runner on a machine still has a
    // store of its own. It has to be set before Setup pnpm runs, which every job does after this.
    const storeDir = join(process.env.RUNNER_TOOL_CACHE, 'pnpm-store');
    appendFileSync(process.env.GITHUB_ENV, `pnpm_config_store_dir=${storeDir}\n`);
    console.log(`pnpm's store is ${storeDir}.`);
  } catch (error) {
    // pnpm falls back to a store Setup pnpm deletes, so the install only downloads more.
    warn(`Could not keep pnpm's store between jobs: ${error.message}`);
  }
}
