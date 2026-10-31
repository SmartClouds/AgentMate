import { describe, expect, it } from 'vitest';
import { cloudflareErrorCode, cloudflareErrorPermission } from '../../../shared/cloudflareErrors';
import type { TurnstileWidgetInput } from '../../../shared/cloudflareTypes';
import { ALL_GRANTS } from './testing/fakeCloudflare';
import { ACCOUNT, connectedService, TOKEN } from './testing/harness';
import {
  CF_ACCOUNT_ID,
  OTHER_ZONE_ID,
  SITEKEY,
  turnstileWidget,
  ZONE_ID,
} from './testing/recorded';

/**
 * Turnstile widgets (E43), reached from a zone: the zone says which Cloudflare account to ask,
 * and the account's saved token makes the call. The secret is read only when asked for and never
 * kept, and a token without Account > Turnstile > Edit is told exactly that.
 */

const GRANTS = { ...ALL_GRANTS, turnstile: 'edit' } as const;

const INPUT: TurnstileWidgetInput = {
  name: 'Contact form',
  domains: ['example.com', 'shop.example.com'],
  mode: 'invisible',
  clearance: 'managed',
  region: 'world',
  offlabel: false,
  ephemeralId: true,
};

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail');
}

function widgets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...turnstileWidget,
    sitekey: `0x4AAAAAAAAlist${String(index).padStart(4, '0')}`,
    name: `Widget ${index}`,
  }));
}

describe('the Cloudflare account behind a zone', () => {
  it("keeps Cloudflare's account id on every zone", async () => {
    const { service } = await connectedService({ token: { grants: GRANTS } });
    const [zone] = await service.listZones(ACCOUNT);
    expect(zone?.cloudflareAccountId).toBe(CF_ACCOUNT_ID);
  });

  it('says so when Cloudflare does not name the account, without asking for widgets', async () => {
    const { service, fake } = await connectedService({
      token: { grants: GRANTS },
      zones: [{ id: ZONE_ID, name: 'example.com', cloudflareAccountId: null }],
    });
    expect((await service.listZones(ACCOUNT))[0]?.cloudflareAccountId).toBe('');
    fake.requests.length = 0;

    await expect(service.listTurnstileWidgets(ZONE_ID)).rejects.toThrow(/account/);
    expect(fake.requests).toEqual([]);
  });
});

describe('listing widgets', () => {
  it('reads every page of widgets in the account, without secrets', async () => {
    const { service, fake } = await connectedService({
      token: { grants: GRANTS },
      widgets: { [CF_ACCOUNT_ID]: widgets(60) },
    });

    const list = await service.listTurnstileWidgets(ZONE_ID);

    expect(list).toHaveLength(60);
    expect(list[0]).toEqual({
      sitekey: '0x4AAAAAAAAlist0000',
      name: 'Widget 0',
      domains: ['example.com', 'blog.example.com'],
      mode: 'managed',
      clearance: 'no_clearance',
      region: 'world',
      offlabel: false,
      ephemeralId: false,
      createdOn: turnstileWidget.created_on,
      modifiedOn: turnstileWidget.modified_on,
    });
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(fake.requests.map((request) => request.path)).toEqual([
      `/accounts/${CF_ACCOUNT_ID}/challenges/widgets`,
      `/accounts/${CF_ACCOUNT_ID}/challenges/widgets`,
      `/accounts/${CF_ACCOUNT_ID}/challenges/widgets`,
    ]);
  });

  it('finds the account of a zone the page has not listed since launch', async () => {
    const { service } = await connectedService({
      token: { grants: GRANTS },
      zones: [
        { id: ZONE_ID, name: 'example.com' },
        { id: OTHER_ZONE_ID, name: 'example.org', cloudflareAccountId: 'b'.repeat(32) },
      ],
      widgets: { ['b'.repeat(32)]: widgets(1) },
    });
    // A fresh service knows no zones yet.
    expect(await service.listTurnstileWidgets(OTHER_ZONE_ID)).toHaveLength(1);
  });

  it('names the Turnstile permission when the token lacks it, and leaves the main report alone', async () => {
    const { service } = await connectedService();
    const before = (await service.status()).accounts[0]?.report;

    const error = await rejection(service.listTurnstileWidgets(ZONE_ID));

    expect(cloudflareErrorCode(error)).toBe('missing-permission');
    expect(cloudflareErrorPermission(error)).toBe('turnstile');
    expect(error.message).toMatch(/Account > Turnstile > Edit/);
    expect(error.message).not.toContain(TOKEN);
    expect((await service.status()).accounts[0]?.report).toEqual(before);
  });
});

describe('making and changing widgets', () => {
  it('makes a widget and hands back its secret once', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });

    const made = await service.createTurnstileWidget(ZONE_ID, INPUT);

    expect(made.widget).toMatchObject({ ...INPUT, sitekey: expect.stringMatching(/^0x/) });
    expect(made.secret).toMatch(/^0x/);
    expect(fake.writes()[0]?.body).toEqual({
      name: 'Contact form',
      domains: ['example.com', 'shop.example.com'],
      mode: 'invisible',
      clearance_level: 'managed',
      region: 'world',
      offlabel: false,
      ephemeral_id: true,
    });
  });

  it('trims the name and refuses a widget Cloudflare would refuse, without asking it', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });

    await expect(service.createTurnstileWidget(ZONE_ID, { ...INPUT, domains: [] })).rejects.toThrow(
      /at least one/,
    );
    await expect(
      service.updateTurnstileWidget(ZONE_ID, SITEKEY, { ...INPUT, mode: 'loud' as never }),
    ).rejects.toThrow(/mode/);
    expect(fake.requests).toEqual([]);

    await service.createTurnstileWidget(ZONE_ID, { ...INPUT, name: '  Login  ' });
    expect(fake.writes()[0]?.body).toMatchObject({ name: 'Login' });
  });

  it('sends the whole widget on a change, as Cloudflare wants', async () => {
    const { service, fake } = await connectedService({
      token: { grants: GRANTS },
      widgets: { [CF_ACCOUNT_ID]: [turnstileWidget] },
    });

    const changed = await service.updateTurnstileWidget(ZONE_ID, SITEKEY, {
      ...INPUT,
      name: 'Renamed',
    });

    expect(changed).toMatchObject({ sitekey: SITEKEY, name: 'Renamed', mode: 'invisible' });
    const [write] = fake.writes();
    expect(write?.method).toBe('PUT');
    expect(write?.path).toBe(`/accounts/${CF_ACCOUNT_ID}/challenges/widgets/${SITEKEY}`);
    expect(write?.body).toMatchObject({ name: 'Renamed', domains: INPUT.domains });
  });

  it('deletes a widget', async () => {
    const { service, fake } = await connectedService({
      token: { grants: GRANTS },
      widgets: { [CF_ACCOUNT_ID]: [turnstileWidget] },
    });

    await service.deleteTurnstileWidget(ZONE_ID, SITEKEY);

    expect(fake.widgets.get(CF_ACCOUNT_ID)).toEqual([]);
  });

  it('refuses a site key that is not one before asking Cloudflare', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    await expect(service.deleteTurnstileWidget(ZONE_ID, '../../zones')).rejects.toThrow(/site key/);
    expect(fake.requests).toEqual([]);
  });
});

describe('the secret', () => {
  it('reads the secret only when asked, and keeps nothing', async () => {
    const { service, fake, port } = await connectedService({
      token: { grants: GRANTS },
      widgets: { [CF_ACCOUNT_ID]: [turnstileWidget] },
    });

    expect(await service.turnstileSecret(ZONE_ID, SITEKEY)).toBe(turnstileWidget.secret);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(JSON.stringify(port.value)).not.toContain(turnstileWidget.secret);
  });

  it('rotates the secret, keeping the old one for two hours unless told otherwise', async () => {
    const { service, fake } = await connectedService({
      token: { grants: GRANTS },
      widgets: { [CF_ACCOUNT_ID]: [turnstileWidget] },
    });

    const later = await service.rotateTurnstileSecret(ZONE_ID, SITEKEY, false);
    const now = await service.rotateTurnstileSecret(ZONE_ID, SITEKEY, true);

    expect(later.secret).not.toBe(turnstileWidget.secret);
    expect(now.secret).not.toBe(later.secret);
    expect(now.widget.sitekey).toBe(SITEKEY);
    expect(fake.writes().map((write) => [write.path, write.body])).toEqual([
      [
        `/accounts/${CF_ACCOUNT_ID}/challenges/widgets/${SITEKEY}/rotate_secret`,
        { invalidate_immediately: false },
      ],
      [
        `/accounts/${CF_ACCOUNT_ID}/challenges/widgets/${SITEKEY}/rotate_secret`,
        { invalidate_immediately: true },
      ],
    ]);
  });

  it('says plainly when the widget is gone', async () => {
    const { service } = await connectedService({ token: { grants: GRANTS } });
    await expect(service.turnstileSecret(ZONE_ID, SITEKEY)).rejects.toThrow(
      'That widget is not in this Cloudflare account any more. Refresh the list.',
    );
  });
});
