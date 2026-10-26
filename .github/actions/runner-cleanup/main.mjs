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
