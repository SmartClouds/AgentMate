import type { DeployWordPressDeployResult } from '@shared/deployWordPressTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import {
  change,
  deferred,
  wpPlan,
  wpProject,
  wpSite,
} from '../projects/wordpress/testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('../deploy/sites/testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { DeployFlowDialog } = await import('./DeployFlowDialog');

/**
 * Deploying a WordPress project from the outside: what the review shows, what blocks the deploy,
 * what the call is sent with, and how the outcome reads.
 */

const done: DeployWordPressDeployResult = {
  deployId: 'd1',
  state: 'done',
  health: [{ name: 'home', status: 200, ok: true, detail: '' }],
  uploaded: 2,
  deleted: 1,
  durationMs: 900,
};

function renderDialog(bridge: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <DeployFlowDialog open onOpenChange={onOpenChange} projectId="p1" siteId="site-1" />,
    {
      bridge: {
        'projects.list': [wpProject()],
        'deployWordPress.listSites': [wpSite()],
        'deployWordPress.planDeploy': wpPlan(),
        ...bridge,
      },
    },
  );
  return { ...view, onOpenChange };
}

async function continueButton(): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', { name: /Continue/ })) as HTMLButtonElement;
}

describe('DeployFlowDialog review', () => {
  it('lists the changes by item with their sizes, and shows a diff for a clicked file', async () => {
    const { user, bridge } = renderDialog({
      'deployWordPress.remoteFile': {
        text: 'old css',
        binary: false,
        tooLarge: false,
        sha256: 'a',
      },
      'fs.readFile': async () => 'new css',
    });

    expect(await screen.findByText('style.css')).toBeTruthy();
    expect(screen.getByText('inc/new.php')).toBeTruthy();
    expect(screen.getByText('old.php')).toBeTruthy();
    expect(screen.getByText('2.00 KB')).toBeTruthy();
    expect(screen.getByText(/2 files to upload \(2.50 KB\), 1 to delete/)).toBeTruthy();
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledWith({ projectId: 'p1' });

    await user.click(screen.getByRole('button', { name: /^Modified\s*style\.css/ }));
    expect(await screen.findByTestId('snippet-diff')).toHaveTextContent('old css => new css');
    expect(bridge.$fn('deployWordPress.remoteFile')).toHaveBeenCalledWith({
      projectId: 'p1',
      item: { kind: 'theme', slug: 'storefront' },
      path: 'style.css',
    });
    expect(bridge.$fn('fs.readFile')).toHaveBeenCalledWith(
      'C:\\code\\acme-shop\\wp-content\\themes\\storefront\\style.css',
    );
  });

  it('blocks on conflicts until the site version is overwritten, then deploys with force', async () => {
    const conflict = change({
      path: 'functions.php',
      local: 'modified',
      remote: 'modified',
      action: 'conflict',
    });
    const { user, bridge } = renderDialog({
      'deployWordPress.planDeploy': wpPlan({
        changes: [...wpPlan().changes, conflict],
        conflicts: [conflict],
      }),
      'deployWordPress.deploy': done,
    });

    const conflicts = await screen.findByRole('region', { name: 'Conflicts' });
    expect(within(conflicts).getByText('functions.php')).toBeTruthy();
    expect(within(conflicts).getByText('Changed here and on the site.')).toBeTruthy();
    expect((await continueButton()).disabled).toBe(true);

    await user.click(within(conflicts).getByRole('checkbox'));
    expect((await continueButton()).disabled).toBe(false);
    await user.click(await continueButton());
    await user.click(screen.getByRole('button', { name: /Deploy now/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.deploy')).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'plan-1', force: true }),
      ),
    );
    const operationId = bridge.$fn('deployWordPress.deploy').mock.calls[0][0].operationId;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Deployed')).toBeTruthy();
  });

  it('deploys without force when nothing needs it', async () => {
    const { user, bridge } = renderDialog({ 'deployWordPress.deploy': done });

    await user.click(await continueButton());
    expect(screen.getByText(/stay on this computer/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Deploy now/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.deploy')).toHaveBeenCalledWith(
        expect.objectContaining({ force: false }),
      ),
    );
    expect(await screen.findByText(/2 files uploaded, 1 file deleted/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Health checks' })).toHaveTextContent('HTTP 200');
  });

  it('asks before deploying over the active theme, then sends force', async () => {
    const { user, bridge } = renderDialog({
      'deployWordPress.planDeploy': wpPlan({ warnings: ['touchesActiveThemeCore', 'createsItem'] }),
      'deployWordPress.deploy': done,
    });

    expect(await screen.findByText("Changes the active theme's core files")).toBeTruthy();
    expect(screen.getByText('Adds a new theme or plugin folder to the site')).toBeTruthy();
    expect((await continueButton()).disabled).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /Deploy these anyway/ }));
    await user.click(await continueButton());
    await user.click(screen.getByRole('button', { name: /Deploy now/ }));
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.deploy')).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      ),
    );
  });

  it('keeps a read-only site from being deployed to, and says why', async () => {
    renderDialog({
      'deployWordPress.listSites': [wpSite({ scope: 'read' })],
      'deployWordPress.planDeploy': wpPlan({ warnings: ['readOnlyScope'] }),
    });

    expect(await screen.findByText("This site's key is read-only")).toBeTruthy();
    expect((await continueButton()).disabled).toBe(true);
  });

  it('shows the plan error with a way to try again', async () => {
    let calls = 0;
    const { user } = renderDialog({
      'deployWordPress.planDeploy': async () => {
        calls += 1;
        if (calls === 1) throw new Error('[wp:vaultLocked] The Servers vault is locked.');
        return wpPlan();
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Servers vault is locked.');
    expect(screen.getByText(/Unlock the Servers vault/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('style.css')).toBeTruthy();
  });
});

describe('DeployFlowDialog outcome', () => {
  async function deployWith(result: unknown) {
    const view = renderDialog({ 'deployWordPress.deploy': result });
    await view.user.click(await continueButton());
    await view.user.click(screen.getByRole('button', { name: /Deploy now/ }));
    return view;
  }

  it('says in words why a deploy was rolled back', async () => {
    await deployWith({ ...done, state: 'rolledBack', reason: 'healthCheck' });
    expect(await screen.findByText('Rolled back')).toBeTruthy();
    expect(
      screen.getByText(
        'The site showed an error after the change, so the old files were put back.',
      ),
    ).toBeTruthy();
  });

  it('names the file and line of each syntax error', async () => {
    await deployWith(async () => {
      throw new Error(
        "Error invoking remote method 'deployWordPress:deploy': Error: [wp:syntaxError] 1 PHP file has a syntax error.\nwp-content/themes/storefront/functions.php:12: syntax error, unexpected '}'",
      );
    });

    const errors = await screen.findByRole('list', { name: 'Syntax errors' });
    expect(within(errors).getByText('wp-content/themes/storefront/functions.php')).toBeTruthy();
    expect(within(errors).getByText(', line 12')).toBeTruthy();
    expect(within(errors).getByText("syntax error, unexpected '}'")).toBeTruthy();
    expect(screen.getByText('1 PHP file has a syntax error.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check again/ })).toBeTruthy();
  });

  it('cancels a running deploy through the main process', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const { user, bridge } = await deployWith(() => call.promise);

    await user.click(await screen.findByRole('button', { name: 'Cancel deploy' }));
    const operationId = bridge.$fn('deployWordPress.deploy').mock.calls[0][0].operationId;
    expect(bridge.$fn('deployWordPress.cancel')).toHaveBeenCalledWith(operationId);
    expect(await screen.findByRole('button', { name: 'Cancelling' })).toBeTruthy();

    await act(async () => call.resolve({ ...done, state: 'rolledBack', reason: 'requested' }));
    expect(
      await screen.findByText('The deploy was stopped, so the old files were put back.'),
    ).toBeTruthy();
  });

  it('picks a running deploy up again after the dialog is gone and back', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    let setMounted: (value: boolean) => void = () => undefined;
    function Harness(): React.JSX.Element | null {
      const [mounted, set] = useState(true);
      setMounted = set;
      return mounted ? (
        <DeployFlowDialog open onOpenChange={() => undefined} projectId="p1" siteId="site-1" />
      ) : null;
    }
    const { user, bridge } = renderWithProviders(<Harness />, {
      bridge: {
        'projects.list': [wpProject()],
        'deployWordPress.listSites': [wpSite()],
        'deployWordPress.planDeploy': wpPlan(),
        'deployWordPress.deploy': () => call.promise,
      },
    });
    await user.click(await continueButton());
    await user.click(screen.getByRole('button', { name: /Deploy now/ }));
    const operationId = bridge.$fn('deployWordPress.deploy').mock.calls[0][0].operationId;
    const event = { operationId, siteId: 'site-1', projectId: 'p1', kind: 'deploy' as const };
    act(() => {
      bridge.$emit('deployWordPress.onProgress', {
        ...event,
        phase: 'connecting',
        done: 0,
        total: 0,
      });
      bridge.$emit('deployWordPress.onProgress', { ...event, phase: 'upload', done: 1, total: 3 });
    });

    act(() => setMounted(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      bridge.$emit('deployWordPress.onProgress', { ...event, phase: 'upload', done: 2, total: 3 });
    });
    act(() => setMounted(true));

    const progress = await screen.findByRole('list', { name: 'Progress' });
    expect(within(progress).getByLabelText('Uploading the changes: in progress')).toHaveTextContent(
      '2 of 3',
    );
    expect(within(progress).getByLabelText('Reaching the site: done')).toBeTruthy();
    // Picking the run up again does not plan a second deploy.
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve(done));
    expect(await screen.findByText('Deployed')).toBeTruthy();
  });
});

describe('DeployFlowDialog ignoring files', () => {
  const NEW_PHP = change({ path: 'inc/new.php', local: 'added', expectedRemote: null, size: 512 });
  const STYLE = change({ path: 'style.css' });
  const OLD = change({ path: 'old.php', local: 'deleted', action: 'deleteRemote', size: 0 });
  const FULL = wpPlan({ changes: [STYLE, NEW_PHP, OLD] });
  const WITHOUT_INC = wpPlan({ changes: [STYLE, OLD], uploadBytes: 2048 });

  type Calls = { $fn: (path: string) => { mock: { calls: unknown[][] } } };
  /** What setProjectIgnore was called with; the bridge refuses to name a call nobody made. */
  const saved = (bridge: Calls): unknown[] => {
    try {
      return bridge.$fn('deployWordPress.setProjectIgnore').mock.calls.map((call) => call[0]);
    } catch {
      return [];
    }
  };
  const planCalls = (bridge: Calls) => bridge.$fn('deployWordPress.planDeploy').mock.calls.length;

  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
    toast.info.mockClear();
  });

  /** A project whose saved list is kept in the test, as the main process would keep it. */
  function renderIgnoring(
    options: {
      plans?: unknown[];
      ignore?: Record<string, string[]>;
      save?: (input: { ignore: Record<string, string[]> }) => Promise<unknown>;
    } = {},
  ) {
    let current = wpProject();
    const withList = (ignore?: Record<string, string[]>) => {
      const { ignore: _old, ...rest } = current.wordpress as unknown as Record<string, unknown>;
      current = {
        ...current,
        wordpress: { ...rest, ...(ignore && Object.keys(ignore).length ? { ignore } : {}) },
      } as typeof current;
      return current;
    };
    withList(options.ignore);
    const plans = [...(options.plans ?? [FULL])];
    return renderDialog({
      'projects.list': async () => [current],
      'deployWordPress.planDeploy': vi.fn(async () =>
        plans.length > 1 ? (plans.shift() as unknown) : plans[0],
      ),
      'deployWordPress.setProjectIgnore':
        options.save ??
        (async (input: { ignore: Record<string, string[]> }) => withList(input.ignore)),
    });
  }

  it('ignores a folder from a file menu, saves it, and shows the list without it', async () => {
    const { user, bridge } = renderIgnoring({ plans: [FULL, WITHOUT_INC] });
    await user.click(await screen.findByRole('button', { name: 'Ignore options for inc/new.php' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ignore the folder inc/' }));

    await waitFor(() =>
      expect(saved(bridge)).toEqual([
        { projectId: 'p1', ignore: { 'theme:storefront': ['/inc/'] } },
      ]),
    );
    await waitFor(() => expect(screen.queryByText('inc/new.php')).toBeNull());
    expect(planCalls(bridge)).toBe(2);
    expect(screen.getByText('style.css')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith(
      'Ignored inc/ in storefront.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
    // What is saved shows up under the review, ready to be taken back.
    expect(
      await screen.findByRole('button', { name: 'Stop ignoring inc/ in storefront' }),
    ).toBeTruthy();
  });

  it('ignores a series of ticked files in one go, and the bar goes away', async () => {
    const { user, bridge } = renderIgnoring({ plans: [FULL, wpPlan({ changes: [NEW_PHP] })] });
    await user.click(await screen.findByRole('checkbox', { name: 'Select style.css' }));
    expect(screen.getByText('1 file selected')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Select old.php' }));
    expect(screen.getByText('2 files selected')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Ignore selected files' }));
    await waitFor(() =>
      expect(saved(bridge)).toEqual([
        { projectId: 'p1', ignore: { 'theme:storefront': ['/style.css', '/old.php'] } },
      ]),
    );
    await waitFor(() => expect(screen.queryByText('2 files selected')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Ignored 2 files in storefront.', expect.anything());
    // The rows are gone from the changes; the saved lines show under the review instead.
    expect(screen.queryByRole('checkbox', { name: 'Select style.css' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select old.php' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select inc/new.php' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Stop ignoring style.css in storefront' }),
    ).toBeTruthy();
  });

  it('keeps the list on screen while it is worked out again, and holds Continue', async () => {
    const second = deferred<unknown>();
    let calls = 0;
    const { user, bridge } = renderDialog({
      'projects.list': [wpProject()],
      'deployWordPress.planDeploy': async () => {
        calls += 1;
        return calls === 1 ? FULL : second.promise;
      },
      'deployWordPress.setProjectIgnore': async (input: { ignore: Record<string, string[]> }) => ({
        ...wpProject(),
        wordpress: { ...wpProject().wordpress, ignore: input.ignore },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Ignore options for old.php' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ignore this file' }));
    await waitFor(() => expect(calls).toBe(2));

    // The old rows are still there, but nothing can be changed or continued until the new ones.
    expect(screen.getByRole('checkbox', { name: 'Select old.php' })).toBeTruthy();
    expect((await continueButton()).disabled).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Select style.css' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(saved(bridge)).toHaveLength(1);

    await act(async () => second.resolve(WITHOUT_INC));
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Select inc/new.php' })).toBeNull(),
    );
    expect((await continueButton()).disabled).toBe(false);
  });

  it('puts the list back from the toast, and checks the changes again', async () => {
    const { user, bridge } = renderIgnoring({ plans: [FULL, WITHOUT_INC, FULL] });
    await user.click(await screen.findByRole('button', { name: 'Ignore options for inc/new.php' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ignore this file' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Select inc/new.php' })).toBeNull(),
    );

    const options = toast.success.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } };
    await act(async () => options.action.onClick());
    await waitFor(() => expect(saved(bridge).at(-1)).toEqual({ projectId: 'p1', ignore: {} }));
    expect(await screen.findByRole('checkbox', { name: 'Select inc/new.php' })).toBeTruthy();
    expect(planCalls(bridge)).toBe(3);
  });

  it('lists what is ignored and stops ignoring from the review', async () => {
    const { user, bridge } = renderIgnoring({
      ignore: { 'theme:storefront': ['/vendor/'] },
      plans: [FULL, FULL],
    });
    expect(await screen.findByText('Ignored for this project')).toBeTruthy();
    await user.click(
      await screen.findByRole('button', { name: 'Stop ignoring vendor/ in storefront' }),
    );
    await waitFor(() => expect(saved(bridge)).toEqual([{ projectId: 'p1', ignore: {} }]));
    await waitFor(() => expect(planCalls(bridge)).toBe(2));
  });

  it('says so when the ticked files cannot be ignored, and saves nothing', async () => {
    const solo = change({
      item: { kind: 'plugin', slug: 'solo.php' },
      path: 'solo.php',
      local: 'modified',
    });
    const { user, bridge } = renderIgnoring({ plans: [wpPlan({ changes: [solo] })] });
    await user.click(await screen.findByRole('checkbox', { name: 'Select solo.php' }));
    await user.click(screen.getByRole('button', { name: 'Ignore selected files' }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "A single-file plugin has only its own file, so there's nothing to ignore in it.",
      ),
    );
    expect(saved(bridge)).toEqual([]);
    expect(screen.getByText('1 file selected')).toBeTruthy();
  });

  it('tells the user when saving fails, and leaves the list as it was', async () => {
    const { user, bridge } = renderIgnoring({
      save: async () => {
        throw new Error('[wp:badRequest] Line 1 of the ignore list cannot be read.');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Ignore options for old.php' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ignore this file' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Line 1 of the ignore list cannot be read.'),
    );
    expect(planCalls(bridge)).toBe(1);
    expect(screen.getByText('old.php')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'Select style.css' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
