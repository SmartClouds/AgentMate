import { describe, expect, it } from 'vitest';
import { filesError, filesErrorCode } from '../../shared/deployFilesErrors';
import { encodeSshError, sshErrorCode } from '../../shared/sshErrors';
import { FilesTransportError } from '../deploy/files/transport/errors';
import { HostKeyChangedError } from '../ssh/connectConfig';
import { VaultLockedError } from '../ssh/vaultErrors';
import { toCodedError, toLocalCodedError } from './errors';

/** A node file system error, as fs/promises rejects with. */
function errno(code: string, message = `${code}: something, open 'x'`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: -1, syscall: 'open' });
}

/** An ssh2 SFTP failure: the SFTP status as a number in `code`. */
function sftpStatus(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('toCodedError', () => {
  it('hands back errors that already carry a files or ssh tag untouched', () => {
    const files = filesError('changedOnServer', 'It changed.');
    const ssh = new Error(encodeSshError('sudo-password-required', 'Needs a password.'));
    const transport = new FilesTransportError('hostKeyChanged', 'Changed.', {
      hostKey: { presented: 'SHA256:new', stored: 'SHA256:old' },
    });
    const hostKey = new HostKeyChangedError('example.com', 22, {
      stored: 'SHA256:old',
      presented: 'SHA256:new',
    });

    expect(toCodedError(files, '/srv')).toBe(files);
    expect(toCodedError(ssh)).toBe(ssh);
    expect(toCodedError(transport)).toBe(transport);
    expect(toCodedError(hostKey, '/srv')).toBe(hostKey);
    expect(sshErrorCode(toCodedError(hostKey))).toBe('host-key-changed');
  });

  it('wraps a tagged message that is not an Error into one', () => {
    const coded = toCodedError('[files:busy] Another one runs.');
    expect(coded).toBeInstanceOf(Error);
    expect(filesErrorCode(coded)).toBe('busy');
  });

  it('turns a locked vault into [ssh:vault-locked], keeping its words', () => {
    const coded = toCodedError(new VaultLockedError(), '/srv');
    expect(sshErrorCode(coded)).toBe('vault-locked');
    expect(filesErrorCode(coded)).toBeNull();
    expect(coded.message).toContain('Unlock it with your passkey');
  });

  it('maps SFTP status codes the way Deploy does', () => {
    const missing = toCodedError(sftpStatus(2, 'No such file'), '/srv/gone');
    expect(filesErrorCode(missing)).toBe('remoteFolderMissing');
    expect(missing.message).toContain('/srv/gone');

    const denied = toCodedError(sftpStatus(3, 'Permission denied'), '/root');
    expect(filesErrorCode(denied)).toBe('permissionDenied');
    expect(denied.message).toContain('/root');

    expect(filesErrorCode(toCodedError(sftpStatus(4, 'Failure'), '/x'))).toBe('server');
  });

  it('reads a dropped connection as unreachable', () => {
    const coded = toCodedError(new Error('The SSH connection to example.com closed.'), '/srv');
    expect(filesErrorCode(coded)).toBe('unreachable');
  });

  it('reads socket errors as a connection failure, not a local one', () => {
    expect(filesErrorCode(toCodedError(errno('ECONNRESET'), '/srv'))).toBe('unreachable');
    expect(filesErrorCode(toCodedError(errno('ETIMEDOUT'), '/srv'))).toBe('timeout');
  });

  it('still says something sensible about an SFTP failure without a path', () => {
    const coded = toCodedError(sftpStatus(2, 'No such file'));
    expect(filesErrorCode(coded)).toBe('remoteFolderMissing');
    expect(coded.message).toMatch(/\] [A-Z]/);
  });

  it('maps local file system errors, naming the path', () => {
    const cases: [string, string][] = [
      ['EEXIST', 'exists'],
      ['ENOENT', 'folderMissing'],
      ['ENOTDIR', 'invalidInput'],
      ['ENAMETOOLONG', 'invalidInput'],
      ['EACCES', 'permissionDenied'],
      ['EBUSY', 'permissionDenied'],
      ['EPERM', 'permissionDenied'],
      ['ENOSPC', 'diskFull'],
      ['EDQUOT', 'diskFull'],
      ['EIO', 'server'],
    ];
    for (const [code, files] of cases) {
      const coded = toCodedError(errno(code), 'C:\\Users\\me\\report.pdf');
      expect(filesErrorCode(coded), code).toBe(files);
      expect(coded.message, code).toContain('C:\\Users\\me\\report.pdf');
      expect(coded.message, code).not.toMatch(/\bE[A-Z]{3,}\b/);
    }
  });

  it('says a busy or locked file is in use', () => {
    for (const code of ['EBUSY', 'EPERM']) {
      expect(toCodedError(errno(code), '/tmp/a.log').message).toMatch(/in use/i);
    }
  });

  it('words local errors without a path too', () => {
    const coded = toCodedError(errno('EEXIST'));
    expect(filesErrorCode(coded)).toBe('exists');
    expect(coded.message).toMatch(/\] [A-Z]/);
  });

  it('calls anything else a server error, keeping what it said', () => {
    const plain = toCodedError(new Error('Something odd'), '/srv');
    expect(filesErrorCode(plain)).toBe('server');
    expect(plain.message).toContain('Something odd');

    const thrown = toCodedError('just a string');
    expect(filesErrorCode(thrown)).toBe('server');
    expect(thrown.message).toContain('just a string');

    expect(filesErrorCode(toCodedError(undefined))).toBe('server');
  });
});

describe('toLocalCodedError', () => {
  it('maps errno codes as toCodedError does', () => {
    const coded = toLocalCodedError(errno('EEXIST'), 'C:\\x');
    expect(filesErrorCode(coded)).toBe('exists');
    expect(coded.message).toContain('C:\\x');
  });

  it('never puts an uncoded failure down to the server', () => {
    const coded = toLocalCodedError(new Error('Permission denied by policy'), '/tmp/a');
    expect(filesErrorCode(coded)).toBe('server');
    expect(coded.message).toContain('/tmp/a');
    expect(coded.message).toContain('Permission denied by policy');
    expect(coded.message).not.toMatch(/the server/i);
  });

  it('passes tagged errors through', () => {
    const files = filesError('exists', 'There.');
    expect(toLocalCodedError(files)).toBe(files);
  });
});
