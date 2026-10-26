import { describe, expect, it, vi } from 'vitest';
import type { SshAuthMethod } from '../../shared/apiTypes';
import { coreErrorCode, encodeCoreError } from '../../shared/coreErrors';
import type {
  SecurityChecklist,
  SshHardeningChangeInfo,
  SshHardeningPreview,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { DeploySshProgressEvent } from '../../shared/deployHardeningTypes';
import { DeployHardening, PASSWORD_LOGIN_REFUSAL } from './hardening';

/**
 * The checklist and its SSH fixes from the main process: the checklist carries the release this
 * build installs, the SSH change is refused here when the saved login is a password, and it is
 * previewed, applied and kept over new SSH connections, each step reported.
 */

const CHANGE: SshHardeningChangeInfo = {
  id: 'c1',
  state: 'awaitingConfirmation',
  summary: 'SSH password login off',
  createdAtUnixMs: 1,
  deadlineUnixMs: 60_001,
  requestedBy: 'maria',
};

const PREVIEW: SshHardeningPreview = {
  summary: 'SSH password login off',
  path: '/etc/ssh/sshd_config.d/00-runova.conf',
  content: 'PasswordAuthentication no\n',
  commands: ['sshd -t'],
  proof: { keyLoginProven: true, explanation: 'signed in with a key' },
  allowed: true,
  confirmWithinSeconds: 60,
  notes: ['Connections open now stay open.'],
};

function setup(
  options: {
    method?: SshAuthMethod | null;
    fresh?: 'fails';
    hub?: Partial<ICoreHub>;
    available?: () => Promise<string | null>;
    roles?: string[] | null;
  } = {},
) {
  const calls: string[] = [];
  const hub = {
    getSecurityChecklist: vi.fn(async () => ({ score: 50 }) as unknown as SecurityChecklist),
    previewSshHardening: vi.fn(async () => PREVIEW),
    applySshHardening: vi.fn(async () => CHANGE),
    confirmSshHardening: vi.fn(async () => ({ ...CHANGE, state: 'confirmed' as const })),
    revertSshHardening: vi.fn(async () => ({ ...CHANGE, state: 'rolledBack' as const })),
    ...options.hub,
  } as unknown as ICoreHub;
  const events: DeploySshProgressEvent[] = [];
  const hardening = new DeployHardening({
    links: {
      call: async (_id, work) => {
        calls.push('link');
        return work(hub);
      },
    },
    service: {
      withFreshHub: async (_id, work) => {
        if (options.fresh === 'fails')
          throw new Error('All configured authentication methods failed');
        calls.push('fresh');
        return work(hub);
      },
      availableCoreVersion: options.available ?? (async () => '1.4.0'),
      loginMethod: async () => (options.method === undefined ? 'privateKey' : options.method),
    },
    roles: () => (options.roles === undefined ? ['admin'] : options.roles),
    progress: (event) => events.push(event),
    now: () => 5,
  });
  const steps = () => events.map((event) => `${event.operation}:${event.step}:${event.state}`);
  return { hub, hardening, calls, steps, events };
}

const INPUT = { serverId: 'srv', disablePasswordLogin: true, restrictRootLogin: false };

describe('DeployHardening', () => {
  it('reads the checklist on the lasting connection with the release this build installs', async () => {
    const { hardening, hub, calls } = setup();

    await hardening.checklist('srv');

    expect(hub.getSecurityChecklist).toHaveBeenCalledWith({ availableCoreVersion: '1.4.0' });
    expect(calls).toEqual(['link']);
  });

  it('says what a role cannot do', async () => {
    const { hardening } = setup({
      hub: {
        getSecurityChecklist: async () => {
          throw new Error("Failed to invoke 'GetSecurityChecklist' because user is unauthorized");
        },
      },
    });

    const failure = await hardening.checklist('srv').catch((error) => error);

    expect(coreErrorCode(failure)).toBe('forbidden');
    expect(String(failure.message)).toContain('(admin)');
  });

  it('previews over a new connection, and never allows it while the saved login is a password', async () => {
    const key = setup();
    const password = setup({ method: 'password' });

    expect(await key.hardening.previewSsh(INPUT)).toEqual(PREVIEW);
    const refused = await password.hardening.previewSsh(INPUT);

    expect(key.calls).toEqual(['fresh']);
    expect(refused.allowed).toBe(false);
    expect(refused.notes[0]).toBe(PASSWORD_LOGIN_REFUSAL);
  });

  it('refuses to apply over a saved password before the core is asked', async () => {
    const { hardening, hub, steps } = setup({ method: 'password' });

    await expect(hardening.applySsh(INPUT)).rejects.toThrow(PASSWORD_LOGIN_REFUSAL);

    expect(hub.applySshHardening).not.toHaveBeenCalled();
    expect(steps()).toEqual(['apply:checkingLogin:running', 'apply:checkingLogin:failed']);
  });

  it('applies over a new key login and keeps the change over another', async () => {
    const { hardening, hub, calls, steps } = setup();

    const change = await hardening.applySsh(INPUT);
    const kept = await hardening.confirmSsh({ serverId: 'srv', changeId: change.id });

    expect(hub.applySshHardening).toHaveBeenCalledWith({
      disablePasswordLogin: true,
      restrictRootLogin: false,
    });
    expect(hub.confirmSshHardening).toHaveBeenCalledWith('c1');
    expect(kept.state).toBe('confirmed');
    expect(calls).toEqual(['fresh', 'fresh']);
    expect(steps()).toEqual([
      'apply:checkingLogin:running',
      'apply:checkingLogin:done',
      'apply:openingConnection:running',
      'apply:openingConnection:done',
      'apply:applying:running',
      'apply:applying:done',
      'confirm:openingConnection:running',
      'confirm:openingConnection:done',
      'confirm:confirming:running',
      'confirm:confirming:done',
    ]);
  });

  it('lets a refused policy through as it is, so the window can ask for a step-up', async () => {
    const { hardening } = setup({
      hub: {
        applySshHardening: async () => {
          throw new Error("Failed to invoke 'ApplySshHardening' because user is unauthorized");
        },
      },
    });

    await expect(hardening.applySsh(INPUT)).rejects.toThrow(/because user is unauthorized/);
  });

  it('says the timer rolls back when a new connection cannot get in to keep it', async () => {
    const { hardening, steps } = setup({ fresh: 'fails' });

    await expect(hardening.confirmSsh({ serverId: 'srv', changeId: 'c1' })).rejects.toThrow(
      /rolls back by itself at its deadline/,
    );
    expect(steps()).toEqual([
      'confirm:openingConnection:running',
      'confirm:openingConnection:failed',
    ]);
  });

  it('passes the core refusal of a confirmation through', async () => {
    const { hardening } = setup({
      hub: {
        confirmSshHardening: async () => {
          throw new Error('A new connection has to show that key login still works.');
        },
      },
    });

    await expect(hardening.confirmSsh({ serverId: 'srv', changeId: 'c1' })).rejects.toThrow(
      'A new connection has to show that key login still works.',
    );
  });

  it('reverts over the lasting connection', async () => {
    const { hardening, calls, steps } = setup();

    const reverted = await hardening.revertSsh({ serverId: 'srv', changeId: 'c1' });

    expect(reverted.state).toBe('rolledBack');
    expect(calls).toEqual(['link']);
    expect(steps()).toEqual(['revert:reverting:running', 'revert:reverting:done']);
  });

  it('reports a failed revert', async () => {
    const { hardening, steps } = setup({
      hub: {
        revertSshHardening: async () => {
          throw new Error('The old settings could not be put back');
        },
      },
    });

    await expect(hardening.revertSsh({ serverId: 'srv', changeId: 'c1' })).rejects.toThrow(
      'The old settings could not be put back',
    );
    expect(steps()).toEqual(['revert:reverting:running', 'revert:reverting:failed']);
  });

  it('asks for the checklist without a release when the build has none or cannot tell', async () => {
    const none = setup({ available: async () => null });
    const broken = setup({
      available: async () => {
        throw new Error('no manifest');
      },
    });

    await none.hardening.checklist('srv');
    await broken.hardening.checklist('srv');

    expect(none.hub.getSecurityChecklist).toHaveBeenCalledWith({});
    expect(broken.hub.getSecurityChecklist).toHaveBeenCalledWith({});
  });

  it('says a role cannot do it without naming roles it does not know', async () => {
    const { hardening } = setup({
      roles: null,
      hub: {
        revertSshHardening: async () => {
          throw new Error("Failed to invoke 'RevertSshHardening' because user is unauthorized");
        },
      },
    });

    const failure = await hardening.revertSsh({ serverId: 'srv', changeId: 'c1' }).catch((e) => e);

    expect(coreErrorCode(failure)).toBe('forbidden');
    expect(String(failure.message)).toContain('Your role on this server cannot');
  });

  it('keeps the connection own coded refusals, and explains a failed preview', async () => {
    const signIn = new Error(encodeCoreError('sessionExpired', 'Sign in again.'));
    const coded = setup({
      hub: {
        applySshHardening: async () => {
          throw signIn;
        },
        getSecurityChecklist: async () => {
          throw signIn;
        },
      },
    });
    const preview = setup({
      hub: {
        previewSshHardening: async () => {
          throw new Error('The core could not tell which SSH connection this came over.');
        },
      },
    });

    await expect(coded.hardening.applySsh(INPUT)).rejects.toBe(signIn);
    await expect(coded.hardening.checklist('srv')).rejects.toBe(signIn);
    await expect(preview.hardening.previewSsh(INPUT)).rejects.toThrow(/could not tell/);
  });

  it('keeps a coded refusal of a confirmation as it is', async () => {
    const { hardening } = setup({
      hub: {
        confirmSshHardening: async () => {
          throw new Error(encodeCoreError('stepUpRequired', 'Confirm it is you.'));
        },
      },
    });

    const failure = await hardening.confirmSsh({ serverId: 'srv', changeId: 'c1' }).catch((e) => e);

    expect(String(failure.message)).toContain('Confirm it is you.');
  });
});
