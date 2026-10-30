import type { RecaptchaAccount, RecaptchaStatus } from '@shared/deployRecaptchaTypes';
import { encodeRecaptchaError } from '@shared/recaptchaErrors';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ACCOUNT, deferred, ipcError, SCORE_KEY, status } from './testing/fixtures';

/**
 * The reCAPTCHA page: one click to sign in with Google (or the user's own OAuth client), a project
 * picked or made for them and set up in front of them, then the keys. Every state has one clear
 * way on: unlock, sign in again, or try again.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { RecaptchaView } = await import('./RecaptchaView');

const NO_PROJECT: RecaptchaAccount = { ...ACCOUNT, projectId: null };

/** A status the test can change, the way the main process would after a sign-in or a setup. */
function liveStatus(initial: RecaptchaStatus) {
  let current = initial;
  return {
    set: (next: RecaptchaStatus) => {
      current = next;
    },
    answer: async () => current,
  };
}

function renderView(bridge: Record<string, unknown>) {
  return renderWithProviders(
    <>
      <RecaptchaView />
      <ConfirmDialogHost />
    </>,
    {
      route: '/deploy?recaptcha=1',
      bridge: {
        'deployRecaptcha.listKeys': async () => [SCORE_KEY],
        'deployRecaptcha.usage': async () => ({ month: '2026-10', assessments: 120 }),
        'deployRecaptcha.listProjects': async () => [
          { projectId: 'shop-project', name: 'Shop' },
          { projectId: 'blog-project', name: 'Blog' },
        ],
        'deployWordPress.listSites': async () => [],
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('signing in', () => {
  it('signs in with one click and moves on to picking a project', async () => {
    const live = liveStatus(status({ accounts: [] }));
    const signIn = deferred<RecaptchaAccount>();
    const signInCall = vi.fn(() => signIn.promise);
    const { user } = renderView({
      'deployRecaptcha.status': live.answer,
      'deployRecaptcha.signIn': signInCall,
    });

    expect(await screen.findByRole('heading', { name: 'Stop bots on your sites' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'reCAPTCHA' })).toBeTruthy();
    expect(screen.getByText(/Free for up to 10,000 checks a month/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(signInCall).toHaveBeenCalledWith({ mode: 'runova' });
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeTruthy();

    live.set(status({ accounts: [NO_PROJECT] }));
    await act(async () => signIn.resolve(NO_PROJECT));
    expect(
      await screen.findByRole('heading', { name: 'Choose a Google Cloud project' }),
    ).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Signed in as amin@example.com.');
  });

  it('cancels a sign-in that is waiting on the browser', async () => {
    const cancel = vi.fn(async () => undefined);
    const { user } = renderView({
      'deployRecaptcha.status': async () => status({ accounts: [] }),
      'deployRecaptcha.signIn': () =>
        new Promise((_resolve, reject) => {
          cancel.mockImplementation(async () => {
            reject(ipcError('signIn', 'The sign-in was cancelled.'));
          });
        }),
      'deployRecaptcha.cancelSignIn': cancel,
    });
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeTruthy();
    expect(screen.queryByText(/cancelled/)).toBeNull();
  });

  it('says why a sign-in failed', async () => {
    const { user } = renderView({
      'deployRecaptcha.status': async () => status({ accounts: [] }),
      'deployRecaptcha.signIn': async () => {
        throw ipcError('signIn', 'Google did not sign in: access_denied');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText('Google did not sign in: access_denied')).toBeTruthy();
  });

  it('lets the user bring their own OAuth client', async () => {
    const signIn = vi.fn(async () => NO_PROJECT);
    const { user } = renderView({
      'deployRecaptcha.status': async () => status({ accounts: [] }),
      'deployRecaptcha.signIn': signIn,
    });
    await user.click(await screen.findByRole('button', { name: /Use my own OAuth client/ }));
    const form = screen.getByRole('form', { name: 'Your own OAuth client' });
    const submit = within(form).getByRole('button', { name: 'Sign in with Google' });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText('Client ID'), '123.apps.googleusercontent.com');
    await user.type(within(form).getByLabelText('Client secret'), 'GOCSPX-mine');
    await user.click(submit);
    expect(signIn).toHaveBeenCalledWith({
      mode: 'own',
      clientId: '123.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-mine',
    });
  });

  it('asks for an own client straight away in a build without Runova one', async () => {
    renderView({
      'deployRecaptcha.status': async () => status({ runovaClient: false, accounts: [] }),
    });
    const form = await screen.findByRole('form', { name: 'Your own OAuth client' });
    expect(within(form).getByLabelText('Client ID')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Use my own OAuth client/ })).toBeNull();
  });
});

describe('a locked vault and a lapsed sign-in', () => {
  it('asks to unlock the Servers vault first', async () => {
    renderView({ 'deployRecaptcha.status': async () => status({ locked: true }) });
    expect(await screen.findByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(screen.getByText(/locked with a passkey/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Keys' })).toBeNull();
  });

  it('offers a fresh sign-in when Google stopped accepting the old one', async () => {
    const signIn = vi.fn(async () => ACCOUNT);
    const { user } = renderView({
      'deployRecaptcha.status': async () =>
        status({ accounts: [{ ...ACCOUNT, needsSignIn: true }] }),
      'deployRecaptcha.signIn': signIn,
    });
    expect(
      await screen.findByText(/Google no longer accepts the sign-in for amin@example.com/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signIn).toHaveBeenCalledWith({ mode: 'runova' });
  });

  it('moves to the fresh sign-in when a call finds the sign-in lapsed', async () => {
    const live = liveStatus(status());
    renderView({
      'deployRecaptcha.status': live.answer,
      'deployRecaptcha.listKeys': async () => {
        live.set(status({ accounts: [{ ...ACCOUNT, needsSignIn: true }] }));
        throw ipcError('listKeys', encodeRecaptchaError('reauth', 'Sign in to Google again.'));
      },
    });
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });
});

describe('the project', () => {
  it('sets up a picked project in front of the user, then shows its keys', async () => {
    const live = liveStatus(status({ accounts: [NO_PROJECT] }));
    const prepare = deferred<void>();
    const prepareCall = vi.fn(() => prepare.promise);
    const { user, bridge } = renderView({
      'deployRecaptcha.status': live.answer,
      'deployRecaptcha.prepareProject': prepareCall,
    });
    await user.click(await screen.findByRole('button', { name: /Shop.*shop-project/ }));
    expect(prepareCall).toHaveBeenCalledWith({ accountId: ACCOUNT.id, projectId: 'shop-project' });

    const steps = await screen.findByRole('list', { name: 'Setting up the project' });
    act(() => {
      bridge.$emit('deployRecaptcha.onProgress', {
        accountId: ACCOUNT.id,
        projectId: 'shop-project',
        step: 'project',
        state: 'done',
      });
      bridge.$emit('deployRecaptcha.onProgress', {
        accountId: ACCOUNT.id,
        projectId: 'shop-project',
        step: 'api',
        state: 'running',
      });
    });
    expect(within(steps).getByRole('listitem', { name: /Project found.*done/ })).toBeTruthy();
    expect(
      within(steps).getByRole('listitem', { name: /Turning on reCAPTCHA.*working/ }),
    ).toBeTruthy();

    live.set(status());
    await act(async () => prepare.resolve());
    expect(await screen.findByRole('listitem', { name: 'Shop' })).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Checks this month' })).toBeTruthy();
  });

  it('makes a project for the user', async () => {
    const live = liveStatus(status({ accounts: [NO_PROJECT] }));
    const create = vi.fn(async () => ({
      projectId: 'runova-recaptcha-ab12cd',
      name: 'Runova reCAPTCHA',
    }));
    const prepare = vi.fn(async () => {
      live.set(status({ accounts: [{ ...ACCOUNT, projectId: 'runova-recaptcha-ab12cd' }] }));
    });
    const { user } = renderView({
      'deployRecaptcha.status': live.answer,
      'deployRecaptcha.createProject': create,
      'deployRecaptcha.prepareProject': prepare,
    });
    await user.click(await screen.findByRole('button', { name: /Create a project for me/ }));
    expect(create).toHaveBeenCalledWith(ACCOUNT.id);
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({
        accountId: ACCOUNT.id,
        projectId: 'runova-recaptcha-ab12cd',
      }),
    );
    expect(await screen.findByRole('list', { name: 'Keys' })).toBeTruthy();
  });

  it('finds a project by name or id', async () => {
    const { user } = renderView({
      'deployRecaptcha.status': async () => status({ accounts: [NO_PROJECT] }),
      'deployRecaptcha.listProjects': async () =>
        Array.from({ length: 8 }, (_, index) => ({
          projectId: `project-${index}`,
          name: `Site ${index}`,
        })),
    });
    await user.type(await screen.findByRole('searchbox', { name: 'Search projects' }), 'project-5');
    expect(screen.getByRole('button', { name: /Site 5/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Site 4/ })).toBeNull();
  });

  it('says plainly when setting up failed, and offers another try', async () => {
    let calls = 0;
    const { user } = renderView({
      'deployRecaptcha.status': async () => status({ accounts: [NO_PROJECT] }),
      'deployRecaptcha.prepareProject': async () => {
        calls += 1;
        if (calls === 1) {
          throw ipcError(
            'prepareProject',
            encodeRecaptchaError(
              'permission',
              'Your Google account is not allowed to do that here.',
            ),
          );
        }
      },
    });
    await user.click(await screen.findByRole('button', { name: /Blog.*blog-project/ }));
    expect(await screen.findByText(/not allowed to do that here/)).toBeTruthy();
    expect(screen.getByText(/Owner or Editor/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it('switches to another project from the account menu, and can go back', async () => {
    const { user } = renderView({ 'deployRecaptcha.status': async () => status() });
    await screen.findByRole('listitem', { name: 'Shop' });
    await user.click(screen.getByRole('button', { name: /Google account/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change project' }));
    expect(
      await screen.findByRole('heading', { name: 'Choose a Google Cloud project' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep shop-project' }));
    expect(await screen.findByRole('listitem', { name: 'Shop' })).toBeTruthy();
  });
});

describe('accounts', () => {
  it('shows who is signed in and which project is open', async () => {
    renderView({ 'deployRecaptcha.status': async () => status() });
    const menu = await screen.findByRole('button', { name: /Google account/ });
    expect(menu.textContent).toContain('amin@example.com');
    expect(menu.textContent).toContain('shop-project');
  });

  it('signs out after asking', async () => {
    const remove = vi.fn(async () => undefined);
    const { user } = renderView({
      'deployRecaptcha.status': async () => status(),
      'deployRecaptcha.removeAccount': remove,
    });
    await user.click(await screen.findByRole('button', { name: /Google account/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out of amin@example.com' }));
    const confirm = await screen.findByRole('dialog', { name: /Sign out of amin@example.com/ });
    await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
    expect(remove).toHaveBeenCalledWith(ACCOUNT.id);
  });

  it('switches between Google accounts', async () => {
    const other: RecaptchaAccount = {
      ...ACCOUNT,
      id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
      email: 'work@example.com',
      projectId: 'work-project',
    };
    const listKeys = vi.fn(async () => [SCORE_KEY]);
    const { user } = renderView({
      'deployRecaptcha.status': async () => status({ accounts: [ACCOUNT, other] }),
      'deployRecaptcha.listKeys': listKeys,
    });
    await screen.findByRole('listitem', { name: 'Shop' });
    await user.click(screen.getByRole('button', { name: /Google account/ }));
    await user.click(await screen.findByRole('menuitem', { name: /work@example.com/ }));
    await waitFor(() =>
      expect(listKeys).toHaveBeenCalledWith({ accountId: other.id, projectId: 'work-project' }),
    );
    expect(screen.getByRole('button', { name: /Google account/ }).textContent).toContain(
      'work@example.com',
    );
  });

  it('adds another Google account', async () => {
    const { user } = renderView({ 'deployRecaptcha.status': async () => status() });
    await screen.findByRole('listitem', { name: 'Shop' });
    await user.click(screen.getByRole('button', { name: /Google account/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add another Google account' }));
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to your keys' }));
    expect(await screen.findByRole('listitem', { name: 'Shop' })).toBeTruthy();
  });
});

describe('failures', () => {
  it('says why the page could not load, and tries again', async () => {
    let calls = 0;
    const { user } = renderView({
      'deployRecaptcha.status': async () => {
        calls += 1;
        if (calls === 1) throw ipcError('status', 'google-cloud.json could not be read.');
        return status();
      },
    });
    expect(await screen.findByText('google-cloud.json could not be read.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: 'Shop' })).toBeTruthy();
  });
});
