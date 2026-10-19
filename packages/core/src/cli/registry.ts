import { z } from 'zod';
import { CLI_MODEL_EXAMPLES } from '../models/catalog.js';

export const SupportedOSSchema = z.enum(['win32', 'darwin', 'linux']);
export type SupportedOS = z.infer<typeof SupportedOSSchema>;

export const ShellCommandSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
});
export type ShellCommand = z.infer<typeof ShellCommandSchema>;

export const UpdateCheckSourceSchema = z.object({
  type: z.enum(['npm', 'pypi', 'github-release']),
  /** npm/PyPI package name, or "owner/repo" for github-release. */
  package: z.string(),
});
export type UpdateCheckSource = z.infer<typeof UpdateCheckSourceSchema>;

export const CliDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Short name used in every agent picker (Target AI, project agent type, and
   * similar dropdowns) so those lists cannot drift from this registry.
   */
  label: z.string(),
  description: z.string(),
  homepageUrl: z.string().url().optional(),
  docsUrl: z.string().url().optional(),
  executableNames: z.array(z.string()).min(1),
  detectCommand: ShellCommandSchema,
  versionCommand: ShellCommandSchema,
  /**
   * One-shot ("headless") prompt invocation: the agent answers on stdout without
   * opening a TUI. Absent for CLIs that have no non-interactive mode we can rely on.
   */
  promptCommand: ShellCommandSchema.optional(),
  /**
   * How the prompt text reaches `promptCommand`: appended as the final argument
   * (the default), or piped through stdin. Windows routes every npm-installed CLI
   * through cmd.exe, which caps its own command line at ~8191 characters, so a
   * diff-heavy prompt needs the stdin path to avoid "The command line is too long."
   * Only set this for CLIs confirmed to read a piped prompt in headless mode.
   */
  promptInputMode: z.enum(['arg', 'stdin']).optional(),
  /**
   * Extra args that let a headless run actually edit files. Without them these CLIs
   * either stop to ask for approval (which nothing can answer with no TTY) or refuse
   * to write at all. Absent for CLIs that already edit by default in headless mode, and
   * for read-only ones. Only ever added for prompts the user explicitly asked to apply.
   */
  promptWriteArgs: z.array(z.string()).optional(),
  /**
   * Example for the per-CLI "Arguments" field, shown as its placeholder. Each one names
   * a flag this CLI really has (taken from its own --help), since the flag for picking a
   * model differs per CLI: `--model sonnet`, `-m provider/model`, and so on. Absent for
   * CLIs with no obvious flag worth suggesting.
   */
  argsExample: z.string().optional(),
  /**
   * How a file is referred to in this CLI's input box: `@path` (the default, which the CLI
   * turns into an attached file) or the bare path for CLIs with no mention syntax.
   */
  fileMention: z.enum(['at', 'plain']).optional(),
  /**
   * How a headless run attaches a screenshot: a CLI flag per image (`flag`), a file mention in
   * the prompt (`mention`), or a prompt that tells the agent to open the file with its own read
   * tool (`read-tool`). Absent for CLIs that cannot look at an image in headless mode. Only set
   * after checking by hand that the CLI really describes the attached image.
   */
  promptImageInput: z.enum(['flag', 'mention', 'read-tool']).optional(),
  /**
   * Args added once to a run that attaches images. For `read-tool` they are what lets the agent
   * use that tool without a TTY to approve it.
   */
  promptImageArgs: z.array(z.string()).optional(),
  /** For `flag`: the flag that names one image, repeated with each image's path. */
  promptImageFlag: z.string().optional(),
  /** Env vars for a run that attaches images, e.g. to let the CLI read from a temp folder. */
  promptImageEnv: z.record(z.string(), z.string()).optional(),
  /**
   * Keyed by SupportedOS; not every OS needs an entry. Each is the vendor's own recommended
   * command for that OS. The Windows one is typed into Windows PowerShell 5.1, which has no `&&`.
   */
  installCommand: z.record(z.string(), z.string()),
  /** Keyed by SupportedOS; falls back to installCommand when absent. */
  updateCommand: z.record(z.string(), z.string()).optional(),
  /** Where to look up the latest published version, if known. */
  updateCheck: UpdateCheckSourceSchema.optional(),
  supportedOS: z.array(SupportedOSSchema).min(1),
});
export type CliDefinition = z.infer<typeof CliDefinitionSchema>;

export const CLI_REGISTRY: CliDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code CLI',
    label: 'Claude Code',
    description: "Anthropic's agentic coding CLI.",
    homepageUrl: 'https://claude.com/claude-code',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
    executableNames: ['claude'],
    detectCommand: { command: 'claude', args: ['--version'] },
    versionCommand: { command: 'claude', args: ['--version'] },
    promptCommand: { command: 'claude', args: ['-p'] },
    promptInputMode: 'stdin',
    promptWriteArgs: ['--permission-mode', 'acceptEdits'],
    // `-p` has no image flag, but it can open a PNG with its Read tool, which a headless run
    // may only use when it is allowed up front.
    promptImageInput: 'read-tool',
    promptImageArgs: ['--allowedTools', 'Read'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['claude-code']}`,
    // Anthropic's native installer: no Node needed, and it keeps itself up to date. The npm
    // package still works but needs Node and a writable npm prefix, which a stock Mac lacks.
    installCommand: {
      win32: 'irm https://claude.ai/install.ps1 | iex',
      darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash',
    },
    // Works for native and npm installs alike.
    updateCommand: {
      win32: 'claude update',
      darwin: 'claude update',
      linux: 'claude update',
    },
    // The npm package carries the same version stream as the native builds.
    updateCheck: { type: 'npm', package: '@anthropic-ai/claude-code' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    label: 'Gemini',
    description: "Google's Gemini command-line AI agent.",
    homepageUrl: 'https://github.com/google-gemini/gemini-cli',
    executableNames: ['gemini'],
    detectCommand: { command: 'gemini', args: ['--version'] },
    versionCommand: { command: 'gemini', args: ['--version'] },
    promptCommand: { command: 'gemini', args: ['-p'] },
    promptInputMode: 'stdin',
    promptWriteArgs: ['--yolo'],
    promptImageInput: 'mention',
    // Headless gemini refuses to read from a folder it doesn't trust, and a per-run temp folder
    // never is.
    promptImageEnv: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    argsExample: `-m ${CLI_MODEL_EXAMPLES['gemini-cli']}`,
    // Google publishes no native installer, so npm (Node 20+) it is.
    installCommand: {
      win32: 'npm install -g @google/gemini-cli',
      darwin: 'npm install -g @google/gemini-cli',
      linux: 'npm install -g @google/gemini-cli',
    },
    updateCommand: {
      win32: 'npm install -g @google/gemini-cli@latest',
      darwin: 'npm install -g @google/gemini-cli@latest',
      linux: 'npm install -g @google/gemini-cli@latest',
    },
    updateCheck: { type: 'npm', package: '@google/gemini-cli' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    label: 'OpenCode',
    description: 'Open-source AI coding agent for the terminal.',
    homepageUrl: 'https://opencode.ai',
    executableNames: ['opencode'],
    detectCommand: { command: 'opencode', args: ['--version'] },
    versionCommand: { command: 'opencode', args: ['--version'] },
    // `opencode run` reads a piped prompt; stdin avoids Windows cmd.exe's ~8191-char limit.
    promptCommand: { command: 'opencode', args: ['run'] },
    promptInputMode: 'stdin',
    // `--auto` is a `run` flag, so it must follow `run` in argv (see headlessPrompt write-arg order).
    promptWriteArgs: ['--auto'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['opencode']}`,
    // There is no PowerShell installer (install.ps1 is a 404), so Windows stays on npm.
    installCommand: {
      win32: 'npm install -g opencode-ai@latest',
      darwin: 'curl -fsSL https://opencode.ai/install | bash',
      linux: 'curl -fsSL https://opencode.ai/install | bash',
    },
    // `opencode upgrade` works out on its own whether it came from the script, npm or brew.
    updateCommand: {
      win32: 'opencode upgrade',
      darwin: 'opencode upgrade',
      linux: 'opencode upgrade',
    },
    updateCheck: { type: 'npm', package: 'opencode-ai' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    label: 'OpenClaude',
    description: 'Open-source coding agent CLI that runs against any model provider.',
    homepageUrl: 'https://openclaude.gitlawb.com',
    docsUrl: 'https://openclaude.gitlawb.com/docs/cli-reference/',
    executableNames: ['openclaude'],
    detectCommand: { command: 'openclaude', args: ['--version'] },
    versionCommand: { command: 'openclaude', args: ['--version'] },
    // `-p/--print` is a boolean flag that answers and exits, and it reads a piped prompt,
    // which keeps diff-heavy prompts off Windows' ~8191-char cmd.exe line.
    promptCommand: { command: 'openclaude', args: ['-p'] },
    promptInputMode: 'stdin',
    promptWriteArgs: ['--permission-mode', 'acceptEdits'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['openclaude']}`,
    // @gitlawb/openclaude is deprecated ("Moved to @twigpine/openclaude"). Node 22+.
    installCommand: {
      win32: 'npm install -g @twigpine/openclaude@latest',
      darwin: 'npm install -g @twigpine/openclaude@latest',
      linux: 'npm install -g @twigpine/openclaude@latest',
    },
    // Both packages own the `openclaude` bin, so the old one has to go first or npm refuses to
    // link the new one. Uninstalling a package that isn't there is a no-op. `;` rather than `&&`
    // so the same line runs in Windows PowerShell 5.1.
    updateCommand: {
      win32: 'npm uninstall -g @gitlawb/openclaude; npm install -g @twigpine/openclaude@latest',
      darwin: 'npm uninstall -g @gitlawb/openclaude; npm install -g @twigpine/openclaude@latest',
      linux: 'npm uninstall -g @gitlawb/openclaude; npm install -g @twigpine/openclaude@latest',
    },
    updateCheck: { type: 'npm', package: '@twigpine/openclaude' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    label: 'Codex',
    description: "OpenAI's local coding agent CLI.",
    homepageUrl: 'https://github.com/openai/codex',
    executableNames: ['codex'],
    detectCommand: { command: 'codex', args: ['--version'] },
    versionCommand: { command: 'codex', args: ['--version'] },
    promptCommand: { command: 'codex', args: ['exec'] },
    promptInputMode: 'stdin',
    // `--full-auto` only exists on the interactive `codex` command; `codex exec` rejects it
    // ("unexpected argument '--full-auto'"). The exec equivalent is the sandbox policy, and
    // exec never prompts for approvals anyway.
    promptWriteArgs: ['--sandbox', 'workspace-write'],
    promptImageInput: 'flag',
    promptImageFlag: '--image',
    // An image run happens in a fresh temp folder, and outside a git repo `codex exec` stops with
    // "Not inside a trusted directory and --skip-git-repo-check was not specified."
    promptImageArgs: ['--skip-git-repo-check'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['codex-cli']}`,
    // OpenAI's native installers. The Windows one runs in a child PowerShell as the docs give it,
    // so the script's execution-policy bypass stays scoped to it.
    installCommand: {
      win32:
        'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      darwin: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      linux: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    },
    // Detects npm, Homebrew and script installs and runs the matching upgrade.
    updateCommand: {
      win32: 'codex update',
      darwin: 'codex update',
      linux: 'codex update',
    },
    updateCheck: { type: 'npm', package: '@openai/codex' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'grok-cli',
    name: 'Grok CLI',
    label: 'Grok',
    description: "xAI's official Grok coding agent CLI.",
    homepageUrl: 'https://x.ai',
    docsUrl: 'https://docs.x.ai/build/overview',
    executableNames: ['grok'],
    detectCommand: { command: 'grok', args: ['--version'] },
    versionCommand: { command: 'grok', args: ['--version'] },
    // Grok's headless flag is `-p/--single <PROMPT>`; it takes the prompt as the flag's
    // value, so there is no stdin path (`grok -p` with a piped prompt errors on the
    // missing value).
    promptCommand: { command: 'grok', args: ['-p'] },
    promptWriteArgs: ['--permission-mode', 'acceptEdits'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['grok-cli']}`,
    // xAI's docs only give these scripts. They also install an `agent` binary, the same name as
    // Cursor's, which is why Cursor is always called as `cursor-agent` here.
    installCommand: {
      win32: 'irm https://x.ai/cli/install.ps1 | iex',
      darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      linux: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    },
    // On Windows an npm-installed Grok can't run its own updater, so the desktop app swaps in
    // `npm install -g` for that case (see grokInstalledWithNpm).
    updateCommand: {
      win32: 'grok update',
      darwin: 'grok update',
      linux: 'grok update',
    },
    // Published by xAI and kept in step with x.ai/cli/stable.
    updateCheck: { type: 'npm', package: '@xai-official/grok' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'cursor-cli',
    name: 'Cursor CLI',
    label: 'Cursor',
    description: "Cursor's agentic coding CLI for the terminal.",
    homepageUrl: 'https://cursor.com/cli',
    docsUrl: 'https://cursor.com/docs/cli/overview',
    executableNames: ['cursor-agent'],
    detectCommand: { command: 'cursor-agent', args: ['--version'] },
    versionCommand: { command: 'cursor-agent', args: ['--version'] },
    promptCommand: { command: 'cursor-agent', args: ['-p'] },
    promptWriteArgs: ['--force'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['cursor-cli']}`,
    installCommand: {
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
      darwin: 'curl https://cursor.com/install -fsS | bash',
      linux: 'curl https://cursor.com/install -fsS | bash',
    },
    // The CLI ships its own self-updater; re-running the install script would work too, but
    // this is the documented path and avoids re-downloading the whole installer. Cursor's docs
    // now call the binary `agent`, but Grok installs an `agent` too (first on PATH on Windows),
    // and the installers still create `cursor-agent`, so that is the name used everywhere here.
    updateCommand: {
      win32: 'cursor-agent update',
      darwin: 'cursor-agent update',
      linux: 'cursor-agent update',
    },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    label: 'Copilot',
    description: "GitHub's Copilot coding agent in the terminal.",
    homepageUrl: 'https://github.com/features/copilot/cli',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    executableNames: ['copilot'],
    detectCommand: { command: 'copilot', args: ['--version'] },
    versionCommand: { command: 'copilot', args: ['--version'] },
    // Copilot ignores piped input whenever `-p/--prompt` is also passed, so the stdin path
    // deliberately leaves the prompt flag off and lets the pipe carry the prompt. `-s`
    // suppresses the session banner and stats, leaving only the answer on stdout.
    promptCommand: { command: 'copilot', args: ['-s'] },
    promptInputMode: 'stdin',
    promptWriteArgs: ['--allow-all-tools'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['copilot-cli']}`,
    // GitHub's install script is macOS/Linux only; on Windows the documented path is winget.
    installCommand: {
      win32: 'winget install GitHub.Copilot',
      darwin: 'curl -fsSL https://gh.io/copilot-install | bash',
      linux: 'curl -fsSL https://gh.io/copilot-install | bash',
    },
    updateCommand: {
      win32: 'copilot update',
      darwin: 'copilot update',
      linux: 'copilot update',
    },
    updateCheck: { type: 'npm', package: '@github/copilot' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'freebuff-cli',
    name: 'FreeBuff CLI',
    label: 'FreeBuff',
    description: 'Free, ad-supported AI coding agent for the terminal.',
    homepageUrl: 'https://freebuff.com',
    docsUrl: 'https://freebuff.com/get-started',
    executableNames: ['freebuff'],
    detectCommand: { command: 'freebuff', args: ['--version'] },
    versionCommand: { command: 'freebuff', args: ['--version'] },
    argsExample: '--continue',
    installCommand: {
      win32: 'npm install -g freebuff',
      darwin: 'npm install -g freebuff',
      linux: 'npm install -g freebuff',
    },
    updateCheck: { type: 'npm', package: 'freebuff' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'qwen-cli',
    name: 'Qwen CLI',
    label: 'Qwen',
    description: "Alibaba's Qwen Code command-line AI agent.",
    homepageUrl: 'https://github.com/QwenLM/qwen-code',
    executableNames: ['qwen'],
    detectCommand: { command: 'qwen', args: ['--version'] },
    versionCommand: { command: 'qwen', args: ['--version'] },
    promptCommand: { command: 'qwen', args: ['-p'] },
    promptInputMode: 'stdin',
    promptWriteArgs: ['--yolo'],
    argsExample: `-m ${CLI_MODEL_EXAMPLES['qwen-cli']}`,
    // The vendor's standalone installers, which bring their own Node. There is no self-update,
    // so re-running the installer is the update.
    installCommand: {
      win32:
        'irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex',
      darwin:
        'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
      linux:
        'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
    },
    updateCheck: { type: 'npm', package: '@qwen-code/qwen-code' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'aider',
    name: 'Aider',
    label: 'Aider',
    description: 'AI pair programming CLI that edits code in your local git repo.',
    homepageUrl: 'https://aider.chat',
    executableNames: ['aider'],
    detectCommand: { command: 'aider', args: ['--version'] },
    versionCommand: { command: 'aider', args: ['--version'] },
    argsExample: `--model ${CLI_MODEL_EXAMPLES['aider']}`,
    fileMention: 'plain',
    // Aider's one-liners install uv and let it fetch Python 3.12, so nothing has to be there
    // first. pipx still works but needs a matching Python already installed.
    installCommand: {
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"',
      darwin: 'curl -LsSf https://aider.chat/install.sh | sh',
      linux: 'curl -LsSf https://aider.chat/install.sh | sh',
    },
    // The uv install includes pip for exactly this, and pipx installs are handled too.
    updateCommand: {
      win32: 'aider --upgrade',
      darwin: 'aider --upgrade',
      linux: 'aider --upgrade',
    },
    updateCheck: { type: 'pypi', package: 'aider-chat' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'goose',
    name: 'Goose',
    label: 'Goose',
    description: "Block's on-machine AI agent CLI.",
    // The project moved from block/goose to the Agentic AI Foundation.
    homepageUrl: 'https://github.com/aaif-goose/goose',
    docsUrl: 'https://goose-docs.ai',
    executableNames: ['goose'],
    detectCommand: { command: 'goose', args: ['--version'] },
    versionCommand: { command: 'goose', args: ['--version'] },
    promptCommand: { command: 'goose', args: ['run', '-t'] },
    fileMention: 'plain',
    // The Windows script calls `exit 1` when something fails, which piped straight into this
    // tab's `iex` would close the tab along with the error. A child PowerShell keeps the message.
    // It installs to %USERPROFILE%\.local\bin without touching PATH; AgentMate looks there itself.
    installCommand: {
      win32:
        'powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 | iex"',
      darwin:
        'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
      linux:
        'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
    },
    // `goose update` is the built-in self-updater, faster and more reliable than re-running
    // the install script. Its docs only cover it on macOS and Linux, so Windows re-runs the
    // installer.
    updateCommand: {
      darwin: 'goose update',
      linux: 'goose update',
    },
    updateCheck: { type: 'github-release', package: 'aaif-goose/goose' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'cline-cli',
    name: 'Cline CLI',
    label: 'Cline',
    description: 'Autonomous coding agent CLI from the Cline team.',
    homepageUrl: 'https://cline.bot/cli',
    docsUrl: 'https://docs.cline.bot/cli/cli-reference',
    executableNames: ['cline'],
    detectCommand: { command: 'cline', args: ['--version'] },
    versionCommand: { command: 'cline', args: ['--version'] },
    promptCommand: { command: 'cline', args: ['-y'] },
    argsExample: `--model ${CLI_MODEL_EXAMPLES['cline-cli']}`,
    installCommand: {
      win32: 'npm install -g cline',
      darwin: 'npm install -g cline',
      linux: 'npm install -g cline',
    },
    updateCheck: { type: 'npm', package: 'cline' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'continue-cli',
    name: 'Continue CLI',
    label: 'Continue',
    description: 'Open-source AI coding assistant CLI ("cn").',
    homepageUrl: 'https://continue.dev',
    executableNames: ['cn'],
    detectCommand: { command: 'cn', args: ['--version'] },
    versionCommand: { command: 'cn', args: ['--version'] },
    promptCommand: { command: 'cn', args: ['-p'] },
    argsExample: `--model ${CLI_MODEL_EXAMPLES['continue-cli']}`,
    // The official scripts install Node through fnm when it is missing, then npm-install the CLI,
    // so a machine without Node gets a working `cn` too.
    installCommand: {
      win32:
        'irm https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/scripts/install.ps1 | iex',
      darwin:
        'curl -fsSL https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/scripts/install.sh | bash',
      linux:
        'curl -fsSL https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/scripts/install.sh | bash',
    },
    updateCommand: {
      win32: 'npm install -g @continuedev/cli@latest',
      darwin: 'npm install -g @continuedev/cli@latest',
      linux: 'npm install -g @continuedev/cli@latest',
    },
    updateCheck: { type: 'npm', package: '@continuedev/cli' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'pi',
    name: 'Pi',
    label: 'Pi',
    description: 'Minimal, extensible terminal coding agent.',
    homepageUrl: 'https://pi.dev',
    docsUrl: 'https://pi.dev/docs',
    executableNames: ['pi'],
    detectCommand: { command: 'pi', args: ['--version'] },
    versionCommand: { command: 'pi', args: ['--version'] },
    // `pi -p` prints the answer and exits. Print mode also merges piped stdin into the
    // prompt, which keeps diff-heavy prompts off Windows' ~8191-char cmd.exe line.
    promptCommand: { command: 'pi', args: ['-p'] },
    promptInputMode: 'stdin',
    // No promptWriteArgs: pi has no permission popups, so its write/edit/bash tools run
    // as-is, and the project trust prompt never appears in non-interactive mode.
    argsExample: `--model ${CLI_MODEL_EXAMPLES['pi']}`,
    // pi.dev's installers are the recommended path: they pin every dependency and can bring Node
    // along. The Windows line is the one pi itself prints.
    installCommand: {
      win32: 'powershell -c "irm https://pi.dev/install.ps1 | iex"',
      darwin: 'curl -fsSL https://pi.dev/install.sh | sh',
      linux: 'curl -fsSL https://pi.dev/install.sh | sh',
    },
    // `--self` updates pi only, leaving its extensions alone. It updates both installer-managed
    // and npm copies (the latter with pi's own `--ignore-scripts`).
    updateCommand: {
      win32: 'pi update --self',
      darwin: 'pi update --self',
      linux: 'pi update --self',
    },
    updateCheck: { type: 'npm', package: '@earendil-works/pi-coding-agent' },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
  {
    id: 'muse-code',
    name: 'Muse Code CLI',
    label: 'Muse Code',
    description: "Meta's coding agent for the terminal and CI, built for Muse Spark.",
    homepageUrl: 'https://dev.meta.ai/lp/muse-code',
    docsUrl: 'https://dev.meta.ai/docs/muse-code',
    executableNames: ['muse'],
    detectCommand: { command: 'muse', args: ['--version'] },
    versionCommand: { command: 'muse', args: ['--version'] },
    // `muse exec "<prompt>"` runs one prompt to completion and exits. The docs don't describe a
    // piped prompt, so the prompt goes in as the final argument.
    promptCommand: { command: 'muse', args: ['exec'] },
    // Skips the approval prompts that nothing can answer in a headless run, and keeps the OS
    // sandbox on. `--yolo` would turn the sandbox off too, so it stays out of these runs.
    promptWriteArgs: ['--disable-approval'],
    argsExample: `--model ${CLI_MODEL_EXAMPLES['muse-code']}`,
    // The docs give `curl ... | sh`, but the script is bash only (it uses `[[`, which dash does
    // not support), so it is piped to bash here.
    installCommand: {
      win32: 'irm https://dev.meta.ai/install.ps1 | iex',
      darwin: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
      linux: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    },
    supportedOS: ['win32', 'darwin', 'linux'],
  },
];

export function getCliDefinition(id: string): CliDefinition | undefined {
  return CLI_REGISTRY.find((cli) => cli.id === id);
}

/**
 * Prompt Builder / Target AI values. Same order and names as CLI_REGISTRY, so a
 * new CLI shows up in every picker without a second handwritten list.
 */
export const TARGET_AIS: readonly string[] = CLI_REGISTRY.map((cli) => cli.label);
export type TargetAI = (typeof TARGET_AIS)[number];
export const DEFAULT_TARGET_AI: TargetAI = CLI_REGISTRY[0]?.label ?? 'Claude Code';

/** Prompt Builder used to store "Claude" before the label matched Claude Code. */
const LEGACY_TARGET_AI_LABELS: Record<string, string> = {
  Claude: 'Claude Code',
};

/** Map a stored Target AI string (current label, legacy label, or CLI id) onto today's label. */
export function normalizeTargetAI(value: string): string {
  const mapped = LEGACY_TARGET_AI_LABELS[value] ?? value;
  const byLabel = CLI_REGISTRY.find((cli) => cli.label === mapped);
  if (byLabel) return byLabel.label;
  const byId = getCliDefinition(mapped);
  if (byId) return byId.label;
  return mapped;
}

export function isTargetAI(value: string): boolean {
  return TARGET_AIS.includes(normalizeTargetAI(value));
}

export function cliIdForTargetAI(targetAI: string): string | undefined {
  const normalized = normalizeTargetAI(targetAI);
  return CLI_REGISTRY.find((cli) => cli.label === normalized || cli.id === targetAI)?.id;
}

export function targetAIForCliId(cliId: string): string | undefined {
  return getCliDefinition(cliId)?.label;
}

/**
 * Pick the Target AI for a prompt form. Prefers an explicit stored value when it
 * still names a known CLI. `untouched` covers empty forms that still hold the old
 * hardcoded Claude default from before this followed the project's agent.
 */
export function resolvePromptTargetAI(
  stored: string | undefined,
  fallback: string,
  options?: { untouched?: boolean },
): string {
  if (!stored) return fallback;
  const normalized = normalizeTargetAI(stored);
  // Older builds always wrote "Claude" into an empty form. If the project is a
  // different agent and the user hasn't started a request, follow the project.
  if (options?.untouched && stored === 'Claude' && fallback !== normalized) {
    return fallback;
  }
  if (TARGET_AIS.includes(normalized)) return normalized;
  return fallback;
}

export function getInstallCommandForCurrentOS(
  cli: CliDefinition,
  platform: SupportedOS,
): string | null {
  return cli.installCommand[platform] ?? null;
}

export function getUpdateCommandForCurrentOS(
  cli: CliDefinition,
  platform: SupportedOS,
): string | null {
  return cli.updateCommand?.[platform] ?? cli.installCommand[platform] ?? null;
}
