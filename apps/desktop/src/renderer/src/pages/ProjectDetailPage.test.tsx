import type { Project } from '@runova/core';
import { AGENT_TYPE_LABELS } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The project detail page reads its project out of the route, so everything here renders it
 * under `projects/:projectId`. The page is a shell around eighteen sections, so the tests cover
 * the shell (the header, the section nav, the not-found path) plus the sections that are the
 * page's own code rather than a separate component with its own tests.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

// The confirmation modal itself lives in the app shell, outside anything this page renders, so
// there is no button for a test to press. Standing in for it is the only way to reach both
// answers.
const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/confirmStore')>();
  return { ...actual, confirmDialog: confirm.confirmDialog };
});

// Monaco's real module registers web workers through Vite's `?worker` imports, which do not
// exist outside a Vite build, and it measures layout jsdom has none of. The Config section only
// needs something that shows the text and reports edits.
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (next: string) => void }) => (
    <textarea
      aria-label="Editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  MonacoDiffEditor: () => <div />,
  languageFor: () => 'plaintext',
}));

const { default: ProjectDetailPage } = await import('./ProjectDetailPage');

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Apollo',
    folderPath: 'C:\\code\\apollo',
    description: 'The control room.',
    tags: ['web'],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    prompt: '',
    notifications: {
      completion: { enabled: false, cliId: null, message: '' },
      confirmation: { enabled: false, cliId: null, message: '' },
      pet: { enabled: false, cliId: null, message: '' },
    },
    cliId: null,
    iconDataUrl: null,
    iconFile: null,
    iconBgColor: null,
    iconColor: null,
    websiteUrl: '',
    repoUrl: '',
    githubActionsMuted: [],
    worktreeSetup: { command: '', copyGlobs: null },
    pinned: false,
    archived: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    ...overrides,
  };
}

type Overrides = Record<string, unknown>;

/** Renders the page at `/projects/p1` with one project behind the bridge. */
/**
 * The tabs that load in the background but that these tests are not about. They fail to load,
 * which leaves them in the same error state an empty answer would, without React Query logging.
 */
const notLoaded = () => Promise.reject(new Error('not loaded in this test'));
const backgroundTabs: Overrides = {
  'projects.bootstrapPlan': notLoaded,
  'blueprints.get': notLoaded,
  'blueprints.agentFileTarget': notLoaded,
  'git.status': notLoaded,
  'security.getConfig': notLoaded,
  'packages.list': notLoaded,
  'studio.projectStorage': notLoaded,
  'deployWordPress.localChanges': notLoaded,
  'deploy.listServers': [],
};

function renderPage(bridge: Overrides = {}, projects: Project[] = [project()]) {
  return renderWithProviders(<ProjectDetailPage />, {
    route: '/projects/p1',
    path: 'projects/:projectId',
    bridge: { ...backgroundTabs, 'projects.list': projects, ...bridge },
  });
}

function sectionNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Project sections' });
}

/** Clicks a section in the left-hand nav and waits for it to report itself as the current one. */
async function openSection(
  user: ReturnType<typeof renderWithProviders>['user'],
  label: RegExp,
): Promise<void> {
  await user.click(within(sectionNav()).getByRole('button', { name: label }));
  await waitFor(() =>
    expect(within(sectionNav()).getByRole('button', { name: label, current: 'page' })).toBeTruthy(),
  );
}

async function openHeaderMenu(
  user: ReturnType<typeof renderWithProviders>['user'],
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'More project actions' }));
  return screen.findByRole('menu');
}

describe('ProjectDetailPage shell', () => {
  it('shows the project named in the route, with its folder and agent', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Apollo' })).toBeTruthy();
    expect(screen.getByText('The control room.')).toBeTruthy();
    expect(screen.getByText(AGENT_TYPE_LABELS['claude-code'])).toBeTruthy();
    expect(screen.getByText('C:\\code\\apollo')).toBeTruthy();
    expect(screen.getByText('web')).toBeTruthy();
  });

  it('says so instead of crashing when the id in the route matches nothing', async () => {
    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/ghost',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [project()] },
    });

    expect(await screen.findByText('Project not found')).toBeTruthy();
    expect(screen.getByText('It may have been removed, or this link is out of date.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Back to Projects/ }).length).toBeGreaterThan(0);
    // The header, and everything that reads off a project, must stay off the screen.
    expect(screen.queryByRole('button', { name: 'More project actions' })).toBeNull();
  });

  it('survives the project list failing to load, with the same not-found state', async () => {
    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1',
      path: 'projects/:projectId',
      bridge: {
        ...backgroundTabs,
        'projects.list': async () => {
          throw new Error('database locked');
        },
      },
    });

    expect(await screen.findByText('Project not found')).toBeTruthy();
  });

  it('offers Run only once the project has a command to run', async () => {
    const { unmount } = renderPage();
    expect(await screen.findByRole('heading', { name: 'Apollo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull();
    unmount();

    renderPage({}, [
      project({ runCommands: [{ id: 'r1', label: 'dev', command: 'npm run dev' }] }),
    ]);
    expect(await screen.findByRole('button', { name: /^Run/ })).toBeTruthy();
  });

  it('names a command with placeholders by its readable form in the Terminal section', async () => {
    const { user } = renderPage({}, [
      project({
        runCommands: [{ id: 'r1', label: 'serve', command: 'npm run dev -- --port {{port=3000}}' }],
      }),
    ]);
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^Terminal/);

    expect(
      await screen.findByRole('button', { name: 'Run npm run dev -- --port <port>' }),
    ).toBeTruthy();
  });

  it('copies the folder path to the clipboard', async () => {
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    await user.click(screen.getByRole('button', { name: /C:\\code\\apollo/ }));

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('C:\\code\\apollo'),
    );
    expect(toast.success).toHaveBeenCalledWith('Path copied to clipboard.');
  });

  it('asks the shell to open the project folder, and reports a refusal', async () => {
    const { user, bridge } = renderPage({
      'shell.openPath': async () => {
        throw new Error('no such directory');
      },
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await user.click(screen.getByRole('button', { name: 'Open in File Explorer' }));

    expect(bridge.$fn('shell.openPath')).toHaveBeenCalledWith('C:\\code\\apollo');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('no such directory'));
  });
});

describe('ProjectDetailPage sections', () => {
  it('starts on Overview and shows its empty prompt and notes', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    expect(
      within(sectionNav()).getByRole('button', { name: /^Overview/, current: 'page' }),
    ).toBeTruthy();
    expect(screen.getByText('Standing prompt')).toBeTruthy();
    expect(screen.getByText('No standing prompt')).toBeTruthy();
    expect(screen.getByText('No notes yet')).toBeTruthy();
  });

  it('shows each section it is switched to', async () => {
    const { user } = renderPage({
      'skills.listInstalled': [],
      'mcp.listInstalled': [],
      // A scalar answer is read back as a value, so a string one has to arrive as a function.
      'fs.readFile': async () => '{ "runCommand": "npm run dev" }',
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^Skills/);
    expect(await screen.findByText('No skills installed')).toBeTruthy();

    await openSection(user, /^MCP/);
    expect(await screen.findByText('No MCP servers installed')).toBeTruthy();

    await openSection(user, /^Terminal/);
    expect(await screen.findByText('Project terminal')).toBeTruthy();
    expect(screen.getByText(/Opens in this folder/)).toBeTruthy();
    // Nothing is configured to run, so the section offers to set one up instead.
    expect(screen.getByRole('button', { name: 'Set a run command' })).toBeTruthy();

    await openSection(user, /^Config/);
    expect(await screen.findByText('.runova/config.json')).toBeTruthy();

    await openSection(user, /^Prompts/);
    // Leaving a section really unmounts it, rather than stacking the sections up.
    expect(screen.queryByText('Project terminal')).toBeNull();
    expect(screen.queryByText('No skills installed')).toBeNull();
  });

  it('lets the agent in this project suggest run commands once the switch is turned on', async () => {
    const { user, bridge } = renderPage({
      'mcp.listInstalled': [],
      'runProposals.getEnabled': false,
      'runProposals.setEnabled': { ok: true },
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^MCP/);
    const toggle = await screen.findByRole('switch', { name: 'Let agents suggest run commands' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    expect(bridge.$fn('runProposals.setEnabled')).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('sends an old Schedule link to the Scheduled tab of Prompts', async () => {
    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=schedule',
      path: 'projects/:projectId',
      bridge: {
        ...backgroundTabs,
        'projects.list': [project()],
        'scheduledTasks.listByProject': [],
      },
    });

    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
    expect(
      within(sectionNav()).getByRole('button', { name: /^Prompts/, current: 'page' }),
    ).toBeTruthy();
    const promptViews = screen.getByRole('navigation', { name: 'Prompt views' });
    expect(
      within(promptViews).getByRole('button', { name: /^Scheduled/, current: true }),
    ).toBeTruthy();
  });

  it('opens the Usage section from its link and reads the usage of that project', async () => {
    const { bridge } = renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=usage',
      path: 'projects/:projectId',
      bridge: {
        ...backgroundTabs,
        'projects.list': [project()],
        'agents.projectUsage': { status: 'unavailable' },
      },
    });

    expect(await screen.findByRole('heading', { name: 'Usage and cost' })).toBeTruthy();
    expect(
      within(sectionNav()).getByRole('button', { name: /^Usage/, current: 'page' }),
    ).toBeTruthy();
    expect(bridge.$fn('agents.projectUsage')).toHaveBeenCalledWith('p1', null);
  });

  it('mounts every section in the nav without falling over', async () => {
    // The page is mostly a router between nineteen sections, so the thing worth proving is that
    // each one can be reached and rendered with nothing but a project behind the bridge.
    const { user } = renderPage({
      'tools.detectAll': [{ id: 'diffray', installed: true }],
      'agents.projectUsage': { status: 'unavailable' },
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    const labels = within(sectionNav())
      .getAllByRole('button')
      .map((button) => button.textContent?.trim() ?? '');
    expect(labels.length).toBe(19);

    for (const label of labels) {
      const button = within(sectionNav()).getByRole('button', { name: label });
      await user.click(button);
      await waitFor(() =>
        expect(
          within(sectionNav()).getByRole('button', { name: label, current: 'page' }),
        ).toBeTruthy(),
      );
      // The header belongs to the page, not to a section, so it proves the page is still up.
      expect(screen.getByRole('heading', { name: 'Apollo' })).toBeTruthy();
    }
  });

  it('opens the section named in the query string, and ignores one it does not know', async () => {
    const { unmount } = renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=git',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [project()] },
    });

    expect(await screen.findByText("This folder isn't a git repository yet")).toBeTruthy();
    expect(
      within(sectionNav()).getByRole('button', { name: /^Git/, current: 'page' }),
    ).toBeTruthy();
    unmount();

    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=nonsense',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [project()] },
    });
    await screen.findByRole('heading', { name: 'Apollo' });
    expect(
      within(sectionNav()).getByRole('button', { name: /^Overview/, current: 'page' }),
    ).toBeTruthy();
  });

  it('hides the Review section until diffray is installed', async () => {
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });
    expect(within(sectionNav()).queryByRole('button', { name: /^Review/ })).toBeNull();
    unmount();

    renderPage({ 'tools.detectAll': [{ id: 'diffray', installed: true }] });
    await screen.findByRole('heading', { name: 'Apollo' });
    await waitFor(() =>
      expect(within(sectionNav()).getByRole('button', { name: /^Review/ })).toBeTruthy(),
    );
  });

  it('previews the files bootstrapping would write', async () => {
    const { user } = renderPage({
      'projects.bootstrapPlan': {
        agentLabel: 'Claude Code',
        docsUrl: 'https://example.test/docs',
        files: [{ relativePath: 'CLAUDE.md' }, { relativePath: '.claude/settings.json' }],
        folders: ['.claude'],
      },
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^Bootstrap/);

    expect(await screen.findByText('CLAUDE.md')).toBeTruthy();
    expect(screen.getByText('.claude/settings.json')).toBeTruthy();
    expect(screen.getByText('.claude/')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bootstrap Project/ })).toBeTruthy();
  });

  it('explains a plan that could not be loaded rather than showing an empty box', async () => {
    const { user } = renderPage({
      'projects.bootstrapPlan': async () => {
        throw new Error('agent template missing');
      },
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^Bootstrap/);

    expect(await screen.findByText(/Could not load the plan: agent template missing/)).toBeTruthy();
  });

  it('lists the installed skills and removes one after the confirmation', async () => {
    const { user, bridge } = renderPage({
      'skills.listInstalled': [{ skillId: 'acme/linter', version: '1.2.0' }],
      'skills.checkForUpdates': [],
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^Skills/);
    expect(await screen.findByText('acme/linter')).toBeTruthy();
    expect(screen.getByText('v1.2.0')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove acme/linter' }));

    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Remove "acme/linter"?', variant: 'destructive' }),
      ),
    );
    await waitFor(() =>
      expect(bridge.$fn('skills.remove')).toHaveBeenCalledWith({
        projectId: 'p1',
        skillId: 'acme/linter',
      }),
    );
  });
});

describe('ProjectDetailPage notes', () => {
  it('saves what was typed in the notes box', async () => {
    const { user, bridge } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    await user.click(screen.getByRole('button', { name: /Add notes/ }));
    await user.type(screen.getByRole('textbox'), 'Deploy on Fridays, never.');
    await user.click(screen.getByRole('button', { name: 'Save notes' }));

    expect(bridge.$fn('projects.update')).toHaveBeenCalledWith('p1', {
      notes: 'Deploy on Fridays, never.',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Notes saved.'));
  });

  it('keeps the draft on screen and says why when saving the notes fails', async () => {
    const { user } = renderPage({
      'projects.update': async () => {
        throw new Error('disk is read only');
      },
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    await user.click(screen.getByRole('button', { name: /Add notes/ }));
    await user.type(screen.getByRole('textbox'), 'Something worth keeping.');
    await user.click(screen.getByRole('button', { name: 'Save notes' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk is read only'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Something worth keeping.',
    );
  });
});

describe('ProjectDetailPage header menu', () => {
  it('removes the project once the confirmation is accepted', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(true);
    const { user, bridge } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Remove project/ }));

    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Remove "Apollo"?', variant: 'destructive' }),
      ),
    );
    await waitFor(() => expect(bridge.$fn('projects.delete')).toHaveBeenCalledWith('p1'));
    expect(toast.success).toHaveBeenCalledWith('Project removed.');
  });

  it('keeps the project when the confirmation is declined', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user, bridge } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Remove project/ }));

    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(() => bridge.$fn('projects.delete')).toThrow();
    expect(await screen.findByRole('heading', { name: 'Apollo' })).toBeTruthy();
  });

  it('archives the project and marks it as archived in the header', async () => {
    const { user, bridge } = renderPage({
      'projects.setArchived': async () => project({ archived: true }),
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Archive project/ }));

    expect(bridge.$fn('projects.setArchived')).toHaveBeenCalledWith('p1', true);
    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith(
      'Archived. It now lives behind the Archived toggle on the Projects page.',
    );
  });

  it('opens the standing prompt dialog from the header', async () => {
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    await user.click(screen.getByRole('button', { name: 'Prompt' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Project prompt')).toBeTruthy();
  });

  it('opens the edit dialog filled in with the project', async () => {
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });

    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Edit project/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit project')).toBeTruthy();
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Apollo');
    expect((within(dialog).getByLabelText(/^Folder/) as HTMLInputElement).value).toBe(
      'C:\\code\\apollo',
    );
  });
});

describe('ProjectDetailPage edit run commands link', () => {
  const withRun = project({ runCommands: [{ id: 'dev', label: 'Dev', command: 'pnpm dev' }] });

  function renderAt(route: string) {
    return renderWithProviders(<ProjectDetailPage />, {
      route,
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [withRun] },
    });
  }

  it('opens Edit project on the Agent tab when the route asks for ?edit=run', async () => {
    renderAt('/projects/p1?edit=run');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit project')).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: /Agent/, selected: true })).toBeTruthy();
    expect((within(dialog).getByLabelText('Command 1') as HTMLInputElement).value).toBe('pnpm dev');
  });

  it('keeps the section from the route alongside the edit link', async () => {
    renderAt('/projects/p1?tab=terminal&edit=run');

    await screen.findByRole('dialog');
    // The open dialog hides the page behind it from the accessibility tree.
    const nav = screen.getByRole('navigation', { name: 'Project sections', hidden: true });
    expect(
      within(nav).getByRole('button', { name: /Terminal/, current: 'page', hidden: true }),
    ).toBeTruthy();
  });

  it('goes back to opening on Basics after the run commands dialog is closed', async () => {
    const { user } = renderAt('/projects/p1?edit=run');
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Edit project/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /Basics/, selected: true })).toBeTruthy();
  });

  it('does not open the edit dialog without the link', async () => {
    renderAt('/projects/p1');

    await screen.findByRole('heading', { name: 'Apollo' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ProjectDetailPage create a run command with AI', () => {
  const withRun = project({ runCommands: [{ id: 'dev', label: 'Dev', command: 'pnpm dev' }] });
  const bridge = { 'cli.detectAll': [{ id: 'claude-code', installed: true }] };

  function renderAt(route: string, projects: Project[] = [project()]) {
    return renderWithProviders(<ProjectDetailPage />, {
      route,
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, ...bridge, 'projects.list': projects },
    });
  }

  it('offers it next to Set a run command when the project has none', async () => {
    const { user } = renderAt('/projects/p1?tab=terminal');
    await screen.findByText('Project terminal');
    expect(screen.getByRole('button', { name: 'Set a run command' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create with AI' }));

    expect(
      await screen.findByRole('dialog', { name: 'Create a run command with AI' }),
    ).toBeTruthy();
  });

  it('does not push it on a project that already has a run command', async () => {
    renderAt('/projects/p1?tab=terminal', [withRun]);
    await screen.findByText('Project terminal');

    expect(screen.queryByRole('button', { name: 'Create with AI' })).toBeNull();
  });

  it('opens on the AI dialog when the route asks for ?createRun=ai', async () => {
    renderAt('/projects/p1?createRun=ai');

    const dialog = await screen.findByRole('dialog', { name: 'Create a run command with AI' });
    expect(within(dialog).getByText(/Say what you want to run in Apollo/)).toBeTruthy();
  });

  it('does not open it again once it has been closed', async () => {
    const { user } = renderAt('/projects/p1?createRun=ai');
    await screen.findByRole('dialog', { name: 'Create a run command with AI' });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'More project actions' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts it in the project menu while there is no run command', async () => {
    const { user } = renderAt('/projects/p1');
    const menu = await openHeaderMenu(user);

    await user.click(within(menu).getByRole('menuitem', { name: /Create run command with AI/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Create a run command with AI' }),
    ).toBeTruthy();
  });

  it('leaves it out of the project menu once there is a run command', async () => {
    const { user } = renderAt('/projects/p1', [withRun]);
    const menu = await openHeaderMenu(user);

    expect(within(menu).queryByRole('menuitem', { name: /Create run command with AI/ })).toBeNull();
  });

  it('swaps the edit form for the AI dialog when Create with AI is pressed in the form', async () => {
    const { user } = renderAt('/projects/p1?edit=run');
    const form = await screen.findByRole('dialog', { name: 'Edit project' });

    await user.click(within(form).getByRole('button', { name: 'Create with AI' }));

    expect(
      await screen.findByRole('dialog', { name: 'Create a run command with AI' }),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull());
  });

  it("opens the run commands editor from the dialog's write-it-myself button", async () => {
    const { user } = renderAt('/projects/p1?createRun=ai');
    const dialog = await screen.findByRole('dialog', { name: 'Create a run command with AI' });

    await user.click(within(dialog).getByRole('button', { name: "I'll write it myself" }));

    const form = await screen.findByRole('dialog', { name: 'Edit project' });
    expect(within(form).getByRole('tab', { name: /Agent/, selected: true })).toBeTruthy();
  });

  it('asks the agent for the project, not for something else', async () => {
    const { user, bridge: fns } = renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?createRun=ai',
      path: 'projects/:projectId',
      bridge: {
        ...backgroundTabs,
        ...bridge,
        'projects.list': [project()],
        'runProposals.startGuided': { ok: false, error: 'No.' },
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Create a run command with AI' });

    await user.click(within(dialog).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(fns.$fn('runProposals.startGuided')).toHaveBeenCalledWith('p1'));
  });
});

describe('ProjectDetailPage WordPress section', () => {
  const linked = project({
    wordpress: {
      siteId: 'site-1',
      items: [{ kind: 'theme', slug: 'storefront' }],
      linkedAt: '2026-10-01T00:00:00.000Z',
    },
  });
  const site = {
    id: 'site-1',
    label: 'Acme Shop',
    siteUrl: 'https://shop.example.com',
    siteName: 'Acme Shop',
    scope: 'write',
    transport: 'https',
    allowPlainHttp: false,
    hasHttpAuth: false,
    pluginVersion: '1.0.0',
    protocol: 1,
    connectedAt: 1,
    lastSeenAt: null,
  };

  it('hides the WordPress section for a project with no site', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Apollo' });
    expect(within(sectionNav()).queryByRole('button', { name: /^WordPress/ })).toBeNull();
  });

  it('shows the WordPress section for a project linked to a site', async () => {
    const { user } = renderPage(
      {
        'deployWordPress.listSites': [site],
        'deployWordPress.listItems': [],
        'deployWordPress.localChanges': {
          projectId: 'p1',
          added: 0,
          modified: 3,
          deleted: 0,
          checkedAt: 1,
        },
      },
      [linked],
    );
    await screen.findByRole('heading', { name: 'Apollo' });

    await openSection(user, /^WordPress/);
    expect(await screen.findByText('Changes since the last sync')).toBeTruthy();
    expect(await screen.findByText('shop.example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review and deploy/ })).toBeTruthy();
  });

  it('opens the WordPress section from the query string', async () => {
    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=wordpress',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [linked], 'deployWordPress.listSites': [site] },
    });

    expect(
      await within(await screen.findByRole('navigation', { name: 'Project sections' })).findByRole(
        'button',
        { name: /^WordPress/, current: 'page' },
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Linked site' })).toBeTruthy();
  });

  it('sends an old WordPress link on an unlinked project to Overview', async () => {
    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=wordpress',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [project()] },
    });

    // The hop to Overview is a second render that mounts the whole Overview section, which can take
    // longer than the default second on a busy CI runner with coverage on.
    expect(
      await within(await screen.findByRole('navigation', { name: 'Project sections' })).findByRole(
        'button',
        { name: /^Overview/, current: 'page' },
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
  });

  async function openEdit(user: ReturnType<typeof renderPage>['user']): Promise<void> {
    await screen.findByRole('heading', { name: 'Apollo' });
    await user.click(screen.getByRole('button', { name: 'More project actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit project/ }));
    await screen.findByRole('dialog', { name: 'Edit project' });
  }

  it('switches a regular project to WordPress from the edit form', async () => {
    const { user } = renderPage({ 'deployWordPress.listSites': [site] });
    await openEdit(user);
    expect(screen.getByText('Regular project')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Switch to a WordPress project/ }));
    expect(
      await screen.findByRole('dialog', { name: 'Make this a WordPress project' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull();
  });

  it('switches a WordPress project back to regular from the edit form', async () => {
    const { user, bridge } = renderPage(
      {
        'deployWordPress.listSites': [site],
        'deployWordPress.unlinkProject': project(),
      },
      [linked],
    );
    await openEdit(user);
    expect(screen.getByText('WordPress site')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Switch to a regular project/ }));
    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unlink this project from the site?' }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.unlinkProject')).toHaveBeenCalledWith('p1'),
    );
  });
});

describe('ProjectDetailPage Deploy section', () => {
  const SITE = {
    id: 'fs-1',
    label: 'Apollo static',
    protocol: 'sftp',
    connection: {
      kind: 'custom',
      host: 'files.example',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: null,
      tlsPin: null,
      tlsServername: null,
      hasSecret: true,
    },
    remoteRoot: '/var/www/apollo',
    localFolder: 'C:\\code\\apollo\\dist',
    projectIds: ['p1'],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    capabilities: null,
    lastDeploy: null,
    needsReview: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const SNAPSHOT = {
    siteId: 'fs-1',
    computedAt: 1,
    state: 'ready',
    error: null,
    files: [
      { path: 'index.html', change: 'modified', size: 10 },
      { path: 'app.js', change: 'added', size: 20 },
    ],
    totals: { added: 1, modified: 1, deleted: 0, bytes: 30 },
    leftOut: [],
    leftOutTruncated: false,
    localFileCount: 2,
    baseFileCount: 1,
    firstDeploy: false,
  };

  it('opens from the query string with both ways to deploy when nothing is set up', async () => {
    renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=deploy',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [project()], 'deployFiles.list': [] },
    });

    expect(await screen.findByText('Not deployed yet')).toBeTruthy();
    expect(
      within(sectionNav()).getByRole('button', { name: /^Deploy/, current: 'page' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deploy with Runova/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add an FTP or SFTP site/ })).toBeTruthy();
  });

  it('counts the changes waiting on the attached sites in the nav', async () => {
    const { user } = renderPage({
      'deployFiles.list': [SITE],
      'deployFiles.changes': SNAPSHOT,
      'deployFiles.subscribe': SNAPSHOT,
    });
    await screen.findByRole('heading', { name: 'Apollo' });

    const deploy = await waitFor(() =>
      within(sectionNav()).getByRole('button', { name: /^Deploy\s*2$/ }),
    );
    await user.click(deploy);
    expect(await screen.findByRole('region', { name: 'Apollo static' })).toBeTruthy();
    expect(await screen.findByText('2 changes, 30 B since the last deploy')).toBeTruthy();
  });
});

describe('ProjectDetailPage Git tab without a repository', () => {
  function renderGitTab(overrides: Partial<Project>, bridge: Overrides = {}) {
    return renderWithProviders(<ProjectDetailPage />, {
      route: '/projects/p1?tab=git',
      path: 'projects/:projectId',
      bridge: { ...backgroundTabs, 'projects.list': [project(overrides)], ...bridge },
    });
  }

  it('offers to clone the saved GitHub repository instead of only starting a new one', async () => {
    const { user, bridge } = renderGitTab(
      { repoUrl: 'https://github.com/me/my-app' },
      { 'git.cloneProject': async () => ({ ok: true, message: 'Cloned.', mode: 'cloned' }) },
    );

    expect(
      await screen.findByText("This project's GitHub repository isn't on this computer yet"),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Initialize a new repository/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Clone me\/my-app/ }));

    await waitFor(() =>
      expect(bridge.$fn('git.cloneProject')).toHaveBeenCalledWith({
        projectId: 'p1',
        repoUrl: 'https://github.com/me/my-app',
        attach: false,
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cloned.'));
  });

  it('asks before connecting a folder that already has files, then attaches it', async () => {
    const cloneProject = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsAttachConfirm: true, message: 'Has files.' })
      .mockResolvedValueOnce({ ok: true, message: 'Connected.', mode: 'attached' });
    const { user } = renderGitTab(
      { repoUrl: 'https://github.com/me/my-app' },
      { 'git.cloneProject': cloneProject },
    );

    await user.click(await screen.findByRole('button', { name: /Clone me\/my-app/ }));

    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Connect this folder to me/my-app?' }),
      ),
    );
    await waitFor(() =>
      expect(cloneProject).toHaveBeenLastCalledWith({
        projectId: 'p1',
        repoUrl: 'https://github.com/me/my-app',
        attach: true,
      }),
    );
    expect(toast.error).not.toHaveBeenCalledWith('Has files.');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Connected.'));
  });

  it('clones a typed address when the project has none, and saves it as the repo link', async () => {
    const { user, bridge } = renderGitTab(
      {},
      {
        'git.cloneProject': async () => ({ ok: true, message: 'Cloned.', mode: 'cloned' }),
        'projects.update': async () => project({ repoUrl: 'https://github.com/me/other' }),
      },
    );

    await user.click(await screen.findByRole('button', { name: /Clone from GitHub/ }));
    const dialog = await screen.findByRole('dialog');
    const clone = within(dialog).getByRole('button', { name: /^Clone$/ }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Repository address'), 'github.com/me/other');
    await user.click(clone);

    await waitFor(() =>
      expect(bridge.$fn('git.cloneProject')).toHaveBeenCalledWith({
        projectId: 'p1',
        repoUrl: 'github.com/me/other',
        attach: false,
      }),
    );
    await waitFor(() =>
      expect(bridge.$fn('projects.update')).toHaveBeenCalledWith('p1', {
        repoUrl: 'https://github.com/me/other',
      }),
    );
  });
});
