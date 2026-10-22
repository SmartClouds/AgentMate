import type { SiteInfo } from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, SHOP, site, sitesBridge } from './testing/fixtures';

/**
 * The site editor: every tab's fields, checks made before the core is asked, the core's problems
 * shown next to their field, saving, deleting, and what a Viewer may not touch.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/editor/MonacoEditor', async () => ({
  MonacoEditor: (await import('./testing/monacoMocks')).FakeMonacoEditor,
}));
vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('./testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { SiteEditor } = await import('./SiteEditor');

function renderEditor(
  options: {
    site?: SiteInfo;
    admin?: boolean;
    bridge?: Record<string, unknown>;
    tab?: 'domains' | 'security' | 'performance';
  } = {},
) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const view = renderWithProviders(
    <>
      <SiteEditor
        server={SERVER}
        site={options.site}
        admin={options.admin ?? true}
        owner={options.admin ?? true}
        applyProblems={[]}
        initialTab={options.tab}
        onClose={onClose}
        onSaved={onSaved}
        onChanged={onChanged}
      />
      <ConfirmDialogHost />
    </>,
    { bridge: { ...sitesBridge(), ...options.bridge } },
  );
  return { ...view, onSaved, onClose, onChanged };
}

describe('SiteEditor domains and proxy', () => {
  it('suggests an id from the first domain and checks domains and the port here first', async () => {
    const { user, bridge } = renderEditor();
    await user.type(screen.getByRole('textbox', { name: 'Domain 1' }), 'shop.example.com');
    expect(screen.getByLabelText('Id')).toHaveValue('shop-example-com');
    await user.click(screen.getByRole('button', { name: /Add a domain/ }));
    await user.type(screen.getByRole('textbox', { name: 'Domain 2' }), 'not a domain');
    await user.click(screen.getByRole('button', { name: /Save the site/ }));
    expect(await screen.findByText(/can't contain spaces/)).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /Domains, 1 problem|Domains, one problem/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Proxy, one problem/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove not a domain' }));
    await user.click(screen.getByRole('tab', { name: /Proxy/ }));
    await user.type(screen.getByLabelText('Port'), '99999');
    await user.click(screen.getByRole('button', { name: /Save the site/ }));
    expect(await screen.findByText('Ports go from 1 to 65535.')).toBeInTheDocument();
    expect(() => bridge.$fn('deploySites.save')).toThrow(/has not been touched/);
  });

  it('shows the core’s problems next to their field and on their tab', async () => {
    const { user } = renderEditor({
      bridge: {
        'deploySites.save': {
          problems: [
            {
              field: 'sites[shop-example-com].domains[0]',
              message: 'shop.example.com already belongs to the site shop.',
            },
            {
              field: 'sites[shop-example-com].upstream',
              message: 'Port 5000 is the AgentMate core.',
            },
          ],
        },
      },
    });
    await user.type(screen.getByRole('textbox', { name: 'Domain 1' }), 'shop.example.com');
    await user.click(screen.getByRole('tab', { name: 'Proxy' }));
    await user.type(screen.getByLabelText('Port'), '5000');
    await user.click(screen.getByRole('button', { name: /Save the site/ }));
    expect(await screen.findByText(/already belongs to the site shop/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Proxy/ }));
    expect(screen.getByText('Port 5000 is the AgentMate core.')).toBeInTheDocument();
  });

  it('switches to an address upstream with its own options', async () => {
    const saved = site();
    const { user, bridge, onSaved } = renderEditor({
      site: SHOP,
      bridge: { 'deploySites.save': { problems: [], site: saved } },
    });
    await user.click(screen.getByRole('tab', { name: 'Proxy' }));
    expect(screen.getByRole('radio', { name: /An address/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('Address')).toHaveValue('http://10.0.0.5:8080');
    await user.click(screen.getByRole('switch', { name: /Send the upstream's own host name/ }));
    await user.click(screen.getByRole('switch', { name: 'WebSockets' }));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith(
      SERVER.id,
      expect.objectContaining({
        websocket: true,
        upstream: expect.objectContaining({ kind: 'url', sendUpstreamHost: true }),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('blog.example.com saved. Apply to put it live.');
    await user.click(screen.getByRole('radio', { name: /A port on this server/ }));
    expect(screen.getByLabelText('Service name')).toBeInTheDocument();
  });

  it('says when saving failed outright', async () => {
    const { user } = renderEditor({
      site: SHOP,
      bridge: { 'deploySites.save': () => Promise.reject(new Error('The core went away.')) },
    });
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText('The core went away.')).toBeInTheDocument();
  });
});

describe('SiteEditor performance and security', () => {
  it('turns the cache on with its options and limits the body size', async () => {
    const { user, bridge } = renderEditor({
      site: SHOP,
      tab: 'performance',
      bridge: { 'deploySites.save': { problems: [], site: SHOP } },
    });
    await user.click(screen.getByRole('switch', { name: 'Cache responses' }));
    await user.clear(screen.getByLabelText('Keep for'));
    await user.type(screen.getByLabelText('Keep for'), '120');
    await user.type(screen.getByLabelText('Skip the cache for these cookies'), 'sid');
    await user.type(screen.getByLabelText('Largest request body'), '50');
    await user.type(screen.getByLabelText('Read timeout'), '90');
    await user.click(screen.getByRole('switch', { name: 'Gzip' }));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() =>
      expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith(
        SERVER.id,
        expect.objectContaining({
          gzip: true,
          proxyCache: { ttlSeconds: 120, maxSizeMegabytes: 256, bypassCookies: ['sid'] },
          clientMaxBodySizeMegabytes: 50,
          timeouts: { readSeconds: 90 },
        }),
      ),
    );
  });

  it('adds headers, IP rules, basic auth users and a rate limit', async () => {
    const { user, bridge } = renderEditor({
      site: SHOP,
      tab: 'security',
      bridge: { 'deploySites.save': { problems: [], site: SHOP } },
    });
    await user.click(screen.getByRole('switch', { name: 'Add security headers' }));
    await user.click(screen.getByRole('combobox', { name: 'X-Frame-Options' }));
    await user.click(await screen.findByRole('option', { name: 'No site may frame it' }));
    await user.click(screen.getByRole('combobox', { name: 'Referrer-Policy' }));
    await user.click(await screen.findByRole('option', { name: 'no-referrer' }));
    await user.click(screen.getByRole('switch', { name: /nosniff/ }));
    await user.click(screen.getByRole('button', { name: /Add a header/ }));
    await user.type(screen.getByRole('textbox', { name: 'Header 1 name' }), 'X-Robots-Tag');
    await user.type(screen.getByRole('textbox', { name: 'Header 1 value' }), 'noindex');
    await user.type(screen.getByLabelText('Allow only'), '10.0.0.0/8');
    await user.type(screen.getByLabelText('Block'), 'nope');
    await user.click(screen.getByRole('switch', { name: 'Basic auth' }));
    await user.click(screen.getByRole('button', { name: /Add a user/ }));
    await user.click(screen.getByRole('switch', { name: 'Limit requests' }));
    await user.click(screen.getByRole('combobox', { name: 'Per' }));
    await user.click(await screen.findByRole('option', { name: 'minute' }));
    await user.click(screen.getByRole('switch', { name: 'Serve a burst at once' }));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText(/^nope: /)).toBeInTheDocument();
    expect(screen.getByText('Enter a user name.')).toBeInTheDocument();
    expect(screen.getByText('A new user needs a password.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add a header/ }));
    await user.click(screen.getByRole('button', { name: 'Remove header 2' }));
    await user.click(screen.getByRole('button', { name: /Add a user/ }));
    await user.click(screen.getByRole('button', { name: 'Remove user 2' }));
    await user.clear(screen.getByLabelText('Block'));
    await user.type(screen.getByRole('textbox', { name: 'User 1 name' }), 'ana');
    await user.type(screen.getByLabelText('User 1 password'), 'secret');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() =>
      expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith(
        SERVER.id,
        expect.objectContaining({
          securityHeaders: { noSniff: false, frameOptions: 'deny', referrerPolicy: 'noReferrer' },
          responseHeaders: [{ name: 'X-Robots-Tag', value: 'noindex' }],
          ipRules: { allow: ['10.0.0.0/8'], deny: [] },
          basicAuth: { realm: 'Restricted', users: [{ name: 'ana', password: 'secret' }] },
          rateLimit: { requests: 10, per: 'minute', burst: 20, noDelay: false },
        }),
      ),
    );
    // The editor reloads what the core saved, which here has none of it.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Header 1 name' })).toBeNull(),
    );
    expect(screen.queryByLabelText('X-Frame-Options')).toBeNull();
    // Many fields typed one key at a time: slow under a full parallel run.
  }, 40_000);
});

describe('SiteEditor for a saved site', () => {
  it('deletes the site after asking', async () => {
    const { user, bridge, onClose, onChanged } = renderEditor({
      site: site(),
      bridge: { 'deploySites.remove': async () => undefined },
    });
    await user.click(screen.getByRole('button', { name: /Delete$/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete blog.example.com?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete the site' }));
    await waitFor(() =>
      expect(bridge.$fn('deploySites.remove')).toHaveBeenCalledWith(SERVER.id, 'blog'),
    );
    expect(onClose).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps the site when the delete is cancelled, and says why one failed', async () => {
    const { user } = renderEditor({
      site: site(),
      bridge: { 'deploySites.remove': () => Promise.reject(new Error('Not yours.')) },
    });
    await user.click(screen.getByRole('button', { name: /Delete$/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await user.click(screen.getByRole('button', { name: /Delete$/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete the site' }),
    );
    expect(await screen.findByText('Not yours.')).toBeInTheDocument();
  });

  it('shows a Viewer the settings without letting them change anything', async () => {
    const { user } = renderEditor({ site: site(), admin: false });
    expect(screen.getByRole('textbox', { name: 'Domain 1' })).toBeDisabled();
    expect(screen.getByLabelText('Id')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save changes/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a domain/ })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(
      await screen.findByText(/Only an Owner can change custom directives/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(await screen.findByRole('log', { name: 'Access log' })).toBeInTheDocument();
  });
});
