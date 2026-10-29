import type { DeployWordPressDeployResult } from '@shared/deployWordPressTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_ONLY_HINT } from '@/components/projects/wordpress/WordPressProjectSection';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { deferred, wpPlan, wpProject, wpSite } from '../projects/wordpress/testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('../deploy/sites/testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { WorkspaceDeployButton } = await import('./WorkspaceDeployButton');

/**
 * Deploy in the Workspace header of a WordPress project: what it says before, during and after a
 * deploy, when it is off and why, and that it runs the same review and deploy as the WordPress tab.
 */

const done: DeployWordPressDeployResult = {
  deployId: 'd1',
  state: 'done',
  health: [{ name: 'home', status: 200, ok: true, detail: '' }],
  uploaded: 2,
  deleted: 1,
  durationMs: 900,
};

beforeEach(() => {
  useWordPressOperationStore.setState({ runs: {} });
});

function renderButton(
  bridge: Record<string, unknown> = {},
  props: Partial<{ projectId: string; projectName: string; inWorktree: boolean }> = {},
) {
  return renderWithProviders(
    <WorkspaceDeployButton
      projectId={props.projectId ?? 'p1'}
      projectName={props.projectName ?? 'Acme Shop'}
      siteId="site-1"
      inWorktree={props.inWorktree ?? false}
    />,
    {
      bridge: {
        'projects.list': [wpProject()],
        'deployWordPress.listSites': [wpSite({ label: 'Acme Live' })],
        'deployWordPress.planDeploy': wpPlan(),
        ...bridge,
      },
    },
  );
}

async function readyButton(): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', {
    name: /^Deploy to Acme Live(\. Last deploy: .+)?$/,
  })) as HTMLButtonElement;
}

async function tooltipFor(
  user: ReturnType<typeof renderButton>['user'],
  target: HTMLElement,
): Promise<HTMLElement> {
  // Radix keeps a tooltip shut on a trigger that was just clicked until the pointer leaves it.
  await user.unhover(target);
  await user.hover(target);
  return screen.findByRole('tooltip');
}

/**
 * The tooltip a keyboard user gets on the button. Once the deploy dialog has been used, hovering
 * the trigger again does not open its tooltip under jsdom, so these go through focus.
 */
async function focusTooltip(target: HTMLElement): Promise<HTMLElement> {
  act(() => target.blur());
  act(() => target.focus());
  return screen.findByRole('tooltip');
}

/** Opens the review from the header, continues and confirms; hands back the open dialog. */
async function deployFromHeader(user: ReturnType<typeof renderButton>['user']) {
  await user.click(await readyButton());
  const dialog = await screen.findByRole('dialog', { name: 'Deploy to Acme Live' });
  await user.click(await within(dialog).findByRole('button', { name: /Continue/ }));
  await user.click(within(dialog).getByRole('button', { name: /Deploy now/ }));
  return dialog;
}

describe('WorkspaceDeployButton', () => {
  it('is an icon alone and names the project and the site in its tooltip', async () => {
    const { user } = renderButton();
    const button = await readyButton();
    expect(button).toHaveTextContent(/^$/);
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(await tooltipFor(user, button)).toHaveTextContent(
      'Review and deploy Acme Shop to Acme Live',
    );
  });

  it("leaves the project's name out when it is the site's name", async () => {
    const { user } = renderButton({}, { projectName: 'Acme Live' });
    expect(await tooltipFor(user, await readyButton())).toHaveTextContent(
      /^Review and deploy to Acme Live$/,
    );
  });

  it('opens the review of every linked item for the project', async () => {
    const { user, bridge } = renderButton();
    await user.click(await readyButton());

    const dialog = await screen.findByRole('dialog', { name: 'Deploy to Acme Live' });
    expect(await within(dialog).findByText(/2 files to upload/)).toBeTruthy();
    // No items, so all of the project's themes and plugins are in the plan.
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('deploys through the review and shows the deploy running in the header', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user, bridge } = renderButton({ 'deployWordPress.deploy': () => call.promise });
    const dialog = await deployFromHeader(user);

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.deploy')).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'plan-1', force: false }),
      ),
    );
    // The open dialog hides the rest of the window from the accessibility tree.
    const running = screen.getByRole('button', { name: 'Deploying to Acme Live', hidden: true });
    expect(running).toHaveTextContent(/^$/);
    // Nothing reported yet, so the bar is there and empty.
    expect(screen.getByTestId('deploy-progress')).toHaveAttribute('data-progress', '0');

    await act(async () => call.resolve(done));
    expect(await within(dialog).findByText('Deployed')).toBeTruthy();
    const after = await screen.findByRole('button', {
      name: 'Deploy to Acme Live. Last deploy: Deployed',
      hidden: true,
    });
    expect(after).toHaveTextContent(/^$/);
    expect(screen.queryByTestId('deploy-progress')).toBeNull();
  });

  it('fills a bar across the whole deploy and spells the step out in the tooltip', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user, bridge } = renderButton({ 'deployWordPress.deploy': () => call.promise });
    await deployFromHeader(user);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const operationId = bridge.$fn('deployWordPress.deploy').mock.calls[0][0].operationId;
    const event = { operationId, siteId: 'site-1', projectId: 'p1', kind: 'deploy' as const };
    act(() => {
      bridge.$emit('deployWordPress.onProgress', {
        ...event,
        phase: 'connecting',
        done: 0,
        total: 0,
      });
      bridge.$emit('deployWordPress.onProgress', { ...event, phase: 'upload', done: 2, total: 5 });
    });

    const running = screen.getByRole('button', { name: 'Deploying to Acme Live' });
    // Upload is the third of seven steps, two fifths through: (2 + 0.4) / 7.
    expect(screen.getByTestId('deploy-progress')).toHaveAttribute('data-progress', '34');
    // No count on the button, so its size holds while the numbers change.
    expect(running).toHaveTextContent(/^$/);
    expect(await focusTooltip(running)).toHaveTextContent(
      'Deploying to Acme Live: Uploading the changes (2 of 5). Click to see progress',
    );

    // A rollback is off the plan: the bar stays where the deploy got to.
    act(() => {
      bridge.$emit('deployWordPress.onProgress', { ...event, phase: 'verify', done: 0, total: 0 });
      bridge.$emit('deployWordPress.onProgress', {
        ...event,
        phase: 'rollback',
        done: 1,
        total: 3,
      });
    });
    expect(screen.getByTestId('deploy-progress')).toHaveAttribute('data-progress', '71');

    await act(async () => call.resolve(done));
  });

  it('keeps a hidden deploy going and opens back on it without planning again', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user, bridge } = renderButton({ 'deployWordPress.deploy': () => call.promise });
    await deployFromHeader(user);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Deploying to Acme Live' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deploy to Acme Live' });
    expect(within(dialog).getByRole('button', { name: 'Cancel deploy' })).toBeTruthy();
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve(done));
    expect(await within(dialog).findByText('Deployed')).toBeTruthy();
  });

  it('marks a deploy that finished out of sight until its result has been seen', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user } = renderButton({ 'deployWordPress.deploy': () => call.promise });
    await deployFromHeader(user);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => call.resolve(done));

    const button = await readyButton();
    const dot = await screen.findByTestId('deploy-result-dot');
    expect(dot).toHaveClass('bg-success');
    expect(button).toHaveAccessibleName('Deploy to Acme Live. Last deploy: Deployed');
    expect(await focusTooltip(button)).toHaveTextContent(
      'The deploy finished. Click to see the result',
    );

    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Deploy to Acme Live' });
    expect(within(dialog).getByText('Deployed')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.queryByTestId('deploy-result-dot')).toBeNull());
  });

  it('marks a rolled back deploy as a warning, with the reason in the tooltip', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user } = renderButton({ 'deployWordPress.deploy': () => call.promise });
    await deployFromHeader(user);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => call.resolve({ ...done, state: 'rolledBack' }));

    expect(await screen.findByTestId('deploy-result-dot')).toHaveClass('bg-warning');
    expect(await focusTooltip(await readyButton())).toHaveTextContent(/^Rolled back\. /);
  });

  it('marks a failed deploy and says to look at why', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user } = renderButton({ 'deployWordPress.deploy': () => call.promise });
    await deployFromHeader(user);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => call.reject(new Error('The site went away')));

    const dot = await screen.findByTestId('deploy-result-dot');
    expect(dot).toHaveClass('bg-destructive');
    expect(await readyButton()).toHaveAccessibleName(
      'Deploy to Acme Live. Last deploy: Deploy failed',
    );
    expect(await focusTooltip(await readyButton())).toHaveTextContent(
      'The deploy failed. Click to see why',
    );
  });

  it('is off for a read-only key and says why', async () => {
    const { user } = renderButton({
      'deployWordPress.listSites': [wpSite({ label: 'Acme Live', scope: 'read' })],
    });
    await waitFor(async () => expect(await readyButton()).toBeDisabled());
    const button = await readyButton();
    expect(await tooltipFor(user, button.parentElement as HTMLElement)).toHaveTextContent(
      READ_ONLY_HINT,
    );
    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("is off once the site is no longer connected and points to where it's fixed", async () => {
    const { user } = renderButton({ 'deployWordPress.listSites': [] });
    const name = 'Deploy to its site';
    await waitFor(() => expect(screen.getByRole('button', { name })).toBeDisabled());
    const button = screen.getByRole('button', { name });
    expect(await tooltipFor(user, button.parentElement as HTMLElement)).toHaveTextContent(
      "Acme Shop's site isn't connected any more. Connect it again from the project's WordPress tab.",
    );
  });

  it('says a worktree deploys the main folder, and deploys the linked project', async () => {
    const { user, bridge } = renderButton({}, { inWorktree: true });
    const button = await readyButton();
    expect(await tooltipFor(user, button)).toHaveTextContent(
      "Review and deploy Acme Shop to Acme Live, from the project's main folder, not this worktree",
    );

    await user.click(button);
    await screen.findByRole('dialog', { name: 'Deploy to Acme Live' });
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('shows a deploy of the project started somewhere else', async () => {
    const { bridge } = renderButton();
    await readyButton();
    act(() => {
      bridge.$emit('deployWordPress.onProgress', {
        operationId: 'elsewhere',
        siteId: 'site-1',
        projectId: 'p1',
        kind: 'deploy',
        phase: 'upload',
        done: 1,
        total: 4,
      });
    });
    expect(await screen.findByRole('button', { name: 'Deploying to Acme Live' })).toBeEnabled();
    expect(screen.getByTestId('deploy-progress')).toHaveAttribute('data-progress', '32');
  });
});
