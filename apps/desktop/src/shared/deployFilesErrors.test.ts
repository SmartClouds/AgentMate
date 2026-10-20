import { describe, expect, it } from 'vitest';
import {
  encodeFilesError,
  filesError,
  filesErrorCode,
  filesErrorMessage,
  isFilesErrorCode,
} from './deployFilesErrors';

/** An FTP or SFTP site call's failure keeps its code across IPC, so the renderer can say what to do. */
describe('FTP and SFTP site error codes', () => {
  it('survive the trip through Electron IPC', () => {
    const crossed = new Error(
      `Error invoking remote method 'deployFiles:deploy': Error: ${encodeFilesError('tlsNameMismatch', 'The certificate is for server12.host.example.')}`,
    );

    expect(filesErrorCode(crossed)).toBe('tlsNameMismatch');
    expect(filesErrorMessage(crossed)).toBe('The certificate is for server12.host.example.');
  });

  it('round-trip every code through an Error', () => {
    for (const code of [
      'auth',
      'hostKeyUnknown',
      'vaultLocked',
      'localChanged',
      'server',
      'exists',
      'changedOnServer',
      'tooLarge',
      'notText',
    ] as const) {
      expect(filesErrorCode(filesError(code, 'No.'))).toBe(code);
      expect(isFilesErrorCode(code)).toBe(true);
    }
  });

  it('read as nothing for errors without one, or with a code this app does not know', () => {
    expect(filesErrorCode(new Error('disk full'))).toBeNull();
    expect(filesErrorCode('[files:launchRockets] no')).toBeNull();
    expect(filesErrorCode('[wp:busy] no')).toBeNull();
    expect(isFilesErrorCode(42)).toBe(false);
    expect(filesErrorMessage(new Error('disk full'))).toBe('disk full');
  });
});
