import { describe, expect, it } from 'vitest';
import type { SupportedOS } from '../cli/registry.js';
import {
  AGENT_TOOL_REGISTRY,
  getAgentToolDefinition,
  getDockerRemoveCommand,
  getDockerResetCommand,
  getDockerRunCommand,
  getDockerStartCommand,
  getDockerStopCommand,
  getInteractiveLaunchCommandForCurrentOS,
  getToolInstallCommandForCurrentOS,
  getToolUninstallCommandForCurrentOS,
  getToolUpdateCommandForCurrentOS,
  SECURITY_TOOL_CATEGORY,
} from './registry.js';
import type { AgentToolDefinition } from './types.js';

/**
 * Every command built here is opened in a terminal for the user to confirm, so the
 * invariants are about a tool never reaching the UI half-wired: an install kind with
 * no matching instructions, a Docker block with no container name, or a settings
 * wizard whose fields do not line up with the action it builds.
 */

const PLATFORMS: SupportedOS[] = ['win32', 'darwin', 'linux'];

function withDocker(): AgentToolDefinition[] {
  return AGENT_TOOL_REGISTRY.filter((tool) => tool.docker);
}

describe('AGENT_TOOL_REGISTRY invariants', () => {
  it('is populated', () => {
    expect(AGENT_TOOL_REGISTRY.length).toBeGreaterThan(0);
  });

  it('has unique ids, which key the installed-tool records', () => {
    const ids = AGENT_TOOL_REGISTRY.map((tool) => tool.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('has unique names, so two cards never read the same', () => {
    const names = AGENT_TOOL_REGISTRY.map((tool) => tool.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it('uses ids that are safe as a settings key and a container name suffix', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      expect(tool.id, tool.id).toMatch(/^[a-z0-9]+([._-][a-z0-9]+)*$/);
    }
  });

  it('gives every tool the text the card shows', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      expect(tool.name.trim(), tool.id).not.toBe('');
      expect(tool.description.trim(), tool.id).not.toBe('');
      expect(tool.category.trim(), tool.id).not.toBe('');
      expect(tool.author.trim(), tool.id).not.toBe('');
      expect(tool.repositoryUrl, tool.id).toMatch(/^https?:\/\/\S+$/);
    }
  });

  it('uses http(s) for the optional website link', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (!tool.websiteUrl) continue;
      expect(tool.websiteUrl, tool.id).toMatch(/^https?:\/\/\S+$/);
    }
  });

  it('keeps tags non-empty and free of duplicates', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      for (const tag of tool.tags) expect(tag.trim(), tool.id).not.toBe('');
      expect(new Set(tool.tags).size, tool.id).toBe(tool.tags.length);
    }
  });

  it('backs every install kind with the instructions that kind needs', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (tool.installKind === 'shell') {
        // Without a command for at least one OS the Install button does nothing.
        expect(Object.keys(tool.installCommand ?? {}).length, tool.id).toBeGreaterThan(0);
      }
      if (tool.installKind === 'manual') {
        expect(tool.manualInstallInstructions?.trim(), tool.id).toBeTruthy();
      }
      if (tool.installKind === 'interactive') {
        expect(tool.interactiveInstall, tool.id).toBeDefined();
        expect(tool.interactiveInstall?.pasteCommands.trim(), tool.id).toBeTruthy();
        expect(
          Object.keys(tool.interactiveInstall?.launchCommand ?? {}).length,
          tool.id,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('never leaves a per-OS command blank', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      const maps = [
        tool.installCommand,
        tool.updateCommand,
        tool.uninstallCommand,
        tool.interactiveInstall?.launchCommand,
      ];
      for (const map of maps) {
        for (const [os, command] of Object.entries(map ?? {})) {
          expect(PLATFORMS as string[], `${tool.id} ${os}`).toContain(os);
          expect(command?.trim(), `${tool.id} ${os}`).toBeTruthy();
        }
      }
    }
  });

  it('names a package for every update check', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (!tool.updateCheck) continue;
      expect(tool.updateCheck.package.trim(), tool.id).not.toBe('');
      if (tool.updateCheck.type === 'github-release') {
        expect(tool.updateCheck.package, tool.id).toMatch(/^[^/\s]+\/[^/\s]+$/);
      }
    }
  });

  it('gives every detect probe an executable name with no shell syntax in it', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (!tool.detectCommand) continue;
      expect(tool.detectCommand.command.trim(), tool.id).not.toBe('');
      expect(tool.detectCommand.command, tool.id).not.toMatch(/[\s|&><]/);
    }
  });

  it('gives every Docker block an image and a namespaced container name', () => {
    for (const tool of withDocker()) {
      const docker = tool.docker;
      if (!docker) continue;
      expect(docker.image.trim(), tool.id).not.toBe('');
      expect(docker.containerName, tool.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
      // One shared prefix keeps Runova's containers apart from the user's own.
      expect(docker.containerName, tool.id).toMatch(/^runova-/);
      if (docker.dashboardUrl) expect(docker.dashboardUrl, tool.id).toMatch(/^https?:\/\/\S+$/);
    }
  });

  it('keeps Docker container names unique across tools', () => {
    const names = withDocker().map((tool) => tool.docker?.containerName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every settings field a key, a label and a default of its own type', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      const fields = tool.settingsFields ?? [];
      const keys = fields.map((field) => field.key);
      expect(new Set(keys).size, tool.id).toBe(keys.length);
      for (const field of fields) {
        expect(field.key, tool.id).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
        expect(field.label.trim(), `${tool.id}.${field.key}`).not.toBe('');
        if (field.type === 'boolean') {
          expect(typeof field.defaultValue, `${tool.id}.${field.key}`).toBe('boolean');
        } else {
          expect(typeof field.defaultValue, `${tool.id}.${field.key}`).toBe('string');
        }
        if (field.type === 'select') {
          expect(field.options?.length, `${tool.id}.${field.key}`).toBeGreaterThan(0);
          const values = field.options?.map((option) => option.value) ?? [];
          expect(new Set(values).size, `${tool.id}.${field.key}`).toBe(values.length);
          // A default the dropdown cannot show would leave the field looking empty.
          expect(values, `${tool.id}.${field.key}`).toContain(field.defaultValue);
        }
      }
    }
  });

  it('only defines settings fields for a tool that does something with them', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (!tool.settingsFields?.length) continue;
      expect(tool.buildSettingsAction, tool.id).toBeTypeOf('function');
    }
  });

  it('builds a usable action from every settings wizard, using the field defaults', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (!tool.buildSettingsAction) continue;
      const values = Object.fromEntries(
        (tool.settingsFields ?? []).map((field) => [field.key, field.defaultValue]),
      );
      const action = tool.buildSettingsAction(values);
      if (action.kind === 'command') {
        expect(action.command.trim(), tool.id).not.toBe('');
        expect(['project', 'none'], tool.id).toContain(action.cwd);
      } else if (action.kind === 'write-project-file') {
        // Written through the sandboxed fs IPC, so it has to stay inside the project.
        expect(action.relativePath, tool.id).not.toMatch(/^([a-zA-Z]:|[/\\])/);
        expect(action.relativePath.split(/[\\/]/), tool.id).not.toContain('..');
        expect(action.content, tool.id).not.toContain('undefined');
      } else {
        expect(action.content.trim(), tool.id).not.toBe('');
        expect(action.instructions.trim(), tool.id).not.toBe('');
      }
    }
  });

  it('gives every quick action a unique id, a label and a valid action', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      const actions = tool.quickActions ?? [];
      const ids = actions.map((action) => action.id);
      expect(new Set(ids).size, tool.id).toBe(ids.length);
      for (const quick of actions) {
        expect(quick.label.trim(), `${tool.id}.${quick.id}`).not.toBe('');
        expect(['command', 'write-project-file', 'copy-text'], `${tool.id}.${quick.id}`).toContain(
          quick.action.kind,
        );
      }
    }
  });

  it('uses the shared security category label rather than a retyped string', () => {
    const security = AGENT_TOOL_REGISTRY.filter((tool) => tool.category === SECURITY_TOOL_CATEGORY);
    expect(security.length).toBeGreaterThan(0);
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (!/security/i.test(tool.category)) continue;
      expect(tool.category, tool.id).toBe(SECURITY_TOOL_CATEGORY);
    }
  });
});

describe('getAgentToolDefinition', () => {
  it('finds a tool by id', () => {
    expect(getAgentToolDefinition(AGENT_TOOL_REGISTRY[0].id)).toBe(AGENT_TOOL_REGISTRY[0]);
  });

  it('returns undefined for an unknown or empty id', () => {
    expect(getAgentToolDefinition('no-such-tool')).toBeUndefined();
    expect(getAgentToolDefinition('')).toBeUndefined();
  });
});

describe('per-OS command lookups', () => {
  it('return the listed command or null, never undefined', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      for (const os of PLATFORMS) {
        expect(getToolInstallCommandForCurrentOS(tool, os), tool.id).toBe(
          tool.installCommand?.[os] ?? null,
        );
        expect(getToolUninstallCommandForCurrentOS(tool, os), tool.id).toBe(
          tool.uninstallCommand?.[os] ?? null,
        );
        expect(getInteractiveLaunchCommandForCurrentOS(tool, os), tool.id).toBe(
          tool.interactiveInstall?.launchCommand[os] ?? null,
        );
      }
    }
  });

  it('fall back from update to install, since most tools upgrade in place', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      for (const os of PLATFORMS) {
        expect(getToolUpdateCommandForCurrentOS(tool, os), `${tool.id} ${os}`).toBe(
          tool.updateCommand?.[os] ?? tool.installCommand?.[os] ?? null,
        );
      }
    }
  });

  it('never use && on Windows, where the terminal is PowerShell 5.1', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      const commands = [
        getToolInstallCommandForCurrentOS(tool, 'win32'),
        getToolUpdateCommandForCurrentOS(tool, 'win32'),
        getToolUninstallCommandForCurrentOS(tool, 'win32'),
      ];
      for (const command of commands) expect(command ?? '', tool.id).not.toContain('&&');
    }
  });

  it('never write to /usr/local/bin or call sudo, since the terminal runs as the user', () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      for (const os of PLATFORMS) {
        const commands = [
          getToolInstallCommandForCurrentOS(tool, os),
          getToolUpdateCommandForCurrentOS(tool, os),
          getToolUninstallCommandForCurrentOS(tool, os),
        ];
        for (const command of commands) {
          expect(command ?? '', `${tool.id} ${os}`).not.toContain('/usr/local/bin');
          expect(command ?? '', `${tool.id} ${os}`).not.toMatch(/\bsudo\b/);
        }
      }
    }
  });

  it('install Semgrep with pipx rather than pip, which PEP 668 blocks on most systems', () => {
    const semgrep = getAgentToolDefinition('semgrep');
    if (!semgrep) throw new Error('semgrep missing from the registry');
    for (const os of PLATFORMS) {
      expect(getToolInstallCommandForCurrentOS(semgrep, os), os).toContain('pipx install semgrep');
    }
  });
});

describe('Docker commands', () => {
  it('are all null for a tool with no Docker option', () => {
    const plain = AGENT_TOOL_REGISTRY.find((tool) => !tool.docker);
    expect(plain, 'expected at least one tool without Docker').toBeDefined();
    if (!plain) return;
    expect(getDockerRunCommand(plain)).toBeNull();
    expect(getDockerStartCommand(plain)).toBeNull();
    expect(getDockerStopCommand(plain)).toBeNull();
    expect(getDockerResetCommand(plain)).toBeNull();
    expect(getDockerRemoveCommand(plain)).toBeNull();
  });

  it('name the container and the image on every run command', () => {
    for (const tool of withDocker()) {
      const command = getDockerRunCommand(tool) ?? '';
      expect(command, tool.id).toMatch(/^docker run -d --name /);
      expect(command, tool.id).toContain(tool.docker?.containerName ?? '');
      expect(command, tool.id).toContain(tool.docker?.image ?? '');
      // The image goes last unless the entrypoint needs a subcommand after it.
      if (!tool.docker?.imageArgs?.length) {
        expect(command.endsWith(tool.docker?.image ?? ''), tool.id).toBe(true);
      }
      expect(command, tool.id).not.toContain('  ');
    }
  });

  it('put image args after the image, where the entrypoint reads them', () => {
    for (const tool of withDocker()) {
      const imageArgs = tool.docker?.imageArgs ?? [];
      if (imageArgs.length === 0) continue;
      const command = getDockerRunCommand(tool) ?? '';
      expect(command.endsWith(imageArgs.join(' ')), tool.id).toBe(true);
      expect(command.indexOf(tool.docker?.image ?? ''), tool.id).toBeLessThan(
        command.indexOf(imageArgs[0]),
      );
    }
  });

  it('address the container by name for start, stop and remove', () => {
    for (const tool of withDocker()) {
      const name = tool.docker?.containerName ?? '';
      expect(getDockerStartCommand(tool), tool.id).toBe(`docker start ${name}`);
      expect(getDockerStopCommand(tool), tool.id).toBe(`docker stop ${name}`);
      expect(getDockerRemoveCommand(tool), tool.id).toBe(`docker rm -f ${name}`);
    }
  });

  it('make reset a remove followed by the same run command', () => {
    for (const tool of withDocker()) {
      expect(getDockerResetCommand(tool), tool.id).toBe(
        `${getDockerRemoveCommand(tool)} && ${getDockerRunCommand(tool)}`,
      );
      expect(getDockerResetCommand(tool, 'darwin'), tool.id).toBe(
        `${getDockerRemoveCommand(tool)} && ${getDockerRunCommand(tool)}`,
      );
    }
  });

  it('joins the reset steps with ; on Windows, where PowerShell 5.1 has no &&', () => {
    for (const tool of withDocker()) {
      expect(getDockerResetCommand(tool, 'win32'), tool.id).toBe(
        `${getDockerRemoveCommand(tool)}; ${getDockerRunCommand(tool)}`,
      );
    }
  });
});
