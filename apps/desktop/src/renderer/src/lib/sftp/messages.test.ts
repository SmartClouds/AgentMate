import { encodeFilesError } from '@shared/deployFilesErrors';
import { encodeSshError } from '@shared/sshErrors';
import { describe, expect, it } from 'vitest';
import { sftpProblem } from './messages';

describe('sftpProblem', () => {
  it('words a missing folder for the file manager, not for Deploy', () => {
    expect(sftpProblem(new Error(encodeFilesError('folderMissing', 'gone')))).toMatch(
      /isn't there anymore/,
    );
  });

  it("keeps the server's own words for server and input errors", () => {
    expect(sftpProblem(new Error(encodeFilesError('server', 'No such file')))).toBe('No such file');
  });

  it('falls back to the shared words and strips SSH tags', () => {
    expect(sftpProblem(new Error(encodeFilesError('auth', 'x')))).toMatch(/username, password/);
    expect(
      sftpProblem(
        new Error(
          `Error invoking remote method 'sftp:open': ${encodeSshError('vault-locked', 'Locked.')}`,
        ),
      ),
    ).toBe('Locked.');
    expect(sftpProblem(new Error('plain'))).toBe('plain');
  });
});
