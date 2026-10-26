/**
 * Makes a freshly spawned shell report, on its own, whenever a fresh prompt is ready for input.
 * The terminal renderer listens for that marker (an OSC 7750 sequence) to know it can safely take
 * over the current input line, e.g. to show a pasted file as a short chip instead of its whole
 * path. Each hook chains onto whatever prompt hook the shell (or the user's own dotfiles, or a
 * prompt framework like Starship) already has, rather than replacing it, so a custom prompt keeps
 * working exactly as it did before.
 *
 * The hook goes in through the shell's launch arguments or environment, never by typing it into
 * the shell. Typed input gets echoed back, so the user would see the whole snippet printed at the
 * top of every new terminal.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = '\\033]7750;Runova:PromptReady:1\\007';

export interface ShellLaunch {
  args: string[];
  /** Variables to set on top of the shell's normal environment. */
  env: Record<string, string>;
}

function basename(shell: string): string {
  return shell.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
}

let integrationDir: string | null = null;

/**
 * A private folder (mode 0700, unique name) for the rc files bash and zsh are pointed at. A fixed
 * path under a shared /tmp could be created first by another user, who would then get to run code
 * in every terminal. Made again if something cleans the temp folder while the host is running.
 */
function writeIntegrationFile(name: string, content: string): string {
  if (!integrationDir || !existsSync(integrationDir)) {
    integrationDir = mkdtempSync(join(tmpdir(), 'runova-shell-'));
    const dir = integrationDir;
    process.once('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort, it's a temp folder
      }
    });
  }
  const path = join(integrationDir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

const BASH_HOOK = `PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND$'\\n'}printf '${MARKER}'"`;

/** An interactive non-login bash reads only ~/.bashrc, so the rc file does that first. */
function bashLaunch(): ShellLaunch {
  const rcfile = writeIntegrationFile(
    'bashrc',
    `if [ -f ~/.bashrc ]; then . ~/.bashrc; fi\n${BASH_HOOK}\n`,
  );
  return { args: ['--rcfile', rcfile], env: {} };
}

/**
 * zsh has no --rcfile, so ZDOTDIR points it at a folder whose .zshenv and .zshrc load the user's
 * real ones. ZDOTDIR is swapped back to the user's value while their files run (and left there once
 * .zshrc is done), so anything that reads it, including a .zshenv that moves it, sees what it
 * would outside Runova.
 */
function zshLaunch(env: Record<string, string> | undefined): ShellLaunch {
  writeIntegrationFile(
    '.zshenv',
    [
      '__runova_zdotdir=$ZDOTDIR',
      'ZDOTDIR=${RUNOVA_USER_ZDOTDIR:-$HOME}',
      '[[ -f $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv',
      'RUNOVA_USER_ZDOTDIR=$ZDOTDIR',
      'ZDOTDIR=$__runova_zdotdir',
      'unset __runova_zdotdir',
      '',
    ].join('\n'),
  );
  writeIntegrationFile(
    '.zshrc',
    [
      'ZDOTDIR=$RUNOVA_USER_ZDOTDIR',
      'unset RUNOVA_USER_ZDOTDIR',
      '[[ -f $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc',
      '(( ${+precmd_functions} )) || typeset -ga precmd_functions',
      `runova_precmd() { printf '${MARKER}' }`,
      'precmd_functions+=(runova_precmd)',
      '',
    ].join('\n'),
  );
  const userZdotdir = env?.ZDOTDIR ?? process.env.ZDOTDIR;
  return {
    args: [],
    env: {
      ZDOTDIR: integrationDir as string,
      ...(userZdotdir ? { RUNOVA_USER_ZDOTDIR: userZdotdir } : {}),
    },
  };
}

/** fish runs --init-command after its own config, right before the first prompt. */
function fishLaunch(): ShellLaunch {
  return {
    args: [
      '--init-command',
      `function __runova_marker --on-event fish_prompt; printf '${MARKER}'; end`,
    ],
    env: {},
  };
}

// The marker is written as a side effect and the original prompt's own return value is passed
// straight through, which is the only arrangement that satisfies both constraints here.
// Returning '' and writing the prompt text by hand tells PSReadLine the prompt is 0 columns
// wide and desyncs every redraw. Appending the marker to the returned string instead puts it
// in the string PSReadLine re-renders on each redraw, so it fires again at whatever column the
// cursor happens to be at. Writing it here fires it once, when the prompt is really drawn.
//
// -Command runs after the user's profile, so $function:prompt is already their own. The script
// has no double quotes on purpose: it travels as one Windows command line argument, and quotes
// inside it get mangled differently by each PowerShell version.
const POWERSHELL_HOOK =
  '$global:__runovaPrevPrompt = $function:prompt; ' +
  'function prompt { ' +
  "Write-Host -NoNewline ([char]27 + ']7750;Runova:PromptReady:1' + [char]7); " +
  '& $global:__runovaPrevPrompt ' +
  '}';

function powershellLaunch(): ShellLaunch {
  return { args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_HOOK], env: {} };
}

/** cmd reads PROMPT from its environment. `$E` is cmd's own escape macro, expanded when the prompt
 * is drawn. Terminated with ST (`$E\`) since cmd has no BEL macro. Existing `PROMPT` (the user's
 * own, or cmd's `$P$G` default) is kept, just prefixed. */
function cmdLaunch(env: Record<string, string> | undefined): ShellLaunch {
  const existing = env?.PROMPT ?? process.env.PROMPT ?? '$P$G';
  return { args: [], env: { PROMPT: `$E]7750;Runova:PromptReady:1$E\\${existing}` } };
}

/**
 * How to start this shell so it emits the marker. A shell with no reliable prompt hook (plain
 * `sh`) or one that isn't recognized starts as is and simply never emits it, which is a safe
 * no-op: whatever depends on the marker just stays off, exactly like it does for an SSH session.
 */
export function buildShellLaunch(
  shell: string,
  platform: NodeJS.Platform,
  env: Record<string, string> | undefined,
): ShellLaunch {
  const name = basename(shell);
  try {
    if (name === 'bash') return bashLaunch();
    if (name === 'zsh') return zshLaunch(env);
  } catch {
    // Couldn't write the rc files. Start the shell plain rather than not at all.
    return { args: [], env: {} };
  }
  if (name === 'fish') return fishLaunch();
  if (
    name === 'powershell.exe' ||
    name === 'pwsh.exe' ||
    name === 'pwsh' ||
    name === 'powershell'
  ) {
    return powershellLaunch();
  }
  if (name === 'cmd.exe' || name === 'cmd') return cmdLaunch(env);
  if (platform === 'win32' && name === '') return powershellLaunch();
  return { args: [], env: {} };
}
