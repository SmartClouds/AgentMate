import type { BaseEntry, RemoteObservation, RemoteVerdict } from './types.js';

/**
 * How a file on an FTP or SFTP server compares with what the last deploy saw there (E23).
 *
 * The server is compared with itself: right after each upload the deploy records the size and
 * modified time the server reported for the file, and how it read them (`via`). Times from
 * different sources (an SFTP stat, an MLSD line, an MDTM reply) are not compared, since servers
 * round, shift or localize them differently.
 *
 * In order:
 * - not in the base but on the server: `untracked` (a first deploy, or someone else's file);
 * - its folder was not listed: `unknown`;
 * - the folder was listed and the file is not in it: `missing`;
 * - a different size: `changed`;
 * - both times known and read the same way: `unchanged` when equal, else `changed`;
 * - otherwise (a time missing on either side, read another way, or nothing read after the
 *   upload): `sizeOnly`, the size matches but that is all that can be said.
 */
export function judgeRemote(
  base: BaseEntry | undefined,
  current: RemoteObservation | undefined,
  folderListed: boolean,
): RemoteVerdict {
  if (!base && current) return 'untracked';
  if (!folderListed) return 'unknown';
  if (!current) return 'missing';
  // Not in the base and not on the server falls in one of the cases above.
  if (!base) return 'missing';
  // The size the server reported, which can differ from the bytes sent (an FTP server in ASCII
  // mode). With nothing read after the upload, the bytes sent stand in for it, and the verdict
  // can be no better than sizeOnly.
  const seen = base.remote;
  if (current.size !== (seen?.size ?? base.size)) return 'changed';
  if (seen && comparable(seen, current)) {
    return seen.mtimeMs === current.mtimeMs ? 'unchanged' : 'changed';
  }
  return 'sizeOnly';
}

/** Both times are known and were read the same way. */
function comparable(a: RemoteObservation, b: RemoteObservation): boolean {
  return a.mtimeMs !== null && b.mtimeMs !== null && a.via !== null && a.via === b.via;
}

const HOUR_MS = 3_600_000;
/** A time zone or DST change moves times by at most this much (UTC-12 to UTC+14). */
const MAX_SHIFT_HOURS = 26;

/**
 * Spots a server clock or time zone change: every file the deploy left there now reports a time
 * moved by the same whole number of hours, with its size unchanged. Returns that number of hours
 * (positive when the server's times moved later, `current - base`), or null when the pairs do not
 * all agree. At least two pairs are needed, so one file edited on the server an hour later is not
 * taken for a shift.
 */
export function detectUniformShift(
  pairs: readonly { base: RemoteObservation; current: RemoteObservation }[],
): number | null {
  if (pairs.length < 2) return null;
  let shift: number | null = null;
  for (const { base, current } of pairs) {
    if (base.size !== current.size || !comparable(base, current)) return null;
    // comparable() checked both times are numbers.
    const hours = ((current.mtimeMs as number) - (base.mtimeMs as number)) / HOUR_MS;
    if (!Number.isInteger(hours) || hours === 0 || Math.abs(hours) > MAX_SHIFT_HOURS) return null;
    if (shift !== null && hours !== shift) return null;
    shift = hours;
  }
  return shift;
}
