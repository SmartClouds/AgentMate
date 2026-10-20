import { basename, dirname, resolve } from 'node:path';
import { filesError } from '../../shared/deployFilesErrors';
import { isValidEntryName } from '../../shared/sftpNames';
import { assertPathWithinRoots } from '../pathGuard';

/**
 * Where the SFTP file manager (E25) may write on this computer. The local pane browses the
 * whole disk, but a write (new folder, rename, delete, a download's target) must land inside a
 * folder that window's pane listed recently, so a compromised renderer cannot write wherever it
 * likes by naming a path it never showed the user.
 *
 * Containment is checked on real paths (`assertPathWithinRoots`), so a junction or symlink
 * inside a listed folder that leads elsewhere is refused, and a path that does not exist yet is
 * judged by its nearest existing parent. Owners are `webContents` ids.
 *
 * Two checks, for two kinds of write. `assertWritable` is for writing into a place (a download's
 * target folder): the listed folder itself passes. `assertEntryWritable` is for changing one
 * entry (a new folder, a rename, a delete): the entry's parent must be listed or inside a listed
 * folder, so a listed folder cannot itself be deleted or renamed unless the folder holding it
 * was listed too. The entry itself is not followed, so a junction inside a listed folder can be
 * deleted or renamed without touching where it leads.
 */

/** How many listed folders each window keeps; older ones fall out. */
export const LOCAL_BROWSE_MAX_DIRS = 32;

export class LocalBrowseRegistry {
  private readonly dirs = new Map<number, string[]>();

  /** Notes that `ownerId`'s pane listed `dir`. Listing one again makes it the newest. */
  record(ownerId: number, dir: string): void {
    const resolved = resolve(dir);
    const kept = (this.dirs.get(ownerId) ?? []).filter((one) => one !== resolved);
    kept.push(resolved);
    this.dirs.set(ownerId, kept.slice(-LOCAL_BROWSE_MAX_DIRS));
  }

  /** The folders `ownerId` may write in, oldest first. */
  dirsOf(ownerId: number): string[] {
    return [...(this.dirs.get(ownerId) ?? [])];
  }

  /**
   * `path`, resolved, when it is one of `ownerId`'s listed folders or lies inside one once links
   * are followed. Otherwise `[files:invalidInput]`, without the path in the message.
   */
  async assertWritable(ownerId: number, path: string): Promise<string> {
    const roots = this.dirs.get(ownerId) ?? [];
    if (roots.length > 0) {
      try {
        return await assertPathWithinRoots(path, roots);
      } catch {
        // Falls through to the refusal below, whose words do not repeat the path.
      }
    }
    throw filesError(
      'invalidInput',
      'That place on this computer is not one the file manager has open. Open its folder first.',
    );
  }

  /**
   * `path`, resolved, when it names one entry (a plain name) of a folder that is one of
   * `ownerId`'s listed folders or lies inside one once links are followed. The entry itself is
   * not followed. Otherwise `[files:invalidInput]`, without the path in the message.
   */
  async assertEntryWritable(ownerId: number, path: string): Promise<string> {
    const resolved = resolve(path);
    const parent = dirname(resolved);
    if (parent !== resolved && isValidEntryName(basename(resolved))) {
      await this.assertWritable(ownerId, parent);
      return resolved;
    }
    throw filesError('invalidInput', 'The top of a drive or of the file system cannot be changed.');
  }

  /** Forgets a window, when it closes or its renderer goes away. */
  dropOwner(ownerId: number): void {
    this.dirs.delete(ownerId);
  }
}
