import type { Project } from '@agentmat/core';
import type { SshSavedServer } from '@shared/apiTypes';
import { encodeFilesError } from '@shared/deployFilesErrors';
import type {
  FileSite,
  FileSiteInput,
  FilesTestInput,
  FilesTestResult,
  FilesTestStepResult,
} from '@shared/deployFilesTypes';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import { answerHostKeyPrompt, useHostKeyPromptStore } from '@/stores/hostKeyPromptStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SiteFormDialog } from './SiteFormDialog';

/**
 * Adding or editing an FTP or SFTP site: the form knows which details each protocol needs,
 * tests the connection before saving and offers the fix for what the test finds, never sends a
 * stored secret back, and keeps everything typed when main refuses it.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

const FP = 'ab'.repeat(32);
const NEW_FP = 'cd'.repeat(32);

const OK_STEPS: FilesTestStepResult[] = (
  ['reach', 'login', 'folder', 'write', 'replace', 'time', 'cleanup'] as const
).map((step) => ({ step, status: 'ok', message: null }));

function passed(overrides: Partial<FilesTestResult> = {}): FilesTestResult {
  return {
    ok: true,
    steps: OK_STEPS,
    capabilities: { atomicReplace: true, mtime: 'exact', checkedAt: 1 },
    remoteRoot: '/public_html',
    hostKey: null,
    certificate: null,
    error: null,
    ...overrides,
  };
}

function failed(overrides: Partial<FilesTestResult>): FilesTestResult {
  return passed({
    ok: false,
    steps: OK_STEPS.map((one, index) =>
      index === 0 ? { ...one, status: 'failed' } : { ...one, status: 'skipped' },
    ),
    capabilities: null,
    remoteRoot: null,
    ...overrides,
  });
}

function savedSite(overrides: Partial<FileSite> = {}): FileSite {
  return {
    id: 'site-1',
    label: 'Bakery',
    protocol: 'sftp',
    connection: {
      kind: 'custom',
      host: 'files.bakery.example',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: FP,
      tlsPin: null,
      tlsServername: null,
      hasSecret: true,
    },
    remoteRoot: '/public_html',
    localFolder: 'C:\\sites\\bakery',
    projectIds: [],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: ['*.log'],
    capabilities: null,
    lastDeploy: null,
    needsReview: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const server: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'root',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 1,
  lastConnectedAt: null,
};

const project = {
  id: 'p1',
  name: 'Storefront',
  folderPath: 'C:\\work\\storefront',
  iconDataUrl: null,
  iconBgColor: null,
  iconColor: null,
  archived: false,
} as unknown as Project;

function renderDialog(
  bridge: Record<string, unknown> = {},
  props: Partial<React.ComponentProps<typeof SiteFormDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const view = renderWithProviders(
    <SiteFormDialog open site={null} onOpenChange={onOpenChange} onSaved={onSaved} {...props} />,
    {
      bridge: {
        'deployFiles.create': async (input: FileSiteInput) => savedSite({ label: input.label }),
        'deployFiles.update': async (_id: string, input: FileSiteInput) =>
          savedSite({ label: input.label }),
        ...bridge,
      },
    },
  );
  return { ...view, onOpenChange, onSaved };
}

function fill(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillLogin(): void {
  fill('Host', 'files.bakery.example');
  fill('Username', 'deploy');
  fill('Password', 'hunter2');
  fill('Folder on the server', '/public_html');
  fill('Deploy folder', 'C:\\sites\\bakery');
}

function saveButton(name = 'Add site'): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function testButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement;
}

async function lastTestInput(bridge: { $fn(path: string): ReturnType<typeof vi.fn> }) {
  const calls = bridge.$fn('deployFiles.test').mock.calls;
  return calls.at(-1)?.[0] as FilesTestInput;
}

describe('SiteFormDialog protocol and connection', () => {
  it('opens on SFTP with a login of its own and focuses the host', async () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'SFTP', pressed: true })).toBeTruthy();
    expect(screen.getByText(/Files over SSH/)).toBeTruthy();
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('22');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Host')));
  });

  it('moves an untouched port with the protocol and keeps a chosen one', async () => {
    const { user } = renderDialog();
    const port = () => (screen.getByLabelText('Port') as HTMLInputElement).value;

    await user.click(screen.getByRole('button', { name: 'FTPS' }));
    expect(port()).toBe('21');
    expect(screen.getByText(/FTP over TLS/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Private key' })).toBeNull();

    fill('Port', '2121');
    await user.click(screen.getByRole('button', { name: 'SFTP' }));
    expect(port()).toBe('2121');
  });

  it('warns that plain FTP is not encrypted', async () => {
    const { user } = renderDialog();
    expect(screen.queryByText(/Plain FTP is not encrypted/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'FTP' }));

    expect(screen.getByText(/Plain FTP is not encrypted/)).toBeTruthy();
  });

  it('logs in with a private key picked from disk, with an optional passphrase', async () => {
    const { user, bridge } = renderDialog({
      'ssh.pickPrivateKeyFile': async () => 'C:\\Users\\me\\.ssh\\id_ed25519',
      'deployFiles.test': async () => passed(),
    });
    fillLogin();
    await user.click(screen.getByRole('button', { name: 'Private key' }));
    expect(screen.queryByLabelText('Password')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Choose key file' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Private key file') as HTMLInputElement).value).toBe(
        'C:\\Users\\me\\.ssh\\id_ed25519',
      ),
    );
    expect(screen.getByLabelText('Key passphrase')).toBeTruthy();

    await user.click(testButton());
    await waitFor(() => expect(bridge.$fn('deployFiles.test')).toHaveBeenCalled());
    expect((await lastTestInput(bridge)).site.connection).toMatchObject({
      authMethod: 'privateKey',
      privateKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
    });
    expect('secret' in (await lastTestInput(bridge)).site.connection).toBe(false);
  });

  it('uses a server saved in Remote, shown with its login', async () => {
    const { user, bridge } = renderDialog({
      'ssh.listServers': [server],
      'deployFiles.test': async () => passed(),
    });

    await user.click(screen.getByRole('button', { name: 'Saved server' }));
    expect(screen.queryByLabelText('Host')).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /prod \(root@prod\.example\)/ }));
    expect(screen.getByText('root@prod.example:22')).toBeTruthy();

    fill('Folder on the server', '/var/www');
    await user.click(testButton());

    await waitFor(() =>
      expect(bridge.$fn('deployFiles.test')).toHaveBeenCalledWith({
        siteId: null,
        site: expect.objectContaining({
          connection: { kind: 'saved', sshServerId: 'srv-1' },
          label: 'prod',
        }),
      }),
    );
  });

  it("asks about a saved server's changed key the way Remote does, then tests again", async () => {
    const trust = vi.fn(async () => undefined);
    const test = vi
      .fn()
      .mockResolvedValueOnce(
        failed({ error: { code: 'hostKeyChanged', message: 'The host key changed.' } }),
      )
      .mockResolvedValueOnce(passed({ remoteRoot: '/var/www' }));
    const { user } = renderDialog({
      'ssh.listServers': [server],
      'ssh.hostKeyStatus': {
        serverId: 'srv-1',
        nickname: 'prod',
        host: 'prod.example',
        port: 22,
        stored: FP,
        presented: NEW_FP,
      },
      'ssh.trustHostKey': trust,
      'deployFiles.test': test,
    });
    await user.click(screen.getByRole('button', { name: 'Saved server' }));
    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /prod/ }));
    fill('Folder on the server', '/var/www');

    await user.click(testButton());
    await waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(true);

    await waitFor(() => expect(screen.getByText(/Everything works/)).toBeTruthy());
    expect(trust).toHaveBeenCalledWith('srv-1', NEW_FP);
    expect(test).toHaveBeenCalledTimes(2);
  });

  it("trusts a saved server's first-seen key in Remote, not in the site", async () => {
    const trust = vi.fn(async () => undefined);
    const test = vi
      .fn()
      .mockResolvedValueOnce(
        failed({
          hostKey: { presented: NEW_FP, stored: null },
          error: { code: 'hostKeyUnknown', message: 'Not trusted.' },
        }),
      )
      .mockResolvedValueOnce(passed({ remoteRoot: '/var/www' }));
    const { user } = renderDialog({
      'ssh.listServers': [server],
      'ssh.trustHostKey': trust,
      'deployFiles.test': test,
    });
    await user.click(screen.getByRole('button', { name: 'Saved server' }));
    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /prod/ }));
    fill('Folder on the server', '/var/www');

    await user.click(testButton());
    await user.click(await screen.findByRole('button', { name: 'Trust this key' }));

    await waitFor(() => expect(screen.getByText(/Everything works/)).toBeTruthy());
    expect(trust).toHaveBeenCalledWith('srv-1', NEW_FP);
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('says so when Remote refuses to trust the key', async () => {
    const { user } = renderDialog({
      'ssh.listServers': [server],
      'ssh.trustHostKey': async () => {
        throw new Error('The server now shows another key.');
      },
      'deployFiles.test': async () =>
        failed({
          hostKey: { presented: NEW_FP, stored: null },
          error: { code: 'hostKeyUnknown', message: 'Not trusted.' },
        }),
    });
    await user.click(screen.getByRole('button', { name: 'Saved server' }));
    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /prod/ }));
    fill('Folder on the server', '/var/www');

    await user.click(testButton());
    await user.click(await screen.findByRole('button', { name: 'Trust this key' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/now shows another key/),
    );
  });

  it("keeps the failed result when a saved server's new key is not trusted", async () => {
    const { user } = renderDialog({
      'ssh.listServers': [server],
      'ssh.hostKeyStatus': {
        serverId: 'srv-1',
        nickname: 'prod',
        host: 'prod.example',
        port: 22,
        stored: FP,
        presented: NEW_FP,
      },
      'deployFiles.test': async () =>
        failed({ error: { code: 'hostKeyChanged', message: 'The host key changed.' } }),
    });
    await user.click(screen.getByRole('button', { name: 'Saved server' }));
    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /prod/ }));
    fill('Folder on the server', '/var/www');

    await user.click(testButton());
    await waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(false);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/not the one you trusted/),
    );
  });
});

describe('SiteFormDialog test connection', () => {
  it('keeps Save off until a test passes, then adds the site', async () => {
    const { user, bridge, queryClient, onSaved, onOpenChange } = renderDialog({
      'deployFiles.test': async () => passed(),
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fillLogin();
    expect(saveButton().disabled).toBe(true);

    await user.click(testButton());

    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByText('Reached the server')).toBeTruthy();
    expect(await lastTestInput(bridge)).toEqual({
      siteId: null,
      site: expect.objectContaining({
        protocol: 'sftp',
        remoteRoot: '/public_html',
        connection: expect.objectContaining({
          host: 'files.bakery.example',
          port: 22,
          username: 'deploy',
          secret: 'hunter2',
        }),
      }),
    });

    await user.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.create')).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'files.bakery.example', localFolder: 'C:\\sites\\bakery' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Added files.bakery.example.');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.deployFilesSites });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('needs a new test once the login changes after one passed', async () => {
    const { user } = renderDialog({ 'deployFiles.test': async () => passed() });
    fillLogin();
    await user.click(testButton());
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fill('Host', 'other.example');

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/changed since the last test/)).toBeTruthy();
  });

  it('shimmers the checklist and spins the button while testing', async () => {
    let answer: (value: FilesTestResult) => void = () => undefined;
    const { user } = renderDialog({
      'deployFiles.test': () =>
        new Promise<FilesTestResult>((resolve) => {
          answer = resolve;
        }),
    });
    fillLogin();

    await user.click(testButton());

    const list = await screen.findByRole('list', { name: 'Connection test' });
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: /Testing/ })).toBeDisabled();
    answer(passed());
    await waitFor(() => expect(screen.getByText('Reached the server')).toBeTruthy());
  });

  it('trusts a first-seen host key into the form and tests again with it', async () => {
    const test = vi
      .fn()
      .mockResolvedValueOnce(
        failed({
          hostKey: { presented: NEW_FP, stored: null },
          error: { code: 'hostKeyUnknown', message: 'Not trusted.' },
        }),
      )
      .mockResolvedValueOnce(passed());
    const { user, bridge } = renderDialog({ 'deployFiles.test': test });
    fillLogin();

    await user.click(testButton());
    await user.click(await screen.findByRole('button', { name: 'Trust this key' }));

    await waitFor(() => expect(test).toHaveBeenCalledTimes(2));
    expect((await lastTestInput(bridge)).site.connection).toMatchObject({
      hostKeyFingerprint: NEW_FP,
    });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await user.click(saveButton());
    await waitFor(() =>
      expect(bridge.$fn('deployFiles.create')).toHaveBeenCalledWith(
        expect.objectContaining({
          connection: expect.objectContaining({ hostKeyFingerprint: NEW_FP }),
        }),
      ),
    );
  });

  it("uses the certificate's own name, then pins a self-signed one", async () => {
    const cert = {
      fingerprint256: FP,
      subject: 'CN=server12.host.example',
      issuer: 'CN=server12.host.example',
      names: ['server12.host.example'],
      validTo: '2027-06-15T12:00:00.000Z',
    };
    const test = vi
      .fn()
      .mockResolvedValueOnce(
        failed({
          certificate: { ...cert, reason: 'nameMismatch' },
          error: { code: 'tlsNameMismatch', message: 'Wrong name.' },
        }),
      )
      .mockResolvedValueOnce(
        failed({
          certificate: { ...cert, reason: 'selfSigned' },
          error: { code: 'tlsUntrusted', message: 'Self-signed.' },
        }),
      )
      .mockResolvedValueOnce(passed());
    const { user, bridge } = renderDialog({ 'deployFiles.test': test });
    await user.click(screen.getByRole('button', { name: 'FTPS' }));
    fillLogin();

    await user.click(testButton());
    await user.click(await screen.findByRole('button', { name: 'Use server12.host.example' }));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(2));
    expect((await lastTestInput(bridge)).site.connection).toMatchObject({
      tlsServername: 'server12.host.example',
    });

    await user.click(await screen.findByRole('button', { name: 'Trust this certificate' }));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(3));
    expect((await lastTestInput(bridge)).site.connection).toMatchObject({
      tlsServername: 'server12.host.example',
      tlsPin: FP,
    });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it('takes the folder as the server resolved it, without making the test stale', async () => {
    const { user } = renderDialog({
      'deployFiles.test': async () => passed({ remoteRoot: '/home/deploy/public_html' }),
    });
    fillLogin();

    await user.click(testButton());

    await waitFor(() =>
      expect((screen.getByLabelText('Folder on the server') as HTMLInputElement).value).toBe(
        '/home/deploy/public_html',
      ),
    );
    expect(screen.getByText(/The server calls this folder/)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('shows a test call that failed outright', async () => {
    const { user } = renderDialog({
      'deployFiles.test': async () => {
        throw new Error(encodeFilesError('busy', 'Busy.'));
      },
    });
    fillLogin();

    await user.click(testButton());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/still running/));
    expect(saveButton().disabled).toBe(true);
  });
});

describe('SiteFormDialog validation and keyboard', () => {
  it('shows what is missing and focuses it instead of testing', async () => {
    const { user, bridge } = renderDialog({ 'deployFiles.test': async () => passed() });

    await user.click(testButton());

    expect(screen.getByText('Enter the host name of the server.')).toBeTruthy();
    expect(screen.getByText('Enter the username.')).toBeTruthy();
    expect(screen.getByText('Enter the folder on the server.')).toBeTruthy();
    // Every missing detail shows, but focus goes to the first one the test needs.
    expect(screen.getByText('Choose the folder to deploy.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Host'));
    expect(screen.getByLabelText('Host').getAttribute('aria-invalid')).toBe('true');
    expect(() => bridge.$fn('deployFiles.test')).toThrow();
  });

  it('checks the port and the server folder', async () => {
    const { user } = renderDialog();
    fillLogin();
    fill('Port', '70000');
    fill('Folder on the server', 'public_html');

    await user.click(testButton());

    expect(screen.getByText('Use a port from 1 to 65535.')).toBeTruthy();
    expect(screen.getByText(/Start the folder with \//)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Port'));
  });

  it('runs the test on Enter, and saves on Enter once it passed', async () => {
    const { user, bridge, onSaved } = renderDialog({ 'deployFiles.test': async () => passed() });
    fillLogin();
    await user.click(screen.getByLabelText('Username'));

    await user.keyboard('{Enter}');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(bridge.$fn('deployFiles.test')).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText('Username'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('saves without testing when asked, after checking the fields', async () => {
    const { user, bridge, onSaved } = renderDialog();
    fillLogin();
    fill('Deploy folder', '');

    await user.click(screen.getByRole('button', { name: 'Save without testing' }));
    expect(screen.getByText('Choose the folder to deploy.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Deploy folder'));

    fill('Deploy folder', 'C:\\sites\\bakery');
    await user.click(screen.getByRole('button', { name: 'Save without testing' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(() => bridge.$fn('deployFiles.test')).toThrow();
  });

  it('closes on Escape', async () => {
    const { user, onOpenChange } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns when the server folder is the top folder', () => {
    renderDialog();
    fill('Folder on the server', '/');
    expect(screen.getByText(/top folder of the server/)).toBeTruthy();
  });
});

describe('SiteFormDialog saving', () => {
  it('asks once before saving a plain FTP site', async () => {
    const { user, bridge, onSaved } = renderDialog({ 'deployFiles.test': async () => passed() });
    await user.click(screen.getByRole('button', { name: 'FTP' }));
    fillLogin();
    await user.click(testButton());
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    await user.click(saveButton());
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    expect(useConfirmStore.getState().title).toMatch(/plain FTP/);
    resolveConfirm(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => bridge.$fn('deployFiles.create')).toThrow();

    await user.click(saveButton());
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    resolveConfirm(true);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.create')).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'ftp' }),
    );
  });

  it('keeps the form and says why when main refuses the site', async () => {
    const { user, onSaved, onOpenChange } = renderDialog({
      'deployFiles.test': async () => passed(),
      'deployFiles.create': async () => {
        throw new Error(encodeFilesError('folderMissing', 'Gone.'));
      },
    });
    fillLogin();
    await user.click(testButton());
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    await user.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /deploy folder on this computer is gone/,
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('files.bakery.example');
  });

  it('turns Deploy on save on with quiet seconds and checks their range', async () => {
    const { user, bridge, onSaved } = renderDialog();
    fillLogin();
    expect(screen.queryByLabelText('Quiet time in seconds')).toBeNull();

    await user.click(screen.getByRole('switch', { name: 'Deploy on save' }));
    expect(screen.getByText(/never resolves a conflict/)).toBeTruthy();
    expect((screen.getByLabelText('Quiet time in seconds') as HTMLInputElement).value).toBe('5');
    fill('Quiet time in seconds', '1');
    await user.click(screen.getByRole('button', { name: 'Save without testing' }));
    expect(screen.getByText('Use 2 to 120 seconds.')).toBeTruthy();

    fill('Quiet time in seconds', '30');
    fill('Name', 'Shop');
    await user.click(screen.getByRole('button', { name: 'Save without testing' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.create')).toHaveBeenCalledWith(
      expect.objectContaining({ deployOnSave: true, quietSeconds: 30, label: 'Shop' }),
    );
  });

  it('suggests the host as the name', () => {
    renderDialog();
    fill('Host', 'files.bakery.example');
    expect((screen.getByLabelText('Name') as HTMLInputElement).placeholder).toBe(
      'files.bakery.example',
    );
  });
});

describe('SiteFormDialog folders and projects', () => {
  it('starts from the project it was opened from, with its folder', async () => {
    const { user, bridge } = renderDialog(
      {
        'projects.list': [project],
        'deployFiles.pickLocalFolder': async () => 'C:\\work\\storefront\\dist',
      },
      { initialProjectId: 'p1' },
    );

    await waitFor(() =>
      expect((screen.getByLabelText('Deploy folder') as HTMLInputElement).value).toBe(
        'C:\\work\\storefront',
      ),
    );
    expect(screen.getByRole('button', { name: 'Remove Storefront' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(bridge.$fn('deployFiles.pickLocalFolder')).toHaveBeenCalledWith('C:\\work\\storefront');
    await waitFor(() =>
      expect((screen.getByLabelText('Deploy folder') as HTMLInputElement).value).toBe(
        'C:\\work\\storefront\\dist',
      ),
    );
  });

  it('attaches projects from the picker', async () => {
    const { user, bridge } = renderDialog({ 'projects.list': [project] });
    fillLogin();

    await user.click(screen.getByRole('combobox', { name: 'Projects' }));
    await user.click(await screen.findByRole('option', { name: /Storefront/ }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save without testing' }));

    await waitFor(() =>
      expect(bridge.$fn('deployFiles.create')).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: ['p1'] }),
      ),
    );
  });

  it('browses the server for the folder with the details typed so far', async () => {
    const { user, bridge } = renderDialog({
      'deployFiles.browseRemote': async () => ({
        path: '/home/deploy',
        parent: '/home',
        folders: [{ name: 'public_html', path: '/home/deploy/public_html' }],
      }),
    });
    fillLogin();
    fill('Folder on the server', '');

    await user.click(screen.getByRole('button', { name: 'Browse' }));
    await user.click(await screen.findByRole('button', { name: 'Use this folder' }));

    expect((screen.getByLabelText('Folder on the server') as HTMLInputElement).value).toBe(
      '/home/deploy',
    );
    expect(bridge.$fn('deployFiles.browseRemote')).toHaveBeenCalledWith({
      siteId: null,
      site: expect.objectContaining({
        connection: expect.objectContaining({ host: 'files.bakery.example', secret: 'hunter2' }),
      }),
      path: null,
    });
  });

  it('asks for the login before browsing', async () => {
    const { user } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Browse' }));

    expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Host'));
  });
});

describe('SiteFormDialog editing', () => {
  it('fills in the site and keeps its stored password unless one is typed', async () => {
    const { user, bridge, onSaved } = renderDialog({}, { site: savedSite() });

    expect(screen.getByRole('heading', { name: 'Edit Bakery' })).toBeTruthy();
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('files.bakery.example');
    expect((screen.getByLabelText('Password') as HTMLInputElement).placeholder).toBe(
      'Saved, leave empty to keep it',
    );
    // Nothing about the server changed, so no new test is needed.
    fill('Name', 'Bakery shop');
    expect(saveButton('Save changes').disabled).toBe(false);

    await user.click(saveButton('Save changes'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [siteId, input] = bridge.$fn('deployFiles.update').mock.calls[0] as [
      string,
      FileSiteInput,
    ];
    expect(siteId).toBe('site-1');
    expect(input.label).toBe('Bakery shop');
    expect('secret' in input.connection).toBe(false);
    expect(input.connection).toMatchObject({ hostKeyFingerprint: FP });
    expect(input.ignorePatterns).toEqual(['*.log']);
    expect(toast.success).toHaveBeenCalledWith('Saved Bakery shop.');
  });

  it('sends a new password, tested against the stored site', async () => {
    const { user, bridge } = renderDialog(
      { 'deployFiles.test': async () => passed() },
      { site: savedSite() },
    );
    fill('Password', 'new-secret');
    expect(saveButton('Save changes').disabled).toBe(true);

    await user.click(testButton());
    await waitFor(() => expect(saveButton('Save changes').disabled).toBe(false));
    expect((await lastTestInput(bridge)).siteId).toBe('site-1');
    await user.click(saveButton('Save changes'));

    await waitFor(() =>
      expect(bridge.$fn('deployFiles.update')).toHaveBeenCalledWith(
        'site-1',
        expect.objectContaining({
          connection: expect.objectContaining({ secret: 'new-secret' }),
        }),
      ),
    );
  });

  it('does not ask about plain FTP again for a site that already uses it', async () => {
    const { user, onSaved } = renderDialog({}, { site: savedSite({ protocol: 'ftp' }) });

    await user.click(saveButton('Save changes'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(useConfirmStore.getState().open).toBe(false);
  });

  it('edits a site on a saved server', async () => {
    renderDialog(
      { 'ssh.listServers': [server] },
      { site: savedSite({ connection: { kind: 'saved', sshServerId: 'srv-1' } }) },
    );

    expect(screen.getByRole('button', { name: 'Saved server', pressed: true })).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByRole('combobox', { name: 'Server' })).getByText(/prod/),
      ).toBeTruthy(),
    );
  });
});
