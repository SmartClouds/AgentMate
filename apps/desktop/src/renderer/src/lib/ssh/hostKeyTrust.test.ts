import { encodeFilesError } from '@shared/deployFilesErrors';
import { encodeSshError } from '@shared/sshErrors';
import type { SshHostKeyStatus } from '@shared/sshHostKey';
import { describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { answerHostKeyPrompt, useHostKeyPromptStore } from '../../stores/hostKeyPromptStore';
import { withHostKeyTrust } from './hostKeyTrust';

/**
 * Any SSH connection the app makes (a terminal tab today, Deploy tomorrow) can hit a changed host
 * key. The user sees both fingerprints and decides; nothing is trusted without that answer.
 */

const status: SshHostKeyStatus = {
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  stored: 'ab'.repeat(32),
  presented: 'cd'.repeat(32),
};

const hostKeyChanged = () =>
  new Error(
    `Error invoking remote method 'ssh:create': Error: ${encodeSshError('host-key-changed', 'The host key changed.')}`,
  );

describe('withHostKeyTrust', () => {
  it('passes a successful connection straight through', async () => {
    const attempt = vi.fn().mockResolvedValue('connected');

    await expect(withHostKeyTrust('srv-1', attempt)).resolves.toBe('connected');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rethrows failures that are not about the host key', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('Could not reach prod.example:22.'));

    await expect(withHostKeyTrust('srv-1', attempt)).rejects.toThrow(
      'Could not reach prod.example:22.',
    );
  });

  it('asks, trusts the presented key and tries again when the user agrees', async () => {
    const trust = vi.fn(async () => undefined);
    installRunovaBridge({ 'ssh.hostKeyStatus': status, 'ssh.trustHostKey': trust });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(hostKeyChanged())
      .mockResolvedValueOnce('connected');

    const result = withHostKeyTrust('srv-1', attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    expect(useHostKeyPromptStore.getState().request).toMatchObject(status);
    answerHostKeyPrompt(true);

    await expect(result).resolves.toBe('connected');
    expect(trust).toHaveBeenCalledWith('srv-1', status.presented);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not connect or trust anything when the user declines', async () => {
    const trust = vi.fn(async () => undefined);
    installRunovaBridge({ 'ssh.hostKeyStatus': status, 'ssh.trustHostKey': trust });
    const attempt = vi.fn().mockRejectedValue(hostKeyChanged());

    const result = withHostKeyTrust('srv-1', attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(false);

    await expect(result).rejects.toThrow(/prod.*not trusted/);
    expect(trust).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries without asking when the key was trusted meanwhile', async () => {
    installRunovaBridge({ 'ssh.hostKeyStatus': { ...status, stored: status.presented } });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(hostKeyChanged())
      .mockResolvedValueOnce('connected');

    await expect(withHostKeyTrust('srv-1', attempt)).resolves.toBe('connected');
    expect(useHostKeyPromptStore.getState().request).toBeNull();
  });

  it('answers an older question with no when a newer one arrives', async () => {
    installRunovaBridge({ 'ssh.hostKeyStatus': status });
    const first = withHostKeyTrust('srv-1', vi.fn().mockRejectedValue(hostKeyChanged()));
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());

    const second = withHostKeyTrust('srv-1', vi.fn().mockRejectedValue(hostKeyChanged()));
    await expect(first).rejects.toThrow(/not trusted/);
    answerHostKeyPrompt(false);
    await expect(second).rejects.toThrow(/not trusted/);
  });

  it('ignores an answer when nothing was asked', () => {
    answerHostKeyPrompt(true);

    expect(useHostKeyPromptStore.getState().request).toBeNull();
  });
});

describe('withHostKeyTrust with a source of its own', () => {
  /** An FTP or SFTP site with a login of its own keeps its key itself, not in Remote. */
  const filesHostKeyChanged = () =>
    new Error(
      `Error invoking remote method 'deployFiles:plan': Error: ${encodeFilesError('hostKeyChanged', 'The host key changed.')}`,
    );

  function source(answer: SshHostKeyStatus = status) {
    return {
      status: vi.fn(async () => answer),
      trust: vi.fn(async (_fingerprint: string) => undefined),
    };
  }

  it('passes a successful call straight through without asking the source', async () => {
    const keys = source();
    const attempt = vi.fn().mockResolvedValue('planned');

    await expect(withHostKeyTrust(keys, attempt)).resolves.toBe('planned');
    expect(keys.status).not.toHaveBeenCalled();
  });

  it('asks, trusts through the source and tries again on a files host key error', async () => {
    const keys = source();
    const sshTrust = vi.fn(async () => undefined);
    installRunovaBridge({ 'ssh.trustHostKey': sshTrust });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(filesHostKeyChanged())
      .mockResolvedValueOnce('planned');

    const result = withHostKeyTrust(keys, attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    expect(useHostKeyPromptStore.getState().request).toMatchObject(status);
    answerHostKeyPrompt(true);

    await expect(result).resolves.toBe('planned');
    expect(keys.trust).toHaveBeenCalledWith(status.presented);
    expect(sshTrust).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('also answers an SSH-style host key error through the source', async () => {
    const keys = source();
    const attempt = vi.fn().mockRejectedValueOnce(hostKeyChanged()).mockResolvedValueOnce('ok');

    const result = withHostKeyTrust(keys, attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(true);

    await expect(result).resolves.toBe('ok');
    expect(keys.trust).toHaveBeenCalledWith(status.presented);
  });

  it('trusts nothing when the user declines', async () => {
    const keys = source();
    const attempt = vi.fn().mockRejectedValue(filesHostKeyChanged());

    const result = withHostKeyTrust(keys, attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(false);

    await expect(result).rejects.toThrow(/prod.*not trusted/);
    expect(keys.trust).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries without asking when the source already has the presented key', async () => {
    const keys = source({ ...status, stored: status.presented });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(filesHostKeyChanged())
      .mockResolvedValueOnce('planned');

    await expect(withHostKeyTrust(keys, attempt)).resolves.toBe('planned');
    expect(useHostKeyPromptStore.getState().request).toBeNull();
    expect(keys.trust).not.toHaveBeenCalled();
  });

  it('rethrows other files failures untouched', async () => {
    const keys = source();
    const failure = new Error(encodeFilesError('auth', 'Wrong password.'));

    await expect(withHostKeyTrust(keys, vi.fn().mockRejectedValue(failure))).rejects.toBe(failure);
    expect(keys.status).not.toHaveBeenCalled();
  });
});
