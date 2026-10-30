import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowSudoPasswordPrompt,
  CommandDisplay,
  dropEcho,
  ECHO_TIMEOUT_MS,
  endsWithPasswordPrompt,
  isRiskyCommand,
  type MarkedCommand,
  markedCommandLine,
  PROMPT_READY,
  parseModelReply,
  shellFamily,
} from './shellCommand';

const ID = 'abc123';
const START = `\x1b]7750;Runova:Start:${ID}\x07`;
const done = (code: number) => `\x1b]7750;Runova:Done:${ID}:${code}\x07`;

describe('parseModelReply', () => {
  it('reads a RUN reply and drops wrapping backticks', () => {
    expect(parseModelReply('RUN: `df -h`')).toEqual({ kind: 'run', command: 'df -h' });
  });

  it('finds the reply line even with chatter around it', () => {
    expect(parseModelReply('Sure.\nRUN: uptime\nThanks')).toEqual({
      kind: 'run',
      command: 'uptime',
    });
  });

  it('reads FINISHED with and without a summary', () => {
    expect(parseModelReply('FINISHED: all done')).toEqual({
      kind: 'finished',
      message: 'all done',
    });
    expect(parseModelReply('FINISHED')).toEqual({ kind: 'finished', message: '' });
  });

  it('reads NEEDS_INPUT', () => {
    expect(parseModelReply('NEEDS_INPUT: which port?')).toEqual({
      kind: 'needs-input',
      message: 'which port?',
    });
  });

  it('returns null for anything else', () => {
    expect(parseModelReply('I would run df -h')).toBeNull();
    expect(parseModelReply('RUN: ``')).toBeNull();
  });

  it('keeps only the first line of FINISHED unless long answers are on', () => {
    expect(parseModelReply('FINISHED: line one\nline two')).toEqual({
      kind: 'finished',
      message: 'line one',
    });
  });

  describe('with long answers', () => {
    const long = { multilineFinished: true };

    it('takes everything after FINISHED, over several lines', () => {
      expect(parseModelReply('FINISHED: The app has two services:\n\n- web\n- db', long)).toEqual({
        kind: 'finished',
        message: 'The app has two services:\n\n- web\n- db',
      });
    });

    it('lets the answer start on the next line', () => {
      expect(parseModelReply('FINISHED:\n## Summary\nAll good.', long)).toEqual({
        kind: 'finished',
        message: '## Summary\nAll good.',
      });
    });

    it('does not read a RUN line inside the answer as a command', () => {
      expect(
        parseModelReply('FINISHED: To check it yourself:\nRUN: docker ps\nThat lists them.', long),
      ).toEqual({
        kind: 'finished',
        message: 'To check it yourself:\nRUN: docker ps\nThat lists them.',
      });
    });

    it('still runs a command that comes before FINISHED', () => {
      expect(parseModelReply('RUN: docker ps\nFINISHED: done', long)).toEqual({
        kind: 'run',
        command: 'docker ps',
      });
    });

    it('caps a very long answer', () => {
      const parsed = parseModelReply(`FINISHED: ${'a'.repeat(9000)}`, long);
      expect(parsed?.kind).toBe('finished');
      expect(parsed && 'message' in parsed ? parsed.message.length : 0).toBeLessThanOrEqual(8000);
    });

    it('reads RUN and NEEDS_INPUT as before', () => {
      expect(parseModelReply('NEEDS_INPUT: which port?\nmore', long)).toEqual({
        kind: 'needs-input',
        message: 'which port?',
      });
      expect(parseModelReply('Sure.\nRUN: uptime', long)).toEqual({
        kind: 'run',
        command: 'uptime',
      });
    });
  });
});

describe('isRiskyCommand', () => {
  it.each([
    'rm -rf /var/www',
    'sudo reboot',
    'curl https://x.sh | sudo bash',
    'git push origin main --force',
    'Remove-Item C:\\temp -Recurse',
  ])('flags %s', (command) => {
    expect(isRiskyCommand(command)).toBe(true);
  });

  it.each(['ls -la', 'apt-get update', 'git push origin main', 'rm file.txt'])(
    'lets %s through',
    (command) => {
      expect(isRiskyCommand(command)).toBe(false);
    },
  );
});

describe('allowSudoPasswordPrompt', () => {
  it.each([
    ['sudo -n apt-get update', 'sudo apt-get update'],
    ['sudo --non-interactive apt-get update', 'sudo apt-get update'],
    ['sudo -E -n apt-get upgrade -y', 'sudo -E apt-get upgrade -y'],
    ['sudo -n true && sudo -n reboot', 'sudo true && sudo reboot'],
  ])('turns %s into %s', (input, expected) => {
    expect(allowSudoPasswordPrompt(input)).toBe(expected);
  });

  it.each([
    'sudo apt-get update',
    'apt-get -n install foo',
    'sudo sed -n 1p /etc/hosts',
    'echo sudo -n',
  ])('leaves %s alone', (command) => {
    expect(allowSudoPasswordPrompt(command)).toBe(command);
  });
});

describe('endsWithPasswordPrompt', () => {
  it('sees sudo asking', () => {
    expect(endsWithPasswordPrompt('Reading lists\r\n[sudo] password for smartvpn: ')).toBe(true);
  });

  it('sees a plain Password: prompt', () => {
    expect(endsWithPasswordPrompt('Password:')).toBe(true);
  });

  it('sees a prompt right after the start marker and inside color codes', () => {
    expect(endsWithPasswordPrompt(`cmd\r\n${START}\x1b[1m[sudo] password for bob: \x1b[0m`)).toBe(
      true,
    );
  });

  it('ignores a password mentioned earlier in the output', () => {
    expect(endsWithPasswordPrompt('password: changed\r\nok\r\n')).toBe(false);
  });

  it('ignores a line far too long to be a prompt', () => {
    expect(endsWithPasswordPrompt(`${'x'.repeat(300)} password:`)).toBe(false);
  });
});

describe('shellFamily', () => {
  it.each([
    ['powershell.exe', 'powershell'],
    ['pwsh', 'powershell'],
    ['cmd.exe', 'cmd'],
    ['fish', 'fish'],
    ['bash', 'posix'],
    ['zsh', 'posix'],
  ])('%s is %s', (shell, family) => {
    expect(shellFamily(shell)).toBe(family);
  });
});

describe('PROMPT_READY', () => {
  it('matches both OSC terminators', () => {
    expect(PROMPT_READY.test('\x1b]7750;Runova:PromptReady:1\x07')).toBe(true);
    expect(PROMPT_READY.test('\x1b]7750;Runova:PromptReady:1\x1b\\')).toBe(true);
    expect(PROMPT_READY.test(']7750;Runova:PromptReady:1')).toBe(false);
  });
});

describe('markedCommandLine', () => {
  it('wraps a POSIX command in invisible start and done markers', () => {
    const marked = markedCommandLine('posix', 'uptime', ID, '\n', true);
    expect(marked.line).toBe(
      `printf '\\033]7750;Runova:Start:${ID}\\007'; uptime; ` +
        `printf '\\033]7750;Runova:Done:${ID}:%s\\007' "$?"\n`,
    );
    expect(marked.start).toBe(START);
  });

  it('reads the exit code from the done marker', () => {
    const { done: doneRegex } = markedCommandLine('posix', 'false', ID, '\n', true);
    expect(`out\r\n${done(127)}prompt$ `.match(doneRegex)?.[1]).toBe('127');
  });

  it('does not accept a done marker that has not finished arriving', () => {
    const { done: doneRegex } = markedCommandLine('posix', 'false', ID, '\n', true);
    expect(doneRegex.test(`\x1b]7750;Runova:Done:${ID}:1`)).toBe(false);
  });

  it('ignores markers from another command', () => {
    const { done: doneRegex } = markedCommandLine('posix', 'false', ID, '\n', true);
    expect(doneRegex.test('\x1b]7750;Runova:Done:other:0\x07')).toBe(false);
  });

  it('drops a trailing semicolon so the line stays valid', () => {
    const { line } = markedCommandLine('posix', 'cd /tmp;  ', ID, '\n', true);
    expect(line).toContain("; cd /tmp; printf '");
    expect(line).not.toContain(';;');
  });

  it('uses $status for fish', () => {
    expect(markedCommandLine('fish', 'ls', ID, '\r', true).line).toContain("\\007' $status\r");
  });

  it('prints the PowerShell markers with Write-Host', () => {
    const marked = markedCommandLine('powershell', 'Get-Date', ID, '\r', true);
    expect(marked.line.startsWith("Write-Host -NoNewline ([char]27 + ']7750;Runova:Start:")).toBe(
      true,
    );
    expect(marked.line).toContain('; Get-Date; $__runovaExit = if ($?)');
    expect(marked.start).toBe(START);
  });

  it('falls back to a plain-text marker for cmd, which cannot print ESC', () => {
    const marked = markedCommandLine('cmd', 'dir', ID, '\r', true);
    expect(marked.start).toBeNull();
    expect(marked.line).toBe(`dir & echo. & call echo __RUNOVA_DONE_${ID}__:%^errorlevel%\r`);
    expect(`__RUNOVA_DONE_${ID}__:9`.match(marked.done)?.[1]).toBe('9');
  });

  it('keeps the plain-text marker when hiding is off', () => {
    const marked = markedCommandLine('posix', 'ls', ID, '\r', false);
    expect(marked.start).toBeNull();
    expect(marked.line).toBe(`ls; printf '\\n__RUNOVA_DONE_${ID}__:%s\\n' "$?"\r`);
  });
});

describe('dropEcho', () => {
  const line = markedCommandLine('powershell', 'Get-Location', 'f00d', '\r', false).line;

  it('cuts the echoed line off the front of the output', () => {
    const output = `${line.trimEnd()}\r\n\r\nPath\r\n----\r\nC:\\Users\\me\r\n\r\n`;
    expect(dropEcho(output, line)).toBe('\r\n\r\nPath\r\n----\r\nC:\\Users\\me\r\n\r\n');
  });

  it('finds an echo that ConPTY wrapped and colored', () => {
    const typed = line.trimEnd();
    const wrapped = `\x1b[?25l\x1b[93m${typed.slice(0, 50)}\x1b[m\r\n${typed.slice(50)}\x1b[K\r\n`;
    expect(dropEcho(`${wrapped}C:\\Users\\me\r\n`, line)).toBe('\x1b[K\r\nC:\\Users\\me\r\n');
  });

  it('keeps the output when ConPTY paints the echo again after it', () => {
    const typed = line.trimEnd();
    const output = `${typed}\r\nPath\r\nC:\\Users\\me\r\n\x1b[H${typed}\x1b[K\r\n`;
    expect(dropEcho(output, line)).toBe('\r\nPath\r\nC:\\Users\\me\r\n\x1b[H\x1b[K\r\n');
  });

  it('leaves output alone when the echo is not in it', () => {
    expect(dropEcho('hello\r\n', line)).toBe('hello\r\n');
  });
});

describe('CommandDisplay', () => {
  let shown: string;
  let captured: boolean[];
  const sink = {
    captureDisplay: (value: boolean) => captured.push(value),
    display: (data: string) => {
      shown += data;
    },
  };
  const marked = markedCommandLine('posix', 'uptime', ID, '\n', true) as MarkedCommand & {
    start: string;
  };
  const echo = `printf '\\033]7750;Runova:Start:${ID}\\007'; uptime; printf '...'\r\n`;

  beforeEach(() => {
    vi.useFakeTimers();
    shown = '';
    captured = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures the pane while the command runs and hands it back afterwards', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    expect(captured).toEqual([true]);
    display.push(`${echo}${START}up 3 days\r\n${done(0)}user@host:~$ `);
    expect(captured).toEqual([true, false]);
  });

  it('replaces the echoed wrapper with the bare command', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}up 3 days\r\n${done(0)}user@host:~$ `);
    expect(shown).toBe('uptime\r\nup 3 days\r\nuser@host:~$ ');
  });

  it('shows nothing until the command starts', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(echo);
    expect(shown).toBe('');
  });

  it('passes output through as it arrives, before the command ends', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}`);
    display.push('first line\r\n');
    expect(shown).toBe('uptime\r\nfirst line\r\n');
    display.push('second line\r\n');
    expect(shown).toBe('uptime\r\nfirst line\r\nsecond line\r\n');
  });

  it('gives the same picture however the stream is split', () => {
    const stream = `${echo}${START}line one\r\n\x1b[32mgreen\x1b[0m\r\n${done(0)}user@host:~$ `;
    const expected = 'uptime\r\nline one\r\n\x1b[32mgreen\x1b[0m\r\nuser@host:~$ ';
    for (let a = 1; a < stream.length; a += 1) {
      for (const b of [a + 1, a + 5, a + 23]) {
        if (b >= stream.length) continue;
        shown = '';
        captured = [];
        const display = new CommandDisplay(sink, 'uptime', marked, ID);
        // Like ssh.ts: once the pane is handed back, output goes to it directly.
        const feed = (data: string) => {
          if (!captured.at(-1)) shown += data;
          display.push(data);
        };
        feed(stream.slice(0, a));
        feed(stream.slice(a, b));
        feed(stream.slice(b));
        expect(shown, `split at ${a}/${b}`).toBe(expected);
      }
    }
  });

  it('never shows a piece of the done marker while waiting for the rest', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}out\r\n\x1b]7750;Runova:Do`);
    expect(shown).toBe('uptime\r\nout\r\n');
    display.push(`ne:${ID}:0`);
    expect(shown).toBe('uptime\r\nout\r\n');
    display.push('\x07$ ');
    expect(shown).toBe('uptime\r\nout\r\n$ ');
  });

  it('does not hold back escape sequences that are not the marker', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}\x1b[1m`);
    expect(shown).toBe('uptime\r\n\x1b[1m');
  });

  it('shows the raw echo when the command never starts', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push("echo 'unclosed\r\n> ");
    expect(shown).toBe('');
    vi.advanceTimersByTime(ECHO_TIMEOUT_MS);
    expect(shown).toBe("echo 'unclosed\r\n> ");
    display.push('more');
    expect(shown).toBe("echo 'unclosed\r\n> more");
  });

  it('does not fire the echo timeout once the command started', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}`);
    vi.advanceTimersByTime(ECHO_TIMEOUT_MS * 2);
    expect(shown).toBe('uptime\r\n');
  });

  it('flushes whatever it held and hands the pane back on release', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}partial\x1b]7750;Runova:Done:`);
    display.release();
    expect(shown).toBe('uptime\r\npartial\x1b]7750;Runova:Done:');
    expect(captured).toEqual([true, false]);
  });

  it('ignores output after it is done', () => {
    const display = new CommandDisplay(sink, 'uptime', marked, ID);
    display.push(`${echo}${START}${done(0)}`);
    display.push('later');
    display.release();
    expect(shown).toBe('uptime\r\n');
    expect(captured).toEqual([true, false]);
  });
});
