import { encodeFilesError } from '@shared/deployFilesErrors';
import type { FileSite } from '@shared/deployFilesTypes';
import { encodeSshError } from '@shared/sshErrors';
import type { SshHostKeyStatus } from '@shared/sshHostKey';
import { describe, expect, it, vi } from 'vitest';
import { answerHostKeyPrompt, useHostKeyPromptStore } from '@/stores/hostKeyPromptStore';
import { installAgentmatBridge } from '../../../../../test/renderer/agentmatBridge';
import { fileSiteHostKeySource, withFileSiteHostKeyTrust } from './hostKey';

/**
 * A site with a login of its own keeps its host key itself, so a changed key is asked about and
 * trusted through the site's channels; a site on a saved server goes through Remote's.
 */

const status: SshHostKeyStatus = {
  serverId: 'site-1',
  nickname: 'Bakery',
  host: 'files.bakery.example',
  port: 22,
  stored: 'ab'.repeat(32),
  presented: 'cd'.repeat(32),
};

function site(
  connection: FileSite['connection'],
  protocol: FileSite['protocol'] = 'sftp',
): FileSite {
  return {
    id: 'site-1',
    label: 'Bakery',
    protocol,
    connection,
    remoteRoot: '/public_html',
    localFolder: 'C:\\sites\\bakery',
    projectIds: [],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    capabilities: null,
    lastDeploy: null,
    needsReview: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const custom: FileSite['connection'] = {
  kind: 'custom',
  host: 'files.bakery.example',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  privateKeyPath: null,
  hostKeyFingerprint: 'ab'.repeat(32),
  tlsPin: null,
  tlsServername: null,
  hasSecret: true,
};

describe('fileSiteHostKeySource', () => {
  it("reads and trusts through the site's own channels", async () => {
    const trust = vi.fn(async () => undefined);
    const bridge = installAgentmatBridge({
      'deployFiles.hostKeyStatus': status,
      'deployFiles.trustHostKey': trust,
    });
    const source = fileSiteHostKeySource('site-1');

    await expect(source.status()).resolves.toEqual(status);
    await source.trust(status.presented);

    expect(bridge.$fn('deployFiles.hostKeyStatus')).toHaveBeenCalledWith('site-1');
    expect(trust).toHaveBeenCalledWith('site-1', status.presented);
  });
});

describe('withFileSiteHostKeyTrust', () => {
  it('asks about a changed key of a login of its own and trusts it for the site', async () => {
    const trust = vi.fn(async () => undefined);
    installAgentmatBridge({
      'deployFiles.hostKeyStatus': status,
      'deployFiles.trustHostKey': trust,
    });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error(encodeFilesError('hostKeyChanged', 'Changed.')))
      .mockResolvedValueOnce('planned');

    const result = withFileSiteHostKeyTrust(site(custom), attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(true);

    await expect(result).resolves.toBe('planned');
    expect(trust).toHaveBeenCalledWith('site-1', status.presented);
  });

  it('goes through the saved server for a site on a server saved in Remote', async () => {
    const trust = vi.fn(async () => undefined);
    installAgentmatBridge({
      'ssh.hostKeyStatus': { ...status, serverId: 'srv-9' },
      'ssh.trustHostKey': trust,
    });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error(encodeSshError('host-key-changed', 'Changed.')))
      .mockResolvedValueOnce('planned');

    const result = withFileSiteHostKeyTrust(site({ kind: 'saved', sshServerId: 'srv-9' }), attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(true);

    await expect(result).resolves.toBe('planned');
    expect(trust).toHaveBeenCalledWith('srv-9', status.presented);
  });

  it('just runs the call for FTP and FTPS, which have no host key', async () => {
    const failure = new Error(encodeFilesError('hostKeyChanged', 'Odd.'));
    const attempt = vi.fn().mockRejectedValue(failure);

    await expect(withFileSiteHostKeyTrust(site(custom, 'ftps'), attempt)).rejects.toBe(failure);
    expect(useHostKeyPromptStore.getState().request).toBeNull();
  });
});
