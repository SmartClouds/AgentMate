#!/usr/bin/env node
/**
 * Fails when the app's name from before the rename to Runova shows up where it shouldn't.
 *
 * The old name still has to appear in a few places: installs from before the rename (servers,
 * WordPress sites, users' projects, encrypted data) use it, and the code that reads or moves
 * them has to spell it. Those places say so, and a line that spells the old name passes when:
 *
 * - it carries the marker `legacy-name`, or
 * - it also says Runova (prose like "Runova used to be called ..."), or
 * - its file is one of the legacy names modules (`legacyNames.ts`, `LegacyNames.cs`,
 *   `Legacy.php` and the like), lives under `rebrand/`, or under a folder called `legacy/`.
 *
 * Everything else is a slip, usually code written before the rename and merged after it.
 *
 *   node scripts/check-legacy-names.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OLD_NAME = /agentmat/i; // legacy-name
const MARKER = 'legacy-name';
const BINARY =
  /\.(png|jpe?g|gif|webp|ico|icns|zip|gz|tgz|woff2?|ttf|otf|eot|pdf|mp[34]|wav|ogg|webm|onnx|bin|db|sqlite|jar|exe|dll|so|dylib|wasm|pfx|p12|der)$/i;
const LEGACY_FILE = /legacy[A-Za-z]*\.[A-Za-z]+$|\/rebrand\/|(^|\/)legacy\//i;

const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 1 << 28 })
  .toString('utf8')
  .split('\0')
  .filter((path) => path && !BINARY.test(path) && !LEGACY_FILE.test(path));

const problems = [];
for (const path of files) {
  let text;
  try {
    text = readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    continue;
  }
  if (!OLD_NAME.test(text)) continue;
  text.split('\n').forEach((line, index) => {
    if (OLD_NAME.test(line) && !line.includes(MARKER) && !/runova/i.test(line)) {
      problems.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`The old app name appears ${problems.length} time(s) without a reason:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nUse Runova, or if the old name is needed for an install from before the rename, put it in a legacy names module or mark the line with legacy-name.',
  );
  process.exit(1);
}
console.log('No stray uses of the old app name.');
