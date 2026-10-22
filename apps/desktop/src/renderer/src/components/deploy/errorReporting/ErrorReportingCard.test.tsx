import { encodeCoreError } from '@shared/coreErrors';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, signedIn } from '../security/testing/fixtures';
import { DSN, KEY, notSetUp, reporting } from './testing/fixtures';

/**
 * Error reporting through its states: shimmer, a read that failed, an older core, not set up (for
 * an Owner with the form, for an Admin without), set up with its facts, failing, paused, saving
 * after a step-up, a request the core refused, the test event and removing it again.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { ErrorReportingCard } = await import('./ErrorReportingCard');

function renderCard(
  overrides: Record<string, unknown> = {},
  options: { owner?: boolean; onUpdateCore?: () => void } = {},
) {
  const owner = options.owner ?? true;
  return renderWithProviders(
    <ErrorReportingCard
      server={SERVER}
      owner={owner}
      {...(options.onUpdateCore ? { onUpdateCore: options.onUpdateCore } : {})}
    />,
    {
      bridge: {
        'deploy.access': async () => signedIn(owner ? ['owner'] : ['admin']),
        'deployErrorReporting.status': async () => notSetUp(),
        ...overrides,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
});

describe('ErrorReportingCard', () => {
  it('shimmers while it reads the core', () => {
    const { container } = renderCard({
      'deployErrorReporting.status': () => new Promise(() => undefined),
    });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says why it could not read the core, and asks again on request', async () => {
    let calls = 0;
    const { user } = renderCard({
      'deployErrorReporting.status': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The SSH connection was refused.');
        return notSetUp();
      },
    });

    expect(await screen.findByText('The SSH connection was refused.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Not set up')).toBeTruthy();
  });

  it('offers the core update when the server runs a core without this feature', async () => {
    const onUpdateCore = vi.fn();
    const { user } = renderCard(
      {
        'deployErrorReporting.status': async () => {
          throw new Error(
            'This server runs an older core without error reporting. Update the core from the Overview, then try again.',
          );
        },
      },
      { onUpdateCore },
    );

    expect(await screen.findByText(/older core without error reporting/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Update the core' }));
    expect(onUpdateCore).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Sentry DSN')).toBeNull();
  });

  describe('when it is not set up', () => {
    it('shows an Owner how to get a DSN and the form to turn it on', async () => {
      renderCard();

      expect(await screen.findByText('Not set up')).toBeTruthy();
      expect(screen.getByText(/Client Keys \(DSN\)/)).toBeTruthy();
      expect(screen.getByLabelText('Sentry DSN')).toBeTruthy();
      expect((screen.getByLabelText('Environment') as HTMLInputElement).value).toBe('production');
      expect(screen.getByLabelText('Server name').getAttribute('placeholder')).toBe('prod-box');
      expect(
        screen.getByRole('button', { name: 'Warnings and errors' }).getAttribute('aria-pressed'),
      ).toBe('true');
      expect(screen.getByRole('button', { name: 'Turn on error reporting' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send test event' })).toBeNull();
    });

    it('tells an Admin an Owner has to set it up, with no form', async () => {
      renderCard({}, { owner: false });

      expect(await screen.findByText('Not set up')).toBeTruthy();
      expect(screen.getByText(/An Owner can set this up/)).toBeTruthy();
      expect(screen.queryByLabelText('Sentry DSN')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Turn on error reporting' })).toBeNull();
    });

    it('checks the DSN as it is typed and does not send a bad one', async () => {
      const { user, bridge } = renderCard();

      const field = await screen.findByLabelText('Sentry DSN');
      await user.type(field, 'nonsense');
      await user.tab();
      expect(await screen.findByText(/not a Sentry DSN/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Turn on error reporting' }));

      expect(() => bridge.$fn('deployErrorReporting.save')).toThrow(/not been touched/);
    });

    it('requires a DSN the first time', async () => {
      const { user, bridge } = renderCard();

      await user.click(await screen.findByRole('button', { name: 'Turn on error reporting' }));

      expect(await screen.findByText(/Paste the DSN from your Sentry project/)).toBeTruthy();
      expect(() => bridge.$fn('deployErrorReporting.save')).toThrow(/not been touched/);
    });

    it('says where logs would go once the DSN is good, without showing the key', async () => {
      const { user, container } = renderCard();

      await user.type(await screen.findByLabelText('Sentry DSN'), DSN);

      expect(await screen.findByText('Sends to o1.ingest.sentry.io, project 42')).toBeTruthy();
      expect(container.textContent).not.toContain(KEY);
    });

    it('turns it on after a step-up, and clears the key from the form', async () => {
      let calls = 0;
      const { user, bridge } = renderCard({
        'deployErrorReporting.save': async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error(encodeCoreError('stepUpRequired', 'Needs your password again.'));
          }
          return { problems: [], status: reporting() };
        },
      });

      await user.type(await screen.findByLabelText('Sentry DSN'), DSN);
      await user.click(screen.getByRole('button', { name: 'Turn on error reporting' }));
      await user.type(await screen.findByLabelText('Password'), 'secret');
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(bridge.$fn('deployErrorReporting.save')).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        dsn: DSN,
        enabled: true,
        environment: 'production',
        serverName: '',
        level: 'warning',
        password: 'secret',
      });
      expect(await screen.findByText('On, nothing sent yet')).toBeTruthy();
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Error reporting is on'));
      expect((screen.getByLabelText('Sentry DSN') as HTMLInputElement).value).toBe('');
    });

    it('lists what the core found wrong and keeps the form', async () => {
      const { user } = renderCard({
        'deployErrorReporting.save': async () => ({
          problems: ['Environment can only use letters and digits.', 'The level is not known.'],
        }),
      });

      await user.type(await screen.findByLabelText('Sentry DSN'), DSN);
      await user.click(screen.getByRole('button', { name: 'Turn on error reporting' }));

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('Environment can only use letters and digits.')).toBeTruthy();
      expect(within(alert).getByText('The level is not known.')).toBeTruthy();
      expect(toast.success).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Sentry DSN') as HTMLInputElement).value).toBe(DSN);
    });

    it('says why a save could not be made', async () => {
      const { user } = renderCard({
        'deployErrorReporting.save': async () => {
          throw new Error('Your role on this server (admin) cannot do that.');
        },
      });

      await user.type(await screen.findByLabelText('Sentry DSN'), DSN);
      await user.click(screen.getByRole('button', { name: 'Turn on error reporting' }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Your role on this server (admin) cannot do that.',
        ),
      );
    });

    it('offers the usual environment names as quick picks', async () => {
      const { user } = renderCard();

      await user.click(await screen.findByRole('button', { name: 'staging' }));

      expect((screen.getByLabelText('Environment') as HTMLInputElement).value).toBe('staging');
    });
  });

  describe('when it is set up', () => {
    const delivered = () =>
      reporting({ sentCount: 12, lastSentAtUnixMs: Date.now() - 120_000, minLevel: 'error' });

    it('shows where logs go and how it is going, never the key', async () => {
      const { container } = renderCard({ 'deployErrorReporting.status': async () => delivered() });

      const details = await screen.findByLabelText('Error reporting details');
      expect(within(details).getByText('o1.ingest.sentry.io, project 42')).toBeTruthy();
      expect(within(details).getByText('staging')).toBeTruthy();
      expect(within(details).getByText('web-1')).toBeTruthy();
      expect(within(details).getByText('Errors only')).toBeTruthy();
      expect(within(details).getByText(/12 events/)).toBeTruthy();
      expect(within(details).getByText(/2m ago/)).toBeTruthy();
      expect(within(details).getByText(/by maria/)).toBeTruthy();
      expect(screen.getByText('Sending')).toBeTruthy();
      expect(container.textContent).not.toContain(KEY);
    });

    it('fills the form from what is stored and keeps the stored DSN unless a new one is pasted', async () => {
      const { user, bridge } = renderCard({
        'deployErrorReporting.status': async () => delivered(),
        'deployErrorReporting.save': async () => ({ problems: [], status: reporting() }),
      });

      expect(
        ((await screen.findByLabelText('Sentry DSN')) as HTMLInputElement).getAttribute(
          'placeholder',
        ),
      ).toBe('Leave empty to keep the current key');
      expect((screen.getByLabelText('Environment') as HTMLInputElement).value).toBe('staging');
      expect((screen.getByLabelText('Server name') as HTMLInputElement).value).toBe('web-1');
      expect(screen.getByRole('button', { name: 'Errors only' }).getAttribute('aria-pressed')).toBe(
        'true',
      );

      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(bridge.$fn('deployErrorReporting.save')).toHaveBeenCalled());
      const sent = bridge.$fn('deployErrorReporting.save').mock.calls.at(-1)?.[0];
      expect(sent).not.toHaveProperty('dsn');
      expect(sent).toMatchObject({
        serverId: SERVER.id,
        enabled: true,
        environment: 'staging',
        serverName: 'web-1',
        level: 'error',
      });
    });

    it('saves a different level', async () => {
      const { user, bridge } = renderCard({
        'deployErrorReporting.status': async () => reporting(),
        'deployErrorReporting.save': async () => ({ problems: [], status: reporting() }),
      });

      await user.click(await screen.findByRole('button', { name: 'Errors only' }));
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(bridge.$fn('deployErrorReporting.save')).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'error' }),
        ),
      );
    });

    it('shows a failure the core still holds, in words, with the state on the chip', async () => {
      renderCard({
        'deployErrorReporting.status': async () =>
          reporting({
            lastError: 'Sentry rejected the key in this DSN (HTTP 401).',
            lastFailedAtUnixMs: Date.now() - 30_000,
          }),
      });

      expect(await screen.findByText('Last send failed')).toBeTruthy();
      const alert = screen.getByRole('alert');
      expect(
        within(alert).getByText(/Sentry rejected the key in this DSN \(HTTP 401\)/),
      ).toBeTruthy();
    });

    it('shows a paused setup as paused and turns it back on from the switch', async () => {
      const { user, bridge } = renderCard({
        'deployErrorReporting.status': async () => reporting({ enabled: false }),
        'deployErrorReporting.save': async () => ({ problems: [], status: reporting() }),
      });

      expect(await screen.findByText('Paused')).toBeTruthy();
      const toggle = screen.getByRole('switch', { name: 'Send logs to Sentry' });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('button', { name: 'Send test event' }).hasAttribute('disabled')).toBe(
        true,
      );
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(bridge.$fn('deployErrorReporting.save')).toHaveBeenCalledWith(
          expect.objectContaining({ enabled: true }),
        ),
      );
    });

    it('sends a test event and says that Sentry took it', async () => {
      const { user, bridge } = renderCard({
        'deployErrorReporting.status': async () => reporting(),
        'deployErrorReporting.test': async () => ({
          delivered: true,
          httpStatus: 200,
          message: 'Sentry accepted the test event (HTTP 200).',
        }),
      });

      await user.click(await screen.findByRole('button', { name: 'Send test event' }));

      const result = await screen.findByRole('status');
      expect(within(result).getByText('Sentry accepted the test event (HTTP 200).')).toBeTruthy();
      expect(bridge.$fn('deployErrorReporting.test')).toHaveBeenCalledWith(SERVER.id);
    });

    it('says what Sentry answered when it did not take the test event', async () => {
      const { user } = renderCard({
        'deployErrorReporting.status': async () => reporting(),
        'deployErrorReporting.test': async () => ({
          delivered: false,
          httpStatus: 404,
          message: 'Sentry has no project with this id (HTTP 404).',
        }),
      });

      await user.click(await screen.findByRole('button', { name: 'Send test event' }));

      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByText('Sentry has no project with this id (HTTP 404).'),
      ).toBeTruthy();
    });

    it('removes it after a confirmation', async () => {
      const { user, bridge } = renderCard({
        'deployErrorReporting.status': async () => reporting(),
        'deployErrorReporting.remove': async () => notSetUp(),
      });

      await user.click(await screen.findByRole('button', { name: 'Remove' }));

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
      expect(bridge.$fn('deployErrorReporting.remove')).toHaveBeenCalledWith({
        serverId: SERVER.id,
      });
      expect(await screen.findByText('Not set up')).toBeTruthy();
      expect(toast.success).toHaveBeenCalledWith('Error reporting was removed.');
    });

    it('leaves it alone when the confirmation is declined', async () => {
      confirm.mockResolvedValueOnce(false);
      const { user, bridge } = renderCard({
        'deployErrorReporting.status': async () => reporting(),
      });

      await user.click(await screen.findByRole('button', { name: 'Remove' }));

      expect(() => bridge.$fn('deployErrorReporting.remove')).toThrow(/not been touched/);
    });

    it('lets an Admin read it and send a test event, but not change it', async () => {
      const { user, bridge } = renderCard(
        {
          'deployErrorReporting.status': async () =>
            reporting({ sentCount: 1, lastSentAtUnixMs: 1 }),
          'deployErrorReporting.test': async () => ({
            delivered: true,
            httpStatus: 200,
            message: 'Sentry accepted the test event (HTTP 200).',
          }),
        },
        { owner: false },
      );

      expect(await screen.findByLabelText('Error reporting details')).toBeTruthy();
      expect(screen.getByText('Only an Owner can change error reporting.')).toBeTruthy();
      expect(screen.queryByLabelText('Sentry DSN')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Send test event' }));
      await screen.findByRole('status');
      expect(bridge.$fn('deployErrorReporting.test')).toHaveBeenCalledWith(SERVER.id);
    });
  });
});
