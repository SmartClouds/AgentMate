import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DetectedClaudeHook, Project } from '@agentmat/core';
import { defaultProjectNotifications } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BootstrapResult, CreateProjectInput, FaviconResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog } from '../../test/main/electronMock';
import { json, type LocalServer, startHttpServer, tempDir } from '../../test/main/fixtures';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The Projects page end to end: projects.json on disk, the folder and icon pickers, the
 * bootstrap scaffold written into a temp project folder, and the Claude Code hook editing that
 * reaches into the project's own .claude/settings.json.
 */

const userData = useTempUserData();
const folder = { path: '' };
let server: LocalServer | null = null;

/** A tiny but real SVG, which the icon pipeline stores as-is rather than re-encoding. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
const SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;

expectChannelsCovered(IPC.projects);

function input(overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    name: 'Demo',
    folderPath: folder.path,
    description: 'A demo project',
    tags: ['demo'],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    ...overrides,
  };
}

async function create(overrides: Partial<CreateProjectInput> = {}): Promise<Project> {
  return invoke<Project>(IPC.projects.create, input(overrides));
}

function storedProjects(): Project[] {
  return JSON.parse(readFileSync(userData.dataFile('projects.json'), 'utf-8')) as Project[];
}

let projectsModule: typeof import('./projects');

beforeEach(async () => {
  folder.path = tempDir('agentmate-projects-folder-');
  projectsModule = await loadIpc(
    () => import('./projects'),
    (module) => module.registerProjectHandlers(),
  );
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('projects CRUD', () => {
  it('starts empty and keeps a created project across a reread', async () => {
    expect(await invoke<Project[]>(IPC.projects.list)).toEqual([]);

    const created = await create();
    expect(created).toMatchObject({
      name: 'Demo',
      folderPath: folder.path,
      pinned: false,
      archived: false,
      notifications: defaultProjectNotifications(),
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);

    const listed = await invoke<Project[]>(IPC.projects.list);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    // Creating a project is logged as activity, which the dashboard reads back.
    const activity = JSON.parse(readFileSync(userData.dataFile('activity-log.json'), 'utf-8')) as {
      type: string;
      message: string;
      metadata?: { projectId?: string };
    }[];
    expect(activity).toEqual([
      expect.objectContaining({
        type: 'project-created',
        message: 'Created project "Demo"',
        metadata: { projectId: created.id },
      }),
    ]);
  });

  it('puts the newest project first', async () => {
    const first = await create({ name: 'First' });
    const second = await create({ name: 'Second' });
    expect((await invoke<Project[]>(IPC.projects.list)).map((p) => p.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it('merges an update, stamps updatedAt and normalizes the colours', async () => {
    const created = await create({ iconBgColor: '#ABCDEF' });
    const updated = await invoke<Project>(IPC.projects.update, created.id, {
      name: 'Renamed',
      notes: 'note',
      iconBgColor: 'rgb(1,2,3)',
    });
    expect(updated).toMatchObject({ name: 'Renamed', notes: 'note', iconBgColor: null });
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    expect(storedProjects()[0].name).toBe('Renamed');
  });

  it('leaves the colours alone when an update says nothing about them', async () => {
    const created = await create({ iconBgColor: '#abcdef', iconColor: '#123456' });
    const updated = await invoke<Project>(IPC.projects.update, created.id, { notes: 'x' });
    expect(updated).toMatchObject({ iconBgColor: '#abcdef', iconColor: '#123456' });
  });

  it('starts with no worktree setup and saves a cleaned one', async () => {
    const created = await create();
    expect(created.worktreeSetup).toEqual({ command: '', copyGlobs: null });
    const updated = await invoke<Project>(IPC.projects.update, created.id, {
      worktreeSetup: { command: '  pnpm install  ', copyGlobs: ['.env', ' '] },
    });
    expect(updated.worktreeSetup).toEqual({ command: 'pnpm install', copyGlobs: ['.env'] });
    const untouched = await invoke<Project>(IPC.projects.update, created.id, { notes: 'x' });
    expect(untouched.worktreeSetup.command).toBe('pnpm install');
  });

  it('refuses to update or read a project that is gone', async () => {
    await expect(invoke(IPC.projects.update, 'missing', { name: 'x' })).rejects.toThrow(
      'Project missing not found',
    );
    await expect(invoke(IPC.projects.bootstrapPlan, 'missing')).rejects.toThrow(
      'Project missing not found',
    );
  });

  it('deletes a project and leaves the others in place', async () => {
    const keep = await create({ name: 'Keep' });
    const drop = await create({ name: 'Drop' });
    await invoke(IPC.projects.delete, drop.id);
    expect((await invoke<Project[]>(IPC.projects.list)).map((p) => p.id)).toEqual([keep.id]);
  });

  it('unlinks a deleted project from its FTP and SFTP sites and keeps the sites', async () => {
    const keep = await create({ name: 'Keep' });
    const drop = await create({ name: 'Drop' });
    userData.writeData('deploy-files.json', {
      version: 1,
      sites: [
        {
          id: 'site-1',
          label: 'Site',
          protocol: 'sftp',
          connection: { kind: 'saved', sshServerId: 'srv-1' },
          remoteRoot: '/var/www',
          localFolder: folder.path,
          projectIds: [drop.id, keep.id],
          deployOnSave: false,
          quietSeconds: 5,
          ignorePatterns: [],
          capabilities: null,
          lastDeploy: null,
          needsReview: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await invoke(IPC.projects.delete, drop.id);
    const stored = JSON.parse(readFileSync(userData.dataFile('deploy-files.json'), 'utf-8')) as {
      sites: { id: string; projectIds: string[] }[];
    };
    expect(stored.sites.map((site) => [site.id, site.projectIds])).toEqual([['site-1', [keep.id]]]);
  });

  it('reorders by the ids given, and keeps anything the renderer left out', async () => {
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    const c = await create({ name: 'C' });
    const next = await invoke<Project[]>(IPC.projects.reorder, [c.id, a.id, 'bogus-id']);
    // c and a come first in the order given; b was not mentioned, so it lands at the end.
    expect(next.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(storedProjects().map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });

  it('pins and archives, and archiving drops the pin', async () => {
    const project = await create();
    expect(await invoke<Project>(IPC.projects.setPinned, project.id, true)).toMatchObject({
      pinned: true,
    });
    const archived = await invoke<Project>(IPC.projects.setArchived, project.id, true);
    expect(archived).toMatchObject({ archived: true, pinned: false });
    expect(await invoke<Project>(IPC.projects.setArchived, project.id, false)).toMatchObject({
      archived: false,
      pinned: false,
    });
  });
});

describe('the WordPress link', () => {
  const link = {
    siteId: '6f1c2a9e-3b7d-4c51-9e0a-2d8f4b6c1a03',
    items: [
      { kind: 'theme' as const, slug: 'shop' },
      { kind: 'theme' as const, slug: 'shop' },
      { kind: 'plugin' as const, slug: '../evil' },
    ],
    linkedAt: '2026-10-05T10:00:00.000Z',
  };

  it('is ignored by projects.create and projects.update', async () => {
    const created = await create({ wordpress: link });
    expect(created.wordpress).toBeUndefined();
    expect(storedProjects()[0].wordpress).toBeUndefined();

    const linked = await projectsModule.createProjectRecord({ ...input(), wordpress: link });
    const updated = await invoke<Project>(IPC.projects.update, linked.id, {
      name: 'Renamed',
      wordpress: { ...link, siteId: 'other-site' },
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.wordpress?.siteId).toBe(link.siteId);
  });

  it('is normalized when the WordPress flow creates a project', async () => {
    const created = await projectsModule.createProjectRecord({
      ...input({ name: 'Shop', prompt: 'Mirror of the shop' }),
      wordpress: link,
    });
    expect(created.wordpress).toEqual({
      siteId: link.siteId,
      items: [{ kind: 'theme', slug: 'shop' }],
      linkedAt: link.linkedAt,
    });
    expect(created.prompt).toBe('Mirror of the shop');
    expect(storedProjects()[0].wordpress?.items).toHaveLength(1);
    expect((await invoke<Project[]>(IPC.projects.list))[0].wordpress?.siteId).toBe(link.siteId);
  });

  it('is set and removed only through setProjectWordPressLink', async () => {
    const project = await create();
    const linked = await projectsModule.setProjectWordPressLink(project.id, link);
    expect(linked.wordpress?.items).toEqual([{ kind: 'theme', slug: 'shop' }]);
    const unlinked = await projectsModule.setProjectWordPressLink(project.id, undefined);
    expect(unlinked.wordpress).toBeUndefined();
    expect('wordpress' in storedProjects()[0]).toBe(false);
    await expect(
      projectsModule.setProjectWordPressLink(project.id, { ...link, items: [] }),
    ).rejects.toThrow('not valid');
  });

  it('changes the prompt and website with the link when asked to', async () => {
    const project = await create();
    const linked = await projectsModule.setProjectWordPressLink(project.id, link, {
      prompt: 'Site facts.',
      websiteUrl: 'https://shop.example/',
    });
    expect(linked).toMatchObject({ prompt: 'Site facts.', websiteUrl: 'https://shop.example/' });
    const unlinked = await projectsModule.setProjectWordPressLink(project.id, undefined, {
      prompt: '',
    });
    expect(unlinked).toMatchObject({ prompt: '', websiteUrl: 'https://shop.example/' });
    expect(unlinked.wordpress).toBeUndefined();
  });
});

describe('project icons', () => {
  it('moves the image out of projects.json and hydrates it back on read', async () => {
    const created = await create({ iconDataUrl: SVG_DATA_URL });
    expect(created.iconDataUrl).toBe(SVG_DATA_URL);

    // On disk the image lives in its own file; projects.json only carries the name.
    const stored = storedProjects()[0];
    expect(stored.iconDataUrl).toBeNull();
    expect(stored.iconFile).toMatch(/\.svg$/);
    expect(existsSync(join(userData.dir, 'data', 'project-icons', stored.iconFile ?? ''))).toBe(
      true,
    );

    const listed = await invoke<Project[]>(IPC.projects.list);
    expect(listed[0].iconDataUrl).toBe(SVG_DATA_URL);
  });

  it('drops the icon file when the project is deleted', async () => {
    const created = await create({ iconDataUrl: SVG_DATA_URL });
    const iconFile = storedProjects()[0].iconFile ?? '';
    await invoke(IPC.projects.delete, created.id);
    expect(existsSync(join(userData.dir, 'data', 'project-icons', iconFile))).toBe(false);
  });

  it('reads a picked image file and refuses one that is not an image', async () => {
    const picked = join(folder.path, 'logo.svg');
    writeFileSync(picked, SVG, 'utf-8');
    queueDialog('showOpenDialog', { canceled: false, filePaths: [picked] });
    expect(await invoke<string | null>(IPC.projects.pickIcon)).toBe(SVG_DATA_URL);

    const wrong = join(folder.path, 'notes.txt');
    writeFileSync(wrong, 'not an image', 'utf-8');
    queueDialog('showOpenDialog', { canceled: false, filePaths: [wrong] });
    await expect(invoke(IPC.projects.pickIcon)).rejects.toThrow('not a supported image');
  });

  it('returns null when the icon picker is cancelled', async () => {
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke<string | null>(IPC.projects.pickIcon)).toBeNull();
  });

  it('normalizes a pasted data URL and rejects anything that is not one', async () => {
    expect(await invoke<string>(IPC.projects.normalizeIcon, SVG_DATA_URL)).toBe(SVG_DATA_URL);
    await expect(
      invoke(IPC.projects.normalizeIcon, 'https://example.test/logo.png'),
    ).rejects.toThrow('That does not look like an image.');
  });
});

describe('projects:pickFolder', () => {
  it('returns the folder the dialog chose', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: [folder.path] });
    expect(await invoke<string | null>(IPC.projects.pickFolder)).toBe(folder.path);
  });

  it('returns null when cancelled, and when the dialog hands back nothing', async () => {
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke<string | null>(IPC.projects.pickFolder)).toBeNull();
    queueDialog('showOpenDialog', { canceled: false, filePaths: [] });
    expect(await invoke<string | null>(IPC.projects.pickFolder)).toBeNull();
  });

  it('opens on the saved projects root, and ignores one that has since gone', async () => {
    userData.writeData('settings.json', { projectsRootPath: folder.path });
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    await invoke(IPC.projects.pickFolder);
    expect(electronState.dialogCalls.at(-1)?.args[0]).toMatchObject({ defaultPath: folder.path });

    userData.writeData('settings.json', { projectsRootPath: join(folder.path, 'gone') });
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    await invoke(IPC.projects.pickFolder);
    expect(electronState.dialogCalls.at(-1)?.args[0]).toMatchObject({ defaultPath: undefined });
  });
});

describe('projects:bootstrap', () => {
  it('previews the same plan it writes', async () => {
    const project = await create({ agentType: 'claude-code' });
    const plan = await invoke<{ agentLabel: string; files: { relativePath: string }[] }>(
      IPC.projects.bootstrapPlan,
      project.id,
    );
    const result = await invoke<BootstrapResult>(IPC.projects.bootstrap, project.id);
    expect(result.agentLabel).toBe(plan.agentLabel);
    expect(result.createdFiles).toEqual(plan.files.map((file) => file.relativePath));
    expect(result.skippedFiles).toEqual([]);
    for (const file of plan.files)
      expect(existsSync(join(folder.path, file.relativePath))).toBe(true);
  });

  it('never clobbers a file an agent already put there', async () => {
    const project = await create({ agentType: 'claude-code' });
    const plan = await invoke<{ files: { relativePath: string }[] }>(
      IPC.projects.bootstrapPlan,
      project.id,
    );
    const first = plan.files[0].relativePath;
    mkdirSync(dirname(join(folder.path, first)), { recursive: true });
    writeFileSync(join(folder.path, first), 'mine, hands off', 'utf-8');

    const result = await invoke<BootstrapResult>(IPC.projects.bootstrap, project.id);
    expect(result.skippedFiles).toContain(first);
    expect(result.createdFiles).not.toContain(first);
    expect(readFileSync(join(folder.path, first), 'utf-8')).toBe('mine, hands off');
  });
});

describe('projects notification hooks', () => {
  it('writes the relay script and wires Claude Code when the hook is switched on', async () => {
    const project = await create();
    const notifications = defaultProjectNotifications();
    notifications.completion = { enabled: true, cliId: 'claude-code', message: 'done' };

    const updated = await invoke<Project>(
      IPC.projects.updateNotifications,
      project.id,
      notifications,
    );
    expect(updated.notifications.completion.enabled).toBe(true);

    const hooksDir = join(folder.path, '.agentmate', 'hooks');
    expect(existsSync(hooksDir)).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(folder.path, '.claude', 'settings.json'), 'utf-8'),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const commands = Object.values(settings.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );
    expect(commands.some((command) => command.includes('.agentmate'))).toBe(true);
  });

  it('lists, edits and removes the hooks in the project settings file', async () => {
    const project = await create();
    // Saving notifications with everything off is what creates .claude/settings.json here; the
    // file then gets one hook of the user's own, the way Claude Code itself would leave it.
    const claudeDir = join(folder.path, '.claude');
    await invoke(IPC.projects.updateNotifications, project.id, defaultProjectNotifications());
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      }),
      'utf-8',
    );

    const listed = await invoke<DetectedClaudeHook[]>(IPC.projects.listClaudeHooks, project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'settings.json:Stop:0:0',
      event: 'Stop',
      matcher: 'Bash',
      managedByAgentMate: false,
    });

    await invoke(IPC.projects.updateClaudeHook, project.id, listed[0].id, {
      matcher: 'Write',
      hook: { type: 'command', command: 'echo edited' },
    });
    const afterEdit = await invoke<DetectedClaudeHook[]>(IPC.projects.listClaudeHooks, project.id);
    expect(afterEdit[0]).toMatchObject({ matcher: 'Write' });
    expect(afterEdit[0].hook.command).toBe('echo edited');

    await invoke(IPC.projects.deleteClaudeHook, project.id, listed[0].id);
    expect(await invoke<DetectedClaudeHook[]>(IPC.projects.listClaudeHooks, project.id)).toEqual(
      [],
    );
  });

  it('rejects a hook id that does not point at anything', async () => {
    const project = await create();
    await expect(
      invoke(IPC.projects.deleteClaudeHook, project.id, 'settings.json:Stop:0:0'),
    ).rejects.toThrow('not found');
    await expect(
      invoke(IPC.projects.updateClaudeHook, project.id, 'nonsense', { hook: {} }),
    ).rejects.toThrow('Invalid hook id');
  });
});

describe('projects:fetchFavicon', () => {
  it('downloads the icon a page declares', async () => {
    server = await startHttpServer((request, response) => {
      if (request.url === '/icon.svg') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end(SVG);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><head><link rel="icon" href="/icon.svg"></head><body></body></html>');
    });

    const result = await invoke<FaviconResult | null>(IPC.projects.fetchFavicon, server.url);
    expect(result?.dataUrl).toBe(SVG_DATA_URL);
    expect(result?.sourceUrl).toBe(`${server.url}/icon.svg`);
  });

  it('gives up quietly when the site offers no usable icon', async () => {
    server = await startHttpServer((_request, response) => {
      json(response, { ok: false }, 404);
    });
    expect(await invoke<FaviconResult | null>(IPC.projects.fetchFavicon, server.url)).toBeNull();
  });

  it('refuses a site url that is not http(s), so the fetch cannot read local files', async () => {
    expect(
      await invoke<FaviconResult | null>(IPC.projects.fetchFavicon, 'file:///C:/Windows/win.ini'),
    ).toBeNull();
    expect(await invoke<FaviconResult | null>(IPC.projects.fetchFavicon, '   ')).toBeNull();
  });
});
