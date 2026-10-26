import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { HealthTargetDialog } from './HealthTargetDialog';
import { environment, project, reveal, target } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const projects = [project(), project({ id: 'p2', name: 'Admin' })];

function Harness({ editing }: { editing?: ReturnType<typeof target> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Reopen</Button>
      <HealthTargetDialog
        open={open}
        onOpenChange={setOpen}
        projects={projects}
        defaultProjectId="p1"
        target={editing}
      />
    </>
  );
}

const bridge = {
  'environments.list': async (projectId: string) =>
    projectId === 'p1'
      ? [environment(), environment({ id: 'env-staging', name: 'Staging', order: 1 })]
      : [],
  'ssh.listServers': [{ id: 's1', nickname: 'web-1', host: '10.0.0.5' }],
  'deployWordPress.listSites': [{ id: 'w1', label: 'Shop site', siteUrl: 'https://shop.test' }],
  'health.create': async () => ({ target: target(), secret: reveal() }),
};

async function fillBasics(user: ReturnType<typeof renderWithProviders>['user'], url: string) {
  await user.type(screen.getByLabelText('Name'), 'API');
  await user.clear(screen.getByLabelText('Endpoint URL'));
  await user.type(screen.getByLabelText('Endpoint URL'), url);
}

describe('HealthTargetDialog', () => {
  it('suggests the default path and lists the project environments and servers', async () => {
    const { user } = renderWithProviders(<Harness />, { bridge });
    expect(screen.getByLabelText('Endpoint URL')).toHaveAttribute(
      'placeholder',
      'https://your-app/_runova/health',
    );
    // The app's own list, not the system's: a combobox that opens a styled listbox.
    const env = screen.getByRole('combobox', { name: 'Environment' });
    await user.click(env);
    expect(await screen.findByRole('option', { name: 'Staging' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('combobox', { name: 'Linked server' }));
    expect(await screen.findByRole('option', { name: /web-1/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Shop site/ })).toBeInTheDocument();
  });

  it('refuses an address that is not http(s) and plain http to another machine', async () => {
    const { user, bridge: fake } = renderWithProviders(<Harness />, { bridge });
    await fillBasics(user, 'ftp://example.com/h');
    await user.click(screen.getByRole('button', { name: 'Add target' }));
    expect(await screen.findByText(/starts with https:\/\//)).toBeInTheDocument();
    expect(screen.getByLabelText('Endpoint URL')).toHaveAttribute('aria-invalid', 'true');

    await user.clear(screen.getByLabelText('Endpoint URL'));
    await user.type(screen.getByLabelText('Endpoint URL'), 'http://example.com/h');
    expect(screen.getByText(/turn on Allow insecure HTTP/)).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Allow insecure HTTP' }));
    expect(screen.queryByText(/turn on Allow insecure HTTP/)).toBeNull();
    expect(screen.getByText(/anyone on the network/i)).toBeInTheDocument();
    expect(() => fake.$fn('health.create')).toThrow();
  });

  it('checks a custom interval against the allowed range', async () => {
    const { user } = renderWithProviders(<Harness />, { bridge });
    await fillBasics(user, 'https://example.com/h');
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    await user.type(screen.getByLabelText('Seconds between checks'), '5');
    await user.click(screen.getByRole('button', { name: 'Add target' }));
    expect(await screen.findByText(/from 15 to 86,400/)).toBeInTheDocument();
  });

  it('wants a username for HTTP Basic', async () => {
    const { user } = renderWithProviders(<Harness />, { bridge });
    await fillBasics(user, 'https://example.com/h');
    await user.click(screen.getByRole('radio', { name: /HTTP Basic/ }));
    await user.click(screen.getByRole('button', { name: 'Add target' }));
    expect(await screen.findByText('HTTP Basic needs a username.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'a:b');
    expect(screen.getByText(/cannot contain a colon/)).toBeInTheDocument();
  });

  it('shows the new key once, with its hash and variable, and never again after closing', async () => {
    const { user, bridge: fake } = renderWithProviders(<Harness />, { bridge });
    await fillBasics(user, 'https://api.example.com/_runova/health');
    await user.click(screen.getByRole('combobox', { name: 'Environment' }));
    await user.click(await screen.findByRole('option', { name: 'Staging' }));
    await user.click(screen.getByRole('button', { name: 'Add target' }));

    await screen.findByRole('heading', { name: 'Save this key now' });
    expect(fake.$fn('health.create')).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        environmentId: 'env-staging',
        name: 'API',
        url: 'https://api.example.com/_runova/health',
        intervalSec: 60,
        timeoutSec: 10,
        authMode: 'bearer',
        autoDiagnose: true,
        allowInsecure: false,
      }),
    );
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
    expect(screen.getByText('RUNOVA_HEALTH_TOKEN_SHA256')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(await navigator.clipboard.readText()).toBe(reveal().secret);
    await user.click(screen.getByRole('button', { name: 'Copy SHA-256' }));
    expect(await navigator.clipboard.readText()).toBe(reveal().sha256);
    await user.click(screen.getByRole('button', { name: 'Copy variable' }));
    expect(await navigator.clipboard.readText()).toBe(
      `RUNOVA_HEALTH_TOKEN_SHA256=${reveal().sha256}`,
    );

    // Hidden until asked for, so it is not on screen for anyone looking over a shoulder.
    expect(screen.queryByText(reveal().secret)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show key' }));
    expect(screen.getByText(reveal().secret)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'I saved it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('heading', { name: 'Add a health check' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(reveal().secret);
    expect(JSON.stringify({ ...localStorage })).not.toContain(reveal().secret);
  });

  it('shows the Basic password with its username', async () => {
    const { user } = renderWithProviders(<Harness />, {
      bridge: {
        ...bridge,
        'health.create': async () => ({
          target: target({ authMode: 'basic', basicUser: 'monitor' }),
          secret: reveal({
            authMode: 'basic',
            basicUser: 'monitor',
            hashEnvVar: 'RUNOVA_HEALTH_PASSWORD_SHA256',
          }),
        }),
      },
    });
    await fillBasics(user, 'https://example.com/h');
    await user.click(screen.getByRole('radio', { name: /HTTP Basic/ }));
    await user.type(screen.getByLabelText('Username'), 'monitor');
    await user.click(screen.getByRole('button', { name: 'Add target' }));
    await screen.findByRole('heading', { name: 'Save this password now' });
    expect(screen.getByText('RUNOVA_HEALTH_USER')).toBeInTheDocument();
    expect(screen.getByText('RUNOVA_HEALTH_PASSWORD_SHA256')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy password' })).toBeInTheDocument();
  });

  it('saves an edit as a patch without asking for a new key', async () => {
    const update = vi.fn(async () => target({ name: 'Public API' }));
    const { user } = renderWithProviders(<Harness editing={target()} />, {
      bridge: { ...bridge, 'health.update': update },
    });
    expect(screen.getByRole('heading', { name: 'Edit API' })).toBeInTheDocument();
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Public API');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Public API' })),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
