import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getCliDefinition, runArgsFor } from '@runova/core';
import type {
  AiProvider,
  SshAgentHistoryEntry,
  SshAgentHistoryRun,
  SshAgentMode,
  SshAgentPhase,
  SshAgentProgress,
  SshAgentRunSettings,
  StartSshAgentTaskInput,
} from '../../shared/apiTypes';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '../../shared/sshAgentMessage';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { runAiPrompt } from '../ipc/ai';
import {
  getSshSessionPassword,
  hasSshSession,
  setSshDisplayCaptured,
  sshSessionServerId,
  subscribeSshExit,
  subscribeSshOutput,
  writeToSshDisplay,
  writeToSshSession,
} from '../ipc/ssh';
import {
  hasAttachedTerminalSession,
  setTerminalDisplayCaptured,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  terminalSessionShell,
  writeToSession,
  writeToTerminalDisplay,
} from '../ipc/terminal';
import { getMainWindow } from '../mainWindow';
import { showOsNotification } from '../notifications/osNotification';
import { speakOnPet } from '../notifications/petNotifier';
import { stripAnsi } from '../process/spawnStreaming';
import { store } from '../store';
import {
  allowSudoPasswordPrompt,
  CommandDisplay,
  type DisplaySink,
  dropEcho,
  endsWithPasswordPrompt,
  isRiskyCommand,
  type MarkedCommand,
  markedCommandLine,
  PROMPT_READY,
  parseModelReply,
  type ShellFamily,
  shellFamily,
} from './shellCommand';
import { previousTaskContext } from './sshTaskContext';
import { createSshHistoryStore } from './sshTaskHistoryStore';

/** Refuses to loop forever if the AI never says FINISHED. */
const MAX_STEPS = 40;
const MAX_RUNTIME_MS = 30 * 60 * 1000;
/** How long a single command may run before its output is given up on. */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
/** How much of the transcript is kept in the prompt sent to the AI each step. */
const TRANSCRIPT_TAIL_CHARS = 6000;
/** Past tasks kept per terminal for the history view. */
const MAX_HISTORY_RUNS = 20;
/** Past tasks a saved server's AI history lists, across all of its tabs. */
const MAX_SERVER_HISTORY_RUNS = 50;
/** Output kept per command in the history. The end is what explains how a command went. */
const MAX_HISTORY_OUTPUT_CHARS = 8000;
/** How far back a chain of continued tasks is followed for the AI's background. */
const MAX_CONTINUED_CHAIN = 10;

/**
 * An agent CLI would otherwise happily use its own tools, which run on the user's machine rather
 * than on the server. Every command has to go through the reply format instead.
 */
export function cliPreamble(target: Pick<TaskTarget, 'kind'>): string {
  return (
    'Do not use any tools, do not read or edit local files, and do not run anything yourself. ' +
    'Commands only run when you reply in the format below, and they run ' +
    (target.kind !== 'local'
      ? 'on the remote server, not on this machine.\n\n'
      : "in the user's terminal tab, where they can watch them.\n\n")
  );
}

/**
 * Where a run's commands go: an SSH channel or a local shell (typed with markers), or a server
 * core (E09, through its exec stream). The loop only needs these; how a command runs is up to
 * the run's `CommandExecutor`.
 */
export interface TaskTarget {
  kind: 'ssh' | 'local' | 'core';
  /** How the prompt describes the shell to the AI. */
  description: string;
  /** Short label for pet notifications. */
  label: string;
  isConnected: () => boolean;
  subscribeExit: (listener: () => void) => () => void;
  /** What a stop because the target went away says. The SSH and local wording is the default. */
  endedMessage?: string;
}

/** The terminal a run drives: an SSH channel, or a shell running on this machine. */
interface ShellTarget extends TaskTarget, DisplaySink {
  kind: 'ssh' | 'local';
  write: (data: string) => void;
  subscribeOutput: (listener: (data: string) => void) => () => void;
  /** The saved login password for a sudo prompt. Always null for a local shell. */
  getPassword: () => Promise<string | null>;
  /** The line to type for a command, wrapped so the shell reports when it starts and ends. */
  commandLine: (command: string, id: string) => MarkedCommand;
  /**
   * A local shell announces every fresh prompt (see ptyHost/shellIntegration.ts), which ends a
   * command whose line never printed the marker, e.g. one the shell refused to parse.
   */
  detectsPrompt: boolean;
}

const SHELL_LABELS: Record<ShellFamily, string> = {
  posix: 'POSIX',
  fish: 'fish',
  powershell: 'PowerShell',
  cmd: 'Windows Command Prompt (cmd.exe)',
};

function platformLabel(): string {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

function sshTarget(sessionId: string): ShellTarget {
  return {
    kind: 'ssh',
    description: 'a real remote Linux shell over an active SSH session',
    label: 'SSH session',
    isConnected: () => hasSshSession(sessionId),
    write: (data) => writeToSshSession(sessionId, data),
    subscribeOutput: (listener) => subscribeSshOutput(sessionId, listener),
    subscribeExit: (listener) => subscribeSshExit(sessionId, listener),
    getPassword: () => getSshSessionPassword(sessionId),
    commandLine: (command, id) => markedCommandLine('posix', command, id, '\n', true),
    captureDisplay: (captured) => setSshDisplayCaptured(sessionId, captured),
    display: (data) => writeToSshDisplay(sessionId, data),
    detectsPrompt: false,
  };
}

function localTarget(sessionId: string): ShellTarget {
  const shell = terminalSessionShell(sessionId);
  const family = shellFamily(shell);
  const shellName = family === 'posix' ? shell : SHELL_LABELS[family];
  return {
    kind: 'local',
    description:
      `a real ${shellName} shell running on the user's own ${platformLabel()} computer, in one ` +
      `of their terminal tabs. Every command must be valid ${shellName} syntax`,
    label: 'Terminal',
    isConnected: () => hasAttachedTerminalSession(sessionId),
    write: (data) => writeToSession(sessionId, data),
    subscribeOutput: (listener) => subscribeTerminalOutput(sessionId, listener),
    subscribeExit: (listener) => subscribeTerminalExit(sessionId, listener),
    getPassword: async () => null,
    // ConPTY repaints the screen itself and can pass an escape sequence through ahead of the
    // text printed around it, so on Windows the markers stay plain text.
    commandLine: (command, id) =>
      markedCommandLine(family, command, id, '\r', process.platform !== 'win32'),
    captureDisplay: (captured) => setTerminalDisplayCaptured(sessionId, captured),
    display: (data) => writeToTerminalDisplay(sessionId, data),
    detectsPrompt: true,
  };
}

/** The end of the transcript that goes in each step's prompt. */
function transcriptTail(transcript: string): string {
  return transcript.length > TRANSCRIPT_TAIL_CHARS
    ? `…(earlier output truncated)…${transcript.slice(-TRANSCRIPT_TAIL_CHARS)}`
    : transcript || '(no commands run yet)';
}

/** What a run's own prompt builder gets each step. */
export interface PromptInput {
  /** The user's task, trimmed. */
  task: string;
  /** The transcript's end, as the shell prompt shows it. */
  transcript: string;
  /** True when an agent CLI decides the step, which needs `cliPreamble` first. */
  viaCli: boolean;
}

/**
 * What the user said after starting the run, as a block for the end of the task. It goes in every
 * prompt rather than the transcript, whose tail is cut when a command prints a lot.
 */
function followUpBlock(run: RunState): string {
  if (run.followUps.length === 0) return '';
  const lines = run.followUps.map((text) => `- ${text.replace(/\n/g, '\n  ')}`);
  return `\n\nThe user added these while you were working, oldest first. They take priority over anything earlier, so change course if one asks for it:\n${lines.join('\n')}`;
}

/**
 * What happened in the earlier tasks this one continues, as a block for the end of the task. Like
 * the follow-ups it goes in every prompt, since it is not in this run's transcript.
 */
function previousBlock(run: RunState): string {
  if (!run.previousContext) return '';
  return `\n\n${run.previousContext}\nThat is background. The task above is what to do now.`;
}

function buildPrompt(run: RunState): string {
  const tail = transcriptTail(run.transcript);
  if (run.buildPrompt) {
    return run.buildPrompt({
      task: run.prompt + previousBlock(run) + followUpBlock(run),
      transcript: tail,
      viaCli: run.cliId !== null,
    });
  }
  return `${run.cliId ? cliPreamble(run.target) : ''}You are operating ${run.target.description}, on behalf of a user who is watching every command execute live in their terminal.

User's task: "${run.prompt}"${previousBlock(run)}${followUpBlock(run)}

Reply with EXACTLY one of these three forms, and nothing else:
RUN: <a single shell command>
FINISHED: <one short sentence summarizing what was accomplished>
NEEDS_INPUT: <a short question for the user>

Rules:
- Exactly one command per reply. Do not chain unrelated steps with && unless they are trivially part of the same action.
- Prefer flags that skip confirmations (-y, --yes) so a command never hangs waiting on a TTY prompt.
- When a command needs root, use plain sudo. Never pass sudo -n or -S, and never use NEEDS_INPUT to ask for a password: when sudo prompts for one, Runova answers it for the user.
- Let commands print their normal progress. Do not silence them with -qq or > /dev/null, since the user is watching the output.
- Do not repeat a command that already ran successfully in the transcript below.
- If the transcript shows the task is already done, reply FINISHED.

Transcript so far (most recent last):
${tail}`;
}

interface PendingApproval {
  command: string;
  resolve: (approved: boolean) => void;
}

/** Whether a command waits for the user before it runs, and what the approval bar says. */
export type ApprovalPolicy = (command: string) => { pause: boolean; message?: string };

/** The SSH and local modes: approve every command, only the risky ones, or none. */
function modePolicy(mode: SshAgentMode): ApprovalPolicy {
  return (command) => {
    const risky = isRiskyCommand(command);
    return {
      pause: mode === 'approve-all' || (mode === 'approve-risky' && risky),
      message: risky ? 'This command looks destructive.' : undefined,
    };
  };
}

/** Thrown by an executor whose target refused to run the command without the user's approval. */
export class ApprovalRequiredError extends Error {}

/**
 * Runs one command for the loop and resolves once it has ended. `approved` is true when the user
 * approved this exact command. An executor may throw `ApprovalRequiredError` when its target will
 * not run the command unattended; the loop then asks the user and calls again with true.
 */
export type CommandExecutor = (
  run: { signal: AbortSignal },
  command: string,
  approved: boolean,
) => Promise<CommandResult>;

interface RunState {
  sessionId: string;
  target: TaskTarget;
  policy: ApprovalPolicy;
  executor: CommandExecutor;
  /** A prompt of the run's own; the shell prompt (`buildPrompt`) otherwise. */
  buildPrompt: ((input: PromptInput) => string) | null;
  /** Agent CLI deciding each step, or null for the AI provider from Settings. */
  cliId: string | null;
  /** Model and effort flags for that CLI. */
  runArgs: string[];
  /** Set while a CLI is working out the next step, so Stop can kill it. */
  cliRequestId: string | null;
  prompt: string;
  /** What happened in the earlier tasks this one continues, or empty for a fresh task. */
  previousContext: string;
  /** Messages the user sent after starting, oldest first. Every later prompt carries them. */
  followUps: string[];
  /** How many of those the AI's current step was asked with. The rest are still waiting. */
  followUpsPrompted: number;
  transcript: string;
  step: number;
  startedAt: number;
  aborted: boolean;
  controller: AbortController;
  pendingApproval: PendingApproval | null;
  pendingInputAnswer: ((answer: string) => void) | null;
  /** Resolves with true when the user lets Runova type the saved password into a prompt. */
  pendingPassword: ((approved: boolean) => void) | null;
  /** Set while the run is paused on an error: true picks it up again, false ends it. */
  pendingContinue: ((resume: boolean) => void) | null;
  /** The step the run stops at. Continue after hitting it allows another MAX_STEPS. */
  stepLimit: number;
  history: SshAgentHistoryRun;
  /** What the run last reported, so a notification can say what it is waiting for. */
  lastProgress: SshAgentProgress | null;
  unsubscribeExit: () => void;
  listener: (progress: SshAgentProgress) => void;
}

const runs = new Map<string, RunState>();
/** Every terminal's past and current tasks, newest last. Kept for as long as the app runs. */
const histories = new Map<string, SshAgentHistoryRun[]>();
/** Tasks read back from disk, run in tabs of an earlier session of the app. All on saved servers. */
let restored: SshAgentHistoryRun[] = [];
let restoring: Promise<void> | null = null;
// Async wrappers, so a store without these (a test's) is a rejected read, not a throw.
const savedHistory = createSshHistoryStore({
  read: async () => store.getSshAgentHistory(),
  write: async (list) => store.setSshAgentHistory(list),
});

function allHistory(): SshAgentHistoryRun[] {
  return [...restored, ...[...histories.values()].flat()];
}

/** Writes the history soon, when the task belongs to a saved server. Nothing else is kept. */
function persist(entry: SshAgentHistoryRun): void {
  if (entry.serverId) savedHistory.save(allHistory());
}

/** Reads the saved history once, so earlier tasks can be listed and continued. */
export function ensureSshHistoryRestored(): Promise<void> {
  restoring ??= savedHistory.load().then((saved) => {
    const live = new Set(allHistory().map((run) => run.id));
    restored = saved.filter((run) => !live.has(run.id));
  });
  return restoring;
}

/** Writes any change still waiting, for when the app quits. */
export function flushSshTaskHistory(): Promise<void> {
  return savedHistory.flush();
}

/** Forgets every finished task on a saved server, here and on disk. A task still going stays. */
export async function clearSshServerTaskHistory(serverId: string): Promise<void> {
  await ensureSshHistoryRestored();
  const gone = (run: SshAgentHistoryRun): boolean =>
    run.serverId === serverId && run.status !== 'running' && run.status !== 'paused';
  restored = restored.filter((run) => !gone(run));
  for (const [sessionId, list] of histories)
    histories.set(
      sessionId,
      list.filter((run) => !gone(run)),
    );
  savedHistory.save(allHistory());
  await savedHistory.flush();
}

/** The task with this id and the ones it continued, oldest first. Empty when it is unknown. */
function historyChain(runId: string): SshAgentHistoryRun[] {
  const all = allHistory();
  const chain: SshAgentHistoryRun[] = [];
  let next: string | undefined = runId;
  while (next && chain.length < MAX_CONTINUED_CHAIN) {
    const found = all.find((run) => run.id === next);
    if (!found || chain.includes(found)) break;
    chain.unshift(found);
    next = found.continuedFromRunId;
  }
  return chain;
}

/** Messages from the user the AI has not been asked with yet. */
function queuedMessages(run: RunState): number {
  return run.followUps.length - run.followUpsPrompted;
}

function emit(run: RunState, phase: SshAgentPhase, extra: Partial<SshAgentProgress> = {}): void {
  const queued = queuedMessages(run);
  run.lastProgress = {
    sessionId: run.sessionId,
    phase,
    step: run.step,
    ...extra,
    // Left out when nothing waits, so a run nobody talked to reports what it always did.
    ...(queued > 0 ? { queuedMessages: queued } : {}),
  };
  run.listener(run.lastProgress);
}

/** Reports the queue again with whatever the run last said, so the bar shows a new message at once. */
function announceQueue(run: RunState): void {
  if (!run.lastProgress) return;
  const { queuedMessages: _old, ...rest } = run.lastProgress;
  const queued = queuedMessages(run);
  run.lastProgress = queued > 0 ? { ...rest, queuedMessages: queued } : rest;
  run.listener(run.lastProgress);
}

/** Distributes Omit over the union, so each entry kind keeps its own fields. */
type NewHistoryEntry = SshAgentHistoryEntry extends infer E
  ? E extends SshAgentHistoryEntry
    ? Omit<E, 'at'>
    : never
  : never;

function record(run: RunState, entry: NewHistoryEntry): void {
  run.history.entries.push({ ...entry, at: Date.now() } as SshAgentHistoryEntry);
  persist(run.history);
}

function endHistory(run: RunState, status: SshAgentHistoryRun['status']): void {
  run.history.status = status;
  run.history.endedAt = Date.now();
  persist(run.history);
}

function startHistory(
  sessionId: string,
  serverId: string | null,
  prompt: string,
  extra: Pick<SshAgentHistoryRun, 'settings' | 'continuedFromRunId'>,
): SshAgentHistoryRun {
  const entry: SshAgentHistoryRun = {
    id: randomUUID(),
    sessionId,
    ...(serverId ? { serverId } : {}),
    prompt,
    aiLabel: '',
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    entries: [],
    ...(extra.settings ? { settings: extra.settings } : {}),
    ...(extra.continuedFromRunId ? { continuedFromRunId: extra.continuedFromRunId } : {}),
  };
  const list = histories.get(sessionId) ?? [];
  list.push(entry);
  histories.set(sessionId, list.slice(-MAX_HISTORY_RUNS));
  persist(entry);
  return entry;
}

/** The terminal's AI tasks, newest first. */
/** What a task that continues `runId` is told about it and the tasks it continued. */
export function continuedTaskContext(runId: string): string {
  return previousTaskContext(historyChain(runId));
}

export function getSshTaskHistory(sessionId: string): SshAgentHistoryRun[] {
  return [...(histories.get(sessionId) ?? [])].reverse();
}

/**
 * The AI tasks run in any SSH tab on a saved server, newest first. They outlive the tab, so the
 * server's AI history still lists them after it closed.
 */
export function getSshServerTaskHistory(serverId: string): SshAgentHistoryRun[] {
  return allHistory()
    .filter((run) => run.serverId === serverId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SERVER_HISTORY_RUNS);
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

async function resolveProviderAndModel(): Promise<{ provider: AiProvider; model: string }> {
  const settings = await store.getSettings();
  const provider = settings.promptBuilderProvider;
  const model =
    provider === 'openai'
      ? settings.openaiModel
      : provider === 'gemini'
        ? settings.geminiModel
        : settings.ollamaModel;
  return { provider, model };
}

function waitForApproval(run: RunState, command: string): Promise<boolean> {
  return new Promise((resolve) => {
    run.pendingApproval = { command, resolve };
  });
}

/** Proposes the command and waits; a skip goes in the history and the transcript. */
async function askApproval(
  run: RunState,
  command: string,
  message: string | undefined,
): Promise<boolean> {
  emit(run, 'proposed', { command, message });
  const approved = await waitForApproval(run, command);
  if (run.aborted) return false;
  if (!approved) {
    record(run, { kind: 'skipped', command });
    run.transcript += `\n$ ${command}\n[skipped by user, not run]\n`;
  }
  return approved;
}

/**
 * Asks the user before typing the saved login password into a prompt the running command opened.
 * Declining (or having no saved password) leaves the prompt for them to answer in the terminal.
 */
async function handlePasswordPrompt(
  run: RunState,
  target: ShellTarget,
  command: string,
): Promise<void> {
  const password = await target.getPassword();
  if (run.aborted) return;
  const asker = target.kind === 'ssh' ? 'The server' : 'The command';
  // Listening starts before the bar appears, so an answer can never arrive with nobody waiting.
  const answer = new Promise<boolean>((resolve) => {
    run.pendingPassword = resolve;
  });
  emit(run, 'needs-password', {
    command,
    hasSavedPassword: password !== null,
    message: password
      ? `${asker} is asking for a password. Enter the saved one for you?`
      : target.kind === 'ssh'
        ? 'The server is asking for a password, and none is saved for it. Type it in the terminal.'
        : 'The command is asking for a password. Type it in the terminal.',
  });
  const settings = await store.getSettings();
  speakOnPet(settings, target.label, `${asker} is asking for a password.`, 'warn');
  const approved = await answer;
  if (run.aborted) return;
  if (approved && password !== null) target.write(`${password}\n`);
  emit(run, 'running', { command });
}

function settlePendingPassword(run: RunState): void {
  if (!run.pendingPassword) return;
  const resolve = run.pendingPassword;
  run.pendingPassword = null;
  resolve(false);
}

function waitForUserAnswer(run: RunState): Promise<string> {
  return new Promise((resolve) => {
    run.pendingInputAnswer = resolve;
  });
}

export interface CommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Types `command` into the shell and resolves once it ends. */
function runCommand(run: RunState, target: ShellTarget, command: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const id = randomUUID().replace(/-/g, '');
    const marked = target.commandLine(command, id);
    const { start } = marked;
    const display = start ? new CommandDisplay(target, command, { ...marked, start }, id) : null;
    let buffer = '';
    let settled = false;
    /** Output before this index has already been checked for a password prompt. */
    let promptScanFrom = 0;
    let askingForPassword = false;
    let timer = startTimer();
    const unsubscribeOutput = target.subscribeOutput((data) => {
      buffer += data;
      display?.push(data);
      const match = buffer.match(marked.done);
      if (match?.index !== undefined) {
        // The AI gets the output alone, without the shell's echo of the typed line.
        const startAt = start ? buffer.indexOf(start) : -1;
        finish({
          output: start
            ? buffer.slice(startAt < 0 ? 0 : startAt + start.length, match.index)
            : dropEcho(buffer.slice(0, match.index), marked.line),
          exitCode: Number(match[1]),
          timedOut: false,
        });
        return;
      }
      // Back at a prompt without the marker: the shell never ran the rest of the line.
      if (target.detectsPrompt && PROMPT_READY.test(buffer)) {
        const output = buffer.replace(PROMPT_READY, '');
        finish({
          output: start ? output : dropEcho(output, marked.line),
          exitCode: null,
          timedOut: false,
        });
        return;
      }
      if (askingForPassword || !endsWithPasswordPrompt(buffer.slice(promptScanFrom))) return;
      askingForPassword = true;
      promptScanFrom = buffer.length;
      // Waiting on the user isn't the command hanging, so the timeout starts over afterwards.
      clearTimeout(timer);
      void handlePasswordPrompt(run, target, command).finally(() => {
        askingForPassword = false;
        promptScanFrom = buffer.length;
        if (!settled) timer = startTimer();
      });
    });

    function startTimer(): ReturnType<typeof setTimeout> {
      return setTimeout(
        () => finish({ output: buffer, exitCode: null, timedOut: true }),
        COMMAND_TIMEOUT_MS,
      );
    }
    const unsubscribeExit = target.subscribeExit(() =>
      finish({ output: buffer, exitCode: null, timedOut: false }),
    );

    function finish(result: CommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeOutput();
      unsubscribeExit();
      display?.release();
      // The user may have typed the password in the terminal instead of answering the bar.
      settlePendingPassword(run);
      resolve(result);
    }

    target.write(marked.line);
  });
}

function appendCompletedCommand(run: RunState, command: string, result: CommandResult): void {
  // Aliases like `grep --color=auto` color the output, and the AI only needs the plain text.
  const text = stripAnsi(result.output).replace(/\r\n?/g, '\n');
  const output = result.timedOut
    ? `${text}\n[No output captured within the timeout; the command may still be running]`
    : text;
  const exitNote = result.exitCode !== null ? ` [exit code ${result.exitCode}]` : '';
  run.transcript += `\n$ ${command}${exitNote}\n${output}\n`;
  const trimmed = text.trim();
  record(run, {
    kind: 'command',
    command,
    output:
      trimmed.length > MAX_HISTORY_OUTPUT_CHARS
        ? `(earlier output trimmed)\n${trimmed.slice(-MAX_HISTORY_OUTPUT_CHARS)}`
        : trimmed,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
}

function cleanupRun(run: RunState): void {
  run.unsubscribeExit();
  runs.delete(run.sessionId);
  if (run.history.endedAt === null) endHistory(run, 'error');
}

/** A CLI starts fresh each step and reads the whole prompt, so it gets longer than an API call. */
const CLI_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Asks the CLI the run was started with for its next step. */
async function askCli(run: RunState, prompt: string): Promise<string> {
  const requestId = `ssh-agent:${run.sessionId}:${run.step}`;
  run.cliRequestId = requestId;
  try {
    // The temp dir, not a project folder: the CLI only needs the prompt, and one started inside
    // a repo tends to go reading files first.
    const result = await runHeadlessCliPrompt(prompt, tmpdir(), {
      requestId,
      preferredCliId: run.cliId,
      strictCli: true,
      runArgs: run.runArgs,
      timeoutMs: CLI_STEP_TIMEOUT_MS,
    });
    if (!result.ok) throw new Error(result.error || `${result.cliName ?? 'The CLI'} failed.`);
    return result.text;
  } finally {
    run.cliRequestId = null;
  }
}

/**
 * Holds the run on an error until the user picks Continue (true) or Stop (false). The run keeps
 * its transcript, so continuing asks the AI for the next step as if nothing had happened.
 */
async function pauseOnError(run: RunState, reason: string): Promise<boolean> {
  // "...was stopped." next to a Continue button reads like a contradiction without this.
  const message = reason.startsWith('Paused') ? reason : `Paused: ${reason}`;
  record(run, { kind: 'error', text: message });
  run.history.status = 'paused';
  const pausedAt = Date.now();
  const decision = new Promise<boolean>((resolve) => {
    run.pendingContinue = resolve;
  });
  emit(run, 'error', { message, canContinue: true });
  const settings = await store.getSettings();
  speakOnPet(settings, run.target.label, `AI task paused: ${message}`, 'warn');
  const resume = await decision;
  if (!resume || run.aborted) return false;
  // Time spent waiting on the user isn't the task running long.
  run.startedAt += Date.now() - pausedAt;
  record(run, { kind: 'continued' });
  run.history.status = 'running';
  return true;
}

async function runLoop(run: RunState): Promise<void> {
  try {
    const api = run.cliId ? null : await resolveProviderAndModel();
    run.history.aiLabel = api
      ? PROVIDER_LABELS[api.provider]
      : (getCliDefinition(run.cliId ?? '')?.name ?? 'AI CLI');

    while (!run.aborted) {
      if (run.step >= run.stepLimit) {
        const paused = `Paused after ${run.step} steps without finishing.`;
        if (!(await pauseOnError(run, paused))) return;
        run.stepLimit = run.step + MAX_STEPS;
        continue;
      }
      if (Date.now() - run.startedAt > MAX_RUNTIME_MS) {
        const minutes = Math.round(MAX_RUNTIME_MS / 60_000);
        if (!(await pauseOnError(run, `Paused: this task has run for ${minutes} minutes.`))) return;
        run.startedAt = Date.now();
        continue;
      }

      run.step += 1;
      // Everything the user has said so far goes into this step's prompt, so none of it waits now.
      const askedWith = run.followUps.length;
      run.followUpsPrompted = askedWith;
      emit(run, 'thinking');
      // A message that lands while the AI is working out this step makes its answer out of date.
      const outdated = (): boolean => run.followUps.length !== askedWith;

      let reply: string;
      try {
        const prompt = buildPrompt(run);
        reply = api
          ? await runAiPrompt(api.provider, api.model, prompt, [], run.controller.signal)
          : await askCli(run, prompt);
      } catch (error) {
        if (run.aborted) return;
        // Nothing came of this step, so the retry takes its number rather than skipping one.
        run.step -= 1;
        // The CLI was cancelled for the new message, which is not a failure.
        if (outdated()) continue;
        if (!(await pauseOnError(run, (error as Error).message))) return;
        continue;
      }
      if (run.aborted) return;
      if (outdated()) {
        // Acting on it would ignore what the user just said, so the AI is asked again.
        run.step -= 1;
        continue;
      }

      const parsed = parseModelReply(reply);
      if (!parsed) {
        // Without this the retry would send the very same prompt and likely get the same reply.
        run.transcript +=
          '\n[Your last reply was not in the RUN / FINISHED / NEEDS_INPUT format. Reply in that format.]\n';
        run.step -= 1;
        if (!(await pauseOnError(run, 'The AI reply did not follow the expected format.'))) return;
        continue;
      }

      if (parsed.kind === 'finished') {
        const summary = parsed.message || 'Task complete.';
        record(run, { kind: 'finished', text: summary });
        endHistory(run, 'finished');
        emit(run, 'finished', { message: summary });
        const settings = await store.getSettings();
        speakOnPet(settings, run.target.label, parsed.message || 'AI finished the task.', 'pass');
        return;
      }

      if (parsed.kind === 'needs-input') {
        record(run, { kind: 'question', text: parsed.message });
        emit(run, 'needs-input', { message: parsed.message });
        const settings = await store.getSettings();
        speakOnPet(settings, run.target.label, `AI needs input: ${parsed.message}`, 'warn');
        const answer = await waitForUserAnswer(run);
        if (run.aborted) return;
        record(run, { kind: 'answer', text: answer });
        run.transcript += `\n[You answered]: ${answer}\n`;
        continue;
      }

      const command = allowSudoPasswordPrompt(parsed.command);
      const decision = run.policy(command);
      let approved = false;

      if (decision.pause) {
        approved = await askApproval(run, command, decision.message);
        if (run.aborted) return;
        if (!approved) continue;
      }

      emit(run, 'running', { command });
      let result: CommandResult;
      try {
        result = await run.executor({ signal: run.controller.signal }, command, approved);
      } catch (error) {
        if (!(error instanceof ApprovalRequiredError) || run.aborted) throw error;
        // The target would not run it unattended: the user decides, as in any approval.
        if (!(await askApproval(run, command, error.message))) {
          if (run.aborted) return;
          continue;
        }
        emit(run, 'running', { command });
        result = await run.executor({ signal: run.controller.signal }, command, true);
      }
      if (run.aborted) return;
      appendCompletedCommand(run, command, result);
    }
  } finally {
    cleanupRun(run);
  }
}

/** True while an AI task is actively running in this terminal session. */
export function isSshTaskRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

/** Model and effort flags for a CLI run, or none when the CLI should use its own defaults. */
export function cliRunArgs(input: StartSshAgentTaskInput): string[] {
  return runArgsFor(input.cliId, input.modelId, input.effort);
}

export function startSshTask(
  input: StartSshAgentTaskInput,
  listener: (progress: SshAgentProgress) => void,
): void {
  const { sessionId } = input;
  if (runs.has(sessionId)) throw new Error('An AI task is already running in this session.');
  const chain = input.continueFromRunId ? historyChain(input.continueFromRunId) : [];
  if (input.continueFromRunId && chain.length === 0) {
    throw new Error('That earlier task is no longer in the history.');
  }
  const target = input.target === 'local' ? localTarget(sessionId) : sshTarget(sessionId);
  startAgentTask(
    {
      key: sessionId,
      prompt: input.prompt,
      target,
      settings: {
        target: input.target === 'local' ? 'local' : 'ssh',
        mode: input.mode,
        cliId: input.cliId ?? null,
        modelId: input.modelId ?? null,
        effort: input.effort ?? null,
      },
      ...(input.continueFromRunId
        ? {
            continuedFromRunId: input.continueFromRunId,
            previousContext: previousTaskContext(chain),
          }
        : {}),
      policy: modePolicy(input.mode),
      executor: (_run, command) => {
        const run = runs.get(sessionId);
        if (!run) throw new Error('The AI task is over.');
        return runCommand(run, target, command);
      },
      cliId: input.cliId ?? null,
      runArgs: cliRunArgs(input),
    },
    listener,
  );
}

/** Everything a run needs besides the user's answers. `key` names it, as a session id does. */
export interface AgentTaskSpec {
  key: string;
  prompt: string;
  target: TaskTarget;
  policy: ApprovalPolicy;
  executor: CommandExecutor;
  /** The run's own prompt; the shell prompt otherwise. */
  buildPrompt?: (input: PromptInput) => string;
  cliId: string | null;
  runArgs: string[];
  /** What it says when it is not connected; the SSH and local wording otherwise. */
  notConnectedMessage?: string;
  /** How a terminal task was started, kept in its history so it can be run again. */
  settings?: SshAgentRunSettings;
  /** The earlier task this one continues, and what the AI is told happened in it. */
  continuedFromRunId?: string;
  previousContext?: string;
}

/** Starts the loop on any target with any executor. `startSshTask` is this for a terminal. */
export function startAgentTask(
  spec: AgentTaskSpec,
  listener: (progress: SshAgentProgress) => void,
): void {
  const { key: sessionId, prompt, target } = spec;
  if (runs.has(sessionId)) throw new Error('An AI task is already running in this session.');
  if (!target.isConnected()) {
    throw new Error(
      spec.notConnectedMessage ??
        (target.kind === 'ssh'
          ? 'This SSH session is not connected.'
          : 'This terminal is not running anymore.'),
    );
  }
  if (!prompt.trim()) throw new Error('Describe what you want the AI to do first.');

  const run: RunState = {
    sessionId,
    target,
    policy: spec.policy,
    executor: spec.executor,
    buildPrompt: spec.buildPrompt ?? null,
    cliId: spec.cliId,
    runArgs: spec.runArgs,
    cliRequestId: null,
    prompt: prompt.trim(),
    previousContext: spec.previousContext ?? '',
    followUps: [],
    followUpsPrompted: 0,
    transcript: '',
    step: 0,
    startedAt: Date.now(),
    aborted: false,
    controller: new AbortController(),
    pendingApproval: null,
    pendingInputAnswer: null,
    pendingPassword: null,
    pendingContinue: null,
    stepLimit: MAX_STEPS,
    // Read now: the session forgets its server as soon as the tab closes.
    history: startHistory(
      sessionId,
      target.kind === 'ssh' ? sshSessionServerId(sessionId) : null,
      prompt.trim(),
      { settings: spec.settings, continuedFromRunId: spec.continuedFromRunId },
    ),
    lastProgress: null,
    // Replaced immediately below, once the real subscription exists.
    unsubscribeExit: () => undefined,
    listener,
  };
  run.unsubscribeExit = target.subscribeExit(() => stopSshTask(sessionId, 'exited'));
  runs.set(sessionId, run);
  void runLoop(run);
}

export function approveSshTaskCommand(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingApproval) return;
  const { resolve } = run.pendingApproval;
  run.pendingApproval = null;
  resolve(true);
}

export function skipSshTaskCommand(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingApproval) return;
  const { resolve } = run.pendingApproval;
  run.pendingApproval = null;
  resolve(false);
}

export function answerSshTaskInput(sessionId: string, answer: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingInputAnswer) return;
  const resolve = run.pendingInputAnswer;
  run.pendingInputAnswer = null;
  resolve(answer);
}

/**
 * Passes the user's own message to a run that is still going, without the run having asked. The
 * AI reads it at its next step. Whatever it is working out right now was decided without the
 * message, so that reply is dropped and asked for again, and a command waiting for approval is
 * skipped. A command already running is left to finish. False when there is no such run any more.
 */
export function sendSshTaskMessage(sessionId: string, text: string): boolean {
  const run = runs.get(sessionId);
  if (!run || run.aborted || typeof text !== 'string') return false;
  const message = text.trim().slice(0, MAX_SSH_AGENT_MESSAGE_CHARS);
  if (!message) return false;
  run.followUps.push(message);
  record(run, { kind: 'message', text: message });
  if (run.cliRequestId) cancelHeadlessPrompt(run.cliRequestId);
  if (run.pendingApproval) {
    const { resolve } = run.pendingApproval;
    run.pendingApproval = null;
    resolve(false);
  }
  announceQueue(run);
  return true;
}

/** `approved` types the saved password into the prompt; false leaves it for the user to type. */
export function answerSshTaskPassword(sessionId: string, approved: boolean): void {
  const run = runs.get(sessionId);
  if (!run?.pendingPassword) return;
  const resolve = run.pendingPassword;
  run.pendingPassword = null;
  resolve(approved);
}

/** Picks a run paused on an error back up where it left off. */
export function continueSshTask(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingContinue) return;
  const resolve = run.pendingContinue;
  run.pendingContinue = null;
  resolve(true);
}

/**
 * Raises a system notification for a run that is waiting on the user. The renderer calls this
 * when the terminal isn't in front of them (panel closed, another tab, another app), since only
 * it knows that. `tabTitle` names the terminal the way its tab does.
 */
export async function notifySshTaskWaiting(sessionId: string, tabTitle: string): Promise<void> {
  const progress = runs.get(sessionId)?.lastProgress;
  if (!progress) return;
  const settings = await store.getSettings();
  if (settings.terminalAiNotifications === false) return;

  const where = tabTitle.trim() || 'Terminal';
  let title: string;
  let detail: string | undefined;
  switch (progress.phase) {
    case 'proposed':
      title = 'AI wants to run a command';
      detail = progress.command;
      break;
    case 'needs-input':
      title = 'AI has a question for you';
      detail = progress.message;
      break;
    case 'needs-password':
      title = 'A command is asking for a password';
      detail = progress.command;
      break;
    case 'error':
      if (!progress.canContinue) return;
      title = 'AI task paused';
      detail = progress.message;
      break;
    default:
      return;
  }
  const route = `/terminal-session/${encodeURIComponent(sessionId)}`;
  const body = detail ? `${where}\n${detail}` : where;
  if (showOsNotification({ title, body, route })) getMainWindow()?.flashFrame(true);
}

export function stopSshTask(sessionId: string, reason: 'user' | 'exited' = 'user'): void {
  const run = runs.get(sessionId);
  if (!run || run.aborted) return;
  run.aborted = true;
  run.controller.abort();
  if (run.cliRequestId) cancelHeadlessPrompt(run.cliRequestId);
  settlePendingPassword(run);
  if (run.pendingApproval) {
    run.pendingApproval.resolve(false);
    run.pendingApproval = null;
  }
  if (run.pendingInputAnswer) {
    run.pendingInputAnswer('');
    run.pendingInputAnswer = null;
  }
  if (run.pendingContinue) {
    run.pendingContinue(false);
    run.pendingContinue = null;
  }
  const message =
    reason === 'user'
      ? 'Stopped by user.'
      : (run.target.endedMessage ??
        (run.target.kind === 'ssh' ? 'The SSH session ended.' : 'The terminal closed.'));
  record(run, { kind: 'stopped', text: message });
  endHistory(run, 'stopped');
  emit(run, 'stopped', { message });
  cleanupRun(run);
}

/** Called from `before-quit`, alongside `killAllSshSessions`. */
export function stopAllSshTasks(): void {
  for (const sessionId of [...runs.keys()]) stopSshTask(sessionId, 'exited');
}
