import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotificationHookKind, Project } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, writeTree } from '../../test/main/fixtures';

/**
 * This module edits a file the user also edits by hand, so the cases worth pinning are all about
 * not breaking what is already there: an unrelated hook must survive, saving twice must not
 * duplicate anything, and turning a hook off must leave the file as if Runova never touched it.
 *
 * `hookServer` is stubbed only for the port file path: importing it for real boots the terminal
 * subsystem, and it has its own test file.
 */
vi.mock('./hookServer', () => ({
  portFilePath: () => 'C:/Users/test/AppData/Roaming/Runova/data/hook-server.json',
}));

const { deleteClaudeHook, installProjectNotificationHooks, listClaudeHooks, updateClaudeHook } =
  await import('./hookInstaller');

let folder = '';

beforeEach(() => {
  folder = tempDir('runova-hooks-');
});

type HookOverrides = Partial<Record<NotificationHookKind, { enabled: boolean; cliId?: string }>>;

/** A project with only the fields the installer reads. */
function projectWith(hooks: HookOverrides): Project {
  const hook = (kind: NotificationHookKind) => ({
    enabled: hooks[kind]?.enabled ?? false,
    message: `${kind} for {{project}}`,
    cliId: hooks[kind]?.cliId ?? 'claude-code',
  });
  return {
    id: 'proj-1',
    name: 'Checkout',
    folderPath: folder,
    notifications: {
      completion: hook('completion'),
      confirmation: hook('confirmation'),
      pet: hook('pet'),
    },
  } as unknown as Project;
}

function claudeSettings(file = 'settings.json'): Record<string, unknown> {
  return JSON.parse(readFileSync(join(folder, '.claude', file), 'utf-8')) as Record<
    string,
    unknown
  >;
}

interface HookGroup {
  matcher?: string;
  hooks: { type?: string; command?: string; timeout?: number }[];
}

function groupsFor(event: string, file = 'settings.json'): HookGroup[] {
  const settings = claudeSettings(file) as { hooks?: Record<string, HookGroup[]> };
  return settings.hooks?.[event] ?? [];
}

describe('installProjectNotificationHooks', () => {
  it('writes the relay script and wires Claude Code for an enabled hook', async () => {
    const result = await installProjectNotificationHooks(
      projectWith({ completion: { enabled: true, cliId: 'claude-code' } }),
    );

    const scriptPath = join(folder, '.runova', 'hooks', 'notify-completion.cjs');
    expect(result.completion).toEqual({ scriptPath, wiredAutomatically: true });
    expect(existsSync(scriptPath)).toBe(true);

    const script = readFileSync(scriptPath, 'utf-8');
    // The script has to name the project and kind, since the server decides what to do from them.
    expect(script).toContain('"proj-1"');
    expect(script).toContain('"completion"');
    // A hook that throws shows up as an error in the agent's own CLI, so it must swallow.
    expect(script).toContain("process.on('uncaughtException'");

    // Completion maps to Claude Code's Stop event.
    expect(groupsFor('Stop')[0].hooks[0]).toEqual({
      type: 'command',
      command: `node ${JSON.stringify(scriptPath)}`,
    });
  });

  it('uses the Notification event for a confirmation hook', async () => {
    await installProjectNotificationHooks(projectWith({ confirmation: { enabled: true } }));

    expect(groupsFor('Notification')).toHaveLength(1);
    expect(groupsFor('Notification')[0].hooks[0].command).toContain('notify-confirmation.cjs');
    expect(groupsFor('Stop')).toEqual([]);
  });

  it('writes the script but leaves Claude settings alone for another agent', async () => {
    const result = await installProjectNotificationHooks(
      projectWith({ pet: { enabled: true, cliId: 'codex' } }),
    );

    expect(result.pet?.wiredAutomatically).toBe(false);
    expect(existsSync(join(folder, '.runova', 'hooks', 'notify-pet.cjs'))).toBe(true);
    // Only Claude Code has a schema Runova can safely edit, so nothing may be wired here.
    expect(claudeSettings().hooks).toBeUndefined();
  });

  it('keeps hooks the user configured themselves', async () => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'lint' }] }],
        },
      }),
    });

    await installProjectNotificationHooks(projectWith({ completion: { enabled: true } }));

    const settings = claudeSettings() as {
      permissions?: unknown;
      hooks?: Record<string, HookGroup[]>;
    };
    // Unrelated settings and other events must come through untouched.
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings.hooks?.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'lint' }] }]);
    expect(groupsFor('Stop')).toHaveLength(2);
    expect(groupsFor('Stop')[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }],
    });
    expect(groupsFor('Stop')[1].hooks[0].command).toContain('notify-completion.cjs');
  });

  it('is idempotent: saving twice leaves exactly one entry', async () => {
    const project = projectWith({ completion: { enabled: true } });

    await installProjectNotificationHooks(project);
    await installProjectNotificationHooks(project);
    await installProjectNotificationHooks(project);

    // Without the match-by-filename cleanup the user's agent would fire three notifications.
    expect(groupsFor('Stop')).toHaveLength(1);
  });

  it('removes the script and the wiring when the hook is turned off', async () => {
    const project = projectWith({ completion: { enabled: true } });
    await installProjectNotificationHooks(project);
    const scriptPath = join(folder, '.runova', 'hooks', 'notify-completion.cjs');
    expect(existsSync(scriptPath)).toBe(true);

    const result = await installProjectNotificationHooks(projectWith({}));

    expect(result.completion).toBeNull();
    expect(existsSync(scriptPath)).toBe(false);
    // With nothing left under Stop, the event key itself goes, so the file reads as untouched.
    expect(claudeSettings().hooks).toBeUndefined();
  });

  it('keeps a user hook under the same event after ours is removed', async () => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    });
    await installProjectNotificationHooks(projectWith({ completion: { enabled: true } }));

    await installProjectNotificationHooks(projectWith({}));

    expect(groupsFor('Stop')).toEqual([{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  });

  it('does not fail when the script is already gone', async () => {
    // Disabling a hook that was never installed happens on every project save.
    await expect(installProjectNotificationHooks(projectWith({}))).resolves.toEqual({
      completion: null,
      confirmation: null,
      pet: null,
    });
  });

  it('starts from scratch when the settings file is not valid JSON', async () => {
    writeTree(folder, { '.claude/settings.json': '{ this is not json' });

    await installProjectNotificationHooks(projectWith({ completion: { enabled: true } }));

    // Refusing to write would leave the hook silently broken, so a corrupt file is replaced.
    expect(groupsFor('Stop')).toHaveLength(1);
  });

  it('shares the Stop event between the completion and pet hooks without clobbering', async () => {
    await installProjectNotificationHooks(
      projectWith({ completion: { enabled: true }, pet: { enabled: true } }),
    );

    const commands = groupsFor('Stop').map((group) => group.hooks[0].command ?? '');
    expect(commands.some((one) => one.includes('notify-completion.cjs'))).toBe(true);
    expect(commands.some((one) => one.includes('notify-pet.cjs'))).toBe(true);
    expect(commands).toHaveLength(2);
  });
});

describe('listClaudeHooks', () => {
  it('reads both settings files and encodes where each hook lives', async () => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          Stop: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo one' }] },
            { hooks: [{ type: 'command', command: 'echo two' }] },
          ],
        },
      }),
      '.claude/settings.local.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo local' }] }] },
      }),
    });

    const hooks = await listClaudeHooks(folder);

    expect(hooks.map((one) => one.id)).toEqual([
      'settings.json:Stop:0:0',
      'settings.json:Stop:1:0',
      'settings.local.json:PreToolUse:0:0',
    ]);
    expect(hooks[0].matcher).toBe('Bash');
    expect(hooks[1].matcher).toBeUndefined();
    expect(hooks[2].event).toBe('PreToolUse');
  });

  it('flags the hooks Runova generated', async () => {
    await installProjectNotificationHooks(projectWith({ completion: { enabled: true } }));
    writeTree(folder, {
      '.claude/settings.local.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    });

    const hooks = await listClaudeHooks(folder);

    // The UI only offers to manage the ones Runova owns, so this flag has to be right.
    expect(hooks.find((one) => one.managedByRunova)?.hook.command).toContain(
      'notify-completion.cjs',
    );
    expect(hooks.filter((one) => one.managedByRunova)).toHaveLength(1);
  });

  it('attributes a hook to another agent only when its executable is a standalone token', async () => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'codex exec "say done"' }] },
            { hooks: [{ type: 'command', command: 'node ./geminid-helper.js' }] },
            { hooks: [{ type: 'command', command: 'echo plain' }] },
          ],
        },
      }),
    });

    const hooks = await listClaudeHooks(folder);

    expect(hooks[0].cliId).toBe('codex-cli');
    // "geminid" is not "gemini", so a substring match here would misattribute the hook.
    expect(hooks[1].cliId).toBe('claude-code');
    expect(hooks[2].cliId).toBe('claude-code');
  });

  it('returns nothing when the project has no Claude settings', async () => {
    await expect(listClaudeHooks(folder)).resolves.toEqual([]);
  });
});

describe('updateClaudeHook', () => {
  beforeEach(() => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo one' }] }],
        },
      }),
    });
  });

  it('replaces the hook body and the matcher', async () => {
    await updateClaudeHook(folder, 'settings.json:Stop:0:0', {
      matcher: 'Write',
      hook: { type: 'command', command: 'echo changed', timeout: 10 },
    });

    expect(groupsFor('Stop')[0]).toEqual({
      matcher: 'Write',
      hooks: [{ type: 'command', command: 'echo changed', timeout: 10 }],
    });
  });

  it('drops the matcher when the update leaves it out', async () => {
    await updateClaudeHook(folder, 'settings.json:Stop:0:0', {
      hook: { type: 'command', command: 'echo one' },
    });

    // An empty matcher means "every tool", so it has to be removed rather than left as ''.
    expect(groupsFor('Stop')[0].matcher).toBeUndefined();
  });

  it('refuses an id that points at nothing', async () => {
    await expect(updateClaudeHook(folder, 'settings.json:Stop:9:0', { hook: {} })).rejects.toThrow(
      'not found',
    );
  });

  it.each(['nonsense', 'other.json:Stop:0:0', 'settings.json::0:0', 'settings.json:Stop:x:0'])(
    'refuses the malformed id %s',
    async (id) => {
      await expect(updateClaudeHook(folder, id, { hook: {} })).rejects.toThrow('Invalid hook id');
    },
  );
});

describe('deleteClaudeHook', () => {
  it('removes one hook and leaves its siblings', async () => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'keep me' },
                { type: 'command', command: 'drop me' },
              ],
            },
          ],
        },
      }),
    });

    await deleteClaudeHook(folder, 'settings.json:Stop:0:1');

    expect(groupsFor('Stop')).toEqual([{ hooks: [{ type: 'command', command: 'keep me' }] }]);
  });

  it('cleans up the empty group, the event and the hooks key', async () => {
    writeTree(folder, {
      '.claude/settings.json': JSON.stringify({
        model: 'opus',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'only one' }] }] },
      }),
    });

    await deleteClaudeHook(folder, 'settings.json:Stop:0:0');

    const settings = claudeSettings();
    // Leaving `hooks: {}` behind would show up as a diff in the user's own repository.
    expect(settings.hooks).toBeUndefined();
    expect(settings.model).toBe('opus');
  });

  it('refuses an id that points at nothing', async () => {
    writeTree(folder, { '.claude/settings.json': JSON.stringify({ hooks: {} }) });

    await expect(deleteClaudeHook(folder, 'settings.json:Stop:0:0')).rejects.toThrow('not found');
  });
});
