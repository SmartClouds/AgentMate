import { WP_CONNECTOR_VERSION } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SiteOverviewPanel } from './SiteOverviewPanel';
import { NOW_SECONDS, wpSite, wpSiteInfo } from './testing/fixtures';

/**
 * The site's overview: versions, theme, HTTPS, the connector and its guard, and in plain words
 * whether deploys can write files and what stops them when they can't.
 */

function renderPanel(info: unknown, site = wpSite(), bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<SiteOverviewPanel site={site} />, {
    bridge: { 'deployWordPress.siteInfo': info, ...bridge },
  });
}

describe('SiteOverviewPanel', () => {
  it('shimmers in each card while the site answers', () => {
    const { container } = renderPanel(() => new Promise(() => undefined));

    expect(container.querySelectorAll('[aria-busy="true"] .shimmer').length).toBeGreaterThan(3);
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(3);
  });

  it("lists the site's facts", async () => {
    renderPanel(async () => wpSiteInfo());

    expect(await screen.findByText('6.6.2')).toBeTruthy();
    expect(screen.getByText('8.2.12')).toBeTruthy();
    expect(screen.getByText('crumb-child')).toBeTruthy();
    expect(screen.getByText('crumb')).toBeTruthy();
    expect(screen.getByText(/Installed\. If a deploy breaks the site/)).toBeTruthy();
    expect(screen.getByText(/every deploy is health-checked/)).toBeTruthy();
    expect(
      screen.getByText(/Allowed\. Deploys write theme and plugin files directly/),
    ).toBeTruthy();
  });

  it.each([
    [{ fileModsDisabled: true }, /DISALLOW_FILE_MODS is set/],
    [{ readOnlyByConstant: true }, /RUNOVA_CONNECTOR_READ_ONLY is set/],
    [{ filesystemMethod: 'ftpext' }, /through "ftpext" here/],
  ])('says why file changes are off (%o)', async (patch, expected) => {
    renderPanel(async () => wpSiteInfo(patch));

    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('says a read-only key cannot deploy even when the site allows it', async () => {
    renderPanel(async () => wpSiteInfo(), wpSite({ scope: 'read' }));

    expect(await screen.findByText(/but this key is read-only/)).toBeTruthy();
  });

  it('warns when the rescue guard is missing and loopback fails', async () => {
    renderPanel(async () =>
      wpSiteInfo({ guard: { installed: false, rescueUrl: null }, loopback: 'failed' }),
    );

    expect(await screen.findByText(/Not installed, so a deploy that breaks the site/)).toBeTruthy();
    expect(screen.getByText(/loopback requests fail/)).toBeTruthy();
  });

  it('says clearly when the connector is older than this app expects', async () => {
    renderPanel(async () => wpSiteInfo({ protocol: 0, pluginVersion: '0.9.0' }));

    expect(await screen.findByText(/older than this version of Runova expects/)).toBeTruthy();
    expect(screen.getByText('Update the connector')).toBeTruthy();
  });

  it('mentions a newer connector of the same protocol without alarm', async () => {
    renderPanel(async () => wpSiteInfo({ pluginVersion: '0.9.5' }));

    expect(await screen.findByText(/comes with this app\. This one still works/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
    // An old connector has no update route; the one manual upload is said to be the last.
    expect(screen.getByText(/future updates can be done from here/)).toBeTruthy();
  });

  it('does not promise in-app updates to a connector that cannot replace its folder', async () => {
    renderPanel(async () => wpSiteInfo({ pluginVersion: '0.9.5', selfUpdate: false }));

    expect(await screen.findByText(/can't replace its own folder here/)).toBeTruthy();
    expect(screen.queryByText(/future updates can be done from here/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
  });

  describe('updating the connector from here', () => {
    const updatable = () => wpSiteInfo({ pluginVersion: '0.9.5', selfUpdate: true });
    const done = (patch = {}) => ({
      outcome: 'updated' as const,
      fromVersion: '0.9.5',
      version: WP_CONNECTOR_VERSION,
      checks: [{ name: 'home' as const, status: 200, ok: true, detail: 'HTTP 200' }],
      ...patch,
    });

    it('offers a primary update button, with the download as the fallback', async () => {
      renderPanel(async () => updatable());

      expect(
        await screen.findByRole('button', { name: `Update to ${WP_CONNECTOR_VERSION}` }),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: `Download version ${WP_CONNECTOR_VERSION}` }),
      ).toBeTruthy();
      expect(screen.queryByText(/future updates can be done from here/)).toBeNull();
    });

    it('updates the site, shows the outcome and reads the site again', async () => {
      const update = vi.fn(async () => done());
      const info = vi
        .fn()
        .mockResolvedValueOnce(updatable())
        .mockResolvedValue(wpSiteInfo({ pluginVersion: WP_CONNECTOR_VERSION, selfUpdate: true }));
      const { user } = renderPanel(info, wpSite(), { 'deployWordPress.updateConnector': update });

      await user.click(await screen.findByRole('button', { name: /^Update to/ }));

      expect(update).toHaveBeenCalledWith(wpSite().id);
      expect(await screen.findByText(/is now version/)).toBeTruthy();
      expect(screen.getByText(/passed its health check/)).toBeTruthy();
      // The button is gone once the site reports the new version; the outcome stays.
      await vi.waitFor(() => expect(info.mock.calls.length).toBeGreaterThan(1));
      expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
      expect(screen.getByText(/is now version/)).toBeTruthy();
    });

    it('says when the site downloaded the release itself', async () => {
      const update = vi.fn(async () => done({ source: 'site' }));
      const { user } = renderPanel(async () => updatable(), wpSite(), {
        'deployWordPress.updateConnector': update,
      });

      await user.click(await screen.findByRole('button', { name: /^Update to/ }));

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toContain('downloaded it from GitHub itself');
      expect(notice.textContent).not.toContain('Runova sent the files');
    });

    it('says why Runova sent the files when the site could not download them', async () => {
      const update = vi.fn(async () =>
        done({
          source: 'app',
          downloadProblem:
            'The site could not download the connector from GitHub (cURL error 6: Could not resolve host: github.com).',
        }),
      );
      const { user } = renderPanel(async () => updatable(), wpSite(), {
        'deployWordPress.updateConnector': update,
      });

      await user.click(await screen.findByRole('button', { name: /^Update to/ }));

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toContain("couldn't download it itself, so Runova sent the files");
      expect(notice.textContent).toContain('Could not resolve host: github.com');
      expect(notice.textContent).toContain('is now version');
    });

    it('holds the button while the update runs', async () => {
      let finish: (value: ReturnType<typeof done>) => void = () => undefined;
      const update = vi.fn(
        () =>
          new Promise<ReturnType<typeof done>>((resolve) => {
            finish = resolve;
          }),
      );
      const { user } = renderPanel(async () => updatable(), wpSite(), {
        'deployWordPress.updateConnector': update,
      });

      await user.click(await screen.findByRole('button', { name: /^Update to/ }));

      const busy = await screen.findByRole('button', { name: 'Updating' });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      finish(done());
      expect(await screen.findByText(/is now version/)).toBeTruthy();
    });

    it('warns when the site undid the update on its own', async () => {
      const update = vi.fn(async () =>
        done({
          outcome: 'rolledBack',
          checks: [{ name: 'home', status: 500, ok: false, detail: 'HTTP 500' }],
        }),
      );
      const { user } = renderPanel(async () => updatable(), wpSite(), {
        'deployWordPress.updateConnector': update,
      });

      await user.click(await screen.findByRole('button', { name: /^Update to/ }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toContain('failed its health check');
      expect(notice.textContent).toContain('put version 0.9.5 back');
      expect(notice.textContent).toContain('home (HTTP 500)');
      expect(screen.getByRole('button', { name: /^Update to/ })).toBeTruthy();
    });

    it('says in words why an update could not be made', async () => {
      const update = vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'deployWordPress:updateConnector': Error: [wp:updateRefused] The newer connector needs a newer PHP or WordPress than this site has, so it was not installed. Nothing was changed.",
        );
      });
      const { user } = renderPanel(async () => updatable(), wpSite(), {
        'deployWordPress.updateConnector': update,
      });

      await user.click(await screen.findByRole('button', { name: /^Update to/ }));

      expect(await screen.findByText(/needs a newer PHP or WordPress/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Update to/ })).toBeTruthy();
    });

    it('asks for a write key when the connection is read-only', async () => {
      renderPanel(async () => updatable(), wpSite({ scope: 'read' }));

      expect(await screen.findByText(/This connection is read-only/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
    });

    it('sends the user to wp-admin when file changes are switched off', async () => {
      renderPanel(async () =>
        wpSiteInfo({ pluginVersion: '0.9.5', selfUpdate: true, fileModsDisabled: true }),
      );

      expect(await screen.findByText(/File changes are switched off on this site/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
    });
  });

  it('shows a deploy that waits for its confirmation', async () => {
    renderPanel(async () =>
      wpSiteInfo({
        pendingDeploy: { deployId: 'dep-9', state: 'applied', deadline: NOW_SECONDS + 120 },
      }),
    );

    expect(await screen.findByText(/A deploy is waiting for confirmation/)).toBeTruthy();
  });

  it('explains a locked vault and offers to try again', async () => {
    const { user, bridge } = renderPanel(async () => {
      throw new Error(
        "Error invoking remote method 'deployWordPress:siteInfo': Error: [wp:vaultLocked] locked",
      );
    });

    expect(
      await screen.findByText(/locked with a passkey, and this site's key with them/),
    ).toBeTruthy();
    bridge.$set('deployWordPress.siteInfo', async () => wpSiteInfo());
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('6.6.2')).toBeTruthy();
  });

  it('explains a firewall answering instead of the connector', async () => {
    renderPanel(async () => {
      throw new Error('[wp:foreignResponse] got HTML');
    });

    expect(await screen.findByText(/Something other than the connector answered/)).toBeTruthy();
  });

  it("shows the main process's own words when they say who answered", async () => {
    renderPanel(async () => {
      throw new Error(
        "Error invoking remote method 'deployWordPress:siteInfo': Error: [wp:foreignResponse] Cloudflare answered instead of Runova Connector (HTTP 403), most likely with a bot check.",
      );
    });

    expect(await screen.findByText(/Cloudflare answered instead of Runova Connector/)).toBeTruthy();
  });
});
