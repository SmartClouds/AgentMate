/**
 * Path math for the SFTP file manager's two panes (E25). Remote paths are always POSIX
 * (`/var/www`). Local paths are this computer's own: `C:\Users\me` and `\\nas\share` on
 * Windows, `/home/me` elsewhere. Main resolves and validates every path again; these helpers
 * only shape what the panes show and send.
 */

/** One step of the path bar: what the button says and where it goes. */
export interface Crumb {
  label: string;
  path: string;
}

interface SplitPath {
  /** `/`, `C:\` or `\\nas\share\`. */
  root: string;
  /** What the root crumb says: `/`, `C:` or `\\nas\share`. */
  rootLabel: string;
  segments: string[];
  sep: '/' | '\\';
}

const DRIVE = /^([A-Za-z]):(.*)$/s;
const UNC = /^\\\\([^\\]+)\\([^\\]+)(.*)$/s;

/** A drive path (`C:\x`, `c:/x`) or a UNC share (`\\nas\share`). */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(path) || path.startsWith('\\\\');
}

function segmentsOf(rest: string, sep: RegExp): string[] {
  return rest.split(sep).filter((segment) => segment.length > 0);
}

function split(path: string): SplitPath {
  if (isWindowsPath(path)) {
    const backslashed = path.replace(/\//g, '\\');
    const unc = backslashed.match(UNC);
    if (unc) {
      const label = `\\\\${unc[1]}\\${unc[2]}`;
      return {
        root: `${label}\\`,
        rootLabel: label,
        segments: segmentsOf(unc[3] ?? '', /\\+/),
        sep: '\\',
      };
    }
    const drive = backslashed.match(DRIVE);
    if (drive) {
      return {
        root: `${drive[1]}:\\`,
        rootLabel: `${drive[1]}:`,
        segments: segmentsOf(drive[2] ?? '', /\\+/),
        sep: '\\',
      };
    }
  }
  return { root: '/', rootLabel: '/', segments: segmentsOf(path, /\/+/), sep: '/' };
}

function build(parts: SplitPath, segments: string[]): string {
  return parts.root + segments.join(parts.sep);
}

/** Resolves `.` and `..`; a `..` at the root stays at the root. */
function normalizeSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out;
}

/** The path bar's buttons, from the root down to `path` itself. */
export function breadcrumbs(path: string): Crumb[] {
  const parts = split(path);
  const crumbs: Crumb[] = [{ label: parts.rootLabel, path: parts.root }];
  parts.segments.forEach((segment, index) => {
    crumbs.push({ label: segment, path: build(parts, parts.segments.slice(0, index + 1)) });
  });
  return crumbs;
}

/** The folder above, or null at a root. */
export function parentPath(path: string): string | null {
  const parts = split(path);
  if (parts.segments.length === 0) return null;
  return build(parts, parts.segments.slice(0, -1));
}

/** `name` inside `dir`, with the separator `dir` uses. */
export function joinPath(dir: string, name: string): string {
  const sep = split(dir).sep;
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** The last segment, or the root's own label at a root. */
export function baseName(path: string): string {
  const parts = split(path);
  return parts.segments.at(-1) ?? parts.rootLabel;
}

/** How many folders deep a remote path is: `/` is 0, `/var/www` is 2. */
export function remoteDepth(path: string): number {
  return segmentsOf(path, /\/+/).length;
}

/** Whether two paths of one side name the same folder. Windows paths ignore case. */
export function samePath(a: string, b: string): boolean {
  const left = split(a);
  const right = split(b);
  const windows = left.sep === '\\';
  const one = build(left, left.segments);
  const two = build(right, right.segments);
  return windows ? one.toLowerCase() === two.toLowerCase() : one === two;
}

/**
 * What a path typed into the remote path bar means. `~` and `~/x` go to the server as they are
 * (main expands them); anything else is made absolute against `cwd` and normalized. Null for
 * empty input.
 */
export function resolveRemoteInput(input: string, cwd: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  if (text === '~' || text.startsWith('~/')) return text;
  const combined = text.startsWith('/') ? text : `${cwd}/${text}`;
  return `/${normalizeSegments(segmentsOf(combined, /\/+/)).join('/')}`;
}

/**
 * What a path typed into the local path bar means: an absolute path normalized (with the drive
 * letter upper-cased on Windows), or a relative one resolved against `cwd`. Null for empty input.
 */
export function resolveLocalInput(input: string, cwd: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  const cwdParts = split(cwd);
  let combined: string;
  if (isWindowsPath(text)) combined = text;
  else if (cwdParts.sep === '\\' && /^[\\/](?![\\/])/.test(text)) {
    // `\temp` on Windows: the root of the current drive.
    combined = cwdParts.root + text.slice(1);
  } else if (cwdParts.sep === '/' && text.startsWith('/')) combined = text;
  else combined = joinPath(cwd, text);
  const parts = split(combined);
  if (parts.sep === '\\' && /^[a-z]:/.test(parts.root)) {
    parts.root = parts.root[0]?.toUpperCase() + parts.root.slice(1);
  }
  return build(parts, normalizeSegments(parts.segments));
}
