import { describe, expect, it } from 'vitest';
import {
  emptyGrid,
  formatMode,
  formatOctal,
  gridToMode,
  type ModeGrid,
  mergeModes,
  modeToGrid,
  parseOctal,
} from './mode';

describe('parseOctal', () => {
  it('reads three and four digit octal modes', () => {
    expect(parseOctal('755')).toBe(0o755);
    expect(parseOctal('0644')).toBe(0o644);
    expect(parseOctal('4755')).toBe(0o4755);
    expect(parseOctal(' 600 ')).toBe(0o600);
    expect(parseOctal('7777')).toBe(0o7777);
  });

  it('gives null for anything that is not a mode', () => {
    expect(parseOctal('9')).toBeNull();
    expect(parseOctal('12345')).toBeNull();
    expect(parseOctal('')).toBeNull();
    expect(parseOctal('   ')).toBeNull();
    expect(parseOctal('78')).toBeNull();
    expect(parseOctal('rwx')).toBeNull();
    expect(parseOctal('-644')).toBeNull();
  });
});

describe('formatOctal', () => {
  it('shows three digits unless a special bit is set', () => {
    expect(formatOctal(0o755)).toBe('755');
    expect(formatOctal(0o7)).toBe('007');
    expect(formatOctal(0o4755)).toBe('4755');
    expect(formatOctal(0o100644)).toBe('644');
  });
});

describe('formatMode', () => {
  it('spells out folder and file modes', () => {
    expect(formatMode(0o755, 'dir')).toBe('drwxr-xr-x');
    expect(formatMode(0o644)).toBe('-rw-r--r--');
    expect(formatMode(0o644, 'file')).toBe('-rw-r--r--');
    expect(formatMode(0o777, 'link')).toBe('lrwxrwxrwx');
    expect(formatMode(0o600, 'other')).toBe('?rw-------');
  });

  it('shows setuid, setgid and sticky with s and t, upper case without execute', () => {
    expect(formatMode(0o4755)).toBe('-rwsr-xr-x');
    expect(formatMode(0o4644)).toBe('-rwSr--r--');
    expect(formatMode(0o2755)).toBe('-rwxr-sr-x');
    expect(formatMode(0o2745)).toBe('-rwxr-Sr-x');
    expect(formatMode(0o1777, 'dir')).toBe('drwxrwxrwt');
    expect(formatMode(0o1776, 'dir')).toBe('drwxrwxrwT');
  });

  it('ignores the file type bits a raw mode carries', () => {
    expect(formatMode(0o40755, 'dir')).toBe('drwxr-xr-x');
  });
});

describe('modeToGrid and gridToMode', () => {
  it('converts both ways', () => {
    const grid = modeToGrid(0o4751);
    expect(grid.owner).toEqual({ read: true, write: true, execute: true });
    expect(grid.group).toEqual({ read: true, write: false, execute: true });
    expect(grid.others).toEqual({ read: false, write: false, execute: true });
    expect(grid.special).toEqual({ setuid: true, setgid: false, sticky: false });
    expect(gridToMode(grid)).toBe(0o4751);
  });

  it('round-trips every mode', () => {
    for (let mode = 0; mode <= 0o7777; mode += 1) {
      expect(gridToMode(modeToGrid(mode))).toBe(mode);
    }
  });

  it('builds a mode from a grid edited by hand', () => {
    const grid: ModeGrid = emptyGrid();
    grid.owner.read = true;
    grid.owner.write = true;
    grid.group.read = true;
    grid.special.sticky = true;
    expect(gridToMode(grid)).toBe(0o1640);
    expect(gridToMode(emptyGrid())).toBe(0);
  });
});

describe('mergeModes', () => {
  it('marks bits the modes agree on as on or off and the rest as mixed', () => {
    const merged = mergeModes([0o755, 0o644]);
    expect(merged.owner).toEqual({ read: 'on', write: 'on', execute: 'mixed' });
    expect(merged.group).toEqual({ read: 'on', write: 'off', execute: 'mixed' });
    expect(merged.others).toEqual({ read: 'on', write: 'off', execute: 'mixed' });
    expect(merged.special).toEqual({ setuid: 'off', setgid: 'off', sticky: 'off' });
  });

  it('has no mixed bit for a single mode', () => {
    const merged = mergeModes([0o2700]);
    expect(merged.owner).toEqual({ read: 'on', write: 'on', execute: 'on' });
    expect(merged.group.execute).toBe('off');
    expect(merged.special.setgid).toBe('on');
  });

  it('reads an empty list as all off', () => {
    expect(mergeModes([]).owner).toEqual({ read: 'off', write: 'off', execute: 'off' });
  });
});
