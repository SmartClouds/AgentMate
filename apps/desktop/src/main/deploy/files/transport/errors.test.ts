import { describe, expect, it } from 'vitest';
import { filesError, filesErrorCode } from '../../../../shared/deployFilesErrors';
import { HostKeyChangedError } from '../../../ssh/connectConfig';
import { VaultLockedError } from '../../../ssh/vaultErrors';
import { FilesTransportError, mapSftpError, mapSshConnectError } from './errors';

const sftp = (code: number, message: string) => Object.assign(new Error(message), { code });

describe('FilesTransportError', () => {
  it('carries the code in its message and the details beside it', () => {
    const error = new FilesTransportError('hostKeyUnknown', 'Check the key.', {
      hostKey: { presented: 'ab'.repeat(32), stored: null },
    });

    expect(filesErrorCode(error)).toBe('hostKeyUnknown');
    expect(error.code).toBe('hostKeyUnknown');
    expect(error.hostKey?.presented).toBe('ab'.repeat(32));
    expect(error.certificate).toBeNull();
  });
});

describe('mapSftpError', () => {
  it('keeps an error that already has a code', () => {
    const coded = filesError('localChanged', 'edited');
    expect(mapSftpError(coded, '/srv/a')).toBe(coded);
  });

  it.each([
    [sftp(3, 'Permission denied'), 'permissionDenied'],
    [sftp(4, 'Failure: Disk quota exceeded'), 'diskFull'],
    [sftp(4, 'No space left on device'), 'diskFull'],
    [sftp(2, 'No such file'), 'remoteFolderMissing'],
    [new Error('The SSH connection to example.com closed.'), 'unreachable'],
    [new Error('The SSH connection to example.com is closed.'), 'unreachable'],
    [sftp(7, 'Connection lost'), 'unreachable'],
    [new Error('Listing /srv on example.com did not answer within 30 seconds.'), 'timeout'],
    [sftp(4, 'Failure'), 'server'],
  ])('codes %s as %s', (error, code) => {
    const mapped = mapSftpError(error, '/srv/a');
    expect(filesErrorCode(mapped)).toBe(code);
    expect(mapped.message).toContain('/srv/a');
  });
});

describe('mapSshConnectError', () => {
  it('reads a changed host key with both fingerprints', () => {
    const mapped = mapSshConnectError(
      new HostKeyChangedError('example.com', 22, { stored: 'aa', presented: 'bb' }),
    );

    expect(mapped.code).toBe('hostKeyChanged');
    expect(mapped.hostKey).toEqual({ presented: 'bb', stored: 'aa' });
  });

  it.each([
    [new VaultLockedError(), 'vaultLocked'],
    [new Error('Authentication failed. Check the username, password, or private key.'), 'auth'],
    [new Error('Could not reach example.com:22.'), 'unreachable'],
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'unreachable'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'unreachable'],
    [
      new Error(
        'The connection to example.com:22 was closed by the other end while connecting. ' +
          'Check that the host and port belong to an SSH server.',
      ),
      'unreachable',
    ],
    [
      new Error('example.com:22 does not look like an SSH server. Check the host and port.'),
      'unreachable',
    ],
    [new Error('Connection to example.com:22 timed out.'), 'timeout'],
    [Object.assign(new Error('no key'), { code: 'ENOENT', path: '/k' }), 'auth'],
    [filesError('cancelled', 'stop'), 'cancelled'],
    [new Error('This saved server no longer exists.'), 'server'],
  ])('codes %s as %s', (error, code) => {
    expect(mapSshConnectError(error).code).toBe(code);
  });
});
