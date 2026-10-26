import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildShellLaunch } from './shellIntegration';

/**
 * The prompt marker is what the renderer keys off to know the shell is ready for input, so the
 * launch construction is worth pinning per shell: a wrong argument or a clobbered variable makes
 * the terminal silently lose the feature (or, for zsh and cmd, breaks the user's own prompt).
 */

/** The OSC sequence every hook has to emit, in whichever escaping that shell needs. */
const MARKER_ID = '7750;Runova:PromptReady:1';

describe('buildShellLaunch', () => {
  describe('bash', () => {
    it('points bash at a private rc file that sources the user rc before hooking', () => {
      const launch = buildShellLaunch('/bin/bash', 'linux', undefined);

      expect(launch.args[0]).toBe('--rcfile');
      expect(launch.env).toEqual({});

      const rcfile = launch.args[1];
      const contents = readFileSync(rcfile, 'utf-8');
      // Sourcing ~/.bashrc first is what keeps a user's own prompt working.
      expect(contents.indexOf('. ~/.bashrc')).toBeLessThan(contents.indexOf('PROMPT_COMMAND'));
      expect(contents).toContain(MARKER_ID);
      // Chained onto any existing PROMPT_COMMAND rather than overwriting it.
      expect(contents).toContain('${PROMPT_COMMAND:+$PROMPT_COMMAND');
    });

    it('recognizes bash by basename, whatever the path separator', () => {
      const posix = buildShellLaunch('/usr/local/bin/bash', 'darwin', undefined);
      const windows = buildShellLaunch('C:\\Program Files\\Git\\bin\\bash', 'win32', undefined);

      expect(posix.args[0]).toBe('--rcfile');
      expect(windows.args[0]).toBe('--rcfile');
    });

    it('reuses the same integration directory across launches', () => {
      const first = buildShellLaunch('bash', 'linux', undefined);
      const second = buildShellLaunch('bash', 'linux', undefined);

      expect(second.args[1]).toBe(first.args[1]);
    });
  });

  describe('zsh', () => {
    it('redirects ZDOTDIR at the integration folder and remembers the user value', () => {
      const launch = buildShellLaunch('/bin/zsh', 'darwin', { ZDOTDIR: '/home/me/.config/zsh' });

      expect(launch.args).toEqual([]);
      expect(launch.env.ZDOTDIR).toBeTruthy();
      expect(launch.env.ZDOTDIR).not.toBe('/home/me/.config/zsh');
      // Without this the user's own zsh configuration would never be loaded.
      expect(launch.env.RUNOVA_USER_ZDOTDIR).toBe('/home/me/.config/zsh');
    });

    it('falls back to the ambient ZDOTDIR when the session env does not set one', () => {
      vi.stubEnv('ZDOTDIR', '/ambient/zdotdir');
      const launch = buildShellLaunch('zsh', 'linux', {});
      expect(launch.env.RUNOVA_USER_ZDOTDIR).toBe('/ambient/zdotdir');
    });

    it('omits RUNOVA_USER_ZDOTDIR when the user has no ZDOTDIR at all', () => {
      vi.stubEnv('ZDOTDIR', undefined);
      const launch = buildShellLaunch('zsh', 'linux', undefined);
      expect(launch.env.RUNOVA_USER_ZDOTDIR).toBeUndefined();
      expect(Object.keys(launch.env)).toEqual(['ZDOTDIR']);
    });

    it('writes .zshenv and .zshrc that restore ZDOTDIR around the user files', () => {
      const launch = buildShellLaunch('zsh', 'darwin', undefined);
      const dir = launch.env.ZDOTDIR;

      const zshenv = readFileSync(`${dir}/.zshenv`, 'utf-8');
      const zshrc = readFileSync(`${dir}/.zshrc`, 'utf-8');

      // .zshenv has to put ZDOTDIR back before handing control on, or a .zshenv that moves
      // ZDOTDIR itself would be reading ours instead of the user's.
      expect(zshenv).toContain('ZDOTDIR=${RUNOVA_USER_ZDOTDIR:-$HOME}');
      expect(zshenv).toContain('ZDOTDIR=$__runova_zdotdir');
      expect(zshrc).toContain('[[ -f $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc');
      // Appended to precmd_functions, so a framework like Starship keeps its own hook.
      expect(zshrc).toContain('precmd_functions+=(runova_precmd)');
      expect(zshrc).toContain(MARKER_ID);
    });
  });

  describe('fish', () => {
    it('installs the marker as a fish_prompt event handler', () => {
      const launch = buildShellLaunch('/usr/bin/fish', 'linux', undefined);

      expect(launch.args[0]).toBe('--init-command');
      expect(launch.args[1]).toContain('--on-event fish_prompt');
      expect(launch.args[1]).toContain(MARKER_ID);
      expect(launch.env).toEqual({});
    });
  });

  describe('powershell', () => {
    it.each(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])(
      'wraps the existing prompt function for %s',
      (shell) => {
        const launch = buildShellLaunch(shell, 'win32', undefined);

        expect(launch.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
        expect(launch.env).toEqual({});

        const script = launch.args[3];
        // The previous prompt is saved and called through, so a custom prompt survives.
        expect(script).toContain('$global:__runovaPrevPrompt = $function:prompt');
        expect(script).toContain('& $global:__runovaPrevPrompt');
        // Written as a side effect rather than returned, otherwise PSReadLine desyncs.
        expect(script).toContain('Write-Host -NoNewline');
        expect(script).toContain("]7750;Runova:PromptReady:1' + [char]7");
        // Double quotes get mangled differently by each PowerShell version on a command line.
        expect(script).not.toContain('"');
      },
    );

    it('recognizes a full Windows path to pwsh', () => {
      const launch = buildShellLaunch(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'win32',
        undefined,
      );
      expect(launch.args[0]).toBe('-NoLogo');
    });

    it('falls back to powershell when the shell is empty on Windows', () => {
      const launch = buildShellLaunch('', 'win32', undefined);
      expect(launch.args[0]).toBe('-NoLogo');
    });

    it('does not fall back to powershell when the shell is empty on POSIX', () => {
      expect(buildShellLaunch('', 'linux', undefined)).toEqual({ args: [], env: {} });
    });
  });

  describe('cmd', () => {
    it('prefixes the marker onto the existing PROMPT from the session env', () => {
      const launch = buildShellLaunch('C:\\Windows\\System32\\cmd.exe', 'win32', {
        PROMPT: '$P$_$G',
      });

      expect(launch.args).toEqual([]);
      // cmd has no BEL macro, so the sequence is terminated with ST ($E\).
      expect(launch.env.PROMPT).toBe('$E]7750;Runova:PromptReady:1$E\\$P$_$G');
    });

    it('falls back to the ambient PROMPT, then to cmd default $P$G', () => {
      vi.stubEnv('PROMPT', '$T$G');
      expect(buildShellLaunch('cmd', 'win32', undefined).env.PROMPT).toBe(
        '$E]7750;Runova:PromptReady:1$E\\$T$G',
      );

      vi.stubEnv('PROMPT', undefined);
      expect(buildShellLaunch('cmd.exe', 'win32', {}).env.PROMPT).toBe(
        '$E]7750;Runova:PromptReady:1$E\\$P$G',
      );
    });
  });

  describe('unrecognized shells', () => {
    it.each(['/bin/sh', '/bin/dash', '/usr/bin/nu', 'C:\\msys64\\usr\\bin\\ksh.exe'])(
      'starts %s plain, with the marker simply never firing',
      (shell) => {
        expect(buildShellLaunch(shell, 'linux', undefined)).toEqual({ args: [], env: {} });
      },
    );

    it('matches shell names case insensitively', () => {
      expect(buildShellLaunch('C:\\Windows\\System32\\CMD.EXE', 'win32', {}).env.PROMPT).toContain(
        '7750',
      );
    });
  });
});
