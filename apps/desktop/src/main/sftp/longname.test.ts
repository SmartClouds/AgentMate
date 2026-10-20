import { describe, expect, it } from 'vitest';
import { parseLongname } from './longname';

describe('parseLongname', () => {
  it('reads the owner and group of an OpenSSH line', () => {
    expect(
      parseLongname('-rw-r--r--    1 deploy   www-data     1234 Jan  5 10:12 index.html'),
    ).toEqual({ owner: 'deploy', group: 'www-data' });
  });

  it('reads folders, links and special files the same way', () => {
    expect(parseLongname('drwxr-xr-x    5 root     root         4096 Mar 12  2024 etc')).toEqual({
      owner: 'root',
      group: 'root',
    });
    expect(
      parseLongname(
        'lrwxrwxrwx    1 me       staff          11 Jan  5 10:12 current -> releases/3',
      ),
    ).toEqual({ owner: 'me', group: 'staff' });
    expect(parseLongname('srwxrwsrwt    1 me       staff           0 Jan  5 10:12 sock')).toEqual({
      owner: 'me',
      group: 'staff',
    });
  });

  it('keeps numeric ids as they are when the server has no names for them', () => {
    expect(parseLongname('-rw-------    1 1000     1001          42 Jan  5 10:12 notes')).toEqual({
      owner: '1000',
      group: '1001',
    });
  });

  it('is not thrown off by spaces in the file name', () => {
    expect(
      parseLongname('-rw-r--r--    1 anna     users         512 Feb 29 09:00 my  report final.pdf'),
    ).toEqual({ owner: 'anna', group: 'users' });
  });

  it('accepts an ACL or extended attribute marker after the mode', () => {
    expect(parseLongname('-rw-r--r--+   1 anna     users  512 Feb 29 09:00 a')).toEqual({
      owner: 'anna',
      group: 'users',
    });
    expect(parseLongname('-rw-r--r--@   1 anna     staff  512 Feb 29 09:00 a')).toEqual({
      owner: 'anna',
      group: 'staff',
    });
  });

  it('gives nulls for a line it cannot read', () => {
    const none = { owner: null, group: null };
    expect(parseLongname('')).toEqual(none);
    expect(parseLongname('index.html')).toEqual(none);
    expect(parseLongname('-rw-r--r-- 1 deploy')).toEqual(none);
    expect(parseLongname('hello world this is not ls output')).toEqual(none);
    expect(parseLongname('   ')).toEqual(none);
  });
});
