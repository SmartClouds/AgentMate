import { filesError } from '../../shared/deployFilesErrors';
import { joinRemote, normalizeRemote } from '../deploy/files/transport/remotePath';

/**
 * Remote paths as the SFTP file manager (E25) takes them from the renderer. Path math itself is
 * Deploy's (main/deploy/files/transport/remotePath.ts); this adds what a typed path bar needs.
 * Refusals name what was wrong, never the path, since it came from the renderer.
 */

/**
 * What the user typed in the remote path bar, as an absolute normalized path: `~` and `~/x`
 * start at `home`, anything not starting with `/` is relative to `cwd` (the folder the pane
 * shows), `..` stops at `/`, and nothing at all means `cwd`. `~name` is only a name, since
 * another user's home cannot be looked up over SFTP. Spaces are kept as they are.
 *
 * Callers pass the pane's folder as `cwd`, or `home` again when there is none yet.
 * Throws `[files:invalidInput]` on a NUL byte.
 */
export function resolveRemoteInput(input: string, cwd: string, home: string): string {
  if (input.includes('\0')) throw filesError('invalidInput', 'A path cannot contain a NUL byte.');
  if (input === '') return normalizeRemote(cwd);
  if (input === '~') return normalizeRemote(home);
  if (input.startsWith('~/')) return joinRemote(home, input.slice(2));
  if (input.startsWith('/')) return normalizeRemote(input);
  return joinRemote(cwd, input);
}

/** `path` normalized, or `[files:invalidInput]` unless it is absolute and free of NUL bytes. */
export function assertRemoteAbsolute(path: string): string {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw filesError('invalidInput', 'A remote path must be absolute, starting with /.');
  }
  return normalizeRemote(path);
}
