import type { SupportedOS } from '../cli/registry.js';
import {
  LANGUAGETOOL_DOWNLOAD_URL,
  LANGUAGETOOL_REPOSITORY_URL,
  LANGUAGETOOL_TOOL_ID,
  LANGUAGETOOL_WEBSITE_URL,
} from '../grammar/languagetool.js';
import { STRIX_DEFAULT_MODEL } from '../models/catalog.js';
import {
  buildDiffrayProjectConfig,
  DIFFRAY_EXECUTORS,
  DIFFRAY_REPOSITORY_URL,
  DIFFRAY_TOOL_ID,
  DIFFRAY_WEBSITE_URL,
} from './diffray.js';
import type { AgentToolDefinition } from './types.js';

/**
 * Curated agent-improvement tools (proxies, plugins, and indexers that reduce token spend or
 * make agents write better code), distinct from the MCP/skills marketplaces, since none of
 * these are MCP servers or skill packages. Install, update and uninstall commands were last
 * checked against each project's own README, docs and installer scripts on 2026-10-17; re-check
 * upstream before relying on exact flags, they may have changed since. Windows commands are typed
 * into Windows PowerShell 5.1, which has no `&&`, so two steps there are joined with `;`.
 */
/** Shared so the Tools page tab and the six scanner entries can never drift apart. */
export const SECURITY_TOOL_CATEGORY = 'Security & Code Scanning';

export const AGENT_TOOL_REGISTRY: AgentToolDefinition[] = [
  {
    id: '9router',
    name: '9Router',
    description:
      'Proxy that routes coding-agent requests across 40+ model providers with automatic subscription → budget → free-tier fallback, plus RTK-style output compression to cut token spend. Ships a local dashboard for connecting providers and watching quota usage.',
    category: 'Token & Cost Optimization',
    tags: ['proxy', 'cost-saving', 'model-routing'],
    author: 'decolua',
    official: false,
    repositoryUrl: 'https://github.com/decolua/9router',
    installKind: 'shell',
    installCommand: {
      win32: 'npm install -g 9router',
      darwin: 'npm install -g 9router',
      linux: 'npm install -g 9router',
    },
    updateCommand: {
      win32: 'npm install -g 9router@latest',
      darwin: 'npm install -g 9router@latest',
      linux: 'npm install -g 9router@latest',
    },
    updateCheck: { type: 'npm', package: '9router' },
    uninstallCommand: {
      win32: 'npm uninstall -g 9router',
      darwin: 'npm uninstall -g 9router',
      linux: 'npm uninstall -g 9router',
    },
    detectCommand: { command: '9router', args: ['--version'] },
    docker: {
      image: 'decolua/9router:latest',
      containerName: 'runova-9router',
      runArgs: ['-p', '20128:20128', '-v', '${HOME}/.9router:/app/data'],
      dashboardUrl: 'http://localhost:20128',
    },
    settingsFields: [
      { key: 'port', label: 'Dashboard port', type: 'text', defaultValue: '20128' },
      {
        key: 'initialPassword',
        label: 'Initial dashboard password',
        type: 'text',
        defaultValue: '123456',
        description: 'Change this after first login; 123456 is the published default.',
      },
    ],
    settingsScope: 'global',
    buildSettingsAction: (values) => ({
      kind: 'command',
      command:
        `docker run -d --name runova-9router -p ${values.port}:20128 ` +
        `-e INITIAL_PASSWORD=${values.initialPassword} -v \${HOME}/.9router:/app/data decolua/9router:latest`,
      cwd: 'none',
    }),
  },
  {
    id: 'ponytail',
    name: 'Ponytail',
    description:
      'Coding-agent plugin that enforces a "necessity → reuse → stdlib → one-liner" decision ladder so agents write minimal code instead of over-engineering, while never skipping validation, error handling, security, or accessibility.',
    category: 'Agent Behavior & Prompting',
    tags: ['prompting', 'code-minimalism', 'plugin'],
    author: 'DietrichGebert',
    official: false,
    repositoryUrl: 'https://github.com/DietrichGebert/ponytail',
    installKind: 'interactive',
    interactiveInstall: {
      launchCommand: { win32: 'claude', darwin: 'claude', linux: 'claude' },
      pasteCommands:
        '/plugin marketplace add DietrichGebert/ponytail\n/plugin install ponytail@ponytail',
    },
    manualUninstallInstructions: '/plugin uninstall ponytail@ponytail',
    settingsFields: [
      {
        key: 'mode',
        label: 'Intensity',
        type: 'select',
        options: [
          { value: 'lite', label: 'Lite' },
          { value: 'full', label: 'Full' },
          { value: 'ultra', label: 'Ultra' },
          { value: 'off', label: 'Off' },
        ],
        defaultValue: 'full',
      },
    ],
    settingsScope: 'global',
    buildSettingsAction: (values) => ({
      kind: 'copy-text',
      content: JSON.stringify({ mode: values.mode }, null, 2),
      instructions: 'Save as ~/.config/ponytail/config.json (all platforms).',
    }),
  },
  {
    id: 'rtk',
    name: 'RTK (Rust Token Killer)',
    description:
      'Rust CLI proxy that transparently compresses git/npm/grep/etc. command output before it reaches the model context, cutting agent token usage 60-90% with zero workflow changes.',
    category: 'Token & Cost Optimization',
    tags: ['proxy', 'cost-saving', 'cli'],
    author: 'rtk-ai',
    official: false,
    websiteUrl: 'https://www.rtk-ai.app/',
    repositoryUrl: 'https://github.com/rtk-ai/rtk',
    installKind: 'shell',
    // The install script handles macOS too (no sudo, ~/.local/bin, checks the SHA-256), so a Mac
    // without Homebrew can install it. A copy that did come from brew is still upgraded with brew,
    // because main picks the update by where the binary lives. Windows has a prebuilt winget
    // package now, which saves installing Rust just to compile it.
    installCommand: {
      darwin:
        'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh',
      linux:
        'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh',
      win32: 'winget install rtk-ai.rtk',
    },
    // The installer script is idempotent, so re-running it upgrades in place.
    updateCommand: {
      darwin:
        'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh',
      linux:
        'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh',
      win32: 'winget upgrade rtk-ai.rtk',
    },
    updateCheck: { type: 'github-release', package: 'rtk-ai/rtk' },
    // `rtk init -g --uninstall` removes the agent hook (the part that actually affects agent
    // behavior) on every OS; also uninstalling the binary itself is OS-specific (brew/cargo)
    // and left to the user, since we don't know which install method they used.
    uninstallCommand: {
      win32: 'rtk init -g --uninstall',
      darwin: 'rtk init -g --uninstall',
      linux: 'rtk init -g --uninstall',
    },
    detectCommand: { command: 'rtk', args: ['--version'] },
    settingsFields: [
      {
        key: 'agent',
        label: 'Target agent',
        type: 'select',
        options: [
          { value: 'claude-code', label: 'Claude Code (default)' },
          { value: 'copilot', label: 'GitHub Copilot' },
          { value: 'gemini', label: 'Gemini CLI' },
          { value: 'codex', label: 'Codex (OpenAI)' },
          { value: 'opencode', label: 'OpenCode' },
          { value: 'cursor', label: 'Cursor' },
          { value: 'windsurf', label: 'Windsurf' },
          { value: 'cline', label: 'Cline / Roo Code' },
          { value: 'kilocode', label: 'Kilo Code' },
          { value: 'antigravity', label: 'Google Antigravity' },
          { value: 'pi', label: 'Pi' },
          { value: 'hermes', label: 'Hermes' },
          { value: 'droid', label: 'Factory Droid' },
        ],
        defaultValue: 'claude-code',
      },
      { key: 'global', label: 'Install globally (-g)', type: 'boolean', defaultValue: true },
      {
        key: 'autoPatch',
        label: 'Non-interactive (--auto-patch)',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'hookOnly',
        label: 'Hook only, skip RTK.md (--hook-only)',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    settingsScope: 'project',
    buildSettingsAction: (values) => {
      const flagByAgent: Record<string, string> = {
        'claude-code': '',
        copilot: ' --copilot',
        gemini: ' --gemini',
        codex: ' --codex',
        opencode: ' --opencode',
        cursor: ' --agent cursor',
        windsurf: ' --agent windsurf',
        cline: ' --agent cline',
        kilocode: ' --agent kilocode',
        antigravity: ' --agent antigravity',
        pi: ' --agent pi',
        hermes: ' --agent hermes',
        droid: ' --agent droid',
      };
      let command = 'rtk init';
      if (values.global) command += ' -g';
      command += flagByAgent[String(values.agent)] ?? '';
      if (values.autoPatch) command += ' --auto-patch';
      if (values.hookOnly) command += ' --hook-only';
      return { kind: 'command', command, cwd: 'project' };
    },
  },
  {
    id: 'codegraph',
    name: 'CodeGraph',
    description:
      'Pre-indexes your codebase into a local knowledge graph (tree-sitter + SQLite), so symbol search, call-path tracing, and blast-radius checks are one query instead of a pile of grep/read calls. Re-syncs automatically on every file change.',
    category: 'Code Intelligence',
    tags: ['mcp', 'code-indexing', 'context-efficiency'],
    author: 'colbymchenry',
    official: false,
    repositoryUrl: 'https://github.com/colbymchenry/codegraph',
    installKind: 'shell',
    // The standalone installers bundle their own Node. Neither puts codegraph on this shell's
    // PATH, but the terminal Runova opens already has ~/.local/bin and
    // %LOCALAPPDATA%\codegraph\current\bin on it, so the `codegraph install` that wires up the
    // agents can run right after in the same line.
    installCommand: {
      win32:
        'irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex; codegraph install',
      darwin:
        'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh && codegraph install',
      linux:
        'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh && codegraph install',
    },
    // `codegraph upgrade` works out whether it came from the bundle, npm or npx. `codegraph
    // install` re-registers the MCP server, which the new build may have changed.
    updateCommand: {
      win32: 'codegraph upgrade; codegraph install',
      darwin: 'codegraph upgrade && codegraph install',
      linux: 'codegraph upgrade && codegraph install',
    },
    updateCheck: { type: 'npm', package: '@colbymchenry/codegraph' },
    uninstallCommand: {
      win32: 'codegraph uninstall',
      darwin: 'codegraph uninstall',
      linux: 'codegraph uninstall',
    },
    detectCommand: { command: 'codegraph', args: ['--version'] },
    quickActions: [
      {
        id: 'init',
        label: 'Initialize in project',
        action: { kind: 'command', command: 'codegraph init', cwd: 'project' },
      },
    ],
    settingsFields: [
      {
        key: 'exclude',
        label: 'Extra exclude globs (comma-separated)',
        type: 'text',
        defaultValue: '',
      },
      {
        key: 'include',
        label: 'Force-include globs (comma-separated)',
        type: 'text',
        defaultValue: '',
      },
    ],
    settingsScope: 'project',
    buildSettingsAction: (values) => {
      const toGlobs = (raw: string | boolean): string[] =>
        String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      const exclude = toGlobs(values.exclude);
      const include = toGlobs(values.include);
      return {
        kind: 'write-project-file',
        relativePath: 'codegraph.json',
        content: JSON.stringify(
          { ...(exclude.length && { exclude }), ...(include.length && { include }) },
          null,
          2,
        ),
      };
    },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description:
      'Self-hosted personal AI assistant gateway that runs on your own machine and answers from a multi-channel inbox (WhatsApp, Telegram, Slack, Discord, and more), with voice, a live Canvas view, and a local web UI on port 18789.',
    category: 'Agent Runtimes & Gateways',
    tags: ['gateway', 'self-hosted', 'multi-channel', 'docker'],
    author: 'openclaw',
    official: false,
    repositoryUrl: 'https://github.com/openclaw/openclaw',
    installKind: 'shell',
    // The official installers bring Node 24 when it is missing (OpenClaw refuses Node 22, 23 and
    // 25) and then start onboarding.
    installCommand: {
      win32: 'iwr -useb https://openclaw.ai/install.ps1 | iex',
      darwin: 'curl -fsSL https://openclaw.ai/install.sh | bash',
      linux: 'curl -fsSL https://openclaw.ai/install.sh | bash',
    },
    updateCommand: {
      win32: 'openclaw update',
      darwin: 'openclaw update',
      linux: 'openclaw update',
    },
    updateCheck: { type: 'npm', package: 'openclaw' },
    // `openclaw uninstall` removes the gateway service, state and workspace first; the installers
    // put the CLI itself in through npm, so npm removes it after.
    uninstallCommand: {
      win32: 'openclaw uninstall --all --yes --non-interactive; npm rm -g openclaw',
      darwin: 'openclaw uninstall --all --yes --non-interactive && npm rm -g openclaw',
      linux: 'openclaw uninstall --all --yes --non-interactive && npm rm -g openclaw',
    },
    detectCommand: { command: 'openclaw', args: ['--version'] },
    docker: {
      image: 'ghcr.io/openclaw/openclaw:latest',
      containerName: 'runova-openclaw',
      // Config and the auth-profile secrets live in separate dirs inside the image; both have to
      // be bind-mounted or the gateway re-onboards (and loses channel logins) on every recreate.
      runArgs: [
        '-p',
        '18789:18789',
        '-v',
        '${HOME}/.openclaw:/home/node/.openclaw',
        '-v',
        '${HOME}/.config/openclaw:/home/node/.config/openclaw',
      ],
      dashboardUrl: 'http://127.0.0.1:18789/',
    },
    quickActions: [
      {
        id: 'gateway',
        label: 'Start gateway (foreground)',
        action: {
          kind: 'command',
          command: 'openclaw gateway --port 18789 --verbose',
          cwd: 'none',
        },
      },
    ],
    settingsFields: [
      { key: 'port', label: 'Gateway port', type: 'text', defaultValue: '18789' },
      {
        key: 'gatewayToken',
        label: 'Gateway token',
        type: 'text',
        defaultValue: '',
        description:
          'Shared secret the web UI and clients authenticate with. Leave blank to let OpenClaw generate one on first run.',
      },
      {
        key: 'sandbox',
        label: 'Sandbox agent runs (mounts the Docker socket)',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    settingsScope: 'global',
    buildSettingsAction: (values) => {
      const token = String(values.gatewayToken).trim();
      const sandbox = values.sandbox
        ? ' -e OPENCLAW_SANDBOX=1 -v /var/run/docker.sock:/var/run/docker.sock'
        : '';
      return {
        kind: 'command',
        command:
          `docker run -d --name runova-openclaw -p ${values.port}:18789 ` +
          (token ? `-e OPENCLAW_GATEWAY_TOKEN=${token} ` : '') +
          '-v ${HOME}/.openclaw:/home/node/.openclaw ' +
          '-v ${HOME}/.config/openclaw:/home/node/.config/openclaw' +
          `${sandbox} ghcr.io/openclaw/openclaw:latest`,
        cwd: 'none',
      };
    },
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    description:
      'Self-improving agent from Nous Research that writes its own skills, keeps memory across sessions, and exposes an OpenAI-compatible gateway plus an optional web dashboard. Runs work on local, Docker, SSH, Modal, or Daytona backends.',
    category: 'Agent Runtimes & Gateways',
    tags: ['agent', 'self-hosted', 'skills', 'docker'],
    author: 'Nous Research',
    official: false,
    websiteUrl: 'https://hermes-agent.nousresearch.com',
    repositoryUrl: 'https://github.com/NousResearch/hermes-agent',
    installKind: 'shell',
    installCommand: {
      // The desktop terminal is PowerShell on Windows, so the PS installer runs as-is.
      win32: 'irm https://hermes-agent.nousresearch.com/install.ps1 | iex',
      darwin: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
      linux: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    },
    // `hermes update` is the documented upgrade path now, rather than re-running the installer.
    updateCommand: {
      win32: 'hermes update',
      darwin: 'hermes update',
      linux: 'hermes update',
    },
    updateCheck: { type: 'github-release', package: 'NousResearch/hermes-agent' },
    // Without --full this keeps ~/.hermes (config, skills, memories); the user can rerun with
    // --full themselves if they want the data gone too.
    uninstallCommand: {
      win32: 'hermes uninstall --yes',
      darwin: 'hermes uninstall --yes',
      linux: 'hermes uninstall --yes',
    },
    detectCommand: { command: 'hermes', args: ['--version'] },
    docker: {
      image: 'nousresearch/hermes-agent:latest',
      containerName: 'runova-hermes',
      runArgs: [
        '-p',
        '8642:8642',
        '-p',
        '9119:9119',
        '-e',
        'HERMES_DASHBOARD=1',
        '-v',
        '${HOME}/.hermes:/opt/data',
      ],
      imageArgs: ['gateway', 'run'],
      dashboardUrl: 'http://localhost:9119',
    },
    quickActions: [
      {
        id: 'setup',
        label: 'Run setup wizard',
        action: { kind: 'command', command: 'hermes setup', cwd: 'none' },
      },
      {
        id: 'doctor',
        label: 'Diagnose and fix',
        action: { kind: 'command', command: 'hermes doctor --fix', cwd: 'none' },
      },
    ],
    settingsFields: [
      {
        key: 'gatewayPort',
        label: 'Gateway port (OpenAI-compatible API)',
        type: 'text',
        defaultValue: '8642',
      },
      { key: 'dashboard', label: 'Enable web dashboard', type: 'boolean', defaultValue: true },
      { key: 'dashboardPort', label: 'Dashboard port', type: 'text', defaultValue: '9119' },
    ],
    settingsScope: 'global',
    buildSettingsAction: (values) => {
      const dashboard = values.dashboard
        ? `-p ${values.dashboardPort}:9119 -e HERMES_DASHBOARD=1 `
        : '';
      return {
        kind: 'command',
        command:
          `docker run -d --name runova-hermes --restart unless-stopped ` +
          `-p ${values.gatewayPort}:8642 ${dashboard}` +
          '-v ${HOME}/.hermes:/opt/data nousresearch/hermes-agent:latest gateway run',
        cwd: 'none',
      };
    },
  },
  {
    id: DIFFRAY_TOOL_ID,
    name: 'diffray',
    description:
      'Free multi-agent code review CLI. Specialized agents (bugs, security, performance, consistency) review git diffs locally with Claude Code, Cursor Agent, OpenCode, or Codex. After install, each project gets a review wizard. Hosted PR reviews live at diffray.ai.',
    category: 'Code Intelligence',
    tags: ['code-review', 'multi-agent', 'cli'],
    author: 'diffray',
    official: false,
    websiteUrl: DIFFRAY_WEBSITE_URL,
    repositoryUrl: DIFFRAY_REPOSITORY_URL,
    installKind: 'shell',
    installCommand: {
      win32: 'npm install -g diffray',
      darwin: 'npm install -g diffray',
      linux: 'npm install -g diffray',
    },
    updateCommand: {
      win32: 'npm install -g diffray@latest',
      darwin: 'npm install -g diffray@latest',
      linux: 'npm install -g diffray@latest',
    },
    updateCheck: { type: 'npm', package: 'diffray' },
    uninstallCommand: {
      win32: 'npm uninstall -g diffray',
      darwin: 'npm uninstall -g diffray',
      linux: 'npm uninstall -g diffray',
    },
    detectCommand: { command: 'diffray', args: ['--version'] },
    quickActions: [
      {
        id: 'init',
        label: 'Initialize in project',
        action: { kind: 'command', command: 'diffray config init', cwd: 'project' },
      },
      {
        id: 'setup-command',
        label: 'Install /diffray slash command',
        action: { kind: 'command', command: 'diffray setup-command', cwd: 'none' },
      },
    ],
    settingsFields: [
      {
        key: 'executor',
        label: 'Review executor',
        type: 'select',
        options: DIFFRAY_EXECUTORS.map((executor) => ({
          value: executor.id,
          label: executor.label,
        })),
        defaultValue: 'claude-cli',
      },
      {
        key: 'excludeTests',
        label: 'Skip tests and build output',
        type: 'boolean',
        defaultValue: true,
        description: 'Writes excludePatterns for test files, dist, and node_modules.',
      },
    ],
    settingsScope: 'project',
    buildSettingsAction: buildDiffrayProjectConfig,
  },
  {
    id: LANGUAGETOOL_TOOL_ID,
    name: 'LanguageTool',
    description:
      "Grammar, spelling, and style checker behind Runova's writing checks. Install it here to run every check offline on this machine instead of sending text to LanguageTool's public API. Needs Java 17 or newer on PATH.",
    category: 'Writing & Docs',
    tags: ['grammar', 'offline', 'java'],
    author: 'LanguageTool',
    official: true,
    websiteUrl: LANGUAGETOOL_WEBSITE_URL,
    repositoryUrl: LANGUAGETOOL_REPOSITORY_URL,
    // No install command: it ships as a zip, and Runova runs the server out of
    // its own tools folder rather than installing anything system-wide. The card
    // has its own download/open-folder buttons instead.
    installKind: 'manual',
    manualInstallInstructions: `1. Download ${LANGUAGETOOL_DOWNLOAD_URL}\n2. Extract it into Runova's tools folder (the "Open tools folder" button opens it).\n3. Turn on "Use local LanguageTool" in Settings > AI > Writing check.`,
  },
  // --- Security & Code Scanning ---
  // Commands checked against each project's own docs on 2026-10-17. Semgrep has shipped native
  // Windows binaries since its Fall 2025 release, so it no longer needs WSL; Bearer still has no
  // Windows build at all, which is why its win32 path is Docker. The Trivy and Bearer scripts
  // install into ~/.local/bin, because /usr/local/bin needs sudo and the scripts never ask for it.
  {
    id: 'semgrep',
    name: 'Semgrep',
    description:
      'Pattern-based static analysis for 30+ languages, with a large community ruleset. Fast enough to run on every project and the best first security scan to reach for. Runs the scan from a project\u2019s Security tab. Installs through pipx (Python 3.10+), which is what Semgrep recommends now that plain pip refuses to install into a system Python on most Linux distros and on Homebrew.',
    category: SECURITY_TOOL_CATEGORY,
    tags: ['sast', 'static-analysis', 'security'],
    author: 'Semgrep',
    official: true,
    websiteUrl: 'https://semgrep.dev',
    repositoryUrl: 'https://github.com/semgrep/semgrep',
    installKind: 'shell',
    // Semgrep's quickstart: pipx (or uv) everywhere, brew only "best-effort". On Windows it also
    // asks for PYTHONUTF8=1 in the user environment first. A copy installed the old way, with pip
    // or brew, is still updated with pip or brew, since main picks by where the binary lives.
    installCommand: {
      win32:
        "[System.Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'User'); pipx install semgrep",
      darwin: 'pipx install semgrep',
      linux: 'pipx install semgrep',
    },
    updateCommand: {
      win32: 'pipx upgrade semgrep',
      darwin: 'pipx upgrade semgrep',
      linux: 'pipx upgrade semgrep',
    },
    updateCheck: { type: 'pypi', package: 'semgrep' },
    uninstallCommand: {
      win32: 'pipx uninstall semgrep',
      darwin: 'pipx uninstall semgrep',
      linux: 'pipx uninstall semgrep',
    },
    detectCommand: { command: 'semgrep', args: ['--version'] },
    settingsFields: [
      {
        key: 'ruleset',
        label: 'Ruleset',
        type: 'select',
        options: [
          { value: 'auto', label: 'Auto (fetches rules from semgrep.dev)' },
          { value: 'p/security-audit', label: 'Security audit' },
          { value: 'p/owasp-top-ten', label: 'OWASP Top 10' },
          { value: 'p/default', label: 'Default' },
        ],
        defaultValue: 'auto',
        description:
          'Auto downloads rules from semgrep.dev on every scan. Pick a p/ pack to stay offline.',
      },
    ],
    settingsScope: 'global',
    buildSettingsAction: (values) => ({
      kind: 'command',
      command: `semgrep scan --config ${values.ruleset} --metrics=off .`,
      cwd: 'project',
    }),
  },
  {
    id: 'trivy',
    name: 'Trivy',
    description:
      'Finds known CVEs in your dependencies, hardcoded secrets, and infrastructure-as-code misconfigurations in one pass. The fastest way to learn a project is shipping a vulnerable package.',
    category: SECURITY_TOOL_CATEGORY,
    tags: ['dependencies', 'cve', 'secrets', 'iac'],
    author: 'Aqua Security',
    official: true,
    websiteUrl: 'https://trivy.dev',
    repositoryUrl: 'https://github.com/aquasecurity/trivy',
    installKind: 'shell',
    // Aqua's docs give `brew install trivy` for macOS and this script (with sudo) for Linux. The
    // script runs on macOS too, so both use it without sudo, and a brew copy is still upgraded
    // through brew. Windows: the docs only offer the release zip; the winget package is kept up
    // to date by the community.
    installCommand: {
      win32: 'winget install -e --id AquaSecurity.Trivy',
      darwin:
        'curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"',
      linux:
        'curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"',
    },
    updateCommand: {
      win32: 'winget upgrade -e --id AquaSecurity.Trivy',
      darwin:
        'curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"',
      linux:
        'curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"',
    },
    updateCheck: { type: 'github-release', package: 'aquasecurity/trivy' },
    uninstallCommand: {
      win32: 'winget uninstall -e --id AquaSecurity.Trivy',
      darwin: 'rm -f "$HOME/.local/bin/trivy"',
      linux: 'rm -f "$HOME/.local/bin/trivy"',
    },
    detectCommand: { command: 'trivy', args: ['--version'] },
    quickActions: [
      {
        id: 'trivy-db-update',
        label: 'Update vulnerability DB',
        action: { kind: 'command', command: 'trivy image --download-db-only', cwd: 'none' },
      },
    ],
  },
  {
    id: 'bearer',
    name: 'Bearer',
    description:
      'Data-flow analysis that follows sensitive data (PII, tokens, credentials) through your code and flags where it leaks. Complements pattern scanners rather than repeating them. Bearer ships no Windows build at all (no npm, winget or chocolatey package exists either), so on Windows Runova runs it through Docker, with your project mounted read-only. Nothing else to install.',
    category: SECURITY_TOOL_CATEGORY,
    tags: ['sast', 'privacy', 'data-flow'],
    author: 'Bearer (Cycode)',
    official: true,
    websiteUrl: 'https://docs.bearer.com',
    repositoryUrl: 'https://github.com/bearer/bearer',
    installKind: 'shell',
    installCommand: {
      darwin: 'brew install bearer/tap/bearer',
      linux:
        'curl -sfL https://raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"',
    },
    manualInstallInstructions:
      'Bearer publishes macOS and Linux builds only, and there is no npm, winget or chocolatey package for it. On Windows, run it through Docker: press "Pull Docker image" on this card, then scan from a project’s Security tab. Runova starts a container per scan with your project mounted read-only and removes it afterwards, so nothing else needs installing.',
    updateCommand: {
      darwin: 'brew upgrade bearer/tap/bearer',
      linux:
        'curl -sfL https://raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"',
    },
    updateCheck: { type: 'github-release', package: 'bearer/bearer' },
    uninstallCommand: {
      darwin: 'brew uninstall bearer/tap/bearer',
      linux: 'rm -f "$HOME/.local/bin/bearer"',
    },
    detectCommand: { command: 'bearer', args: ['version'] },
    // Deliberately no `docker` block. Bearer is not a server: a scan starts a container, runs
    // one command and removes it. Declaring a container here would render start/stop/reset
    // buttons for something that exits the moment it starts, so the only Docker action that
    // makes sense is pulling the image ahead of the first scan.
    quickActions: [
      {
        id: 'bearer-pull-image',
        label: 'Pull Docker image',
        action: {
          kind: 'command',
          command: 'docker pull bearer/bearer:latest-amd64',
          cwd: 'none',
        },
      },
    ],
  },
  {
    id: 'sonarqube',
    name: 'SonarQube Community Build',
    description:
      'A self-hosted analysis server that tracks vulnerabilities, security hotspots, and code quality over time. Runs as a Docker container with its own dashboard on port 9000; the Security tab scans into it and pulls the findings back out.',
    category: SECURITY_TOOL_CATEGORY,
    tags: ['sast', 'quality', 'self-hosted', 'docker'],
    author: 'SonarSource',
    official: true,
    websiteUrl: 'https://docs.sonarsource.com/sonarqube-community-build/',
    repositoryUrl: 'https://github.com/SonarSource/sonarqube',
    // The Docker container is the install; there is nothing to put on PATH.
    installKind: 'manual',
    manualInstallInstructions:
      '1. Press "Docker install" on this card to create the server container.\n2. Wait for http://localhost:9000 to come up (the first boot takes a couple of minutes) and log in with admin / admin.\n3. Change the password, then create a token under My Account > Security.\n4. Paste that token into the SonarQube setup in a project\u2019s Security tab.',
    updateCheck: { type: 'github-release', package: 'SonarSource/sonarqube' },
    docker: {
      image: 'sonarqube:community',
      containerName: 'runova-sonarqube',
      runArgs: [
        '-p',
        '9000:9000',
        '-v',
        'runova-sonarqube-data:/opt/sonarqube/data',
        '-v',
        'runova-sonarqube-extensions:/opt/sonarqube/extensions',
        '-v',
        'runova-sonarqube-logs:/opt/sonarqube/logs',
      ],
      dashboardUrl: 'http://localhost:9000',
    },
  },
  {
    id: 'codeql',
    name: 'CodeQL CLI',
    description:
      'GitHub\u2019s semantic analysis engine. It builds a queryable database of your code and traces untrusted input all the way to dangerous sinks, so it finds real exploitable paths that pattern matchers miss. Slow, and worth it. Free for open source; check the licence terms for private code.',
    category: SECURITY_TOOL_CATEGORY,
    tags: ['sast', 'dataflow', 'github'],
    author: 'GitHub',
    official: true,
    websiteUrl: 'https://codeql.github.com',
    repositoryUrl: 'https://github.com/github/codeql-cli-binaries',
    // Not 'shell': there is no winget, chocolatey or apt package for CodeQL, so on Windows and
    // Linux there is no command to run. Runova downloads the release zip itself instead, and
    // the card renders its own download/remove buttons rather than the generic Install one.
    installKind: 'manual',
    manualInstallInstructions:
      'Press "Download CodeQL" on this card and Runova fetches the official release, checks it against the SHA-256 GitHub publishes beside it, and unpacks it into its own tools folder. Nothing goes on your PATH and nothing needs admin rights.\n\nIf you would rather install it yourself, download the bundle for your platform from https://github.com/github/codeql-cli-binaries/releases/latest, extract it somewhere permanent, and add that folder to your PATH. A codeql already on your PATH is always preferred over the downloaded copy.',
    updateCheck: { type: 'github-release', package: 'github/codeql-cli-binaries' },
    detectCommand: { command: 'codeql', args: ['version', '--format=terse'] },
  },
  {
    id: 'strix',
    name: 'Strix',
    description:
      'An autonomous AI agent that runs your code in a sandbox and proves vulnerabilities with real working exploits, so what it reports has no false positives. Needs Docker and your own LLM API key, and a run costs tokens. On macOS and Linux it installs with Strix’s own installer, which needs no Python; on Windows it installs through pipx (Python 3.12+).',
    category: SECURITY_TOOL_CATEGORY,
    tags: ['pentest', 'ai-agent', 'dast'],
    author: 'Strix',
    official: true,
    websiteUrl: 'https://usestrix.com',
    repositoryUrl: 'https://github.com/usestrix/strix',
    installKind: 'shell',
    // The installer drops a prebuilt binary in ~/.strix/bin and adds it to the shell's rc file.
    // It only runs in a POSIX shell, so Windows uses pipx, the other documented method.
    installCommand: {
      win32: 'pipx install strix-agent',
      darwin: 'curl -sSL https://strix.ai/install | bash',
      linux: 'curl -sSL https://strix.ai/install | bash',
    },
    updateCommand: {
      win32: 'pipx upgrade strix-agent',
      darwin: 'strix --update',
      linux: 'strix --update',
    },
    updateCheck: { type: 'pypi', package: 'strix-agent' },
    // The installer copy has no uninstall command (see manualUninstallInstructions), so only the
    // pipx copy on Windows gets one here.
    uninstallCommand: {
      win32: 'pipx uninstall strix-agent',
    },
    manualUninstallInstructions:
      'On macOS and Linux, delete the ~/.strix/bin folder and remove the PATH line the installer added to your shell startup file (~/.zshrc, ~/.bashrc or fish config). If you installed it with pipx instead, run: pipx uninstall strix-agent',
    detectCommand: { command: 'strix', args: ['--version'] },
    settingsFields: [
      {
        key: 'model',
        label: 'Model',
        type: 'text',
        defaultValue: STRIX_DEFAULT_MODEL,
        description: 'Passed as STRIX_LLM, in provider/model form.',
      },
      {
        key: 'apiKey',
        label: 'LLM API key',
        type: 'text',
        defaultValue: '',
        description: 'Passed as LLM_API_KEY. Set this in the project Security tab to store it.',
      },
    ],
    settingsScope: 'global',
    buildSettingsAction: (values) => ({
      kind: 'copy-text',
      content: `STRIX_LLM=${values.model}\nLLM_API_KEY=${values.apiKey}`,
      instructions:
        'Set these as environment variables, or store them in a project\u2019s Security tab so Runova passes them for you.',
    }),
  },
];

export function getAgentToolDefinition(id: string): AgentToolDefinition | undefined {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.id === id);
}

export function getToolInstallCommandForCurrentOS(
  tool: AgentToolDefinition,
  platform: SupportedOS,
): string | null {
  return tool.installCommand?.[platform] ?? null;
}

/** Falls back to the install command, which for most tools is what upgrades in place. */
export function getToolUpdateCommandForCurrentOS(
  tool: AgentToolDefinition,
  platform: SupportedOS,
): string | null {
  return tool.updateCommand?.[platform] ?? tool.installCommand?.[platform] ?? null;
}

export function getToolUninstallCommandForCurrentOS(
  tool: AgentToolDefinition,
  platform: SupportedOS,
): string | null {
  return tool.uninstallCommand?.[platform] ?? null;
}

export function getInteractiveLaunchCommandForCurrentOS(
  tool: AgentToolDefinition,
  platform: SupportedOS,
): string | null {
  return tool.interactiveInstall?.launchCommand[platform] ?? null;
}

export function getDockerRunCommand(tool: AgentToolDefinition): string | null {
  if (!tool.docker) return null;
  const imageArgs = tool.docker.imageArgs?.length ? ` ${tool.docker.imageArgs.join(' ')}` : '';
  return `docker run -d --name ${tool.docker.containerName} ${tool.docker.runArgs.join(' ')} ${tool.docker.image}${imageArgs}`;
}

export function getDockerStartCommand(tool: AgentToolDefinition): string | null {
  if (!tool.docker) return null;
  return `docker start ${tool.docker.containerName}`;
}

export function getDockerStopCommand(tool: AgentToolDefinition): string | null {
  if (!tool.docker) return null;
  return `docker stop ${tool.docker.containerName}`;
}

/**
 * Windows PowerShell 5.1, the terminal on Windows, rejects `&&`, so there the two steps are joined
 * with `;`. `docker rm -f` on a container that is already gone fails harmlessly either way.
 */
export function getDockerResetCommand(
  tool: AgentToolDefinition,
  platform?: SupportedOS,
): string | null {
  if (!tool.docker) return null;
  const runCommand = getDockerRunCommand(tool);
  if (!runCommand) return null;
  const separator = platform === 'win32' ? ';' : ' &&';
  return `docker rm -f ${tool.docker.containerName}${separator} ${runCommand}`;
}

/** Deletes the container outright; unlike reset, doesn't recreate it. */
export function getDockerRemoveCommand(tool: AgentToolDefinition): string | null {
  if (!tool.docker) return null;
  return `docker rm -f ${tool.docker.containerName}`;
}
