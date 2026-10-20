import { describe, expect, it } from 'vitest';
import { assertRemoteAbsolute, resolveRemoteInput } from './remotePaths';

const CWD = '/var/www/site';
const HOME = '/home/deploy';

describe('resolveRemoteInput', () => {
  it('expands ~ and ~/ to the home folder', () => {
    expect(resolveRemoteInput('~', CWD, HOME)).toBe(HOME);
    expect(resolveRemoteInput('~/', CWD, HOME)).toBe(HOME);
    expect(resolveRemoteInput('~/a', CWD, HOME)).toBe('/home/deploy/a');
    expect(resolveRemoteInput('~/a/../b/', CWD, HOME)).toBe('/home/deploy/b');
  });

  it("leaves another user's ~name alone, as a relative name", () => {
    expect(resolveRemoteInput('~root', CWD, HOME)).toBe('/var/www/site/~root');
  });

  it('reads relative input against the current folder', () => {
    expect(resolveRemoteInput('assets', CWD, HOME)).toBe('/var/www/site/assets');
    expect(resolveRemoteInput('./assets/css', CWD, HOME)).toBe('/var/www/site/assets/css');
    expect(resolveRemoteInput('..', CWD, HOME)).toBe('/var/www');
  });

  it('stops .. at the root', () => {
    expect(resolveRemoteInput('../../../../..', CWD, HOME)).toBe('/');
    expect(resolveRemoteInput('/../..', CWD, HOME)).toBe('/');
  });

  it('normalizes absolute input', () => {
    expect(resolveRemoteInput('//x/', CWD, HOME)).toBe('/x');
    expect(resolveRemoteInput('/srv//site/./a/', CWD, HOME)).toBe('/srv/site/a');
    expect(resolveRemoteInput('/', CWD, HOME)).toBe('/');
  });

  it('treats nothing as the current folder', () => {
    expect(resolveRemoteInput('', CWD, HOME)).toBe(CWD);
    expect(resolveRemoteInput('', '/srv//site/', HOME)).toBe('/srv/site');
  });

  it('keeps spaces, since a folder name may start or end with one', () => {
    expect(resolveRemoteInput('/srv/old site ', CWD, HOME)).toBe('/srv/old site ');
    expect(resolveRemoteInput(' x', CWD, HOME)).toBe('/var/www/site/ x');
  });

  it('throws on a NUL byte', () => {
    expect(() => resolveRemoteInput('/etc\0/passwd', CWD, HOME)).toThrow(/\[files:invalidInput\]/);
  });
});

describe('assertRemoteAbsolute', () => {
  it('answers the normalized path', () => {
    expect(assertRemoteAbsolute('/srv//site/')).toBe('/srv/site');
    expect(assertRemoteAbsolute('/')).toBe('/');
  });

  it('refuses relative, home relative, empty and NUL paths', () => {
    for (const bad of ['srv', '~/x', '', 'C:\\x', '/a\0b']) {
      expect(() => assertRemoteAbsolute(bad)).toThrow(/\[files:invalidInput\]/);
    }
  });

  it('does not echo the path it refuses', () => {
    expect(() => assertRemoteAbsolute('secret-relative')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-relative') }),
    );
  });
});
