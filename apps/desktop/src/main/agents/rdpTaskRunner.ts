import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCliDefinition, runArgsFor, supportsPromptImages } from '@runova/core';
import type {
  AiProvider,
  RdpAgentFrame,
  RdpAgentHistoryEntry,
  RdpAgentHistoryRun,
  RdpAgentPhase,
  RdpAgentProgress,
  SshAgentMode,
  StartRdpAgentTaskInput,
} from '../../shared/apiTypes';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '../../shared/sshAgentMessage';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { runAiPrompt } from '../ipc/ai';
import { showOsNotification } from '../notifications/osNotification';
import { speakOnPet } from '../notifications/petNotifier';
import { dropRdpAgentRequests, requestRdpFrame, requestRdpInput } from '../rdp/agentBridge';
import { getRdpWindow, setRdpWindowBackgroundThrottling } from '../rdp/sessionWindows';
import { store } from '../store';
import {
  buildRdpPrompt,
  formatRdpAction,
  isRiskyRdpAction,
  parseRdpReply,
  type RdpAction,
  type RdpImageMode,
  riskyReason,
} from './rdpAction';
import { type FrameMapping, toDesktop } from './rdpCoords';
import { actionToInputOps } from './rdpInputPlan';

/**
 * The Remote Desktop sibling of sshTaskRunner.ts. Each step the AI gets a screenshot of the
 * session and answers with one mouse or keyboard action, which the session window then performs.
 */

/** Refuses to loop forever if the AI never says FINISHED. */
const MAX_STEPS = 40;
const MAX_RUNTIME_MS = 30 * 60 * 1000;
/** Past tasks kept per session for the history view. */
const MAX_HISTORY_RUNS = 20;
/** Lets the remote desktop redraw after an action before the next screenshot is taken. */
const SETTLE_MS = 800;
/** Short label for pet notifications. */
const LABEL = 'Remote Desktop';
/** The screenshot's name in a CLI run's folder. The prompt for Claude Code names it too. */
const FRAME_FILE = 'frame.png';
const UNCHANGED_NOTE = '\n[The screen did not change after your last action]\n';

interface PendingApproval {
  action: string;
  resolve: (approved: boolean) => void;
}

interface RunState {
  sessionId: string;
  mode: SshAgentMode;
  /** Agent CLI deciding each step, or null for the AI provider from Settings. */
  cliId: string | null;
  /** Model and effort flags for that CLI. */
  runArgs: string[];
  /** How the screenshot reaches the AI, which decides the prompt's tool rules. */
  imageMode: RdpImageMode;
  /** The CLI's working folder, holding only the current screenshot. Null for an API run. */
  runDir: string | null;
  /** Set while a CLI is working out the next step, so Stop can kill it. */
  cliRequestId: string | null;
  prompt: string;
  /** What the user told the AI after starting the run, oldest first. */
  followUps: string[];
  /** How many of `followUps` the AI has been asked with so far. */
  followUpsPrompted: number;
  transcript: string;
  step: number;
  startedAt: number;
  aborted: boolean;
  cleanedUp: boolean;
  controller: AbortController;
  pendingApproval: PendingApproval | null;
  pendingInputAnswer: ((answer: string) => void) | null;
  /** Set while the run is paused on an error: true picks it up again, false ends it. */
  pendingContinue: ((resume: boolean) => void) | null;
  /** The step the run stops at. Continue after hitting it allows another MAX_STEPS. */
  stepLimit: number;
  /** Hash of the last screenshot, to tell the AI when an action changed nothing. */
  lastFrameHash: string | null;
  /** True once an action ran since the last screenshot was taken. */
  actedSinceFrame: boolean;
  history: RdpAgentHistoryRun;
  /** What the run last reported, so a notification can say what it is waiting for. */
  lastProgress: RdpAgentProgress | null;
  listener: (progress: RdpAgentProgress) => void;
}

const runs = new Map<string, RunState>();
/** Every session's past and current tasks, newest last. Kept for as long as the app runs. */
const histories = new Map<string, RdpAgentHistoryRun[]>();

/** Messages from the user the AI has not been asked with yet. */
function queuedMessages(run: RunState): number {
  return run.followUps.length - run.followUpsPrompted;
}

function emit(run: RunState, phase: RdpAgentPhase, extra: Partial<RdpAgentProgress> = {}): void {
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
type NewHistoryEntry = RdpAgentHistoryEntry extends infer E
  ? E extends RdpAgentHistoryEntry
    ? Omit<E, 'at'>
    : never
  : never;

function record(run: RunState, entry: NewHistoryEntry): void {
  run.history.entries.push({ ...entry, at: Date.now() } as RdpAgentHistoryEntry);
}

function endHistory(run: RunState, status: RdpAgentHistoryRun['status']): void {
  run.history.status = status;
  run.history.endedAt = Date.now();
}

function startHistory(sessionId: string, prompt: string): RdpAgentHistoryRun {
  const entry: RdpAgentHistoryRun = {
    id: randomUUID(),
    sessionId,
    prompt,
    aiLabel: '',
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    entries: [],
  };
  const list = histories.get(sessionId) ?? [];
  list.push(entry);
  histories.set(sessionId, list.slice(-MAX_HISTORY_RUNS));
  return entry;
}

/** The session's AI tasks, newest first. */
export function getRdpTaskHistory(sessionId: string): RdpAgentHistoryRun[] {
  return [...(histories.get(sessionId) ?? [])].reverse();
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

function waitForApproval(run: RunState, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    run.pendingApproval = { action, resolve };
  });
}

function waitForUserAnswer(run: RunState): Promise<string> {
  return new Promise((resolve) => {
    run.pendingInputAnswer = resolve;
  });
}

/** Resolves after `ms`, or as soon as the run is stopped. */
function sleep(run: RunState, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const { signal } = run.controller;
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** Where a pointer action lands, as fractions of the desktop, for the marker over the session. */
function targetOf(action: RdpAction, mapping: FrameMapping): { x: number; y: number } | undefined {
  let point: { x: number; y: number };
  switch (action.kind) {
    case 'click':
    case 'double-click':
    case 'right-click':
    case 'move':
    case 'scroll':
      point = toDesktop(mapping, action.x, action.y);
      break;
    case 'drag':
      point = toDesktop(mapping, action.x1, action.y1);
      break;
    default:
      return undefined;
  }
  return { x: point.x / mapping.desktopWidth, y: point.y / mapping.desktopHeight };
}

function cleanupRun(run: RunState): void {
  if (run.cleanedUp) return;
  run.cleanedUp = true;
  if (run.history.endedAt === null) endHistory(run, 'error');
  if (run.runDir) void rm(run.runDir, { recursive: true, force: true }).catch(() => undefined);
  // A new run may already own the session after a quick stop and start.
  if (runs.get(run.sessionId) !== run) return;
  runs.delete(run.sessionId);
  setRdpWindowBackgroundThrottling(run.sessionId, true);
}

/** A CLI starts fresh each step and reads the whole prompt, so it gets longer than an API call. */
const CLI_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Asks the CLI the run was started with for its next step, showing it the screenshot. */
async function askCli(run: RunState, prompt: string, frame: RdpAgentFrame): Promise<string> {
  const runDir = run.runDir;
  if (!runDir) throw new Error('The run folder for the CLI is missing.');
  await writeFile(join(runDir, FRAME_FILE), Buffer.from(frame.png, 'base64'));
  if (run.aborted) return '';
  const requestId = `rdp-agent:${run.sessionId}:${run.step}`;
  run.cliRequestId = requestId;
  try {
    // A folder of its own, not a project: the CLI only needs the screenshot, and whatever else
    // sits next to it would tempt it to go reading.
    const result = await runHeadlessCliPrompt(prompt, runDir, {
      requestId,
      preferredCliId: run.cliId,
      strictCli: true,
      runArgs: run.runArgs,
      timeoutMs: CLI_STEP_TIMEOUT_MS,
      images: [FRAME_FILE],
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
  speakOnPet(settings, LABEL, `AI task paused: ${message}`, 'warn');
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

      let frame: RdpAgentFrame;
      try {
        frame = await requestRdpFrame(run.sessionId);
      } catch (error) {
        if (run.aborted) return;
        // Nothing came of this step, so the retry takes its number rather than skipping one.
        run.step -= 1;
        const reason = `Could not take a screenshot. ${(error as Error).message}`;
        if (!(await pauseOnError(run, reason))) return;
        continue;
      }
      if (run.aborted) return;
      if (outdated()) {
        run.step -= 1;
        continue;
      }

      const hash = createHash('sha1').update(frame.png).digest('hex');
      if (hash === run.lastFrameHash && run.actedSinceFrame) run.transcript += UNCHANGED_NOTE;
      run.lastFrameHash = hash;
      run.actedSinceFrame = false;
      const mapping: FrameMapping = {
        frameWidth: frame.width,
        frameHeight: frame.height,
        desktopWidth: frame.desktopWidth,
        desktopHeight: frame.desktopHeight,
      };
      const prompt = buildRdpPrompt({
        task: run.prompt,
        followUps: run.followUps,
        transcript: run.transcript,
        frameWidth: frame.width,
        frameHeight: frame.height,
        imageMode: run.imageMode,
      });

      let reply: string;
      try {
        reply = api
          ? await runAiPrompt(api.provider, api.model, prompt, [], run.controller.signal, [
              frame.png,
            ])
          : await askCli(run, prompt, frame);
      } catch (error) {
        if (run.aborted) return;
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

      const parsed = parseRdpReply(reply);
      if (!parsed) {
        // Without this the retry would send the very same prompt and likely get the same reply.
        run.transcript +=
          '\n[Your last reply was not in the expected format. Reply with exactly one action line, FINISHED: or NEEDS_INPUT:.]\n';
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
        speakOnPet(settings, LABEL, parsed.message || 'AI finished the task.', 'pass');
        return;
      }

      if (parsed.kind === 'needs-input') {
        record(run, { kind: 'question', text: parsed.message });
        emit(run, 'needs-input', { message: parsed.message });
        const settings = await store.getSettings();
        speakOnPet(settings, LABEL, `AI needs input: ${parsed.message}`, 'warn');
        const answer = await waitForUserAnswer(run);
        if (run.aborted) return;
        record(run, { kind: 'answer', text: answer });
        run.transcript += `\n[You answered]: ${answer}\n`;
        continue;
      }

      const action = formatRdpAction(parsed);
      const target = targetOf(parsed, mapping);
      const risky = isRiskyRdpAction(parsed);
      const shouldPause = run.mode === 'approve-all' || (run.mode === 'approve-risky' && risky);

      if (shouldPause) {
        emit(run, 'proposed', {
          action,
          target,
          message: risky ? (riskyReason(parsed) ?? 'This action looks risky.') : undefined,
        });
        const approved = await waitForApproval(run, action);
        if (run.aborted) return;
        if (!approved) {
          record(run, { kind: 'skipped', action });
          run.transcript += `\n> ${action}\n[skipped by user, not done]\n`;
          continue;
        }
      }

      if (parsed.kind === 'wait') {
        emit(run, 'acting', { action });
        await sleep(run, parsed.ms);
        if (run.aborted) return;
        const note = `waited ${parsed.ms} ms`;
        run.transcript += `\n> ${action} -> ${note}\n`;
        record(run, { kind: 'action', action, outcome: note, ok: true });
        run.actedSinceFrame = true;
        continue;
      }

      const plan = actionToInputOps(parsed, mapping);
      if ('error' in plan) {
        run.transcript += `\n> ${action}\n[Not done: ${plan.error}]\n`;
        record(run, { kind: 'action', action, outcome: plan.error, ok: false });
        continue;
      }

      emit(run, 'acting', { action, target });
      try {
        await requestRdpInput(run.sessionId, plan.ops);
      } catch (error) {
        if (run.aborted) return;
        const message = (error as Error).message;
        run.transcript += `\n> ${action}\n[Failed: ${message}]\n`;
        record(run, { kind: 'action', action, outcome: message, ok: false });
        if (!(await pauseOnError(run, `Could not send the input. ${message}`))) return;
        continue;
      }
      if (run.aborted) return;
      run.transcript += `\n> ${action} -> ${plan.note}\n`;
      record(run, { kind: 'action', action, outcome: plan.note, ok: true });
      run.actedSinceFrame = true;
      await sleep(run, SETTLE_MS);
    }
  } finally {
    cleanupRun(run);
  }
}

/** True while an AI task is actively running in this Remote Desktop session. */
export function isRdpTaskRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

/** How the chosen AI takes a screenshot. Throws for a CLI that can't take one at all. */
function imageModeFor(cliId: string | null): RdpImageMode {
  if (!cliId) return 'api';
  const cli = getCliDefinition(cliId);
  if (!cli?.promptImageInput || !supportsPromptImages(cli)) {
    throw new Error(
      `${cli?.name ?? 'This CLI'} can't look at screenshots, which a Remote Desktop task needs. ` +
        'Pick Claude Code, Codex or Gemini CLI, or the AI provider from Settings.',
    );
  }
  return cli.promptImageInput;
}

export function startRdpTask(
  input: StartRdpAgentTaskInput,
  listener: (progress: RdpAgentProgress) => void,
): void {
  const { sessionId, prompt, mode } = input;
  if (runs.has(sessionId)) throw new Error('An AI task is already running in this session.');
  if (!getRdpWindow(sessionId)) throw new Error('This Remote Desktop session is not open.');
  if (!prompt.trim()) throw new Error('Describe what you want the AI to do first.');
  const cliId = input.cliId ?? null;
  const imageMode = imageModeFor(cliId);

  const run: RunState = {
    sessionId,
    mode,
    cliId,
    runArgs: runArgsFor(input.cliId, input.modelId, input.effort),
    imageMode,
    // Made up front, so a stop can never race its creation and leave it behind.
    runDir: cliId ? mkdtempSync(join(tmpdir(), 'runova-rdp-')) : null,
    cliRequestId: null,
    prompt: prompt.trim(),
    followUps: [],
    followUpsPrompted: 0,
    transcript: '',
    step: 0,
    startedAt: Date.now(),
    aborted: false,
    cleanedUp: false,
    controller: new AbortController(),
    pendingApproval: null,
    pendingInputAnswer: null,
    pendingContinue: null,
    stepLimit: MAX_STEPS,
    lastFrameHash: null,
    actedSinceFrame: false,
    history: startHistory(sessionId, prompt.trim()),
    lastProgress: null,
    listener,
  };
  runs.set(sessionId, run);
  // Chromium stops painting a covered or minimized window, which would freeze the screenshots.
  setRdpWindowBackgroundThrottling(sessionId, false);
  void runLoop(run);
}

export function approveRdpTaskAction(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingApproval) return;
  const { resolve } = run.pendingApproval;
  run.pendingApproval = null;
  resolve(true);
}

export function skipRdpTaskAction(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingApproval) return;
  const { resolve } = run.pendingApproval;
  run.pendingApproval = null;
  resolve(false);
}

export function answerRdpTaskInput(sessionId: string, answer: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingInputAnswer) return;
  const resolve = run.pendingInputAnswer;
  run.pendingInputAnswer = null;
  resolve(answer);
}

/**
 * Passes the user's own message to a run that is still going, without the run having asked. The
 * AI reads it at its next step. Whatever it is working out right now was decided without the
 * message, so that reply is dropped and asked for again, and an action waiting for approval is
 * skipped. An action already being sent is left to finish. False when there is no such run any more.
 */
export function sendRdpTaskMessage(sessionId: string, text: string): boolean {
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

/** Picks a run paused on an error back up where it left off. */
export function continueRdpTask(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run?.pendingContinue) return;
  const resolve = run.pendingContinue;
  run.pendingContinue = null;
  resolve(true);
}

/** Brings a session window to the front, e.g. from a click on a notification about it. */
function focusRdpWindow(sessionId: string): void {
  const window = getRdpWindow(sessionId);
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Raises a system notification for a run that is waiting on the user. The renderer calls this
 * when the session window isn't in front of them, since only it knows that. `title` names the
 * session the way its window does.
 */
export async function notifyRdpTaskWaiting(sessionId: string, title: string): Promise<void> {
  const progress = runs.get(sessionId)?.lastProgress;
  if (!progress) return;
  const settings = await store.getSettings();
  if (settings.terminalAiNotifications === false) return;

  const where = title.trim() || LABEL;
  let heading: string;
  let detail: string | undefined;
  switch (progress.phase) {
    case 'proposed':
      heading = 'AI wants to act on the remote desktop';
      detail = progress.action;
      break;
    case 'needs-input':
      heading = 'AI has a question for you';
      detail = progress.message;
      break;
    case 'error':
      if (!progress.canContinue) return;
      heading = 'AI task paused';
      detail = progress.message;
      break;
    default:
      return;
  }
  const body = detail ? `${where}\n${detail}` : where;
  // The session lives in its own window, so a click brings that forward instead of a route.
  const shown = showOsNotification({
    title: heading,
    body,
    route: '',
    onClick: () => focusRdpWindow(sessionId),
  });
  if (shown) getRdpWindow(sessionId)?.flashFrame(true);
}

export function stopRdpTask(sessionId: string, reason: 'user' | 'exited' = 'user'): void {
  const run = runs.get(sessionId);
  if (!run || run.aborted) return;
  run.aborted = true;
  run.controller.abort();
  if (run.cliRequestId) cancelHeadlessPrompt(run.cliRequestId);
  // Wakes the loop if it waits on a screenshot or input, before anything new is sent.
  dropRdpAgentRequests(sessionId);
  // A stop in the middle of a drag or a held shortcut must not leave a key or button down.
  void requestRdpInput(sessionId, [{ kind: 'releaseAll' }]).catch(() => undefined);
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
  const message = reason === 'user' ? 'Stopped by user.' : 'The Remote Desktop window closed.';
  record(run, { kind: 'stopped', text: message });
  endHistory(run, 'stopped');
  emit(run, 'stopped', { message });
  cleanupRun(run);
}

/** Called from `before-quit`, alongside `stopAllSshTasks`. */
export function stopAllRdpTasks(): void {
  for (const sessionId of [...runs.keys()]) stopRdpTask(sessionId, 'exited');
}
