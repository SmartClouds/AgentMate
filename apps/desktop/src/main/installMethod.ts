import { constants, existsSync } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { getExtraToolPathDirs, pythonScriptDirs } from './toolPaths';
import { pathKey } from './windowsPath';

/**
 * How an installed CLI got onto this machine, worked out from where its executable lives.
 *
 * The catalog now installs most CLIs with the vendor's own installer, but plenty of people still
 * have the copy they put there with npm, Homebrew or pip a year ago. Re-running the vendor's
 * install script over one of those leaves two copies side by side, and whichever comes first on
 * PATH wins, so "Update" would seem to do nothing. Knowing the manager lets the update and
 * uninstall buttons talk to the tool that owns the copy that is actually being run.
 */
export type InstallManager =
  | { kind: 'brew'; name: string }
  | { kind: 'npm'; pkg: string }
  | { kind: 'pip' }
  | null;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the first of `names` lives, looked up the way the shell would, without starting it. PATH
 * is searched first, then the folders native installers and pip use that PATH often misses, so
 * a copy the user put on PATH deliberately still wins.
 */
export async function resolveExecutable(names: string[]): Promise<string | null> {
  const pathDirs = (process.env[pathKey(process.env)] ?? '').split(delimiter).filter(Boolean);
  const dirs = [...pathDirs, ...(await getExtraToolPathDirs())];
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const unique = [...new Set(names.filter(Boolean))];
  for (const dir of dirs) {
    for (const name of unique) {
      for (const ext of extensions) {
        const candidate = join(dir, name + ext);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** `@scope/name` or `name`, out of the last `node_modules/...` in a path. */
function lastNodeModulesPackage(path: string): string | null {
  const pattern = /[\\/]node_modules[\\/]((?:@[^\\/"']+[\\/])?[^\\/"']+)/g;
  let pkg: string | null = null;
  for (const match of path.matchAll(pattern)) {
    const name = (match[1] ?? '').replace(/\\/g, '/');
    if (name && name !== '.bin') pkg = name;
  }
  return pkg;
}

/** Shims are a few hundred bytes. Anything bigger is the real binary and not worth reading. */
const MAX_SHIM_BYTES = 64 * 1024;

/**
 * On Windows npm does not symlink: it writes `claude.cmd`, `claude.ps1` and an extensionless sh
 * script next to a `node_modules` folder, each pointing at the package inside it. realpath gets
 * nothing out of those, so the shim's own text is read to find the package.
 */
async function npmShimPackage(executablePath: string): Promise<string | null> {
  const dir = dirname(executablePath);
  if (!existsSync(join(dir, 'node_modules'))) return null;
  const ext = extname(executablePath);
  const stem = ext ? basename(executablePath, ext) : basename(executablePath);
  const candidates = [executablePath, ...['.cmd', '.ps1', ''].map((one) => join(dir, stem + one))];
  for (const candidate of [...new Set(candidates)]) {
    if (!['', '.cmd', '.ps1'].includes(extname(candidate).toLowerCase())) continue;
    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size > MAX_SHIM_BYTES) continue;
      const pkg = lastNodeModulesPackage(await readFile(candidate, 'utf-8'));
      if (pkg && existsSync(join(dir, 'node_modules', ...pkg.split('/')))) return pkg;
    } catch {
      // A shim that vanished or cannot be read just means this was not npm's.
    }
  }
  return null;
}

function normalizeDir(dir: string): string {
  const trimmed = dir.trim().replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Which package manager owns the executable at `executablePath`, or null for anything else. */
export async function installManagerOf(executablePath: string): Promise<InstallManager> {
  let real = executablePath;
  try {
    real = await realpath(executablePath);
  } catch {
    // A dangling link still has a useful path to look at.
  }
  // node_modules is checked before the Homebrew folders: an npm global under a Homebrew Node can
  // live inside Cellar/node, and npm is what owns that copy.
  const pkg = lastNodeModulesPackage(real);
  if (pkg) return { kind: 'npm', pkg };
  const brew = /[\\/](?:Cellar|Caskroom)[\\/]([^\\/]+)[\\/]/.exec(real);
  if (brew?.[1]) return { kind: 'brew', name: brew[1] };
  const shimPkg = await npmShimPackage(executablePath);
  if (shimPkg) return { kind: 'npm', pkg: shimPkg };
  const scriptDirs = new Set((await pythonScriptDirs()).map(normalizeDir));
  if (
    scriptDirs.has(normalizeDir(dirname(executablePath))) ||
    scriptDirs.has(normalizeDir(dirname(real)))
  ) {
    return { kind: 'pip' };
  }
  return null;
}

/**
 * Whether Grok was installed with npm. Its npm package copies the real binary into ~/.grok/bin
 * (or $GROK_HOME/bin), so the copy on PATH looks native and only `installer = "npm"` in Grok's
 * config.toml tells. That matters on Windows: `grok update` then runs `npm view`, but npm is
 * npm.cmd there and Grok's updater can't start it, so it fails with "program not found".
 */
export async function grokInstalledWithNpm(
  grokHome = process.env.GROK_HOME || join(homedir(), '.grok'),
): Promise<boolean> {
  try {
    const config = await readFile(join(grokHome, 'config.toml'), 'utf-8');
    return /^\s*installer\s*=\s*["']npm["']/m.test(config);
  } catch {
    return false;
  }
}

/**
 * First words of a catalog command that just downloads and re-runs the vendor's installer. Run
 * over an npm or pip copy, that installs a second copy rather than updating the first.
 */
const INSTALLER_SCRIPT_WORDS = new Set([
  'curl',
  'wget',
  'irm',
  'iwr',
  'invoke-webrequest',
  'invoke-restmethod',
  'powershell',
  'pwsh',
]);

/** First words of a catalog uninstall that deletes files by hand or runs a removal script. */
const MANUAL_REMOVAL_WORDS = new Set([
  ...INSTALLER_SCRIPT_WORDS,
  'rm',
  'remove-item',
  'del',
  'rd',
  'rmdir',
]);

/**
 * First words of a catalog command that goes through a package manager, keyed to the manager kind
 * it belongs to. A catalog that says `pipx upgrade semgrep` is no help for a copy pip installed:
 * pipx answers that semgrep isn't installed.
 */
const PACKAGE_MANAGER_WORDS: Record<string, string> = {
  npm: 'npm',
  pnpm: 'other',
  yarn: 'other',
  bun: 'other',
  pip: 'pip',
  pip3: 'pip',
  python: 'pip',
  python3: 'pip',
  py: 'pip',
  pipx: 'other',
  uv: 'other',
  brew: 'brew',
  winget: 'other',
  choco: 'other',
  scoop: 'other',
  cargo: 'other',
};

function firstWord(command: string): string {
  return (command.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

function isInstallerRerun(command: string | null): boolean {
  return command === null || INSTALLER_SCRIPT_WORDS.has(firstWord(command));
}

/** True when the catalog command goes through a different package manager than `kind`. */
function usesOtherManager(command: string | null, kind: 'npm' | 'pip'): boolean {
  if (command === null) return false;
  const manager = PACKAGE_MANAGER_WORDS[firstWord(command)];
  return manager !== undefined && manager !== kind;
}

export interface ManagedCommandInput {
  /** The catalog's command for this OS, or null when it has none. */
  catalogCommand: string | null;
  manager: InstallManager;
  /** The PyPI name, for a pip copy whose catalog update is the vendor's installer. */
  pypiPackage?: string;
}

/**
 * The update command to type for a CLI, given the catalog's and whoever owns the installed copy.
 * Self-updaters (`claude update`, `pi update --self`) already handle npm copies and often run
 * follow-up steps, so they are kept. An installer re-run, or a different package manager than the
 * one that owns the copy, is swapped out: the first would leave the old copy in place and still
 * first on PATH, the second would not find it at all.
 */
export function updateCommandFor({
  catalogCommand,
  manager,
  pypiPackage,
}: ManagedCommandInput): string | null {
  if (!manager) return catalogCommand;
  // Homebrew pins the files it installed, and a self-updater run against them is a no-op.
  if (manager.kind === 'brew') return `brew upgrade ${manager.name}`;
  if (!isInstallerRerun(catalogCommand) && !usesOtherManager(catalogCommand, manager.kind)) {
    return catalogCommand;
  }
  if (manager.kind === 'npm') return `npm install -g ${manager.pkg}@latest`;
  if (pypiPackage) return `python -m pip install --upgrade ${pypiPackage}`;
  return catalogCommand;
}

/**
 * The command that puts a fresh copy over one that is found but will not start. The CLI's own
 * updater is no use there, since it is the thing that cannot run, so a package manager copy is
 * reinstalled through that manager and anything else gets the catalog's install command again.
 */
export function reinstallCommandFor({
  catalogCommand,
  manager,
  pypiPackage,
}: ManagedCommandInput): string | null {
  if (!manager) return catalogCommand;
  if (manager.kind === 'brew') return `brew reinstall ${manager.name}`;
  if (manager.kind === 'npm') return `npm install -g ${manager.pkg}@latest`;
  if (pypiPackage) return `python -m pip install --force-reinstall ${pypiPackage}`;
  return catalogCommand;
}

/** Same idea as updateCommandFor, for the uninstall button. */
export function uninstallCommandFor({
  catalogCommand,
  manager,
  pypiPackage,
}: ManagedCommandInput): string | null {
  if (!manager) return catalogCommand;
  if (manager.kind === 'brew') return `brew uninstall ${manager.name}`;
  const swap =
    catalogCommand === null ||
    MANUAL_REMOVAL_WORDS.has(firstWord(catalogCommand)) ||
    usesOtherManager(catalogCommand, manager.kind);
  if (!swap) return catalogCommand;
  if (manager.kind === 'npm') return `npm uninstall -g ${manager.pkg}`;
  if (pypiPackage) return `python -m pip uninstall -y ${pypiPackage}`;
  return catalogCommand;
}
