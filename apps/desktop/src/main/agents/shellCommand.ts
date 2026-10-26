/**
 * The parts of the AI task runner that only deal with text: reading the model's reply, wrapping a
 * command so the shell reports when it starts and ends, and keeping that wrapping out of the
 * terminal the user watches. Nothing here touches Electron or a live session.
 */

/**
 * Commands that look destructive enough to pause for approval even in `approve-risky` mode.
 * False negatives are fine (the user can still stop the run); a false positive just costs one
 * extra click.
 */
const RISKY_PATTERNS = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bdrop\s+(table|database)\b/i,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
  />\s*\/dev\/(sd|nvme|hd|xvd)/i,
  /\bdocker\s+system\s+prune\b/i,
  /\biptables\s+-F\b/i,
  /\bkill\s+-9\s+1\b/i,
  /\buserdel\b/i,
  /\bcurl[^|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
  /\bwget[^|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
  // Local Windows shells.
  /\bRemove-Item\b[^|;]*-Recurse\b/i,
  /\b(rd|rmdir)\s+\/s\b/i,
  /\bdel\s+[^|&]*\/s\b/i,
  /\bformat(-Volume)?\s+[a-z]:/i,
  /\b(Stop|Restart)-Computer\b/i,
  /\bdiskpart\b/i,
  /\b(iex|Invoke-Expression)\b/i,
  // Work that only lives on this machine.
  /\bgit\s+(reset\s+--hard|clean\s+-\w*f|push\s+[^|;&]*(--force|-f)\b)/i,
];

export function isRiskyCommand(command: string): boolean {
  return RISKY_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * `sudo -n` fails right away instead of asking for a password, so the prompt Runova answers
 * with the saved one never shows up. Models add it anyway to avoid a hanging command, so it goes.
 */
export function allowSudoPasswordPrompt(command: string): string {
  return command.replace(/\b(sudo(?:\s+-[A-Za-z]+)*?)\s+(?:-n|--non-interactive)(?=\s)/g, '$1');
}

export type ParsedReply =
  | { kind: 'run'; command: string }
  | { kind: 'finished'; message: string }
  | { kind: 'needs-input'; message: string };

export function parseModelReply(text: string): ParsedReply | null {
  const runMatch = text.match(/^\s*RUN:\s*(.+)$/im);
  if (runMatch) {
    const command = runMatch[1]
      .trim()
      .replace(/^`+|`+$/g, '')
      .trim();
    if (command) return { kind: 'run', command };
  }
  const finishedMatch = text.match(/^\s*FINISHED:?\s*(.*)$/im);
  if (finishedMatch) return { kind: 'finished', message: finishedMatch[1].trim() };
  const needsInputMatch = text.match(/^\s*NEEDS_INPUT:\s*(.+)$/im);
  if (needsInputMatch) return { kind: 'needs-input', message: needsInputMatch[1].trim() };
  return null;
}

export type ShellFamily = 'posix' | 'fish' | 'powershell' | 'cmd';

export function shellFamily(shell: string): ShellFamily {
  const name = shell.toLowerCase().replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (name === 'fish') return 'fish';
  return 'posix';
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC/BEL frame the OSC prompt marker
export const PROMPT_READY = /\x1b\]7750;Runova:PromptReady:1(?:\x07|\x1b\\)/;

/**
 * The output ends on a password prompt: sudo's own (`[sudo] password for bob:`), `su`, `passwd`,
 * or anything else that ends on `Password:`. Only the trailing line is checked, so a log line that
 * merely mentions a password earlier in the output doesn't count.
 */
const PASSWORD_PROMPT = /password(?: for [^\n:]+)?:\s*$/i;

export function endsWithPasswordPrompt(output: string): boolean {
  const lastLine = stripAnsi(output).split('\n').pop() ?? '';
  return lastLine.length <= 200 && PASSWORD_PROMPT.test(lastLine);
}

function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts every ANSI escape sequence
      .replace(/\x1b\[[?]?\d*(?:;\d+)*[a-zA-Z]/g, '')
      .replace(/\r/g, '')
  );
}

export interface MarkedCommand {
  line: string;
  /**
   * Printed right before the command runs, or null when the markers are plain text. Everything
   * ahead of it is the shell echoing the typed line.
   */
  start: string | null;
  /** Matches what the shell prints once the command ends; group 1 is the exit code. */
  done: RegExp;
}

/**
 * Wraps a command so the shell reports when it starts and when it ends. With `hidden`, both
 * reports are OSC sequences, which the terminal draws nothing for, and `CommandDisplay` hides the
 * echo of the wrapper. Otherwise (and always for cmd, which cannot print an escape character) a
 * plain-text marker is printed after the command.
 *
 * `enter` is what the shell treats as pressing Enter: `\r` for a local pty, `\n` over SSH.
 */
export function markedCommandLine(
  family: ShellFamily,
  command: string,
  id: string,
  enter: string,
  hidden: boolean,
): MarkedCommand {
  // A trailing `;` would put `;;` in front of the marker, which bash rejects.
  const body = family === 'cmd' ? command : command.replace(/[\s;]+$/, '');
  if (!hidden || family === 'cmd') {
    const marker = `__RUNOVA_DONE_${id}__`;
    const done = new RegExp(`${marker}:(\\d+)`);
    switch (family) {
      case 'powershell':
        // $? has to be read before anything else runs, since every statement resets it.
        return {
          line:
            `${body}; $__runovaExit = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; ` +
            `Write-Host "\`n${marker}:$__runovaExit"${enter}`,
          start: null,
          done,
        };
      case 'cmd':
        // `call` delays the expansion until the command has run; plain %errorlevel% would be
        // filled in when the line is read.
        return {
          line: `${body} & echo. & call echo ${marker}:%^errorlevel%${enter}`,
          start: null,
          done,
        };
      case 'fish':
        return { line: `${body}; printf '\\n${marker}:%s\\n' $status${enter}`, start: null, done };
      default:
        return { line: `${body}; printf '\\n${marker}:%s\\n' "$?"${enter}`, start: null, done };
    }
  }

  // BEL ends both markers, so a done marker read in pieces can't pass `:1` off as `:12`.
  const start = `\x1b]7750;Runova:Start:${id}\x07`;
  const done = new RegExp(`\x1b\\]7750;Runova:Done:${id}:(\\d+)\x07`);
  if (family === 'powershell') {
    return {
      line:
        `Write-Host -NoNewline ([char]27 + ']7750;Runova:Start:${id}' + [char]7); ${body}; ` +
        '$__runovaExit = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; ' +
        `Write-Host -NoNewline ([char]27 + ']7750;Runova:Done:${id}:' + $__runovaExit + [char]7)${enter}`,
      start,
      done,
    };
  }
  const exitCode = family === 'fish' ? '$status' : '"$?"';
  return {
    line:
      `printf '\\033]7750;Runova:Start:${id}\\007'; ${body}; ` +
      `printf '\\033]7750;Runova:Done:${id}:%s\\007' ${exitCode}${enter}`,
    start,
    done,
  };
}

/** Index of the last character of the escape sequence starting at `from` (an ESC). */
function escapeEnd(text: string, from: number): number {
  const kind = text[from + 1];
  if (kind === '[') {
    let i = from + 2;
    while (i < text.length && !/[@-~]/.test(text[i] ?? '')) i++;
    return i;
  }
  if (kind === ']') {
    let i = from + 2;
    while (i < text.length && text[i] !== '\x07' && !(text[i] === '\x1b' && text[i + 1] === '\\'))
      i++;
    return text[i] === '\x1b' ? i + 1 : i;
  }
  return from + 1;
}

/**
 * Output of a command typed with plain-text markers, minus the shell's echo of the typed line.
 * ConPTY wraps that echo with escape codes and line breaks of its own, and can paint it again
 * after the output has started, so the line is found by its visible characters alone: whatever
 * came before the first copy goes, and any later copy is cut out. Unchanged without an echo.
 */
export function dropEcho(output: string, typedLine: string): string {
  const target = typedLine.replace(/\s+/g, '');
  if (!target) return output;
  let visible = '';
  const origin: number[] = [];
  for (let i = 0; i < output.length; i++) {
    const ch = output[i] ?? '';
    if (ch === '\x1b') {
      i = escapeEnd(output, i);
      continue;
    }
    if (ch <= ' ') continue;
    visible += ch;
    origin.push(i);
  }
  const copies: [number, number][] = [];
  for (
    let at = visible.indexOf(target);
    at >= 0;
    at = visible.indexOf(target, at + target.length)
  ) {
    copies.push([origin[at] ?? 0, (origin[at + target.length - 1] ?? 0) + 1]);
  }
  if (copies.length === 0) return output;
  let result = '';
  let from = copies[0]?.[1] ?? 0;
  for (const [start, end] of copies.slice(1)) {
    result += output.slice(from, start);
    from = end;
  }
  return result + output.slice(from);
}

/** Where `CommandDisplay` draws: the terminal pane of the session the command runs in. */
export interface DisplaySink {
  /** While captured, output only reaches the terminal pane through `display`. */
  captureDisplay: (captured: boolean) => void;
  /** Draws text in the terminal pane without sending it to the shell. */
  display: (data: string) => void;
}

/**
 * How long the shell gets to start a command before its echo is shown as it came. It only runs
 * out when the line never started, e.g. the shell is waiting on an unclosed quote.
 */
export const ECHO_TIMEOUT_MS = 4000;

/**
 * Shows a running command the way it would look had the user typed it. The shell's echo of the
 * typed line, marker commands and all, is held back until the start marker arrives. The bare
 * command is drawn in its place, and from then on output passes straight through with the done
 * marker cut out.
 */
export class CommandDisplay {
  private phase: 'echo' | 'output' | 'released' = 'echo';
  private held = '';
  private readonly echoTimer: ReturnType<typeof setTimeout>;
  private readonly donePrefix: string;

  constructor(
    private readonly sink: DisplaySink,
    private readonly command: string,
    private readonly marked: MarkedCommand & { start: string },
    id: string,
  ) {
    this.donePrefix = `\x1b]7750;Runova:Done:${id}:`;
    sink.captureDisplay(true);
    // The line never started, so there is no clean version to draw. Show what the shell printed.
    this.echoTimer = setTimeout(() => {
      if (this.phase !== 'echo') return;
      this.phase = 'output';
      this.passOutput();
    }, ECHO_TIMEOUT_MS);
  }

  push(data: string): void {
    if (this.phase === 'released') return;
    this.held += data;
    if (this.phase === 'echo') {
      const at = this.held.indexOf(this.marked.start);
      if (at < 0) return;
      clearTimeout(this.echoTimer);
      this.phase = 'output';
      this.held = this.held.slice(at + this.marked.start.length);
      this.sink.display(`${this.command}\r\n`);
    }
    this.passOutput();
  }

  /** The command ended without its done marker: timed out, session closed, or back at a prompt. */
  release(): void {
    if (this.phase === 'released') return;
    const rest = this.held;
    this.finish();
    this.sink.display(rest);
  }

  private passOutput(): void {
    const match = this.held.match(this.marked.done);
    if (match?.index !== undefined) {
      const shown =
        this.held.slice(0, match.index) + this.held.slice(match.index + match[0].length);
      this.finish();
      this.sink.display(shown);
      return;
    }
    // A chunk can end partway through the done marker. That piece waits for the rest of it.
    const esc = this.held.lastIndexOf('\x1b');
    const tail = esc >= 0 ? this.held.slice(esc) : '';
    const partial =
      tail !== '' &&
      (this.donePrefix.startsWith(tail) ||
        (tail.startsWith(this.donePrefix) && /^\d*$/.test(tail.slice(this.donePrefix.length))));
    const cut = partial ? esc : this.held.length;
    this.sink.display(this.held.slice(0, cut));
    this.held = this.held.slice(cut);
  }

  private finish(): void {
    clearTimeout(this.echoTimer);
    this.phase = 'released';
    this.held = '';
    this.sink.captureDisplay(false);
  }
}
