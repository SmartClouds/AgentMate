/**
 * Names in the SFTP file manager (E25), shared by main (the transfer engine's "Keep both") and
 * the renderer (the inline new folder and rename fields).
 */

/** Longest name most file systems take for one entry (NAME_MAX), counted in UTF-8 bytes. */
const MAX_NAME_BYTES = 255;
/** How many numbers `nextFreeName` tries before it gives up. */
const MAX_ATTEMPTS = 10_000;
/** A number the name already carries, like the ` (2)` in `report (2)`. */
const NUMBERED = / \((\d+)\)$/;

/**
 * Splits a name into what the number goes after and the extension it goes before. A leading dot
 * belongs to the name (`.env` has no extension), `.tar.*` stays together (`a.tar.gz`), and
 * anything else splits at the last dot.
 */
function splitName(name: string): { stem: string; extension: string } {
  const last = name.lastIndexOf('.');
  if (last <= 0 || last === name.length - 1) return { stem: name, extension: '' };
  const tar = name.lastIndexOf('.', last - 1);
  if (tar > 0 && name.slice(tar, last).toLowerCase() === '.tar') {
    return { stem: name.slice(0, tar), extension: name.slice(tar) };
  }
  return { stem: name.slice(0, last), extension: name.slice(last) };
}

/**
 * `name` itself when nothing has it yet, otherwise the first free `stem (N).ext`, counting up
 * from 1 or from the number the name already carries (`report (1).pdf` gives `report (2).pdf`).
 *
 * `taken` is the set of names already in the folder, or a predicate for a lookup a set cannot
 * express, such as a case-insensitive Windows folder. Throws when no free name turns up, which
 * only a predicate that answers yes to everything can cause.
 */
export function nextFreeName(
  name: string,
  taken: ReadonlySet<string> | ((candidate: string) => boolean),
): string {
  const isTaken = typeof taken === 'function' ? taken : (candidate: string) => taken.has(candidate);
  if (!isTaken(name)) return name;
  const { stem, extension } = splitName(name);
  const base = stem.replace(NUMBERED, '');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const candidate = `${base} (${attempt})${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`No free name like ${name} was found after ${MAX_ATTEMPTS} tries.`);
}

/**
 * Whether `name` can be one entry in a folder, on the server or on this computer: not empty,
 * not `.` or `..`, no slash or backslash, no NUL, and at most 255 bytes of UTF-8. Characters
 * Windows refuses (`:`, `*`, `CON`) pass here; the local side deals with those itself.
 */
export function isValidEntryName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (/[/\\\0]/.test(name)) return false;
  return new TextEncoder().encode(name).length <= MAX_NAME_BYTES;
}
