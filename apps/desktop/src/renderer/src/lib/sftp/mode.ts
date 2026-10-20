/**
 * Unix permission bits for the SFTP file manager (E25): the Permissions column, its octal
 * tooltip, and the Properties dialog's Read / Write / Execute grid and octal field.
 *
 * A mode here is the permission bits alone, 0 to 0o7777. Anything above (the file type bits a
 * raw `st_mode` carries) is ignored.
 */

/** The three classes of user a mode speaks for, in the order `ls` shows them. */
export const MODE_CLASSES = ['owner', 'group', 'others'] as const;
export type ModeClass = (typeof MODE_CLASSES)[number];

export const MODE_PERMS = ['read', 'write', 'execute'] as const;
export type ModePerm = (typeof MODE_PERMS)[number];

export const MODE_SPECIALS = ['setuid', 'setgid', 'sticky'] as const;
export type ModeSpecial = (typeof MODE_SPECIALS)[number];

/** The bit each class and permission stands for: `MODE_BITS.group.write` is 0o020. */
export const MODE_BITS: Record<ModeClass, Record<ModePerm, number>> = {
  owner: { read: 0o400, write: 0o200, execute: 0o100 },
  group: { read: 0o040, write: 0o020, execute: 0o010 },
  others: { read: 0o004, write: 0o002, execute: 0o001 },
};

export const SPECIAL_BITS: Record<ModeSpecial, number> = {
  setuid: 0o4000,
  setgid: 0o2000,
  sticky: 0o1000,
};

const PERMISSION_MASK = 0o7777;

/** A mode as checkboxes: one row per class, plus the special row. */
export interface ModeGrid {
  owner: Record<ModePerm, boolean>;
  group: Record<ModePerm, boolean>;
  others: Record<ModePerm, boolean>;
  special: Record<ModeSpecial, boolean>;
}

/** One bit across several entries: set on all, on none, or on some. */
export type BitState = 'on' | 'off' | 'mixed';

/** `ModeGrid` for several entries at once, where a bit they disagree on is `mixed`. */
export interface MixedModeGrid {
  owner: Record<ModePerm, BitState>;
  group: Record<ModePerm, BitState>;
  others: Record<ModePerm, BitState>;
  special: Record<ModeSpecial, BitState>;
}

/** What `formatMode` puts first: `d` for a folder, `l` for a link, `?` for anything else odd. */
export type ModeKind = 'file' | 'dir' | 'link' | 'other';

const TYPE_CHAR: Record<ModeKind, string> = { file: '-', dir: 'd', link: 'l', other: '?' };

/**
 * The mode a typed octal field means, or null when it means none: one to four octal digits,
 * so `755`, `0644` and `4755` work and `9`, `12345` and an empty field do not.
 */
export function parseOctal(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-7]{1,4}$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 8);
}

/** `755`, or `4755` when a special bit is set: the form the octal field and tooltip show. */
export function formatOctal(mode: number): string {
  const bits = mode & PERMISSION_MASK;
  return bits.toString(8).padStart(bits > 0o777 ? 4 : 3, '0');
}

/**
 * The mode as `ls -l` spells it: `drwxr-xr-x`. Setuid and setgid show as `s` in the execute
 * slot (`S` when that execute bit is off), sticky as `t` (`T`).
 */
export function formatMode(mode: number, kind: ModeKind = 'file'): string {
  const triple = (cls: ModeClass, special: number, specialChar: string): string => {
    const bits = MODE_BITS[cls];
    const read = mode & bits.read ? 'r' : '-';
    const write = mode & bits.write ? 'w' : '-';
    const exec = (mode & bits.execute) !== 0;
    let x = exec ? 'x' : '-';
    if (mode & special) x = exec ? specialChar : specialChar.toUpperCase();
    return read + write + x;
  };
  return (
    TYPE_CHAR[kind] +
    triple('owner', SPECIAL_BITS.setuid, 's') +
    triple('group', SPECIAL_BITS.setgid, 's') +
    triple('others', SPECIAL_BITS.sticky, 't')
  );
}

/** A grid with every box clear. */
export function emptyGrid(): ModeGrid {
  return modeToGrid(0);
}

export function modeToGrid(mode: number): ModeGrid {
  const row = (cls: ModeClass): Record<ModePerm, boolean> => ({
    read: (mode & MODE_BITS[cls].read) !== 0,
    write: (mode & MODE_BITS[cls].write) !== 0,
    execute: (mode & MODE_BITS[cls].execute) !== 0,
  });
  return {
    owner: row('owner'),
    group: row('group'),
    others: row('others'),
    special: {
      setuid: (mode & SPECIAL_BITS.setuid) !== 0,
      setgid: (mode & SPECIAL_BITS.setgid) !== 0,
      sticky: (mode & SPECIAL_BITS.sticky) !== 0,
    },
  };
}

export function gridToMode(grid: ModeGrid): number {
  let mode = 0;
  for (const cls of MODE_CLASSES) {
    for (const perm of MODE_PERMS) if (grid[cls][perm]) mode |= MODE_BITS[cls][perm];
  }
  for (const special of MODE_SPECIALS) if (grid.special[special]) mode |= SPECIAL_BITS[special];
  return mode;
}

/**
 * Several entries' modes as one grid: a bit is `on` when every mode has it, `off` when none
 * does, and `mixed` otherwise. An empty list reads as all off.
 */
export function mergeModes(modes: readonly number[]): MixedModeGrid {
  const state = (bit: number): BitState => {
    const set = modes.filter((mode) => (mode & bit) !== 0).length;
    if (set === 0) return 'off';
    return set === modes.length ? 'on' : 'mixed';
  };
  const row = (cls: ModeClass): Record<ModePerm, BitState> => ({
    read: state(MODE_BITS[cls].read),
    write: state(MODE_BITS[cls].write),
    execute: state(MODE_BITS[cls].execute),
  });
  return {
    owner: row('owner'),
    group: row('group'),
    others: row('others'),
    special: {
      setuid: state(SPECIAL_BITS.setuid),
      setgid: state(SPECIAL_BITS.setgid),
      sticky: state(SPECIAL_BITS.sticky),
    },
  };
}
