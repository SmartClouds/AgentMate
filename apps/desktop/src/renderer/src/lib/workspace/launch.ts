import {
  AGENT_TYPE_CLI_ID,
  type AgentHistoryProvider,
  type AgentHistorySession,
  buildAgentLaunchCommand,
  type CliLaunchDefault,
  getCliDefinition,
  type Project,
  quoteForShell,
  shellKindFor,
} from '@runova/core';
import type { SshSavedServer } from '@shared/apiTypes';
import { toast } from 'sonner';
import { terminalRuntime } from '@/lib/terminal/terminalRuntime';
import { useCliStore } from '@/stores/cliStore';
import { defaultNewSession, useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceStore, type WorkspaceTerminalTab } from '@/stores/workspaceStore';

export interface ShellOption {
  shell: string;
  label: string;
}

/** The shells main is willing to start on this platform, the default first. */
export function shellOptions(): ShellOption[] {
  const platform = window.runova.platform;
  if (platform === 'win32') {
    return [
      { shell: 'powershell.exe', label: 'PowerShell' },
      { shell: 'pwsh.exe', label: 'PowerShell 7' },
      { shell: 'cmd.exe', label: 'Command Prompt' },
    ];
  }
  const all: ShellOption[] = [
    { shell: 'zsh', label: 'zsh' },
    { shell: 'bash', label: 'bash' },
    { shell: 'fish', label: 'fish' },
  ];
  const first = defaultNewSession().shell;
  return [...all.filter((o) => o.shell === first), ...all.filter((o) => o.shell !== first)];
}

/** The agent a project works with: its own pick, else the app default, else its agent type's CLI. */
export function projectCliId(project: Project): string | null {
  return (
    project.cliId ?? useCliStore.getState().defaultCliId ?? AGENT_TYPE_CLI_ID[project.agentType]
  );
}

/** Settings files that make a CLI report its status through hooks, fetched ahead of launch. */
const statusHookSettings = new Map<string, string | null>();
/** The lookups still in flight, so a launch that runs at startup can wait for its hooks. */
const statusHookLookups = new Map<string, Promise<unknown>>();

/**
 * Looks up, once per CLI, whether its launches can carry status hooks. Called at startup so
 * a launch never has to wait on it.
 */
export function prepareStatusHooks(cliIds: string[]): void {
  for (const cliId of cliIds) {
    if (statusHookSettings.has(cliId)) continue;
    statusHookSettings.set(cliId, null);
    statusHookLookups.set(
      cliId,
      window.runova.agents
        .statusHookSettings(cliId)
        .then((path) => statusHookSettings.set(cliId, path))
        .catch(() => undefined),
    );
  }
}

/**
 * The command a workspace tab types to start a CLI: status hooks when available, the launch
 * defaults from Settings, then the run arguments (a model and effort). A launch default only fills
 * in what the run arguments don't already set. The Arguments box from AI CLI Manager is left out on
 * purpose: it only applies to background tasks. `skipLaunchDefaults` drops the launch defaults,
 * for a launch that asked to start bare.
 */
function agentCommand(
  cliId: string,
  shell: string | undefined,
  runArgs: string[] = [],
  leadingArgs: string[] = [],
  skipLaunchDefaults = false,
): string | null {
  const { cliLaunchDefaults } = useCliStore.getState();
  return buildAgentLaunchCommand({
    cliId,
    shellKind: shellKindFor(shell, window.runova.platform),
    launchDefaults: cliLaunchDefaults[cliId],
    runArgs,
    leadingArgs,
    hookSettingsPath: statusHookSettings.get(cliId),
    skipLaunchDefaults,
  });
}

export interface PromptLaunch {
  cliId: string;
  prompt: string;
  /** Model and effort flags for this CLI, e.g. from the prompt's run recommendation. */
  runArgs?: string[];
  /** Shown on the tab, e.g. "Opus 5.5 · High". */
  runLabel?: string;
}

/**
 * Opens an agent tab and starts the CLI right away, with the model and effort it was given.
 * The prompt is not part of the command: it is pasted into the CLI's own input box once the CLI
 * has finished starting, exactly as if the user had pasted it, and left unsubmitted so they read
 * it over and press Enter.
 */
export function launchPromptTab(
  project: Project,
  launch: PromptLaunch,
  groupId?: string,
): string | null {
  const cli = getCliDefinition(launch.cliId);
  const shell = defaultNewSession().shell;
  const command = agentCommand(launch.cliId, shell, launch.runArgs);
  if (!cli || !command) {
    toast.error('Unknown CLI.');
    return null;
  }
  const store = useWorkspaceStore.getState();
  store.openProject(project.id);
  const tabId = store.addTerminal(
    project.id,
    {
      title: cli.name,
      cliId: launch.cliId,
      shell,
      cwd: project.folderPath,
      launchInput: `${command}\r`,
      runLabel: launch.runLabel,
    },
    groupId,
  );
  // Nothing is typed into a shell that never got the CLI up: the prompt would run as commands.
  // It goes to the clipboard instead, so the user can paste it once they have sorted the CLI out.
  void terminalRuntime.deliverPrompt(tabId, launch.prompt).then((delivered) => {
    if (delivered) return;
    void navigator.clipboard.writeText(launch.prompt);
    toast.warning(`${cli.name} did not come up`, {
      description: 'The prompt is on your clipboard, ready to paste once the CLI is running.',
    });
  });
  return tabId;
}

export interface AgentLaunchOptions {
  /** Start bare: without this CLI's launch defaults from Settings. */
  skipLaunchDefaults?: boolean;
  /** Model and effort flags picked for this one launch. They win over the launch defaults. */
  runArgs?: string[];
  /** Shown on the tab, e.g. "Opus 5.5 · High". */
  runLabel?: string;
}

/**
 * Opens a tab in the project's workspace that starts an agent CLI. Returns the tab id. The model,
 * effort, and mode come from the CLI's launch defaults in Settings, except where `runArgs` set
 * them for this launch. Whatever is not set is left to the CLI's own default (for Claude Code,
 * the last `/model` pick).
 */
export function launchAgentTab(
  project: Project,
  cliId: string,
  groupId?: string,
  options?: AgentLaunchOptions,
): string | null {
  const cli = getCliDefinition(cliId);
  const shell = defaultNewSession().shell;
  const skipLaunchDefaults = options?.skipLaunchDefaults ?? false;
  const command = agentCommand(cliId, shell, options?.runArgs ?? [], [], skipLaunchDefaults);
  if (!cli || !command) {
    toast.error('Unknown CLI.');
    return null;
  }
  const store = useWorkspaceStore.getState();
  store.openProject(project.id);
  return store.addTerminal(
    project.id,
    {
      title: cli.name,
      cliId,
      shell,
      cwd: project.folderPath,
      launchInput: `${command}\r`,
      runLabel: options?.runLabel ?? (skipLaunchDefaults ? 'Without launch defaults' : undefined),
    },
    groupId,
  );
}

/** The CLI that owns each kind of saved conversation. */
export const HISTORY_CLI_ID: Record<AgentHistoryProvider, string> = {
  'claude-code': 'claude-code',
  openclaude: 'openclaude',
  codex: 'codex-cli',
  'gemini-cli': 'gemini-cli',
  'qwen-cli': 'qwen-cli',
  'cursor-cli': 'cursor-cli',
  'continue-cli': 'continue-cli',
  'grok-cli': 'grok-cli',
  'cline-cli': 'cline-cli',
  opencode: 'opencode',
  'freebuff-cli': 'freebuff-cli',
};

/**
 * Whether a saved conversation can be resumed from a fresh tab. Codex uses a
 * positional `resume <id>`, OpenCode a `--session <id>` flag and FreeBuff a
 * `--continue <id>` flag; every other supported CLI resumes with
 * `--resume <id>`. Providers without a known resume spelling return null and
 * the UI disables the resume action with a reason.
 */
export function resumeArgsFor(
  provider: AgentHistoryProvider,
  id: string,
): {
  runArgs?: string[];
  leadingArgs?: string[];
} | null {
  if (provider === 'codex') return { leadingArgs: ['resume', id] };
  if (provider === 'opencode') return { leadingArgs: ['--session', id] };
  if (provider === 'freebuff-cli') return { leadingArgs: ['--continue', id] };
  return { runArgs: ['--resume', id] };
}

/** Why a conversation cannot be resumed right now, if at all. */
export function resumeDisabledReasonFor(
  session: Pick<AgentHistorySession, 'provider'>,
): string | null {
  return resumeArgsFor(session.provider, 'x')
    ? null
    : `Resume is not supported for ${session.provider} yet.`;
}

/**
 * Opens a tab that picks a past conversation back up: `claude --resume <id>`,
 * `codex resume <id>`, `opencode --session <id>`, and so on, with the user's
 * usual arguments.
 */
export function launchResumeTab(
  project: Project,
  session: Pick<AgentHistorySession, 'provider' | 'id' | 'title' | 'firstPrompt'>,
  groupId?: string,
): string | null {
  const cliId = HISTORY_CLI_ID[session.provider];
  const cli = getCliDefinition(cliId);
  const shell = defaultNewSession().shell;
  const resume = resumeArgsFor(session.provider, session.id);
  if (!resume) {
    toast.error(`Resume is not supported for ${session.provider} yet.`);
    return null;
  }
  const command = agentCommand(cliId, shell, resume.runArgs ?? [], resume.leadingArgs ?? []);
  if (!cli || !command) {
    toast.error('Unknown CLI.');
    return null;
  }
  const label = session.title ?? session.firstPrompt;
  const store = useWorkspaceStore.getState();
  store.openProject(project.id);
  return store.addTerminal(
    project.id,
    {
      title: cli.name,
      cliId,
      shell,
      cwd: project.folderPath,
      launchInput: `${command}\r`,
      runLabel: label
        ? `Resumed: ${label.length > 60 ? `${label.slice(0, 59)}…` : label}`
        : undefined,
    },
    groupId,
  );
}

/**
 * The line an SSH tab types to pick up a conversation stored on that server: a `cd` into the
 * folder it ran in (when known), then the resume command with the user's launch defaults. It runs
 * in the server's shell, so it is quoted for POSIX. Status hooks are left out: their settings
 * file lives on this machine, not on the server.
 */
export function remoteResumeCommand(
  session: Pick<AgentHistorySession, 'provider' | 'id' | 'cwd'>,
  launchDefaults?: CliLaunchDefault,
): string | null {
  const resume = resumeArgsFor(session.provider, session.id);
  if (!resume) return null;
  const command = buildAgentLaunchCommand({
    cliId: HISTORY_CLI_ID[session.provider],
    shellKind: 'posix',
    launchDefaults,
    hookSettingsPath: null,
    ...resume,
  });
  if (!command) return null;
  return session.cwd
    ? `cd -- ${quoteForShell(session.cwd, 'posix')} && ${command}\r`
    : `${command}\r`;
}

/** How much of a conversation's title or first prompt fits on a remote resume tab. */
const REMOTE_RESUME_LABEL_MAX = 40;

/**
 * Picks up a conversation stored on a saved server in an SSH tab of the terminal drawer. A tab
 * already resuming it on that server is brought back instead of opening a second one. Returns
 * the tab id.
 */
export function openRemoteResume(
  server: SshSavedServer,
  session: AgentHistorySession,
): string | null {
  const terminal = useTerminalStore.getState();
  const existing = terminal.findSshConversationTab(server.id, session.id);
  if (existing) {
    terminal.setActiveSession(existing);
    terminal.openDrawer();
    return existing;
  }
  const cliId = HISTORY_CLI_ID[session.provider];
  const initialInput = remoteResumeCommand(
    session,
    useCliStore.getState().cliLaunchDefaults[cliId],
  );
  if (!initialInput) {
    toast.error('Unknown CLI.');
    return null;
  }
  const label = session.title ?? session.firstPrompt;
  const short =
    label && label.length > REMOTE_RESUME_LABEL_MAX
      ? `${label.slice(0, REMOTE_RESUME_LABEL_MAX - 1)}…`
      : label;
  return terminal.openSshSession(server, {
    title: short ? `${server.nickname} · ${short}` : server.nickname,
    initialInput,
    conversationId: session.id,
  });
}

/**
 * The conversation a resume command picks up (`--resume <id>`, `resume <id>`
 * for Codex, `--session <id>` for OpenCode, `--continue <id>` for FreeBuff).
 */
export function resumedConversationId(launchInput: string | undefined): string | null {
  return (
    launchInput?.match(
      /(?:--resume|resume|--session|--continue|continue)\s+'?"?([0-9a-zA-Z_-]{8,})/,
    )?.[1] ?? null
  );
}

/** Settles once the status hook lookup for this CLI (if one was started) is done. */
export async function statusHooksReady(cliId: string | undefined): Promise<void> {
  if (cliId) await statusHookLookups.get(cliId);
}

/**
 * The command that picks an agent tab's conversation back up in a new shell, or null when the
 * tab is not an agent or never got far enough to have a conversation worth resuming.
 */
export function resumeInputFor(tab: WorkspaceTerminalTab): string | null {
  const id = tab.conversationId ?? resumedConversationId(tab.launchInput);
  if (!id) return null;
  // Map the tab's CLI back to its history provider; unknown CLIs cannot resume.
  if (!tab.cliId) return null;
  const entry = (Object.entries(HISTORY_CLI_ID) as [AgentHistoryProvider, string][]).find(
    ([, cliId]) => cliId === tab.cliId,
  );
  if (!entry) return null;
  const resume = resumeArgsFor(entry[0], id);
  if (!resume) return null;
  const command = agentCommand(
    tab.cliId,
    tab.shell,
    resume.runArgs ?? [],
    resume.leadingArgs ?? [],
  );
  return command ? `${command}\r` : null;
}

/**
 * What a setup tab types: the command, then an exit that only runs when it succeeded. A clean
 * exit closes the tab (plain shells do, see WorkspaceHost), so a finished install tidies itself
 * away, while a failed one stays open with its error on screen.
 */
export function setupInput(command: string, shell: string | undefined, platform: string): string {
  const kind = shellKindFor(shell, platform);
  const exit =
    kind === 'powershell' ? '; if ($?) { exit }' : kind === 'fish' ? '; and exit' : ' && exit';
  return `${command}${exit}\r`;
}

/** Runs a worktree's setup command (an install, say) in a tab of its own. Returns the tab id. */
export function launchSetupTab(project: Project, command: string, groupId?: string): string {
  const shell = defaultNewSession().shell;
  const store = useWorkspaceStore.getState();
  store.openProject(project.id);
  return store.addTerminal(
    project.id,
    {
      title: 'Setup',
      shell,
      cwd: project.folderPath,
      launchInput: setupInput(command, shell, window.runova.platform),
    },
    groupId,
  );
}

/** Opens a plain shell tab in the project folder, or in `cwd` inside it. Returns the tab id. */
export function launchShellTab(
  project: Project,
  shell?: string,
  groupId?: string,
  cwd: string = project.folderPath,
): string {
  const option = shellOptions().find((o) => o.shell === shell) ?? {
    shell: defaultNewSession().shell ?? '',
    label: defaultNewSession().title,
  };
  const store = useWorkspaceStore.getState();
  store.openProject(project.id);
  return store.addTerminal(
    project.id,
    { title: option.label, shell: option.shell || undefined, cwd },
    groupId,
  );
}
