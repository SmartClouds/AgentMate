import { encodeFilesError } from '@shared/deployFilesErrors';
import type { FileSite } from '@shared/deployFilesTypes';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  filesProblem,
  filesProblemText,
  PROTOCOL_DESCRIPTION,
  PROTOCOL_LABEL,
  RUN_STATE_LABEL,
  siteAddress,
} from './messages';
import { fileSite } from './testing/fixtures';

/**
 * The words FTP and SFTP sites show for a failure, and the labels the rail and the site view
 * share. A failure from main arrives as an Error whose message carries a `[files:code]` tag.
 */

function ipcError(code: string, message: string): Error {
  return new Error(
    `Error invoking remote method 'deployFiles:deploy': Error: [files:${code}] ${message}`,
  );
}

describe('filesProblem', () => {
  it('turns a known code into its fixed words', () => {
    expect(filesProblem(ipcError('auth', 'Permission denied (password).'))).toMatch(
      /didn't accept the username, password or key/,
    );
    expect(filesProblem(new Error(encodeFilesError('planExpired', 'old')))).toBe(
      'The review expired after 10 minutes. Review the changes again.',
    );
  });

  it("keeps the server's own words for the codes where they say more", () => {
    expect(filesProblem(ipcError('server', '550 Quota exceeded for /public_html'))).toBe(
      '550 Quota exceeded for /public_html',
    );
    expect(filesProblem(ipcError('permissionDenied', '553 Could not create file.'))).toBe(
      '553 Could not create file.',
    );
  });

  it('falls back to the fixed words when such a code comes without a message', () => {
    expect(filesProblem(new Error('[files:server]'))).toBe('The server refused the request.');
  });

  it('keeps the words of an error that has no code, and says something for an empty one', () => {
    expect(filesProblem(new Error('disk is gone'))).toBe('disk is gone');
    expect(filesProblem(new Error(''))).toBe('Something went wrong.');
    expect(filesProblem('plain string')).toBe('plain string');
  });
});

describe('filesProblemText', () => {
  it('uses the message main sent for a specific code, and the fixed words otherwise', () => {
    expect(filesProblemText('server', ' 451 Local error ')).toBe('451 Local error');
    expect(filesProblemText('server', '  ')).toBe('The server refused the request.');
    expect(filesProblemText('server', null)).toBe('The server refused the request.');
    expect(filesProblemText('diskFull', 'whatever')).toBe(
      'The server is out of space, or over its quota.',
    );
  });
});

describe('labels', () => {
  it('names every protocol and run state', () => {
    expect(PROTOCOL_LABEL).toEqual({ sftp: 'SFTP', ftps: 'FTPS', ftp: 'FTP' });
    expect(PROTOCOL_DESCRIPTION.ftp).toMatch(/Not encrypted/);
    expect(DEFAULT_PORT).toEqual({ sftp: 22, ftps: 21, ftp: 21 });
    expect(RUN_STATE_LABEL.partial).toBe('Partly deployed');
  });
});

describe('siteAddress', () => {
  it('leaves out the default port of each protocol', () => {
    expect(siteAddress(fileSite())).toBe('deploy@files.example:/var/www/site');
    expect(siteAddress(fileSite({ protocol: 'ftps', connection: customLogin({ port: 21 }) }))).toBe(
      'deploy@files.example:/var/www/site',
    );
    expect(siteAddress(fileSite({ protocol: 'ftp', connection: customLogin({ port: 21 }) }))).toBe(
      'deploy@files.example:/var/www/site',
    );
  });

  it('shows a port that is not the default', () => {
    expect(siteAddress(fileSite({ connection: customLogin({ port: 2222 }) }))).toBe(
      'deploy@files.example:2222:/var/www/site',
    );
    expect(siteAddress(fileSite({ protocol: 'ftp', connection: customLogin({ port: 22 }) }))).toBe(
      'deploy@files.example:22:/var/www/site',
    );
  });

  it('names a saved server by its nickname, or says it is a saved server', () => {
    const site = fileSite({ connection: { kind: 'saved', sshServerId: 'srv-1' } });
    expect(siteAddress(site, 'Production')).toBe('Production:/var/www/site');
    expect(siteAddress(site)).toBe('Saved server:/var/www/site');
    expect(siteAddress(site, null)).toBe('Saved server:/var/www/site');
  });
});

function customLogin(overrides: Partial<Extract<FileSite['connection'], { kind: 'custom' }>>) {
  const base = fileSite().connection as Extract<FileSite['connection'], { kind: 'custom' }>;
  return { ...base, ...overrides };
}
