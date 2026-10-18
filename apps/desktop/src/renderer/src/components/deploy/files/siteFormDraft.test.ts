import type { FileSite } from '@shared/deployFilesTypes';
import { describe, expect, it } from 'vitest';
import {
  browseTarget,
  connectionKey,
  defaultLabel,
  draftFromSite,
  draftToInput,
  emptyDraft,
  firstError,
  keepsStoredSecret,
  type SiteDraft,
  testBlockers,
  validateDraft,
  withAuthMethod,
  withHost,
  withPort,
  withProtocol,
  withTrust,
} from './siteFormDraft';

/**
 * The add and edit form's model, kept pure so every rule is checked here: what the defaults are,
 * which details belong to which protocol, what counts as valid, and what goes to main.
 */

const FP = 'ab'.repeat(32);

function draft(overrides: Partial<SiteDraft> = {}): SiteDraft {
  return {
    ...emptyDraft(),
    host: 'files.bakery.example',
    username: 'deploy',
    secret: 'hunter2',
    remoteRoot: '/public_html',
    localFolder: 'C:\\sites\\bakery',
    ...overrides,
  };
}

function site(overrides: Partial<FileSite> = {}): FileSite {
  return {
    id: 'site-1',
    label: 'Bakery',
    protocol: 'sftp',
    connection: {
      kind: 'custom',
      host: 'files.bakery.example',
      port: 2222,
      username: 'deploy',
      authMethod: 'privateKey',
      privateKeyPath: 'C:\\keys\\id_ed25519',
      hostKeyFingerprint: FP,
      tlsPin: null,
      tlsServername: null,
      hasSecret: true,
    },
    remoteRoot: '/srv/www',
    localFolder: 'C:\\sites\\bakery',
    projectIds: ['p1'],
    deployOnSave: true,
    quietSeconds: 12,
    ignorePatterns: ['*.log'],
    capabilities: null,
    lastDeploy: null,
    needsReview: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('emptyDraft', () => {
  it('starts on SFTP with a login of its own on port 22', () => {
    const empty = emptyDraft();
    expect(empty.protocol).toBe('sftp');
    expect(empty.source).toBe('custom');
    expect(empty.port).toBe('22');
    expect(empty.authMethod).toBe('password');
    expect(empty.deployOnSave).toBe(false);
    expect(empty.quietSeconds).toBe('5');
  });
});

describe('draftFromSite', () => {
  it('reads every field of a site with a login of its own, never a secret', () => {
    const read = draftFromSite(site());
    expect(read).toMatchObject({
      protocol: 'sftp',
      source: 'custom',
      host: 'files.bakery.example',
      port: '2222',
      username: 'deploy',
      authMethod: 'privateKey',
      privateKeyPath: 'C:\\keys\\id_ed25519',
      secret: '',
      hostKeyFingerprint: FP,
      remoteRoot: '/srv/www',
      localFolder: 'C:\\sites\\bakery',
      projectIds: ['p1'],
      deployOnSave: true,
      quietSeconds: '12',
      label: 'Bakery',
      ignorePatterns: ['*.log'],
    });
  });

  it('reads a site on a saved server', () => {
    const read = draftFromSite(site({ connection: { kind: 'saved', sshServerId: 'srv-1' } }));
    expect(read.source).toBe('saved');
    expect(read.sshServerId).toBe('srv-1');
    expect(read.port).toBe('22');
  });
});

describe('withProtocol', () => {
  it('moves an untouched port to the new default', () => {
    expect(withProtocol(emptyDraft(), 'ftps').port).toBe('21');
    expect(withProtocol(withProtocol(emptyDraft(), 'ftp'), 'sftp').port).toBe('22');
  });

  it('keeps a port the user chose', () => {
    const custom = withPort(emptyDraft(), '2200');
    expect(withProtocol(custom, 'ftps').port).toBe('2200');
  });

  it('follows again once the user typed the default back', () => {
    const back = withPort(withPort(emptyDraft(), '2200'), '22');
    expect(withProtocol(back, 'ftp').port).toBe('21');
  });

  it("treats a site's port as chosen only when it is not the default", () => {
    expect(withProtocol(draftFromSite(site()), 'ftps').port).toBe('2222');
    const connection = site().connection as Extract<FileSite['connection'], { kind: 'custom' }>;
    const onDefault = draftFromSite(site({ connection: { ...connection, port: 22 } }));
    expect(withProtocol(onDefault, 'ftps').port).toBe('21');
  });

  it('forces a password login of its own for FTP and FTPS', () => {
    const moved = withProtocol(draft({ source: 'saved', authMethod: 'privateKey' }), 'ftp');
    expect(moved.source).toBe('custom');
    expect(moved.authMethod).toBe('password');
  });
});

describe('withAuthMethod', () => {
  it('drops a typed secret when the login method changes, since it meant something else', () => {
    const keyed = withAuthMethod(draft({ secret: 'hunter2' }), 'privateKey');
    expect(keyed.authMethod).toBe('privateKey');
    expect(keyed.secret).toBe('');
    expect(withAuthMethod(draft({ secret: 'hunter2' }), 'password').secret).toBe('hunter2');
  });

  it('drops a passphrase when a key login turns into FTP', () => {
    const moved = withProtocol(draft({ authMethod: 'privateKey', secret: 'phrase' }), 'ftps');
    expect(moved.secret).toBe('');
    expect(withProtocol(draft({ secret: 'pw' }), 'ftps').secret).toBe('pw');
  });
});

describe('trust pins', () => {
  it('sends a trusted key only for the host and port it was trusted on', () => {
    const trusted = withTrust(draft(), { hostKeyFingerprint: FP });
    expect(draftToInput(trusted).connection).toMatchObject({ hostKeyFingerprint: FP });

    const elsewhere = withHost(trusted, 'other.example');
    expect(draftToInput(elsewhere).connection).toMatchObject({ hostKeyFingerprint: null });

    // Typing the old host back brings the trust back.
    const back = withHost(elsewhere, 'files.bakery.example');
    expect(draftToInput(back).connection).toMatchObject({ hostKeyFingerprint: FP });

    const otherPort = withPort(trusted, '2222');
    expect(draftToInput(otherPort).connection).toMatchObject({ hostKeyFingerprint: null });
  });

  it('keeps the pins of an edited site for its own host', () => {
    expect(draftToInput(draftFromSite(site())).connection).toMatchObject({
      hostKeyFingerprint: FP,
    });
  });

  it('sends certificate pins and names only for FTPS', () => {
    const pinned = withTrust(draft({ protocol: 'ftps', port: '21' }), {
      tlsPin: FP,
      tlsServername: 'server12.host.example',
    });
    expect(draftToInput(pinned).connection).toMatchObject({
      tlsPin: FP,
      tlsServername: 'server12.host.example',
      hostKeyFingerprint: null,
    });
    expect(draftToInput(withProtocol(pinned, 'ftp')).connection).toMatchObject({
      tlsPin: null,
      tlsServername: null,
    });
  });
});

describe('draftToInput', () => {
  it('builds a login of its own with the typed secret and trimmed fields', () => {
    const input = draftToInput(
      draft({
        host: '  files.bakery.example ',
        username: ' deploy ',
        remoteRoot: ' /public_html ',
      }),
    );
    expect(input).toEqual({
      label: 'files.bakery.example',
      protocol: 'sftp',
      connection: {
        kind: 'custom',
        host: 'files.bakery.example',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        privateKeyPath: null,
        hostKeyFingerprint: null,
        tlsPin: null,
        tlsServername: null,
        secret: 'hunter2',
      },
      remoteRoot: '/public_html',
      localFolder: 'C:\\sites\\bakery',
      projectIds: [],
      deployOnSave: false,
      quietSeconds: 5,
      ignorePatterns: [],
    });
  });

  it('leaves the secret out when none was typed, so the stored one stays', () => {
    const input = draftToInput(draft({ secret: '' }));
    expect('secret' in input.connection).toBe(false);
  });

  it('sends the key path only for a private key login', () => {
    const keyed = draftToInput(draft({ authMethod: 'privateKey', privateKeyPath: ' C:\\k ' }));
    expect(keyed.connection).toMatchObject({ authMethod: 'privateKey', privateKeyPath: 'C:\\k' });
    expect(draftToInput(draft({ privateKeyPath: 'C:\\k' })).connection).toMatchObject({
      privateKeyPath: null,
    });
  });

  it('builds a saved server connection with nothing else', () => {
    const input = draftToInput(draft({ source: 'saved', sshServerId: 'srv-1' }));
    expect(input.connection).toEqual({ kind: 'saved', sshServerId: 'srv-1' });
  });

  it('uses the typed label, quiet seconds and projects', () => {
    const input = draftToInput(
      draft({ label: ' Shop ', quietSeconds: '30', deployOnSave: true, projectIds: ['p1'] }),
    );
    expect(input).toMatchObject({
      label: 'Shop',
      quietSeconds: 30,
      deployOnSave: true,
      projectIds: ['p1'],
    });
  });

  it('keeps the quiet seconds the site had when the field is off and empty', () => {
    expect(draftToInput(draft({ quietSeconds: '' })).quietSeconds).toBe(5);
  });
});

describe('defaultLabel', () => {
  it('takes the host, then the saved server, then the folder name', () => {
    expect(defaultLabel(draft())).toBe('files.bakery.example');
    expect(defaultLabel(draft({ source: 'saved', sshServerId: 'srv-1' }), 'prod')).toBe('prod');
    expect(defaultLabel(draft({ host: '' }))).toBe('bakery');
    expect(defaultLabel(draft({ host: '', localFolder: '/home/me/www/' }))).toBe('www');
    expect(defaultLabel(draft({ host: '', localFolder: '' }))).toBe('New site');
  });
});

describe('validateDraft', () => {
  it('passes a complete draft', () => {
    expect(validateDraft(draft(), { storedSecret: false })).toEqual({});
  });

  it('asks for every required detail of a login of its own', () => {
    const errors = validateDraft(
      draft({ host: ' ', username: '', secret: '', remoteRoot: '', localFolder: '' }),
      { storedSecret: false },
    );
    expect(Object.keys(errors).sort()).toEqual(
      ['host', 'localFolder', 'remoteRoot', 'secret', 'username'].sort(),
    );
  });

  it('keeps the stored secret on an edit', () => {
    expect(validateDraft(draft({ secret: '' }), { storedSecret: true }).secret).toBeUndefined();
  });

  it('needs a key file for a key login, but no passphrase', () => {
    const errors = validateDraft(draft({ authMethod: 'privateKey', secret: '' }), {
      storedSecret: false,
    });
    expect(errors.privateKeyPath).toBeTruthy();
    expect(errors.secret).toBeUndefined();
  });

  it('needs a saved server when one is to be used', () => {
    const errors = validateDraft(draft({ source: 'saved', host: '', secret: '' }), {
      storedSecret: false,
    });
    expect(Object.keys(errors)).toEqual(['sshServerId']);
  });

  it.each(['0', '65536', '2.5', 'abc', ''])('refuses port %s', (port) => {
    expect(validateDraft(draft({ port }), { storedSecret: false }).port).toBeTruthy();
  });

  it('refuses a host written as an address', () => {
    expect(
      validateDraft(draft({ host: 'sftp://files.example' }), { storedSecret: false }).host,
    ).toMatch(/Leave out/);
    expect(
      validateDraft(draft({ host: 'files example' }), { storedSecret: false }).host,
    ).toBeTruthy();
  });

  it('wants the server folder absolute', () => {
    expect(
      validateDraft(draft({ remoteRoot: 'public_html' }), { storedSecret: false }).remoteRoot,
    ).toMatch(/Start the folder with \//);
  });

  it('wants the local folder as a full path', () => {
    const relative = validateDraft(draft({ localFolder: 'sites\\bakery' }), {
      storedSecret: false,
    });
    expect(relative.localFolder).toMatch(/full path/);
    for (const path of ['C:\\x', 'D:/x', '\\\\nas\\share', '/home/me/site']) {
      expect(validateDraft(draft({ localFolder: path }), { storedSecret: false })).toEqual({});
    }
  });

  it('checks the quiet seconds only while Deploy on save is on', () => {
    expect(validateDraft(draft({ quietSeconds: '1' }), { storedSecret: false })).toEqual({});
    for (const value of ['1', '121', 'x', '']) {
      expect(
        validateDraft(draft({ deployOnSave: true, quietSeconds: value }), { storedSecret: false })
          .quietSeconds,
      ).toBeTruthy();
    }
    expect(
      validateDraft(draft({ deployOnSave: true, quietSeconds: '120' }), { storedSecret: false }),
    ).toEqual({});
  });

  it('keeps the name short', () => {
    expect(
      validateDraft(draft({ label: 'x'.repeat(101) }), { storedSecret: false }).label,
    ).toBeTruthy();
  });
});

describe('testBlockers and firstError', () => {
  it('only lets the connection and server folder block a test', () => {
    const errors = validateDraft(draft({ localFolder: '', host: '' }), { storedSecret: false });
    expect(Object.keys(testBlockers(errors, 'test'))).toEqual(['host']);
  });

  it('lets browsing go ahead without a server folder', () => {
    const errors = validateDraft(draft({ remoteRoot: '' }), { storedSecret: false });
    expect(testBlockers(errors, 'test')).toHaveProperty('remoteRoot');
    expect(testBlockers(errors, 'browse')).toEqual({});
  });

  it('names the first invalid field in the order of the form', () => {
    expect(firstError({ label: 'x', host: 'y', remoteRoot: 'z' })).toBe('host');
    expect(firstError({})).toBeNull();
  });
});

describe('keepsStoredSecret', () => {
  it('keeps the stored secret only while the login method is the same', () => {
    const edited = draftFromSite(site());
    expect(keepsStoredSecret(edited, site())).toBe(true);
    expect(keepsStoredSecret({ ...edited, authMethod: 'password' }, site())).toBe(false);
    expect(keepsStoredSecret({ ...edited, source: 'saved' }, site())).toBe(false);
    expect(keepsStoredSecret(edited, null)).toBe(false);
    expect(
      keepsStoredSecret(edited, site({ connection: { kind: 'saved', sshServerId: 's' } })),
    ).toBe(false);
  });
});

describe('connectionKey and browseTarget', () => {
  it('changes with anything that changes what a test would find', () => {
    const base = connectionKey(draft());
    expect(connectionKey(draft())).toBe(base);
    expect(connectionKey(draft({ remoteRoot: '/www' }))).not.toBe(base);
    expect(connectionKey(draft({ secret: 'other' }))).not.toBe(base);
    expect(connectionKey(withProtocol(draft(), 'ftps'))).not.toBe(base);
    // The label and projects don't touch the server.
    expect(connectionKey(draft({ label: 'Shop', projectIds: ['p1'] }))).toBe(base);
  });

  it('names the connection for the cache without its secret', () => {
    const target = browseTarget(draft(), null);
    expect(target).not.toContain('hunter2');
    expect(browseTarget(draft({ secret: 'other' }), null)).toBe(target);
    expect(browseTarget(draft({ host: 'other.example' }), null)).not.toBe(target);
    expect(browseTarget(draft({ source: 'saved', sshServerId: 'srv-1' }), 'site-1')).toContain(
      'srv-1',
    );
  });
});
