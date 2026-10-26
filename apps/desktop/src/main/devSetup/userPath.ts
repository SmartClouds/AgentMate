import { type DevOs, LEGACY_DEV_SETUP_END, LEGACY_DEV_SETUP_MARKER } from '@runova/core';

/**
 * Putting a folder on the user's PATH, so a tool Runova installs (Flutter) also works in a
 * terminal opened later outside the app. This is the one place Dev Setup edits something that is
 * not its own, so it is deliberately careful:
 *
 * - On Windows it edits the user's registry PATH in place and keeps every existing entry as it
 *   was, including ones that refer to other variables (`%JAVA_HOME%\bin`). `setx` is not used
 *   because it cuts the value at 1024 characters, and PowerShell's setter rewrites the value type
 *   and flattens those references.
 * - On macOS and Linux it adds one marked block to the shell's startup file, once.
 * - A folder with a character that could break the line it is written into is refused.
 */

export interface UserPathDeps {
  os: DevOs;
  home: string;
  /** `$SHELL`, which decides the startup file off Windows. */
  shell?: string;
  /** The raw user PATH from the registry, with its `%VAR%` references unexpanded. Null if unset. */
  readRegistryPath: () => Promise<string | null>;
  writeRegistryPath: (value: string) => Promise<void>;
  /** Tells Windows the environment changed, so programs started afterwards see it. */
  broadcastEnvironmentChange: () => Promise<void>;
  /** Also puts the folder on the PATH this app is running with. */
  addToProcessPath: (dir: string) => void;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, text: string) => Promise<void>;
}

export interface UserPathResult {
  changed: boolean;
  /** Where it was written, for the sentence that says so. */
  where: string;
}

const REFUSED = 'That folder cannot go on the PATH.';
/** An absolute Windows path with nothing in it that would split, expand or end the entry. */
const SAFE_WINDOWS_DIR = /^[A-Za-z]:\\[^"%;<>|\r\n\0]+$/;
/** An absolute POSIX path with nothing a shell would treat as syntax inside double quotes. */
const SAFE_POSIX_DIR = /^\/[^"$`\\\r\n\0]+$/;

/** The raw PATH value out of `reg query HKCU\Environment /v Path`, or null if there is none. */
export function parseRegistryPath(output: string): string | null {
  const value = /\bPath[ \t]+REG_(?:EXPAND_)?SZ[ \t]+(.*)/i.exec(output)?.[1]?.trim();
  return value ? value : null;
}

function sameWindowsEntry(a: string, b: string): boolean {
  const normalize = (entry: string): string =>
    entry
      .trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return normalize(a) === normalize(b);
}

async function addOnWindows(dir: string, deps: UserPathDeps): Promise<UserPathResult> {
  const where = 'your user PATH';
  const current = (await deps.readRegistryPath()) ?? '';
  // A quote in the value does not survive being passed back through reg.exe unchanged, and a
  // PATH that is quietly damaged is far worse than one the person adds a folder to by hand.
  if (current.includes('"')) {
    throw new Error(
      'Your PATH has an entry in quotes, which this cannot safely rewrite. Add the folder by hand.',
    );
  }
  const entries = current.split(';').filter((entry) => entry.trim() !== '');

  deps.addToProcessPath(dir);
  if (entries.some((entry) => sameWindowsEntry(entry, dir))) return { changed: false, where };

  await deps.writeRegistryPath([...entries, dir].join(';'));
  try {
    await deps.broadcastEnvironmentChange();
  } catch {
    // The value is saved either way. Without the broadcast, programs already running just do not
    // see it until they are restarted, which is also true of every other PATH edit.
  }
  return { changed: true, where };
}

const END_MARKER = '# <<< Runova Dev Setup <<<';

/**
 * A block written before the app was renamed carries the old name. It is renamed where it stands
 * instead of getting a second block beside it. Null when there is none for `dir`.
 */
function renameLegacyBlock(text: string, dir: string, marker: string): string | null {
  const legacyMarker = `${LEGACY_DEV_SETUP_MARKER}: ${dir} >>>`;
  const start = text.indexOf(legacyMarker);
  if (start === -1) return null;
  const end = text.indexOf(LEGACY_DEV_SETUP_END, start);
  const block =
    end === -1
      ? text.slice(start, start + legacyMarker.length)
      : text.slice(start, end + LEGACY_DEV_SETUP_END.length);
  const next = block.replace(legacyMarker, marker).replace(LEGACY_DEV_SETUP_END, END_MARKER);
  return text.slice(0, start) + next + text.slice(start + block.length);
}

function startupFile(deps: UserPathDeps): string {
  const shell = (deps.shell ?? '').split('/').pop() ?? '';
  if (shell === 'zsh') return `${deps.home}/.zshrc`;
  if (shell === 'bash') return `${deps.home}/.bashrc`;
  return `${deps.home}/.profile`;
}

async function addOnPosix(dir: string, deps: UserPathDeps): Promise<UserPathResult> {
  const file = startupFile(deps);
  const marker = `# >>> Runova Dev Setup: ${dir} >>>`;
  const existing = (await deps.readFile(file)) ?? '';

  deps.addToProcessPath(dir);
  if (existing.includes(marker)) return { changed: false, where: file };
  const renamed = renameLegacyBlock(existing, dir, marker);
  if (renamed !== null) {
    await deps.writeFile(file, renamed);
    return { changed: false, where: file };
  }

  // Written with $HOME where it applies, so the line still works if the home folder is moved.
  const inHome = dir.startsWith(`${deps.home}/`) ? `$HOME/${dir.slice(deps.home.length + 1)}` : dir;
  const block = ['', marker, `export PATH="${inHome}:$PATH"`, END_MARKER, ''];
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await deps.writeFile(file, `${existing}${separator}${block.join('\n')}`);
  return { changed: true, where: file };
}

/**
 * Adds `dir` to the user's PATH. Resolves with whether anything changed (adding what is already
 * there is a quiet no-op) and where it was written.
 */
export async function addToUserPath(dir: string, deps: UserPathDeps): Promise<UserPathResult> {
  const safe = deps.os === 'win32' ? SAFE_WINDOWS_DIR : SAFE_POSIX_DIR;
  if (!safe.test(dir)) throw new Error(REFUSED);
  return deps.os === 'win32' ? addOnWindows(dir, deps) : addOnPosix(dir, deps);
}
