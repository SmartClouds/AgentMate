import type { DockerContainer, DockerLogLine } from '@shared/apiTypes';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockTime } from '@/lib/deploy/containers/logs';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The logs of one container on this machine, opened from its row on the Docker page. A user
 * comes here to find out why a container misbehaves, so stderr has to stand out, a search has to
 * find a line in a long log, a running container has to keep its log live, and what is shown has
 * to be easy to take elsewhere.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { ContainerLogsDialog } = await import('./ContainerLogsDialog');

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: 'web-id',
    name: 'web',
    image: 'nginx:1.27',
    state: 'running',
    status: 'Up 2 hours',
    composeProject: null,
    cpuPercent: null,
    memUsedBytes: null,
    memLimitBytes: null,
    ...overrides,
  };
}

function line(second: number, text: string, stream: DockerLogLine['stream'] = 'stdout') {
  const time = `2024-05-01T10:00:${String(second).padStart(2, '0')}`;
  return {
    stream,
    timestamp: `${time}.000000000Z`,
    atUnixMs: Date.parse(`${time}.000Z`),
    text,
  } satisfies DockerLogLine;
}

const LINES = [
  line(0, 'listening on :8080'),
  line(1, 'db refused the connection', 'stderr'),
  line(2, 'retrying'),
  line(3, 'db refused again', 'stderr'),
  line(4, 'connected'),
];

function renderDialog(
  target: DockerContainer | null = container(),
  bridge: Record<string, unknown> = {},
) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <ContainerLogsDialog container={target} onOpenChange={onOpenChange} />,
    { bridge: { 'docker.logs': LINES, ...bridge } },
  );
  return { ...view, onOpenChange };
}

async function findLog(): Promise<HTMLElement> {
  const log = await screen.findByRole('log', { name: 'Log of web' });
  await within(log).findByText('connected');
  return log;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ContainerLogsDialog', () => {
  it('stays closed without a container', () => {
    renderDialog(null);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the container and shows its log, with stderr lines marked apart', async () => {
    const { bridge } = renderDialog();

    const dialog = await screen.findByRole('dialog', { name: 'web' });
    expect(within(dialog).getByText(/nginx:1\.27/)).toBeInTheDocument();
    const log = await findLog();
    expect(bridge.$fn('docker.logs')).toHaveBeenCalledWith('web-id', { tail: 500 });

    const refused = within(log).getByText('db refused the connection').closest('[data-stream]');
    expect(refused?.getAttribute('data-stream')).toBe('stderr');
    const listening = within(log).getByText('listening on :8080').closest('[data-stream]');
    expect(listening?.getAttribute('data-stream')).toBe('stdout');
    expect(within(log).getByText(clockTime(LINES[0].atUnixMs))).toBeInTheDocument();
  });

  it('counts the lines and those from stderr in the footer', async () => {
    renderDialog();
    await findLog();

    expect(screen.getByText('5 lines')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 from stderr' })).toBeInTheDocument();
  });

  it('follows a running container live', async () => {
    renderDialog();
    await findLog();

    expect(screen.getByRole('switch', { name: 'Follow new lines' })).toBeChecked();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it("can't follow a container that is not running, and says so", async () => {
    renderDialog(container({ state: 'exited', status: 'Exited (1) 2 minutes ago' }));
    await findLog();

    const follow = screen.getByRole('switch', { name: 'Follow new lines' });
    expect(follow).not.toBeChecked();
    expect(follow).toBeDisabled();
    expect(screen.getByText('Not running')).toBeInTheDocument();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('pauses following when the switch is turned off', async () => {
    renderDialog();
    await findLog();

    const follow = screen.getByRole('switch', { name: 'Follow new lines' });
    fireEvent.click(follow);

    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(follow).not.toBeChecked();
    expect(follow).toHaveAttribute('data-state', 'unchecked');
  });

  it('marks what the search finds and steps through the matches', async () => {
    renderDialog();
    const log = await findLog();

    const search = screen.getByRole('textbox', { name: 'Search the log' });
    fireEvent.change(search, { target: { value: 'refused' } });

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(log.querySelectorAll('mark')).toHaveLength(2);

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('steps through the stderr lines from their count', async () => {
    renderDialog();
    const log = await findLog();

    fireEvent.click(screen.getByRole('button', { name: '2 from stderr' }));

    const current = log.querySelector('[data-current="true"]');
    expect(current?.textContent).toContain('db refused the connection');
    fireEvent.click(screen.getByRole('button', { name: '2 from stderr' }));
    expect(log.querySelector('[data-current="true"]')?.textContent).toContain('db refused again');
  });

  it('hides the times on request', async () => {
    renderDialog();
    const log = await findLog();

    const toggle = screen.getByRole('button', { name: 'Show times' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(within(log).queryByText(clockTime(LINES[0].atUnixMs))).toBeNull();
  });

  it('copies the log as text', async () => {
    renderDialog();
    await findLog();
    // After rendering, since user-event puts a clipboard of its own in place when it sets up.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    fireEvent.click(screen.getByRole('button', { name: 'Copy log' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Log of web copied.'));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied.split('\n')).toHaveLength(5);
    expect(copied).toContain('2024-05-01T10:00:01.000000000Z [stderr] db refused the connection');
  });

  it('saves the log to a file named after the container', async () => {
    const createObjectURL = vi.fn(() => 'blob:log');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderDialog();
    await findLog();

    fireEvent.click(screen.getByRole('button', { name: 'Download log' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^web-logs-\d{4}-\d{2}-\d{2}-\d{6}\.log$/);
  });

  it('offers a way back to the newest line after scrolling up', async () => {
    renderDialog();
    const log = await findLog();

    Object.defineProperty(log, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 400, configurable: true });
    log.scrollTop = 200;
    fireEvent.scroll(log);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));
    expect(log.scrollTop).toBe(2000);
  });

  it('says so when the container has printed nothing yet', async () => {
    renderDialog(container(), { 'docker.logs': [] });

    expect(await screen.findByText('Nothing logged yet')).toBeInTheDocument();
  });

  it("gives docker's reason when the log can't be read, and tries again", async () => {
    const logs = vi
      .fn()
      .mockRejectedValueOnce(new Error('No such container: web-id'))
      .mockResolvedValue(LINES);
    renderDialog(container(), { 'docker.logs': logs });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No such container: web-id');

    fireEvent.click(within(alert).getByRole('button', { name: /try again/i }));

    await findLog();
    expect(logs).toHaveBeenCalledTimes(2);
  });
});
