import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { detail, incident, NOW, project, reveal, target } from './testing/fixtures';

vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: vi.fn(() => 'tab-1'),
  projectCliId: () => 'claude-code',
}));
vi.mock('@/components/promptBuilder/RunRecommendation', () => ({
  useRunRecommendation: () => ({
    status: 'idle',
    recommendation: null,
    choice: null,
    analyze: vi.fn(),
  }),
  RunRecommendationPanel: () => <div>sizing panel</div>,
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { HealthTargetDetail } = await import('./HealthTargetDetail');

const onClose = vi.fn();
const onEdit = vi.fn();
const onSetup = vi.fn();

function renderPanel(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <HealthTargetDetail
        targetId="t1"
        onClose={onClose}
        onEdit={onEdit}
        onSetup={onSetup}
        projects={[project()]}
        environmentName="Production"
        now={NOW}
      />
      <ConfirmDialogHost />
    </>,
    { bridge: { 'health.get': async () => detail(), ...bridge } },
  );
}

async function panel() {
  return screen.findByRole('dialog', { name: 'API' });
}

describe('HealthTargetDetail', () => {
  it('lists the services and explains the failing one', async () => {
    const { user } = renderPanel();
    const view = await panel();
    const table = within(view).getByRole('table', { name: 'Services' });
    expect(within(table).getByText('redis:ping')).toBeInTheDocument();
    expect(within(table).getByText('3 ms')).toBeInTheDocument();

    const error = within(view).getByRole('region', { name: 'postgres:connection error' });
    expect(error).toHaveTextContent('Connection refused');
    expect(error).toHaveTextContent('ECONNREFUSED');
    expect(error).toHaveTextContent('Check that the database is running');
    expect(error).toHaveTextContent('Tried 10.0.0.5:5432');

    expect(within(error).queryByText(/at connect/)).toBeNull();
    await user.click(within(error).getByRole('button', { name: 'Stack trace' }));
    expect(within(error).getByText(/at connect \(db\.js:10:5\)/)).toBeInTheDocument();
    await user.click(within(error).getByRole('button', { name: 'Copy stack trace' }));
    expect(await navigator.clipboard.readText()).toContain('at connect (db.js:10:5)');
  });

  it('charts the response time of the last 24 hours', async () => {
    renderPanel({
      'health.get': async () =>
        detail({
          latency: [
            { start: NOW - 7_200_000, checks: 60, failures: 0, p50: 110, p95: 250 },
            { start: NOW - 3_600_000, checks: 60, failures: 0, p50: 95, p95: 180 },
          ],
        }),
    });
    const view = await panel();
    const section = await within(view).findByRole('region', { name: 'Response time, 24 h' });
    expect(within(section).getByRole('img', { name: /Response time, 2 readings/ })).toBeTruthy();
  });

  it('keeps the raw response folded until asked for', async () => {
    const { user } = renderPanel();
    const view = await panel();
    expect(within(view).queryByText(/"status": "fail"/)).toBeNull();
    await user.click(within(view).getByRole('button', { name: 'Raw response' }));
    expect(within(view).getByText(/"status": "fail"/)).toBeInTheDocument();
  });

  it('shows the incident timeline', async () => {
    renderPanel({
      'health.get': async () =>
        detail({
          incidents: [
            incident(),
            incident({
              id: 'i0',
              openedAt: NOW - 7_200_000,
              resolvedAt: NOW - 3_600_000,
              summary: 'Timed out',
            }),
          ],
        }),
    });
    const view = await panel();
    const list = within(view).getByRole('list', { name: 'Incidents' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list).toHaveTextContent('Ongoing');
    expect(list).toHaveTextContent('Resolved after 1 h');
    expect(list).toHaveTextContent('Timed out');
  });

  it('shimmers while the diagnosis runs and can cancel it', async () => {
    const { user, bridge } = renderPanel({
      'health.get': async () =>
        detail({
          target: target({
            state: 'fail',
            openIncident: incident({
              diagnosis: {
                status: 'running',
                startedAt: NOW,
                finishedAt: null,
                cliName: 'Claude Code',
                text: null,
              },
            }),
          }),
        }),
    });
    const view = await panel();
    const section = within(view).getByRole('region', { name: 'AI diagnosis' });
    expect(within(section).getByRole('status', { name: 'Diagnosis running' })).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Cancel' }));
    expect(bridge.$fn('health.cancelDiagnose')).toHaveBeenCalledWith('t1');
  });

  it('shows a finished diagnosis as plain text and can run it again', async () => {
    const { user, bridge } = renderPanel({
      'health.get': async () =>
        detail({
          target: target({
            state: 'fail',
            openIncident: incident({
              diagnosis: {
                status: 'done',
                startedAt: NOW - 60_000,
                finishedAt: NOW - 30_000,
                cliName: 'Claude Code',
                text: 'The database container stopped. <b>Restart</b> it.',
              },
            }),
          }),
        }),
    });
    const section = within(await panel()).getByRole('region', { name: 'AI diagnosis' });
    expect(section).toHaveTextContent('The database container stopped. <b>Restart</b> it.');
    expect(section.querySelector('b')).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Run again' }));
    expect(bridge.$fn('health.diagnoseNow')).toHaveBeenCalledWith('t1');
  });

  it('says why a diagnosis failed', async () => {
    renderPanel({
      'health.get': async () =>
        detail({
          target: target({
            state: 'fail',
            openIncident: incident({
              diagnosis: {
                status: 'failed',
                startedAt: NOW,
                finishedAt: NOW,
                cliName: null,
                text: 'No agent CLI is installed.',
              },
            }),
          }),
        }),
    });
    const section = within(await panel()).getByRole('region', { name: 'AI diagnosis' });
    expect(section).toHaveTextContent('No agent CLI is installed.');
    expect(within(section).getByRole('button', { name: 'Run diagnosis' })).toBeInTheDocument();
  });

  it('checks now and pauses', async () => {
    const { user, bridge } = renderPanel({
      'health.checkNow': async () => detail(),
      'health.setPaused': async () => target({ paused: true }),
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Check now' }));
    expect(bridge.$fn('health.checkNow')).toHaveBeenCalledWith('t1');
    await user.click(within(view).getByRole('button', { name: 'Pause' }));
    expect(bridge.$fn('health.setPaused')).toHaveBeenCalledWith('t1', true);
  });

  it('hands the fix prompt to Fix with AI', async () => {
    const { user, bridge } = renderPanel({
      'health.fixPrompt': async () => 'Fix the failing postgres connection.',
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Fix with AI' }));
    const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
    expect(prompt.value).toBe('Fix the failing postgres connection.');
    expect(bridge.$fn('health.fixPrompt')).toHaveBeenCalledWith('t1');
  });

  it('copies the fix prompt for another AI', async () => {
    const { user } = renderPanel({ 'health.fixPrompt': async () => 'Fix it.' });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Copy for AI' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('Fix it.'));
  });

  it('rotates the key only after a confirmation, then shows the new one once', async () => {
    const rotate = vi.fn(async () => reveal({ secret: 'rnh_rotated_key' }));
    const { user } = renderPanel({ 'health.rotateSecret': rotate });
    const view = await panel();

    await user.click(within(view).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate key' }));
    const confirm = await screen.findByRole('dialog', { name: 'Rotate the key for API?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(rotate).not.toHaveBeenCalled();

    await user.click(within(view).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate key' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Rotate the key for API?' })).getByRole(
        'button',
        { name: 'Rotate key' },
      ),
    );
    expect(rotate).toHaveBeenCalledWith('t1');
    expect(await screen.findByRole('heading', { name: 'Save this key now' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I saved it' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Save this key now' })).toBeNull(),
    );
    expect(document.body).not.toHaveTextContent('rnh_rotated_key');
  });

  it('deletes after a confirmation and closes', async () => {
    const { user, bridge } = renderPanel();
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete API?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(bridge.$fn('health.remove')).toHaveBeenCalledWith('t1'));
    expect(onClose).toHaveBeenCalled();
  });

  it('offers to build the endpoint while the target does not answer with a report', async () => {
    const { user } = renderPanel({
      'health.get': async () =>
        detail({ target: target({ state: 'invalid' }), report: null, incidents: [] }),
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Build the endpoint with AI' }));
    expect(onSetup).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('keeps the build button out of the way once the endpoint answers', async () => {
    renderPanel({ 'health.get': async () => detail({ target: target({ state: 'pass' }) }) });
    const view = await panel();
    expect(within(view).queryByRole('button', { name: 'Build the endpoint with AI' })).toBeNull();
  });

  it('opens the edit and build flows from the menu', async () => {
    const { user } = renderPanel();
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    await user.click(within(view).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Build the endpoint with AI' }));
    expect(onSetup).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });
});
