import type { ContainerList } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { logLines, SERVER, seededDocker } from '../containers/testing/fixtures';
import { parseSourceValue } from './LogSourcePicker';
import { LogViewer } from './LogViewer';

/**
 * The logs center's viewer: a unit's journal, a container, an app's services together and the
 * audit trail, as text only, with the level in words, a level filter, a search and a download.
 */

const containers = seededDocker().list();
const sites = [
  {
    settings: { id: 'blog', domains: ['blog.example.com'] },
    applied: true,
    createdAtUnixMs: 0,
    updatedAtUnixMs: 0,
  },
] as never;

function render(
  initial: string,
  extra: Record<string, unknown> = {},
  props: { scope?: 'stack'; containers?: ContainerList } = {},
) {
  const onAskAi = vi.fn();
  const view = renderWithProviders(
    <div style={{ height: 600 }}>
      <LogViewer
        serverId={SERVER.id}
        containers={props.containers ?? containers}
        sites={sites}
        initial={initial}
        scope={props.scope}
        onAskAi={onAskAi}
      />
    </div>,
    {
      bridge: {
        'deployLogs.watchJournal': async () => 'j-1',
        'deployLogs.unwatchJournal': async () => true,
        'deployDocker.watchLogs': async (input: { containerId: string }) =>
          `logs-${input.containerId}`,
        'deployDocker.unwatchLogs': async () => true,
        'deploySites.watchLog': async () => 'site-1',
        'deploySites.unwatchLog': async () => true,
        'deploySecurity.queryAudit': {
          events: [
            {
              id: 1,
              atUnixMs: 1_000,
              action: 'exec.run',
              result: 'denied',
              actorUserName: 'maria',
            },
          ],
        },
        ...extra,
      },
    },
  );
  return { ...view, onAskAi };
}

describe('LogViewer', () => {
  it('shows a journal as text with each level in words, filters by level and searches', async () => {
    const { bridge, user } = render('journal:nginx.service');
    await waitFor(() =>
      expect(bridge.$fn('deployLogs.watchJournal')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        unit: 'nginx.service',
        follow: true,
        lines: 500,
      }),
    );
    act(() =>
      bridge.$emit('deployLogs.onJournal', {
        subscriptionId: 'j-1',
        serverId: SERVER.id,
        unit: 'nginx.service',
        lines: [
          { atUnixMs: Date.now() - 1_000, priority: 6, text: 'started <script>x</script>' },
          { atUnixMs: Date.now(), priority: 3, text: 'bind failed' },
        ],
      }),
    );
    const log = screen.getByRole('log', { name: 'Log: nginx.service' });
    expect(await within(log).findByText('started <script>x</script>')).toBeInTheDocument();
    expect(log.querySelector('script')).toBeNull();
    expect(log.querySelector('[data-level="error"]')).toHaveTextContent('err');

    await user.type(screen.getByLabelText('Search the log'), 'bind');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1');
    await user.clear(screen.getByLabelText('Search the log'));

    await user.click(screen.getByLabelText('Level'));
    await user.click(await screen.findByRole('option', { name: 'Errors only' }));
    await waitFor(() => expect(within(log).queryByText(/started/)).not.toBeInTheDocument());
    expect(within(log).getByText('bind failed')).toBeInTheDocument();
  });

  it('follows every service of an app at once, each named', async () => {
    const { bridge } = render('stack:shop');
    await waitFor(() => expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenCalledTimes(4));
    const shop = containers.groups.find((group) => group.project === 'shop');
    const [first, second] = shop?.containers ?? [];
    act(() => {
      bridge.$emit('deployDocker.onLogs', {
        subscriptionId: `logs-${first?.id}`,
        serverId: SERVER.id,
        containerId: first?.id,
        lines: logLines([['from the first', 'stdout']]),
      });
      bridge.$emit('deployDocker.onLogs', {
        subscriptionId: `logs-${second?.id}`,
        serverId: SERVER.id,
        containerId: second?.id,
        lines: logLines([['error: from the second', 'stderr']]),
      });
    });
    const log = screen.getByRole('log', { name: 'Log: shop' });
    expect(await within(log).findByText('from the first')).toBeInTheDocument();
    expect(within(log).getByText(first?.composeService ?? '')).toBeInTheDocument();
    expect(within(log).getByText(second?.composeService ?? '')).toBeInTheDocument();
  });

  it('reads the audit trail once and offers it to the AI and as a download', async () => {
    const created = vi.fn(() => 'blob:x');
    URL.createObjectURL = created as never;
    URL.revokeObjectURL = vi.fn();
    const { user, onAskAi } = render('audit');
    const log = screen.getByRole('log', { name: 'Log: Core audit trail' });
    expect(await within(log).findByText('exec.run denied')).toBeInTheDocument();
    // jsdom treats following the download link as leaving the page, which it cannot do.
    const follow = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(created).toHaveBeenCalled();
    expect(follow).toHaveBeenCalled();
    follow.mockRestore();
    await user.click(screen.getByRole('button', { name: 'Ask the AI' }));
    expect(onAskAi).toHaveBeenCalledWith({ kind: 'audit', label: 'Core audit trail' });
  });

  it('says why a source failed', async () => {
    render('journal:docker', {
      'deployLogs.watchJournal': async () => {
        throw new Error('[core:forbidden] Your role on this server (operator) cannot do that.');
      },
    });
    expect(await screen.findByText(/cannot do that/)).toBeInTheDocument();
  });
});

describe('LogViewer, how much and which logs', () => {
  it('starts with as many lines as asked, up to 2000 for a journal and 5000 for a container', async () => {
    const { bridge, user } = render('journal:nginx.service');
    await user.click(screen.getByLabelText('Lines to read'));
    expect(screen.queryByRole('option', { name: 'Last 5,000 lines' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Last 2,000 lines' }));
    await waitFor(() =>
      expect(bridge.$fn('deployLogs.watchJournal')).toHaveBeenLastCalledWith(
        expect.objectContaining({ unit: 'nginx.service', lines: 2_000 }),
      ),
    );

    await user.click(screen.getByLabelText('Log source'));
    await user.click(await screen.findByRole('option', { name: 'Container shop-api-1' }));
    await user.click(screen.getByLabelText('Lines to read'));
    await user.click(await screen.findByRole('option', { name: 'Last 5,000 lines' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenLastCalledWith(
        expect.objectContaining({ tail: 5_000 }),
      ),
    );
  });

  it('offers only the app and its containers when kept to one app', async () => {
    const shop = containers.groups.filter((group) => group.project === 'shop');
    const { user } = render('stack:shop', {}, { scope: 'stack', containers: { groups: shop } });
    await user.click(screen.getByLabelText('Log source'));
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toContain('App shop: every service');
    expect(options).toContain('Container shop-api-1');
    expect(options.some((text) => /Journal|Site|audit/.test(text ?? ''))).toBe(false);
  });

  it('says when an app has more services than are followed together', async () => {
    const shop = containers.groups.find((group) => group.project === 'shop');
    const first = shop?.containers[0];
    if (!shop || !first) throw new Error('the seed has a shop');
    const bigger: ContainerList = {
      groups: [
        {
          ...shop,
          containers: [
            ...shop.containers,
            { ...first, id: `${first.id}-extra`, name: 'shop-worker-1', composeService: 'worker' },
          ],
        },
      ],
    };
    const { bridge } = render('stack:shop', {}, { scope: 'stack', containers: bigger });
    expect(
      screen.getByText(/Showing the first 4 of 5 services together. Pick one service/),
    ).toBeInTheDocument();
    await waitFor(() => expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenCalledTimes(4));
  });
});

describe('parseSourceValue', () => {
  it('reads each kind back and refuses what it cannot find', () => {
    const api = containers.groups
      .flatMap((group) => group.containers)
      .find((c) => c.name === 'shop-api-1');
    expect(parseSourceValue(`container:${api?.id}`, containers, sites)).toEqual({
      kind: 'container',
      containerId: api?.id,
      label: 'shop-api-1',
    });
    expect(parseSourceValue('container:nope', containers, sites)).toBeNull();
    expect(parseSourceValue('stack:nope', containers, sites)).toBeNull();
    expect(parseSourceValue('site:access:blog', containers, sites)).toEqual({
      kind: 'site',
      siteId: 'blog',
      logKind: 'access',
      label: 'blog.example.com access log',
    });
    expect(parseSourceValue('site:weird:blog', containers, sites)).toBeNull();
    expect(parseSourceValue('cron.service', containers, sites)).toEqual({
      kind: 'journal',
      unit: 'cron.service',
      label: 'cron.service',
    });
    expect(parseSourceValue('rm -rf', containers, sites)).toBeNull();
  });
});

describe('LogViewer, reading a container', () => {
  it('steps through matches, narrows the time range, stops following and reads again', async () => {
    const api = containers.groups
      .flatMap((group) => group.containers)
      .find((c) => c.name === 'shop-api-1');
    const { bridge, user } = render(`container:${api?.id}`);
    await waitFor(() => expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenCalledTimes(1));
    const now = Date.now();
    act(() =>
      bridge.$emit('deployDocker.onLogs', {
        subscriptionId: `logs-${api?.id}`,
        serverId: SERVER.id,
        containerId: api?.id,
        lines: [
          {
            stream: 'stdout',
            timestamp: 'a',
            atUnixMs: now - 3 * 60 * 60_000,
            text: 'old timeout',
          },
          { stream: 'stdout', timestamp: 'b', atUnixMs: now - 1_000, text: 'new timeout' },
          { stream: 'stderr', timestamp: 'c', atUnixMs: now, text: 'last timeout' },
        ],
      }),
    );
    const log = screen.getByRole('log', { name: 'Log: shop-api-1' });
    expect(await within(log).findByText('old timeout')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search the log'), 'timeout');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3');
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3');
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByRole('status')).toHaveTextContent('3 of 3');
    await user.type(screen.getByLabelText('Search the log'), '{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3');
    await user.type(screen.getByLabelText('Search the log'), '{Shift>}{Enter}{/Shift}');
    expect(screen.getByRole('status')).toHaveTextContent('3 of 3');
    await user.clear(screen.getByLabelText('Search the log'));

    await user.click(screen.getByLabelText('Time range'));
    await user.click(await screen.findByRole('option', { name: 'Last hour' }));
    await waitFor(() => expect(within(log).queryByText('old timeout')).not.toBeInTheDocument());

    await user.click(screen.getByLabelText('Follow new lines'));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenLastCalledWith(
        expect.objectContaining({ follow: false }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(bridge.$fn('deployDocker.watchLogs')).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBeDefined();
  });

  it('asks for a source when the choice no longer exists', () => {
    render('container:gone');
    expect(screen.getByText('Choose a log to read.')).toBeInTheDocument();
  });
});

describe('sourceValue', () => {
  it('writes each kind the way the picker reads it', async () => {
    const { sourceValue } = await import('./LogSourcePicker');
    expect(sourceValue({ kind: 'container', containerId: 'c1', label: 'x' })).toBe('container:c1');
    expect(sourceValue({ kind: 'stack', project: 'shop', containers: [], label: 'shop' })).toBe(
      'stack:shop',
    );
    expect(sourceValue({ kind: 'journal', unit: 'ssh', label: 'ssh' })).toBe('journal:ssh');
    expect(sourceValue({ kind: 'site', siteId: 'b', logKind: 'error', label: 'b' })).toBe(
      'site:error:b',
    );
    expect(sourceValue({ kind: 'audit', label: 'a' })).toBe('audit');
  });
});
