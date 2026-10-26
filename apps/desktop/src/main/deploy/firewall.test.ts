import { describe, expect, it } from 'vitest';
import { coreErrorCode } from '../../shared/coreErrors';
import type { FirewallChange } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { FAKE_CORE_PASSWORD, FakeCore } from '../../shared/deploy/testing/fakeCore';
import { FAKE_GUARD_PHRASE } from '../../shared/deploy/testing/fakeFirewall';
import type { DeployFirewallProgressEvent } from '../../shared/deployFirewallTypes';
import { DeployFirewall } from './firewall';

/**
 * Safe apply against the fake core: the change goes over the server's lasting connection with
 * the `$SSH_CONNECTION` read under it, the confirmation over a new connection (the core refuses
 * one over the connection that applied), and a change nobody keeps rolls back by its timer.
 */

const SSH = '203.0.113.50 51515 203.0.113.10 22';
const open8080: FirewallChange = {
  kind: 'addRule',
  rule: { action: 'allow', protocol: 'tcp', port: 8080 },
};

function setup(options: { fresh?: 'new' | 'same' | 'fails'; roles?: string[] } = {}) {
  let clock = 1_700_000_000_000;
  const core = new FakeCore(() => clock);
  if (options.roles) core.roles = options.roles;
  const link = core.connect();
  const fresh: ICoreHub[] = [];
  const events: DeployFirewallProgressEvent[] = [];
  const linkReads: string[] = [];
  const onLinkConnection = async <T>(id: string, work: (ssh: string | undefined) => Promise<T>) => {
    linkReads.push(id);
    return work(SSH);
  };
  const firewall = new DeployFirewall({
    links: { call: async (_id, work) => work(link) },
    service: {
      onLinkConnection,
      withFreshHub: async (_id, work, step) => {
        if (options.fresh === 'fails') throw new Error('connect ETIMEDOUT 203.0.113.10:22');
        step?.('signingIn');
        const hub = options.fresh === 'same' ? link : core.connect();
        fresh.push(hub);
        return work(hub);
      },
    },
    roles: () => core.roles,
    progress: (event) => events.push(event),
    now: () => clock,
  });
  const steps = () => events.map((event) => `${event.operation}:${event.step}:${event.state}`);
  return {
    core,
    link,
    fresh,
    events,
    steps,
    firewall,
    linkReads,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('DeployFirewall', () => {
  it('reads the status, presets, history and exposure over the lasting connection', async () => {
    const { firewall } = setup({ roles: ['viewer'] });

    const status = await firewall.status('srv-1');
    expect(status).toMatchObject({ backend: 'ufw', active: true, confirmWithinSeconds: 60 });
    expect(status.ssh.ports).toEqual([22]);
    expect((await firewall.presets('srv-1')).map((preset) => preset.id)).toContain('https');
    expect(await firewall.history({ serverId: 'srv-1', limit: 5 })).toEqual([]);
    expect(await firewall.history({ serverId: 'srv-1' })).toEqual([]);
    expect((await firewall.exposure('srv-1')).containers[0].firewall).toBe('bypassed');
  });

  it('previews with the SSH connection read on the link', async () => {
    const { firewall, linkReads } = setup();

    const preview = await firewall.preview({ serverId: 'srv-1', changes: [open8080] });

    expect(linkReads).toEqual(['srv-1']);
    expect(preview.commands).toEqual(['ufw allow 8080 proto tcp']);
    expect(preview.guard.blocked).toBe(false);
    expect(preview.needsStepUp).toBe(false);
  });

  it('applies over the link, then keeps the change over a new connection', async () => {
    const { firewall, core, link, fresh, steps } = setup();

    const change = await firewall.apply({ serverId: 'srv-1', changes: [open8080] });
    expect(change.state).toBe('awaitingConfirmation');
    expect(change.appliedFrom).toBe('203.0.113.50');
    expect(change.deadlineUnixMs).toBe(core.now() + 60_000);
    expect((await firewall.status('srv-1')).pending?.id).toBe(change.id);

    const kept = await firewall.confirm({ serverId: 'srv-1', changeSetId: change.id });
    expect(kept.state).toBe('confirmed');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe(link);
    expect(steps()).toEqual([
      'apply:readingConnection:running',
      'apply:readingConnection:done',
      'apply:applying:running',
      'apply:applying:done',
      'confirm:openingConnection:running',
      'confirm:openingConnection:done',
      'confirm:signingIn:running',
      'confirm:signingIn:done',
      'confirm:confirming:running',
      'confirm:confirming:done',
    ]);
    expect(core.firewall.rules.some((rule) => rule.port === 8080)).toBe(true);
  });

  it('is refused by the core when the confirmation comes over the connection that applied', async () => {
    const { firewall, events } = setup({ fresh: 'same' });
    const change = await firewall.apply({ serverId: 'srv-1', changes: [open8080] });

    await expect(firewall.confirm({ serverId: 'srv-1', changeSetId: change.id })).rejects.toThrow(
      /same SSH connection/,
    );
    expect(events.at(-1)).toMatchObject({
      operation: 'confirm',
      step: 'confirming',
      state: 'failed',
      changeSetId: change.id,
    });
  });

  it('leaves the change to its timer when a new connection cannot get in', async () => {
    const { firewall, core, events, tick } = setup({ fresh: 'fails' });
    const change = await firewall.apply({ serverId: 'srv-1', changes: [open8080] });

    await expect(firewall.confirm({ serverId: 'srv-1', changeSetId: change.id })).rejects.toThrow(
      /could not get in \(connect ETIMEDOUT.*rolls back by itself/,
    );
    expect(events.at(-1)).toMatchObject({ step: 'openingConnection', state: 'failed' });

    tick(60_001);
    const [latest] = await firewall.history({ serverId: 'srv-1' });
    expect(latest).toMatchObject({ id: change.id, state: 'rolledBack', rolledBackBy: 'timer' });
    expect(core.firewall.rules.some((rule) => rule.port === 8080)).toBe(false);
    expect([...core.alerts.values()].map((alert) => alert.kind)).toContain('firewallRolledBack');
    await expect(firewall.status('srv-1')).resolves.not.toHaveProperty('pending');
  });

  it('reverts a waiting change now', async () => {
    const { firewall, core, steps } = setup();
    const change = await firewall.apply({ serverId: 'srv-1', changes: [open8080] });

    const reverted = await firewall.revert({ serverId: 'srv-1', changeSetId: change.id });

    expect(reverted).toMatchObject({ state: 'rolledBack', rolledBackBy: 'user' });
    expect(core.firewall.rules.some((rule) => rule.port === 8080)).toBe(false);
    expect(steps().slice(-2)).toEqual(['revert:reverting:running', 'revert:reverting:done']);
    await expect(firewall.revert({ serverId: 'srv-1', changeSetId: 'nope' })).rejects.toThrow(
      /no such firewall change/,
    );
    expect(steps().at(-1)).toBe('revert:reverting:failed');
  });

  it('asks for a step-up to turn the firewall off, and applies with the password', async () => {
    const { firewall, events } = setup();
    const off = { serverId: 'srv-1', changes: [{ kind: 'disable' as const }] };

    expect((await firewall.preview(off)).needsStepUp).toBe(true);
    const refused = await firewall.apply(off).catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('stepUpRequired');
    expect(events.at(-1)).toMatchObject({ step: 'applying', state: 'failed' });

    const change = await firewall.apply({ ...off, password: FAKE_CORE_PASSWORD });
    expect(change.summary).toBe('turn the firewall off');
  });

  it('refuses a change that closes SSH until the phrase is typed, with a step-up', async () => {
    const { firewall } = setup();
    const ssh = (await firewall.status('srv-1')).rules.find((rule) => rule.port === 22);
    const cut = { serverId: 'srv-1', changes: [{ kind: 'removeRule' as const, ruleId: ssh?.id }] };

    const preview = await firewall.preview(cut);
    expect(preview.guard).toMatchObject({ blocked: true, confirmationPhrase: FAKE_GUARD_PHRASE });
    await expect(firewall.apply(cut)).rejects.toThrow(/would cut this computer off from SSH/);
    await expect(firewall.apply({ ...cut, overrideConfirmation: 'yes' })).rejects.toThrow(
      /not the phrase/,
    );
    const noStepUp = await firewall
      .apply({ ...cut, overrideConfirmation: FAKE_GUARD_PHRASE })
      .catch((error: unknown) => error);
    expect(coreErrorCode(noStepUp)).toBe('stepUpRequired');

    const change = await firewall.apply({
      ...cut,
      overrideConfirmation: FAKE_GUARD_PHRASE,
      password: FAKE_CORE_PASSWORD,
    });
    expect(change.guardOverridden).toBe(true);
  });

  it('says a role cannot change the firewall, in its own words', async () => {
    const { firewall } = setup({ roles: ['operator'] });

    const refused = await firewall
      .apply({ serverId: 'srv-1', changes: [open8080] })
      .catch((error: unknown) => error);

    expect(coreErrorCode(refused)).toBe('forbidden');
    expect(String(refused)).toContain('(operator) cannot do that in the Firewall section');
    await expect(firewall.preview({ serverId: 'srv-1', changes: [open8080] })).rejects.toThrow(
      /cannot do that/,
    );
  });

  it('refuses a second change while one waits, and a late confirmation', async () => {
    const { firewall, tick } = setup();
    const change = await firewall.apply({ serverId: 'srv-1', changes: [open8080] });
    await expect(firewall.apply({ serverId: 'srv-1', changes: [open8080] })).rejects.toThrow(
      /Another firewall change is waiting/,
    );

    tick(61_000);
    await expect(firewall.confirm({ serverId: 'srv-1', changeSetId: change.id })).rejects.toThrow(
      /Too late/,
    );
  });

  it('keeps the codes the connection already put on its refusals', async () => {
    const coded = new Error('[core:sessionExpired] Sign in again.');
    const firewall = new DeployFirewall({
      links: { call: async () => Promise.reject(coded) },
      service: {
        onLinkConnection: async (_id, work) => work(undefined),
        withFreshHub: async () => Promise.reject(coded),
      },
      roles: () => null,
      progress: () => undefined,
    });

    await expect(firewall.status('srv-1')).rejects.toBe(coded);
    await expect(firewall.confirm({ serverId: 'srv-1', changeSetId: 'x' })).rejects.toBe(coded);
  });
});
