import type { Project } from '@runova/core';
import { API_TOKEN, DB_PASSWORD, GRAFANA_PASSWORD } from '@shared/deploy/testing/fakeDockerData';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeployContainerLinksStore } from '@/stores/deployContainerLinksStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { container, dockerBridge, logLines, SERVER } from './testing/fixtures';

/**
 * "Send logs to the project CLI" (T9): the prompt goes to the project the container comes from,
 * or one the user picks once, and never carries an environment value (AC3), even when the log
 * printed one the core did not catch and an Admin had revealed the values.
 */

vi.mock('@/components/workspace/FixWithAiDialog', () => ({
  FixWithAiDialog: ({
    project,
    title,
    source,
  }: {
    project: Project;
    title: string;
    source: { prompt: string | null; error?: string | null; retry?: () => void };
  }) => (
    <div role="dialog" aria-label={title}>
      <p>Project: {project.name}</p>
      {source.error ? (
        <button type="button" onClick={source.retry}>
          {source.error}
        </button>
      ) : (
        <pre data-testid="prompt">{source.prompt ?? 'loading'}</pre>
      )}
    </div>
  ),
}));

const { SendLogsDialog } = await import('./SendLogsDialog');

const project = (id: string, name: string, folderPath: string) =>
  ({ id, name, folderPath }) as Project;

beforeEach(() => {
  useDeployContainerLinksStore.setState({ links: {} });
});

function render(
  name: string,
  bridge: Record<string, unknown> = {},
  revealed?: Array<{ name: string; value: string }>,
) {
  const onClose = vi.fn();
  const view = renderWithProviders(
    <SendLogsDialog
      serverId={SERVER.id}
      serverName={SERVER.nickname}
      container={container(name)}
      revealed={revealed}
      onClose={onClose}
    />,
    { bridge: { ...dockerBridge(), ...bridge } },
  );
  return { ...view, onClose };
}

describe('SendLogsDialog', () => {
  it('sends a redacted prompt to the project the compose project names (AC3)', async () => {
    render(
      'shop-api-1',
      {
        'projects.list': [
          project('p1', 'Shop', '/code/shop'),
          project('p2', 'Other', '/code/other'),
        ],
        'deployDocker.logTail': logLines([
          ['listening on 3000', 'stdout'],
          [`auth failed for postgres://shop:${DB_PASSWORD}@db`, 'stderr'],
          [`token ${API_TOKEN} rejected`, 'stderr'],
        ]),
      },
      [
        { name: 'DATABASE_URL', value: `postgres://shop:${DB_PASSWORD}@db:5432/shop` },
        { name: 'API_TOKEN', value: API_TOKEN },
      ],
    );
    expect(
      await screen.findByRole('dialog', { name: "Send shop-api-1's log to Shop" }),
    ).toBeInTheDocument();
    const prompt = await screen.findByTestId('prompt');
    await waitFor(() => expect(prompt).toHaveTextContent('listening on 3000'));
    expect(prompt).toHaveTextContent('Environment variables (names only');
    for (const secret of [DB_PASSWORD, API_TOKEN]) expect(prompt.textContent).not.toContain(secret);
  });

  it('asks which project when none matches, and remembers the answer', async () => {
    const { user, bridge } = render('monitoring-grafana-1', {
      'projects.list': [project('p1', 'Shop', '/code/shop'), project('p2', 'Ops', '/code/ops')],
      'deployDocker.logTail': logLines([
        [`GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}`, 'stdout'],
      ]),
    });
    const picker = await screen.findByRole('dialog', {
      name: 'Which project runs monitoring-grafana-1?',
    });
    expect(picker).toHaveTextContent('No project here is called monitoring.');
    expect(screen.getByRole('button', { name: 'Use this project' })).toBeDisabled();
    await user.click(await screen.findByRole('radio', { name: /Ops/ }));
    await user.click(screen.getByRole('button', { name: 'Use this project' }));
    expect(await screen.findByText('Project: Ops')).toBeInTheDocument();
    expect(useDeployContainerLinksStore.getState().links).toEqual({
      [`${SERVER.id}:project:monitoring`]: 'p2',
    });
    expect(bridge.$fn('deployDocker.logTail')).toHaveBeenCalledWith(
      expect.objectContaining({ tail: 200 }),
    );
    // Not revealed, but printed under its variable's name: still left out.
    await waitFor(() =>
      expect(screen.getByTestId('prompt')).toHaveTextContent(
        'GF_SECURITY_ADMIN_PASSWORD=[redacted]',
      ),
    );
    expect(screen.getByTestId('prompt').textContent).not.toContain(GRAFANA_PASSWORD);
  });

  it('says there is nothing to send to when this computer has no projects', async () => {
    const { user, onClose } = render('toolbox', { 'projects.list': [] });
    expect(
      await screen.findByText(/There are no projects on this computer yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Pick the project this container comes from',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows why the log could not be read, and tries again', async () => {
    let calls = 0;
    const { user } = render('shop-api-1', {
      'projects.list': [project('p1', 'Shop', '/code/shop')],
      'deployDocker.logTail': async () => {
        calls += 1;
        if (calls === 1) throw new Error('No such container: shop-api-1');
        return [];
      },
    });
    await user.click(await screen.findByRole('button', { name: 'No such container: shop-api-1' }));
    await waitFor(() =>
      expect(screen.getByTestId('prompt')).toHaveTextContent('(The log is empty.)'),
    );
  });

  it('renders nothing without a container', () => {
    const { container: root } = renderWithProviders(
      <SendLogsDialog
        serverId={SERVER.id}
        serverName="x"
        container={null}
        onClose={() => undefined}
      />,
      { bridge: dockerBridge() },
    );
    expect(root).toBeEmptyDOMElement();
  });
});
