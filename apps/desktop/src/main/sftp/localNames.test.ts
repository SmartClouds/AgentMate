import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { assertContained, safeLocalName } from './localNames';

/**
 * Names from the server made safe for this computer (E25): Windows refuses some characters and
 * device names, POSIX only the slash and NUL, and nothing a server sends may land outside the
 * folder the user picked.
 */

describe('safeLocalName on Windows', () => {
  const win = (name: string) => safeLocalName(name, 'win32');

  it('replaces the characters Windows refuses', () => {
    expect(win('a:b')).toEqual({ name: 'a_b', changed: true });
    expect(win('what?<now>|"x"*.txt').name).toBe('what__now___x__.txt');
    expect(win('back\\slash/and').name).toBe('back_slash_and');
    expect(win('tab\there\u0001').name).toBe('tab_here_');
  });

  it('gives reserved device names a trailing underscore, with or without an extension', () => {
    expect(win('CON')).toEqual({ name: 'CON_', changed: true });
    expect(win('nul.txt').name).toBe('nul_.txt');
    expect(win('COM1').name).toBe('COM1_');
    expect(win('lpt9.log').name).toBe('lpt9_.log');
    expect(win('CONSOLE').name).toBe('CONSOLE');
    expect(win('COM0').name).toBe('COM0');
  });

  it('strips trailing dots and spaces, and a name left empty becomes an underscore', () => {
    expect(win('notes. . ').name).toBe('notes');
    expect(win('CON.').name).toBe('CON_');
    expect(win('...')).toEqual({ name: '_', changed: true });
    expect(win('..').name).toBe('_');
  });

  it('leaves a fine name alone', () => {
    expect(win('report (1).pdf')).toEqual({ name: 'report (1).pdf', changed: false });
    expect(win('مستند.txt')).toEqual({ name: 'مستند.txt', changed: false });
  });
});

describe('safeLocalName on POSIX', () => {
  const posix = (name: string) => safeLocalName(name, 'linux');

  it('keeps what POSIX allows', () => {
    expect(posix('a:b')).toEqual({ name: 'a:b', changed: false });
    expect(posix('CON').name).toBe('CON');
    expect(posix('trailing. ').name).toBe('trailing. ');
  });

  it('replaces the slash and NUL, and refuses . and ..', () => {
    expect(posix('a/b').name).toBe('a_b');
    expect(posix('a\0b').name).toBe('a_b');
    expect(posix('../x').name).toBe('.._x');
    expect(posix('..')).toEqual({ name: '_', changed: true });
    expect(posix('.')).toEqual({ name: '_', changed: true });
    expect(posix('').name).toBe('_');
  });

  it('defaults to the platform it runs on', () => {
    expect(safeLocalName('plain.txt')).toEqual({ name: 'plain.txt', changed: false });
  });
});

describe('assertContained', () => {
  const root = resolve('/tmp/agentmate-downloads');

  it('answers the resolved path of something inside the folder', () => {
    expect(assertContained(join(root, 'site', 'a.txt'), root)).toBe(join(root, 'site', 'a.txt'));
    expect(assertContained(`${root}/site/../b.txt`, root)).toBe(join(root, 'b.txt'));
    expect(assertContained(join(root, '..foo'), root)).toBe(join(root, '..foo'));
  });

  it('refuses the folder itself and anything outside it', () => {
    for (const child of [root, join(root, '..', 'x'), join(root, '..'), resolve('/etc/passwd')]) {
      let error: unknown = null;
      try {
        assertContained(child, root);
      } catch (caught) {
        error = caught;
      }
      expect(filesErrorCode(error)).toBe('invalidInput');
    }
  });

  it('never names the path in the error', () => {
    expect(() => assertContained('/secret/place', root)).toThrow(/^(?!.*secret)/);
  });
});
