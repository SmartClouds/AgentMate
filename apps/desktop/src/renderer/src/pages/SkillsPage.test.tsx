import { bundledSkillsShDirectory, type Skill, type SkillRepository } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  InstalledSkillRecord,
  SkillAuditRecord,
  SkillUsageReport,
  UsedSkillInspection,
} from '../../../shared/apiTypes';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The Skill Marketplace is six views behind one nav: a bundled skills.sh directory that needs no
 * main process at all, the repositories the user added, their favorites, usage counts, and the
 * security check history. These tests walk the paths a user actually takes through it: find a
 * skill, narrow the list, install it somewhere, remove it again, and read the verdict a security
 * check left on the card.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

/**
 * The renderer suite already swaps Framer Motion for a stub, but the tab bar's springs call
 * `jump` on their motion value, which the stub has no answer for. Reduced motion is on in the
 * stub, so nothing here animates either way.
 */
vi.mock('framer-motion', async (importOriginal) => {
  const stub = (await importOriginal()) as Record<string, unknown>;
  const motionValue = (initial: number) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: number) => {
        current = next;
      },
      jump: (next: number) => {
        current = next;
      },
      on: () => () => undefined,
    };
  };
  return {
    ...stub,
    useMotionValue: motionValue,
    useSpring: motionValue,
    useTransform: () => motionValue(0),
    useMotionValueEvent: () => undefined,
  };
});

const { default: SkillsPage } = await import('./SkillsPage');

const repository: SkillRepository = {
  id: 'repo-1',
  name: 'Community Skills',
  sourceType: 'local-folder',
  source: '/skills',
  addedAt: '2026-01-01T00:00:00.000Z',
  lastRefreshedAt: null,
};

const otherRepository: SkillRepository = { ...repository, id: 'repo-2', name: 'Internal Skills' };

function skill(overrides: Partial<Skill> & { id: string; name: string }): Skill {
  return {
    description: 'Does a thing.',
    category: 'writing',
    tags: [],
    author: 'someone',
    version: '1.0.0',
    popularity: 0,
    dependencies: [],
    compatibility: [],
    files: [{ path: 'SKILL.md', url: 'https://example.com/SKILL.md' }],
    ...overrides,
  };
}

const changelog = skill({
  id: 'changelog-writer',
  name: 'Changelog Writer',
  description: 'Turns commits into a readable changelog.',
  category: 'writing',
  tags: ['git'],
  author: 'runova',
  version: '2.1.0',
});

const migrator = skill({
  id: 'db-migrator',
  name: 'DB Migrator',
  description: 'Writes reversible SQL migrations.',
  category: 'database',
  tags: ['sql'],
  version: '0.4.0',
});

function audit(overrides: Partial<SkillAuditRecord> & { skillId: string }): SkillAuditRecord {
  return {
    id: `audit-${overrides.skillId}`,
    skillName: 'Changelog Writer',
    sourceKind: 'repository',
    sourceLabel: 'Community Skills',
    projectId: null,
    verdict: 'caution',
    score: 42,
    findings: [],
    filesScanned: 1,
    bytesScanned: 120,
    deepReview: false,
    cliName: null,
    aiSummary: null,
    aiError: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    ...overrides,
  };
}

/** The bridge answers a seeded repository with two skills needs. */
const seeded = {
  'skills.listRepositories': [repository],
  'skills.getRepositoryIndex': async () => ({
    name: 'Community Skills',
    skills: [changelog, migrator],
  }),
};

function renderPage(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<SkillsPage />, { route: '/skills', bridge });
}

/** Moves to one of the six views the nav offers. */
async function openTab(user: ReturnType<typeof renderPage>['user'], label: RegExp): Promise<void> {
  await user.click(screen.getByRole('button', { name: label }));
}

/**
 * The card a skill's title heads. The title and the actions sit in separate boxes, so the card is
 * the first ancestor that carries the skill's own Install button.
 */
function skillCard(name: string): HTMLElement {
  let element: HTMLElement | null = screen.getByText(name).parentElement;
  while (element) {
    if (within(element).queryByRole('button', { name: /^Install/ })) return element;
    element = element.parentElement;
  }
  throw new Error(`No card found around "${name}"`);
}

describe('SkillsPage first load', () => {
  it('opens on the bundled directory, which needs nothing from the main process', async () => {
    renderPage();

    // The snapshot ships with the app, so the page has something to show before any call lands.
    expect(
      await screen.findByText(`${bundledSkillsShDirectory.length} popular skills bundled from`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Directory/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: /Global Skills/ })).toBeTruthy();
    expect(screen.queryByText('No skills match your search.')).toBeNull();
  });

  it('subscribes to repository changes while it is open and lets go on the way out', () => {
    const { bridge, unmount } = renderPage();

    // A watched local folder invalidates this page's caches, so the listener has to be live.
    expect(bridge.$listenerCount('skills.onRepositoryChanged')).toBe(1);
    unmount();
    expect(bridge.$listenerCount('skills.onRepositoryChanged')).toBe(0);
  });
});

describe('SkillsPage repositories', () => {
  it('lists the seeded repository’s skills with what each one is', async () => {
    const { user } = renderPage(seeded);
    await openTab(user, /^Repositories/);

    expect(await screen.findByText('Changelog Writer')).toBeTruthy();
    const card = skillCard('Changelog Writer');
    expect(within(card).getByText('Turns commits into a readable changelog.')).toBeTruthy();
    expect(within(card).getByText('writing')).toBeTruthy();
    expect(within(card).getByText('git')).toBeTruthy();
    expect(within(card).getByText(/runova · v2\.1\.0/)).toBeTruthy();
    expect(screen.getByText('DB Migrator')).toBeTruthy();
  });

  it('says there is nothing to browse when no repository has been added', async () => {
    const { user } = renderPage({ 'skills.listRepositories': [] });
    await openTab(user, /^Repositories/);

    expect(
      await screen.findByText('No repositories yet. Add one to browse its skills here.'),
    ).toBeTruthy();
  });

  it('narrows the grid to what the search box matches', async () => {
    const { user } = renderPage(seeded);
    await openTab(user, /^Repositories/);
    await screen.findByText('Changelog Writer');

    await user.type(screen.getByPlaceholderText('Search skills by name, tag, category…'), 'sql');

    // Matched on its tag, not its name, which is what makes the search worth having.
    await waitFor(() => expect(screen.queryByText('Changelog Writer')).toBeNull());
    expect(screen.getByText('DB Migrator')).toBeTruthy();

    await user.clear(screen.getByPlaceholderText('Search skills by name, tag, category…'));
    await user.type(screen.getByPlaceholderText('Search skills by name, tag, category…'), 'zzz');

    expect(await screen.findByText('No skills match your search.')).toBeTruthy();
  });

  it('scopes the grid to one repository when its name is clicked on a card', async () => {
    const { user, bridge } = renderPage({
      'skills.listRepositories': [repository, otherRepository],
      'skills.getRepositoryIndex': async (id: unknown) => ({
        name: String(id),
        skills: id === 'repo-1' ? [changelog] : [migrator],
      }),
    });
    await openTab(user, /^Repositories/);
    await screen.findByText('Changelog Writer');
    expect(screen.getByText('DB Migrator')).toBeTruthy();

    // The repository label is only shown while several are mixed together, and it filters.
    await user.click(
      within(skillCard('Changelog Writer')).getByRole('button', { name: 'Community Skills' }),
    );

    await waitFor(() => expect(screen.queryByText('DB Migrator')).toBeNull());
    expect(screen.getByText('Changelog Writer')).toBeTruthy();
    expect(bridge.$fn('skills.getRepositoryIndex')).toHaveBeenCalledWith('repo-1');
  });

  it('names the repository it could not index instead of showing an empty grid', async () => {
    const { user } = renderPage({
      'skills.listRepositories': [repository],
      'skills.getRepositoryIndex': () => Promise.reject(new Error('ENOENT: /skills')),
    });
    await openTab(user, /^Repositories/);

    expect(await screen.findByText('Community Skills: ENOENT: /skills')).toBeTruthy();
  });
});

describe('SkillsPage installing', () => {
  it('installs the chosen skill globally and says where it landed', async () => {
    const { user, bridge } = renderPage(seeded);
    await openTab(user, /^Repositories/);
    await screen.findByText('Changelog Writer');

    await user.click(
      within(skillCard('Changelog Writer')).getByRole('button', { name: /Install/ }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Install Changelog Writer')).toBeTruthy();
    // Nothing is selected yet, so there is nowhere to install to.
    expect(within(dialog).getByRole('button', { name: /^Install/ })).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Install (1)' }));

    await waitFor(() =>
      expect(bridge.$fn('skills.install')).toHaveBeenCalledWith({
        projectId: null,
        repositoryId: 'repo-1',
        skillId: 'changelog-writer',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Installed to 1 location.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the picker open and reports the failure when the install is refused', async () => {
    const { user } = renderPage({
      ...seeded,
      'skills.install': () => Promise.reject(new Error('target folder is read-only')),
    });
    await openTab(user, /^Repositories/);
    await screen.findByText('Changelog Writer');

    await user.click(
      within(skillCard('Changelog Writer')).getByRole('button', { name: /Install/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Install (1)' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to install to 1 location. target folder is read-only',
      ),
    );
    // Still open, so the user can pick somewhere else rather than starting over.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('SkillsPage global skills', () => {
  const installed: InstalledSkillRecord = {
    skillId: 'changelog-writer',
    repositoryId: 'repo-1',
    version: '2.1.0',
    installedAt: '2026-02-01T00:00:00.000Z',
  };

  it('lists what is installed for every project and removes one on confirmation', async () => {
    const { user, bridge } = renderPage({ ...seeded, 'skills.listInstalled': [installed] });
    await screen.findByRole('button', { name: /Global Skills/ });

    await user.click(screen.getByRole('button', { name: /Global Skills/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('changelog-writer')).toBeTruthy();
    expect(within(dialog).getByText('v2.1.0')).toBeTruthy();

    // The last button on the row is the bin; removal is destructive, so it asks first.
    const row = within(dialog).getByText('changelog-writer').closest('div.flex') as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.$fn('skills.remove')).toHaveBeenCalledWith({
        projectId: null,
        skillId: 'changelog-writer',
      }),
    );
  });

  it('says so plainly when nothing is installed globally', async () => {
    const { user } = renderPage({ 'skills.listInstalled': [] });

    await user.click(screen.getByRole('button', { name: /Global Skills/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('No skills installed globally yet.')).toBeTruthy();
  });
});

describe('SkillsPage security verdicts', () => {
  it('shows the last verdict on the skill’s own card', async () => {
    const { user } = renderPage({
      ...seeded,
      'skills.latestAuditPerSkill': [audit({ skillId: 'changelog-writer' })],
    });
    await openTab(user, /^Repositories/);
    await screen.findByText('Changelog Writer');

    // The badge carries the verdict and the score, so a card says what the check found.
    expect(
      within(skillCard('Changelog Writer')).getByText(/Read before installing · 42/),
    ).toBeTruthy();
    expect(within(skillCard('DB Migrator')).queryByText(/Read before installing/)).toBeNull();
  });

  it('lists every saved check and offers to clear the history', async () => {
    const { user, bridge } = renderPage({
      'skills.latestAuditPerSkill': [],
      'skills.listAudits': [audit({ skillId: 'changelog-writer', verdict: 'safe', score: 95 })],
    });
    await openTab(user, /^Security/);

    expect(await screen.findByText('1 check saved on this machine.')).toBeTruthy();
    expect(screen.getByText(/Looks safe · 95/)).toBeTruthy();
    expect(screen.getByText('Repository')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Clear history/ }));

    await waitFor(() => expect(bridge.$fn('skills.clearAudits')).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Security check history cleared.');
  });

  it('says nothing has been checked yet when the history is empty', async () => {
    const { user } = renderPage({ 'skills.listAudits': [] });
    await openTab(user, /^Security/);

    expect(
      await screen.findByText(
        'No skills checked yet. Open the Directory or Repositories tab and use the shield button on a skill.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Clear history/ })).toBeNull();
  });
});

describe('SkillsPage directory filters', () => {
  it('searches skills.sh live once there is enough to search for', async () => {
    const { user, bridge } = renderPage({
      'skills.searchSkillsSh': [
        {
          id: 'acme/tools/deployer',
          name: 'deployer',
          owner: 'acme',
          repo: 'acme/tools',
          installs: 2400,
          official: false,
          url: 'https://www.skills.sh/acme/tools/deployer',
          installCommand: 'npx skills add acme/tools/deployer',
        },
      ],
    });
    await screen.findByRole('button', { name: /^Directory/ });

    await user.click(screen.getByRole('button', { name: 'Live' }));
    expect(screen.getByText('Type at least 2 characters to search skills.sh live.')).toBeTruthy();

    await user.type(
      screen.getByPlaceholderText('Search skills.sh live (2+ characters)…'),
      'deployer',
    );

    // The box is debounced, so the call only goes out once the typing settles.
    await waitFor(() =>
      expect(bridge.$fn('skills.searchSkillsSh')).toHaveBeenCalledWith('deployer'),
    );
    expect(await screen.findByText('deployer')).toBeTruthy();
    expect(screen.getByText('2.4K installs')).toBeTruthy();
  });

  it('says skills.sh could not be reached rather than showing an empty catalog', async () => {
    const { user } = renderPage({
      'skills.searchSkillsSh': () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    });
    await screen.findByRole('button', { name: /^Directory/ });

    await user.click(screen.getByRole('button', { name: 'Live' }));
    await user.type(
      screen.getByPlaceholderText('Search skills.sh live (2+ characters)…'),
      'deploy',
    );

    expect(
      await screen.findByText("Couldn't reach skills.sh. Check your connection and try again."),
    ).toBeTruthy();
  });
});

describe('SkillsPage adding a used skill to another project', () => {
  const demo = { id: 'p1', name: 'Demo', folderPath: '/work/demo' };
  const site = { id: 'p2', name: 'Site', folderPath: '/work/site' };
  const docs = { id: 'p3', name: 'Docs', folderPath: '/work/docs' };

  const days = Array.from(
    { length: 30 },
    (_, index) => `2026-09-${`${index + 1}`.padStart(2, '0')}`,
  );
  const usage: SkillUsageReport = {
    stats: [
      {
        skill: 'formatter',
        count: 4,
        count7d: 2,
        count30d: 4,
        firstUsedAt: '2026-09-01T09:00:00.000Z',
        lastUsedAt: '2026-09-29T09:00:00.000Z',
        projects: [{ path: demo.folderPath, label: demo.name, count: 4 }],
        daily: new Array(30).fill(0),
      },
    ],
    totalInvocations: 4,
    days,
    dailyTotals: new Array(30).fill(0),
    filesScanned: 1,
    sourceRoots: ['/home/.claude/projects'],
    scannedAt: '2026-09-30T09:00:00.000Z',
  };

  const found: UsedSkillInspection = {
    skill: 'formatter',
    folderName: 'formatter',
    source: {
      path: '/work/demo/.claude/skills/formatter',
      origin: 'project',
      label: demo.folderPath,
    },
    presentInProjectIds: [demo.id],
  };

  const bridge = {
    'projects.list': [demo, site, docs],
    'skills.getUsage': usage,
    'skills.inspectUsedSkill': found,
    'skills.addUsedSkillToProjects': async ({ projectIds }: { projectIds: string[] }) =>
      projectIds.map((projectId) => ({ projectId, status: 'added' })),
  };

  async function openPicker(overrides: Record<string, unknown> = {}) {
    const view = renderPage({ ...bridge, ...overrides });
    await openTab(view.user, /^Usage/);
    await view.user.click(
      await screen.findByRole('button', { name: 'Add formatter to another project' }),
    );
    const dialog = await screen.findByRole('dialog');
    return { ...view, dialog };
  }

  it('copies the skill into the projects picked, from where it was found', async () => {
    const { user, bridge: fake, dialog } = await openPicker();

    expect(within(dialog).getByText('Add formatter to projects')).toBeTruthy();
    expect(await within(dialog).findByText(`From ${demo.folderPath}`)).toBeTruthy();
    expect(fake.$fn('skills.inspectUsedSkill')).toHaveBeenCalledWith({
      skill: 'formatter',
      projectPaths: [demo.folderPath],
    });

    // The project it came from already has it, so it can't be picked again.
    expect(within(dialog).getByRole('checkbox', { name: demo.name })).toBeDisabled();
    expect(within(dialog).getByText('Already has it')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: site.name }));
    await user.click(within(dialog).getByRole('checkbox', { name: docs.name }));
    await user.click(within(dialog).getByRole('button', { name: 'Add to 2 projects' }));

    await waitFor(() =>
      expect(fake.$fn('skills.addUsedSkillToProjects')).toHaveBeenCalledWith({
        skill: 'formatter',
        projectPaths: [demo.folderPath],
        projectIds: [site.id, docs.id],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Added formatter to 2 projects.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('narrows the projects to what the search matches', async () => {
    const { user, dialog } = await openPicker();
    await within(dialog).findByText(`From ${demo.folderPath}`);

    await user.type(within(dialog).getByPlaceholderText('Search projects…'), 'site');
    expect(within(dialog).getByRole('checkbox', { name: site.name })).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox', { name: docs.name })).toBeNull();

    await user.clear(within(dialog).getByPlaceholderText('Search projects…'));
    await user.type(within(dialog).getByPlaceholderText('Search projects…'), 'nothing here');
    expect(within(dialog).getByText('No projects match your search.')).toBeTruthy();
  });

  it('says the files are missing and offers nothing to add when the skill is not on disk', async () => {
    const { user, dialog } = await openPicker({
      'skills.inspectUsedSkill': { ...found, source: null, presentInProjectIds: [] },
    });

    expect(
      await within(dialog).findByText(/Couldn't find this skill's files on disk/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: site.name }));
    expect(within(dialog).getByRole('button', { name: 'Add to 1 project' })).toBeDisabled();
  });

  it('keeps the picker open on the projects that failed, and notes the ones left alone', async () => {
    const {
      user,
      bridge: fake,
      dialog,
    } = await openPicker({
      'skills.addUsedSkillToProjects': async () => [
        { projectId: site.id, status: 'exists' },
        { projectId: docs.id, status: 'failed', error: 'EACCES: permission denied' },
      ],
    });
    await within(dialog).findByText(`From ${demo.folderPath}`);

    await user.click(within(dialog).getByRole('checkbox', { name: site.name }));
    await user.click(within(dialog).getByRole('checkbox', { name: docs.name }));
    await user.click(within(dialog).getByRole('button', { name: 'Add to 2 projects' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not add formatter to 1 project. EACCES: permission denied',
      ),
    );
    expect(toast.info).toHaveBeenCalledWith('1 project already had formatter, left as is.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Only the failure stays ticked, so trying again doesn't touch the rest.
    expect(within(dialog).getByRole('checkbox', { name: docs.name })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: site.name })).not.toBeChecked();
    expect(fake.$fn('skills.addUsedSkillToProjects')).toHaveBeenCalledTimes(1);
  });

  it('opens the same picker from a skill in the by-project view', async () => {
    const { user } = renderPage(bridge);
    await openTab(user, /^Usage/);
    await user.click(await screen.findByRole('button', { name: /By project/ }));

    const buttons = await screen.findAllByRole('button', {
      name: 'Add formatter to another project',
    });
    // The by-skill row is gone in this view, so the only button is the project card's own.
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    expect(await screen.findByText('Add formatter to projects')).toBeTruthy();
  });
});
