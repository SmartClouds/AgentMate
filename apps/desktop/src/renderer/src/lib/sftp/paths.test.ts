import { describe, expect, it } from 'vitest';
import {
  baseName,
  breadcrumbs,
  isWindowsPath,
  joinPath,
  parentPath,
  remoteDepth,
  resolveLocalInput,
  resolveRemoteInput,
  samePath,
} from './paths';

describe('breadcrumbs', () => {
  it('splits a POSIX path below the root', () => {
    expect(breadcrumbs('/var/www/site')).toEqual([
      { label: '/', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'www', path: '/var/www' },
      { label: 'site', path: '/var/www/site' },
    ]);
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('splits a Windows path below its drive', () => {
    expect(breadcrumbs('C:\\Users\\me')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'me', path: 'C:\\Users\\me' },
    ]);
    expect(breadcrumbs('D:\\')).toEqual([{ label: 'D:', path: 'D:\\' }]);
  });

  it('keeps a UNC share as one root', () => {
    expect(breadcrumbs('\\\\nas\\share\\docs')).toEqual([
      { label: '\\\\nas\\share', path: '\\\\nas\\share\\' },
      { label: 'docs', path: '\\\\nas\\share\\docs' },
    ]);
  });
});

describe('parentPath', () => {
  it('gives the folder above', () => {
    expect(parentPath('/var/www')).toBe('/var');
    expect(parentPath('/var')).toBe('/');
    expect(parentPath('C:\\Users\\me')).toBe('C:\\Users');
    expect(parentPath('C:\\Users')).toBe('C:\\');
  });

  it('is null at a root', () => {
    expect(parentPath('/')).toBeNull();
    expect(parentPath('C:\\')).toBeNull();
    expect(parentPath('\\\\nas\\share\\')).toBeNull();
  });
});

describe('joinPath and baseName', () => {
  it('joins with the separator of the folder', () => {
    expect(joinPath('/var/www', 'index.html')).toBe('/var/www/index.html');
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(joinPath('C:\\Users', 'me')).toBe('C:\\Users\\me');
    expect(joinPath('C:\\', 'temp')).toBe('C:\\temp');
  });

  it('takes the last segment', () => {
    expect(baseName('/var/www/index.html')).toBe('index.html');
    expect(baseName('C:\\Users\\me\\a.txt')).toBe('a.txt');
    expect(baseName('/')).toBe('/');
  });

  it('tells Windows paths apart', () => {
    expect(isWindowsPath('C:\\x')).toBe(true);
    expect(isWindowsPath('c:/x')).toBe(true);
    expect(isWindowsPath('\\\\nas\\share')).toBe(true);
    expect(isWindowsPath('/home/me')).toBe(false);
  });
});

describe('resolveRemoteInput', () => {
  it('leaves home forms to the server', () => {
    expect(resolveRemoteInput('~', '/srv')).toBe('~');
    expect(resolveRemoteInput('~/logs', '/srv')).toBe('~/logs');
  });

  it('normalizes absolute and relative input against the current folder', () => {
    expect(resolveRemoteInput('/var//www/', '/srv')).toBe('/var/www');
    expect(resolveRemoteInput('logs', '/srv/app')).toBe('/srv/app/logs');
    expect(resolveRemoteInput('..', '/srv/app')).toBe('/srv');
    expect(resolveRemoteInput('../../../..', '/srv/app')).toBe('/');
    expect(resolveRemoteInput('./a/./b/../c', '/')).toBe('/a/c');
  });

  it('trims and rejects nothing at all', () => {
    expect(resolveRemoteInput('  /tmp  ', '/')).toBe('/tmp');
    expect(resolveRemoteInput('   ', '/srv')).toBeNull();
  });
});

describe('resolveLocalInput', () => {
  it('normalizes Windows input and resolves relative paths', () => {
    expect(resolveLocalInput('d:/work/', 'C:\\Users')).toBe('D:\\work');
    expect(resolveLocalInput('C:', 'D:\\x')).toBe('C:\\');
    expect(resolveLocalInput('..', 'C:\\Users\\me')).toBe('C:\\Users');
    expect(resolveLocalInput('..\\..\\..', 'C:\\Users\\me')).toBe('C:\\');
    expect(resolveLocalInput('Downloads', 'C:\\Users\\me')).toBe('C:\\Users\\me\\Downloads');
  });

  it('normalizes POSIX input', () => {
    expect(resolveLocalInput('/home/me/../you/', '/')).toBe('/home/you');
    expect(resolveLocalInput('docs', '/home/me')).toBe('/home/me/docs');
    expect(resolveLocalInput('', '/home/me')).toBeNull();
  });
});

describe('remoteDepth and samePath', () => {
  it('counts the segments below the root', () => {
    expect(remoteDepth('/')).toBe(0);
    expect(remoteDepth('/var')).toBe(1);
    expect(remoteDepth('/var/www/')).toBe(2);
    expect(remoteDepth('/var/www/site')).toBe(3);
  });

  it('compares Windows paths without case and trailing separators', () => {
    expect(samePath('C:\\Users\\Me', 'c:\\users\\me\\')).toBe(true);
    expect(samePath('/var/www', '/var/www/')).toBe(true);
    expect(samePath('/var/WWW', '/var/www')).toBe(false);
  });
});
