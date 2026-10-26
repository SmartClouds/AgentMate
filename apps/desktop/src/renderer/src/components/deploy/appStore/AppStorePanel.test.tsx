import { CATALOG_TEMPLATES } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, STACK_ID, storeBridge } from './testing/fixtures';

/**
 * The App Store section: the catalog and the installed apps, the install sheet in every state
 * (badges, versions, passwords, settings, a domain, roles) and an install that goes on to the
 * deploy timeline and, with a domain, the site, nginx and the certificate.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { AppStorePanel } = await import('./AppStorePanel');

function Where(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

function renderStore(
  bridge: Record<string, unknown> = {},
  roles?: string[],
  route = `/deploy?server=${SERVER.id}&view=store`,
) {
  return renderWithProviders(
    <>
      <AppStorePanel server={SERVER} />
      <Where />
    </>,
    { bridge: { ...storeBridge(roles), ...bridge }, route },
  );
}

const sheetRoute = (id: string) => `/deploy?server=${SERVER.id}&view=store&install=${id}`;

describe('AppStorePanel', () => {
  it('shimmers while it finds out who is signed in, and then while its apps load', async () => {
    const never = () => new Promise(() => undefined);
    const first = renderStore({ 'deploy.access': never });
    expect(first.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    first.unmount();

    const second = renderStore({ 'deployStacks.list': never });
    await screen.findByRole('region', { name: 'Catalog' });
    expect(second.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Installed from the App Store' })).toBeNull();
  });

  it('asks for a sign-in first', async () => {
    renderStore({ 'deploy.access': { state: 'needs-sign-in' } });
    expect(await screen.findByText(/Sign in to Production on its Overview/)).toBeTruthy();
  });

  it('lists every app by category and finds them by name', async () => {
    const { user } = renderStore();
    const catalog = await screen.findByRole('region', { name: 'Catalog' });
    expect(within(catalog).getAllByRole('listitem')).toHaveLength(CATALOG_TEMPLATES.length);
    expect(within(catalog).getByRole('list', { name: 'Databases' })).toBeTruthy();
    expect(within(catalog).queryByText('MinIO')).toBeNull();
    await user.type(screen.getByLabelText('Find an app'), 'ghost');
    expect(within(catalog).getAllByRole('listitem')).toHaveLength(1);
    await user.clear(screen.getByLabelText('Find an app'));
    await user.type(screen.getByLabelText('Find an app'), 'zzz');
    expect(within(catalog).getByText('No app matches "zzz".')).toBeTruthy();
  });

  it('shows the apps it installed, with their status', async () => {
    renderStore();
    const installed = await screen.findByRole('region', { name: 'Installed from the App Store' });
    const cache = await within(installed).findByRole('listitem', { name: 'cache' });
    expect(within(cache).getByText(/Redis 8.10/)).toBeTruthy();
    expect(within(cache).getByText('Running')).toBeTruthy();
    // An app from a project is not listed here.
    expect(within(installed).queryByRole('listitem', { name: 'shop' })).toBeNull();
  });

  it('lets a Viewer browse but not install', async () => {
    renderStore({}, ['viewer']);
    const card = await screen.findByRole('listitem', { name: 'Redis' });
    expect(within(card).getByRole('button', { name: 'Install Redis' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('opens the install sheet from a card, in the address', async () => {
    const { user } = renderStore();
    const card = await screen.findByRole('listitem', { name: 'Redis' });
    await user.click(within(card).getByRole('button', { name: 'Install Redis' }));
    expect(screen.getByTestId('where').textContent).toContain('install=redis');
    expect(await screen.findByRole('dialog', { name: 'Install Redis' })).toBeTruthy();
  });
});

describe('the install sheet', () => {
  it('shows who publishes the images, the version, a free name and a fresh password', async () => {
    renderStore({}, ['operator'], sheetRoute('redis'));
    const sheet = await screen.findByRole('dialog', { name: 'Install Redis' });
    const images = within(sheet).getByRole('list', { name: 'Images' });
    expect(within(images).getByText('Docker Official Image')).toBeTruthy();
    expect(within(images).getByText(/redis:8\.10\.\d+ @/)).toBeTruthy();
    expect(within(sheet).getByLabelText('Version')).toHaveTextContent('Redis 8.10');
    // "cache" is taken by the Redis already there; the template id is not.
    expect(within(sheet).getByLabelText('App name')).toHaveProperty('value', 'redis');
    const password = within(sheet).getByLabelText(/^Password/) as HTMLInputElement;
    expect(password.value).toMatch(/^[A-Za-z0-9]{32}$/);
    // An Operator cannot add a website; Redis has no web interface anyway.
    expect(within(sheet).getByRole('switch', { name: 'Put it on a domain' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(sheet).getByText(/Redis speaks its own protocol/)).toBeTruthy();
  });

  it('copies and remakes a password, and refuses a weak one', async () => {
    const { user } = renderStore({}, ['owner'], sheetRoute('redis'));
    const sheet = await screen.findByRole('dialog', { name: 'Install Redis' });
    const password = within(sheet).getByLabelText(/^Password/) as HTMLInputElement;
    const first = password.value;
    await user.click(within(sheet).getByRole('button', { name: 'Copy Password' }));
    expect(await navigator.clipboard.readText()).toBe(first);
    await user.click(within(sheet).getByRole('button', { name: 'Make a new Password' }));
    expect(password.value).not.toBe(first);
    await user.clear(password);
    await user.type(password, 'short');
    expect(within(sheet).getByText(/at least 16 characters/)).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Install Redis' }));
    expect(within(sheet).getByRole('button', { name: 'Install Redis' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('marks a setting that does not fit and a name already taken', async () => {
    const { user } = renderStore({}, ['owner'], sheetRoute('redis'));
    const sheet = await screen.findByRole('dialog', { name: 'Install Redis' });
    const port = within(sheet).getByLabelText('Port');
    await user.clear(port);
    await user.type(port, '70000');
    expect(within(sheet).getByText('Ports go from 1 to 65535.')).toBeTruthy();
    const name = within(sheet).getByLabelText('App name');
    await user.clear(name);
    await user.type(name, 'cache');
    expect(within(sheet).getByText('An app called cache is already on this server.')).toBeTruthy();
  });

  it('installs, then follows the deploy with the passwords at hand', async () => {
    const { user, bridge } = renderStore({}, ['owner'], sheetRoute('redis'));
    const sheet = await screen.findByRole('dialog', { name: 'Install Redis' });
    const password = (within(sheet).getByLabelText(/^Password/) as HTMLInputElement).value;
    await user.click(within(sheet).getByRole('button', { name: 'Install Redis' }));

    await waitFor(() => expect(bridge.$fn('deployAppStore.install')).toHaveBeenCalled());
    expect(bridge.$fn('deployAppStore.install')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      templateId: 'redis',
      version: '8.10',
      name: 'redis',
      params: { port: 6379 },
      secrets: { REDIS_PASSWORD: password },
      domain: null,
    });
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toContain(`app=${STACK_ID}`),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('list', { name: 'Deploy steps' })).toBeTruthy();
    const card = await screen.findByRole('list', { name: 'Connection details' });
    // The facts come from the live revision's compose file (port 16379 there).
    expect(within(card).getByText('redis://:********@127.0.0.1:16379/0')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show passwords' }));
    expect(within(card).getByText(`redis://:${password}@127.0.0.1:16379/0`)).toBeTruthy();
  });

  it('says what the server said when the install is refused', async () => {
    const { user } = renderStore(
      {
        'deployAppStore.install': async () => {
          throw new Error('There is already an app called redis on this server.');
        },
      },
      ['owner'],
      sheetRoute('redis'),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Install Redis' });
    await user.click(within(sheet).getByRole('button', { name: 'Install Redis' }));
    expect(
      await within(sheet).findByText('There is already an app called redis on this server.'),
    ).toBeTruthy();
  });

  it('puts a web app on a domain: the site, nginx, then the certificate', async () => {
    const { user, bridge } = renderStore(
      {
        'deploySites.save': async () => ({ problems: [], site: { settings: {} } }),
        'deploySites.applyChanges': async () => ({ applied: true, problems: [], warnings: [] }),
        'deployCerts.issue': async () => ({ id: 'job-cert' }),
      },
      ['owner'],
      sheetRoute('uptime-kuma'),
    );
    const sheet = await screen.findByRole('dialog', { name: /^Install Uptime Kuma/ });
    await user.click(within(sheet).getByRole('switch', { name: 'Put it on a domain' }));
    await user.type(within(sheet).getByLabelText('Domain'), 'status.example.com');
    await user.click(within(sheet).getByRole('button', { name: /^Install Uptime Kuma/ }));

    await waitFor(() => expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalled());
    expect(bridge.$fn('deployAppStore.install')).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'status.example.com' }),
    );
    expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith(
      SERVER.id,
      expect.objectContaining({
        id: 'status-example-com',
        domains: ['status.example.com'],
        // The core takes a service name of letters, digits, '.', '_' and '-' only.
        upstream: expect.objectContaining({
          kind: 'servicePort',
          service: 'uptime-kuma-uptime-kuma',
          port: expect.any(Number),
        }),
        websocket: true,
      }),
    );
    expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      siteId: 'status-example-com',
      acceptTermsOfService: true,
      staging: false,
    });
    const steps = await screen.findByRole('region', { name: 'Domain steps' });
    expect(
      within(steps).getByRole('listitem', { name: 'Ask for a certificate' }),
    ).toHaveTextContent('(done)');
  });

  it('marks the domain step that failed', async () => {
    const { user } = renderStore(
      {
        'deploySites.save': async () => ({ problems: [], site: { settings: {} } }),
        'deploySites.applyChanges': async () => ({
          applied: false,
          problems: [],
          warnings: [],
          error: 'nginx -t failed.',
        }),
      },
      ['owner'],
      sheetRoute('uptime-kuma'),
    );
    const sheet = await screen.findByRole('dialog', { name: /^Install Uptime Kuma/ });
    await user.click(within(sheet).getByRole('switch', { name: 'Put it on a domain' }));
    await user.type(within(sheet).getByLabelText('Domain'), 'status.example.com');
    await user.click(within(sheet).getByRole('button', { name: /^Install Uptime Kuma/ }));
    const steps = await screen.findByRole('region', { name: 'Domain steps' });
    const apply = await within(steps).findByRole('listitem', { name: 'Apply nginx' });
    await waitFor(() => expect(apply).toHaveTextContent('(failed)'));
    expect(apply).toHaveTextContent('nginx -t failed.');
  });
});
