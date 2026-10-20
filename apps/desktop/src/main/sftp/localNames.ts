import { isAbsolute, relative, resolve, sep } from 'node:path';
import { filesError } from '../../shared/deployFilesErrors';

/**
 * Names that come from a server, made fit for this computer (E25). A server can send any byte but
 * the slash in a name, so a download never trusts one: Windows refuses `<>:"/\|?*`, control
 * characters, device names like `CON` and trailing dots or spaces, and every path a download
 * writes is checked to be inside the folder the user picked.
 */

/** What Windows refuses in a name: its reserved characters and the control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it matches.
const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is one of the two it matches.
const POSIX_ILLEGAL = /[/\u0000]/g;
/** Device names Windows keeps for itself, alone or with any extension (`nul.txt`). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

export interface SafeLocalName {
  name: string;
  /** The name had to be changed. */
  changed: boolean;
}

/**
 * `name` as it can be written on `platform`. On Windows `a:b` becomes `a_b`, `CON` becomes `CON_`
 * (and `nul.txt` becomes `nul_.txt`), and trailing dots and spaces go. On POSIX only the slash and
 * NUL are replaced. `.`, `..` and a name left empty become `_`, so the result is always one entry.
 */
export function safeLocalName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): SafeLocalName {
  let safe: string;
  if (platform === 'win32') {
    safe = name.replace(WINDOWS_ILLEGAL, '_').replace(TRAILING_DOTS_AND_SPACES, '');
    const reserved = safe.match(WINDOWS_RESERVED);
    if (reserved) safe = `${reserved[1]}_${reserved[2] ?? ''}`;
  } else {
    safe = name.replace(POSIX_ILLEGAL, '_');
  }
  if (safe === '' || safe === '.' || safe === '..') safe = '_';
  return { name: safe, changed: safe !== name };
}

/**
 * `child` resolved, when it is strictly inside `root`; throws `[files:invalidInput]` otherwise,
 * the folder itself included. Neither path is named in the error.
 */
export function assertContained(child: string, root: string): string {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(child);
  const path = relative(resolvedRoot, resolvedChild);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw filesError(
      'invalidInput',
      'A name from the server would put a file outside the folder you picked, so it was not written.',
    );
  }
  return resolvedChild;
}
