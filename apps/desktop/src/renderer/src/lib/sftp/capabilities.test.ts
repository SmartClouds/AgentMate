import type { SftpSessionInfo } from '@shared/sftpTypes';
import { describe, expect, it } from 'vitest';
import { allowed, limitationOf, refusalFor } from './capabilities';

/**
 * What a remote side lets the file manager do (E27). A saved server's disk over SFTP allows
 * everything, and so does any session that says nothing; a stopped or shell-less container
 * turns some actions off, with a sentence that says why.
 */

const SSH: SftpSessionInfo = {
  sessionId: 'sess-1',
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  home: '/home/deploy',
};

const STOPPED: SftpSessionInfo = {
  ...SSH,
  serverId: 'docker~srv-1~container~web-1',
  kind: 'container',
  capabilities: { rename: false, remove: false, chmod: false, edit: false },
  limitation: 'The container is stopped. Start it to rename, delete or change permissions.',
};

describe('allowed', () => {
  it('allows everything when the session says nothing, or there is no session', () => {
    for (const action of ['rename', 'remove', 'chmod', 'edit'] as const) {
      expect(allowed(SSH, action)).toBe(true);
      expect(allowed(null, action)).toBe(true);
    }
  });

  it('follows what the session says, action by action', () => {
    const shellLess: SftpSessionInfo = {
      ...STOPPED,
      capabilities: { rename: true, remove: true, chmod: false, edit: false },
    };
    expect(allowed(shellLess, 'rename')).toBe(true);
    expect(allowed(shellLess, 'remove')).toBe(true);
    expect(allowed(shellLess, 'chmod')).toBe(false);
    expect(allowed(shellLess, 'edit')).toBe(false);
  });
});

describe('limitationOf', () => {
  it('is the sentence the session gives, or null', () => {
    expect(limitationOf(STOPPED)).toBe(
      'The container is stopped. Start it to rename, delete or change permissions.',
    );
    expect(limitationOf(SSH)).toBeNull();
    expect(limitationOf({ ...STOPPED, limitation: '  ' })).toBeNull();
    expect(limitationOf(null)).toBeNull();
  });
});

describe('refusalFor', () => {
  it('is null for an allowed action', () => {
    expect(refusalFor(SSH, 'remove')).toBeNull();
  });

  it('gives the session sentence, or a plain one when the session has none', () => {
    expect(refusalFor(STOPPED, 'rename')).toBe(STOPPED.limitation);
    const quiet = { ...STOPPED, limitation: null };
    expect(refusalFor(quiet, 'rename')).toBe("Renaming isn't possible here.");
    expect(refusalFor(quiet, 'remove')).toBe("Deleting isn't possible here.");
    expect(refusalFor(quiet, 'chmod')).toBe("Changing permissions isn't possible here.");
    expect(refusalFor(quiet, 'edit')).toBe("Editing in place isn't possible here.");
  });
});
