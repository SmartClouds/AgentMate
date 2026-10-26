import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  countResults,
  createStreamParser,
  formatCommand,
  matchesTestGlob,
  type ParsedTestResult,
  parseTestReport,
  planTestRun,
  type ReportSearch,
  type ResolvedTarget,
  readableCommand,
  resolveResults,
  resolveTarget,
  TEST_FRAMEWORKS,
  type TestDiscovery,
  type TestProject,
  type TestResult,
  type TestRunError,
  type TestRunEvent,
  type TestRunPlan,
  type TestRunSnapshot,
  type TestRunSummary,
  type TestTarget,
  testNodeId,
} from '@runova/core';
import { type CancelToken, cancelSpawn, spawnStreaming } from '../process/spawnStreaming';

/**
 * Runs tests for the Tests panel in the background, one run per project at a time. A run walks its
 * test projects in order: plan the command, stream its output (turning machine output into results
 * as it arrives where the framework streams), read any report files once it exits, and match every
 * result back to the discovered test it belongs to.
 */

/**
 * How long a run may go without printing before it is stopped. It is not a limit on the whole run:
 * a big suite that keeps reporting results is working, and a fixed cap stopped this repo's own
 * end-to-end suite, which takes about 40 minutes, with most of its tests already passed.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200_000;
/** cmd.exe refuses lines past 8191 characters; leave room for the shim's own expansion. */
const MAX_WINDOWS_COMMAND_CHARS = 7_000;

/**
 * The app's own environment, minus NODE_ENV. Jest and Vitest only set NODE_ENV=test when it is
 * unset, so passing on the app's "development" or "production" changes how the tests run. React
 * Native's Animated, for one, stops re-rendering on setValue outside of "test".
 */
function testEnv(): NodeJS.ProcessEnv {
  const { NODE_ENV: _, ...env } = process.env;
  return env;
}

/**
 * The last `max` characters of a run's output. A big suite prints tens of thousands of lines, and
 * trimming a 200 KB string for each one kept the main process, and so every click in the window,
 * busy for seconds. Appending here only stores the piece; the tail is cut back once it grows to
 * twice the cap, so each character costs the same however long the run goes on.
 */
export class OutputTail {
  private parts: string[] = [];
  private length = 0;

  constructor(private readonly max: number) {}

  get isEmpty(): boolean {
    return this.length === 0;
  }

  append(text: string): void {
    if (!text) return;
    this.parts.push(text);
    this.length += text.length;
    if (this.length > this.max * 2) this.compact();
  }

  toString(): string {
    this.compact();
    return this.parts[0] ?? '';
  }

  private compact(): void {
    const text = this.parts.join('').slice(-this.max);
    this.parts = text ? [text] : [];
    this.length = text.length;
  }
}

export interface TestRunManagerDeps {
  emit: (event: TestRunEvent) => void;
  spawn?: typeof spawnStreaming;
  /** How long a run may print nothing before it is stopped. */
  timeoutMs?: number;
  /** How long output and results are held so a burst goes out as one event each. */
  outputFlushMs?: number;
  platform?: string;
}

export interface StartRunInput {
  projectId: string;
  folderPath: string;
  discovery: TestDiscovery;
  /** Empty runs every test project. */
  targets: TestTarget[];
}

interface ActiveRun {
  summary: TestRunSummary;
  results: Map<string, TestResult>;
  output: OutputTail;
  /** Every test the run picked, kept so a panel that reopens mid-run knows what is still waiting. */
  queued: string[];
  token: CancelToken;
  done: Promise<void>;
}

export class TestRunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly deps: Required<Omit<TestRunManagerDeps, 'spawn'>> & {
    spawn: typeof spawnStreaming;
  };

  constructor(deps: TestRunManagerDeps) {
    this.deps = {
      emit: deps.emit,
      spawn: deps.spawn ?? spawnStreaming,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outputFlushMs: deps.outputFlushMs ?? 80,
      platform: deps.platform ?? process.platform,
    };
  }

  isRunning(projectId: string): boolean {
    return this.runs.get(projectId)?.summary.running === true;
  }

  start(input: StartRunInput): TestRunSummary {
    if (this.isRunning(input.projectId)) {
      throw new Error('Tests are already running for this project. Stop that run first.');
    }
    const targets = mergeTargets(
      input.targets.length > 0
        ? input.targets
        : input.discovery.projects.map((project) => ({ testProjectId: project.id })),
    );
    const summary: TestRunSummary = {
      runId: randomUUID(),
      projectId: input.projectId,
      startedAt: Date.now(),
      running: true,
      cancelled: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      commands: [],
      errors: [],
    };
    const run: ActiveRun = {
      summary,
      results: new Map(),
      output: new OutputTail(MAX_OUTPUT_CHARS),
      queued: [],
      token: { cancelled: false, child: null },
      done: Promise.resolve(),
    };
    this.runs.set(input.projectId, run);

    const queued = targets.flatMap((target) => {
      const node = input.discovery.tree.find((entry) => entry.id === target.testProjectId);
      if (!node) return [];
      return resolveTarget(node, target).expanded.map((ref) =>
        testNodeId(node.id, ref.file, ref.path),
      );
    });
    run.queued = queued;
    this.deps.emit({
      type: 'started',
      runId: summary.runId,
      projectId: input.projectId,
      summary: { ...summary },
      queued,
    });
    run.done = this.execute(input, run, targets);
    return { ...summary };
  }

  cancel(projectId: string): boolean {
    const run = this.runs.get(projectId);
    if (!run?.summary.running) return false;
    cancelSpawn(run.token);
    return true;
  }

  lastRun(projectId: string): TestRunSnapshot | null {
    const run = this.runs.get(projectId);
    if (!run) return null;
    return {
      summary: { ...run.summary },
      results: [...run.results.values()],
      output: run.output.toString(),
      queued: [...run.queued],
    };
  }

  /** Resolves once the project's current run (if any) has finished. */
  async whenIdle(projectId: string): Promise<void> {
    await this.runs.get(projectId)?.done;
  }

  /** The command a target would run with, for Copy issue. */
  describeCommand(folderPath: string, discovery: TestDiscovery, target: TestTarget): string | null {
    const project = discovery.projects.find((entry) => entry.id === target.testProjectId);
    const node = discovery.tree.find((entry) => entry.id === target.testProjectId);
    if (!project || !node) return null;
    const reportDir = tmpdir();
    return readableCommand(
      this.plan(project, resolveTarget(node, target), folderPath, reportDir),
      reportDir,
    );
  }

  private plan(
    project: TestProject,
    target: ResolvedTarget,
    folderPath: string,
    reportDir: string,
  ): TestRunPlan {
    const ctx = {
      platform: this.deps.platform,
      folderPath,
      reportDir,
      exists: (path: string) => existsSync(join(folderPath, path)),
    };
    let plan = planTestRun(project, target, ctx);
    if (this.deps.platform !== 'win32') return plan;
    // cmd.exe can neither pass a double quote inside an argument nor take a very long line, so
    // widen the selection until the command fits: named tests become their files, files become all.
    const fits = (candidate: TestRunPlan) =>
      !candidate.args.some((arg) => arg.includes('"')) &&
      formatCommand(candidate).length <= MAX_WINDOWS_COMMAND_CHARS;
    if (!fits(plan) && target.tests.length > 0) {
      const files = [...new Set([...target.files, ...target.tests.map((ref) => ref.file)])];
      plan = planTestRun(project, { ...target, files, tests: [] }, ctx);
    }
    if (!fits(plan) && !target.all) {
      plan = planTestRun(
        project,
        { all: true, files: [], tests: [], expanded: target.expanded },
        ctx,
      );
    }
    return plan;
  }

  private async execute(
    input: StartRunInput,
    run: ActiveRun,
    targets: TestTarget[],
  ): Promise<void> {
    const { summary } = run;
    let reportRoot: string | null = null;
    let pendingOutput = '';
    let pendingResults: TestResult[] = [];
    let flushTimer: NodeJS.Timeout | null = null;

    // A streaming runner reports a result per line of output. Sent one by one, a big suite came
    // to thousands of messages to every window, so both wait here and leave together.
    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingOutput) {
        const text = pendingOutput;
        pendingOutput = '';
        this.deps.emit({ type: 'output', runId: summary.runId, projectId: input.projectId, text });
      }
      if (pendingResults.length > 0) {
        const results = pendingResults;
        pendingResults = [];
        this.deps.emit({
          type: 'results',
          runId: summary.runId,
          projectId: input.projectId,
          results,
        });
      }
    };
    const scheduleFlush = (): void => {
      flushTimer ??= setTimeout(flush, this.deps.outputFlushMs);
    };
    const appendOutput = (text: string): void => {
      run.output.append(text);
      pendingOutput += text;
      scheduleFlush();
    };
    const publish = (results: TestResult[]): void => {
      if (results.length === 0) return;
      for (const result of results) {
        run.results.set(result.id, result);
        pendingResults.push(result);
      }
      scheduleFlush();
    };

    try {
      reportRoot = await mkdtemp(join(tmpdir(), 'runova-tests-'));
      for (const [index, target] of targets.entries()) {
        if (run.token.cancelled) break;
        const project = input.discovery.projects.find((entry) => entry.id === target.testProjectId);
        const node = input.discovery.tree.find((entry) => entry.id === target.testProjectId);
        if (!project || !node) continue;

        const reportDir = join(reportRoot, String(index));
        await mkdir(reportDir, { recursive: true });
        const resolved = resolveTarget(node, target);
        const plan = this.plan(project, resolved, input.folderPath, reportDir);
        for (const file of plan.files ?? []) await writeFile(file.path, file.content);
        // Runners that filter by name (Vitest, Jest) still list the tests they left out, as
        // skipped. Only what was picked, and anything nested under it, may change status.
        const picked = new Set(
          resolved.expanded.map((ref) => testNodeId(node.id, ref.file, ref.path)),
        );
        // Walks the result's own ancestors rather than every pick: a rerun of many failures in a
        // big suite otherwise compared each skipped result against each pick.
        const underPicked = (id: string): boolean => {
          for (let at = id.lastIndexOf(' > '); at > 0; at = id.lastIndexOf(' > ', at - 1)) {
            if (picked.has(id.slice(0, at))) return true;
          }
          return false;
        };
        const wasPicked = (result: TestResult): boolean =>
          resolved.all ||
          result.status !== 'skipped' ||
          picked.has(result.id) ||
          underPicked(result.id);
        // The output shows exactly what ran; errors carry the version a person would retype.
        summary.commands.push(formatCommand(plan));
        const command = readableCommand(plan, reportDir);
        appendOutput(`${run.output.isEmpty ? '' : '\n'}$ ${formatCommand(plan)}\n`);

        const parser = createStreamParser(project);
        let reported = 0;
        const accept = (parsed: ParsedTestResult[]): void => {
          const results = resolveResults(node, project, parsed, input.folderPath).filter(wasPicked);
          reported += results.length;
          publish(results);
        };
        const startedAt = Date.now();

        let outcome: Awaited<ReturnType<typeof spawnStreaming>>;
        try {
          outcome = await this.deps.spawn({
            command: plan.command,
            args: plan.args,
            cwd: join(input.folderPath, plan.cwd),
            env: { ...testEnv(), PYTHONUNBUFFERED: '1', ...plan.env },
            timeoutMs: this.deps.timeoutMs,
            idle: true,
            token: run.token,
            onLine: (line) => {
              const shown = parser?.display ? parser.display(line) : line;
              if (shown !== null) appendOutput(`${shown}\n`);
              if (parser) accept(parser.push(line));
            },
          });
        } catch (error) {
          summary.errors.push(runError('failedToStart', project, command, errorMessage(error), ''));
          continue;
        }

        if (parser) accept(parser.finish());
        for (const text of await readReports(plan, input.folderPath, startedAt)) {
          accept(parseTestReport(project.framework, text));
        }
        flush();

        if (outcome.cancelled) break;
        const label = TEST_FRAMEWORKS[project.framework].label;
        if (outcome.notFound) {
          summary.errors.push(
            runError(
              'notFound',
              project,
              command,
              `Could not start ${label}. Check that it is installed and on your PATH, then run the tests again.`,
              outcome.log,
            ),
          );
        } else if (outcome.timedOut) {
          summary.errors.push(
            runError(
              'timedOut',
              project,
              command,
              `The ${label} run printed nothing for ${Math.round(this.deps.timeoutMs / 60_000) || 1} minutes and was stopped.`,
              outcome.log,
            ),
          );
        } else if (reported === 0 && outcome.code !== 0) {
          summary.errors.push(
            runError(
              'noResults',
              project,
              command,
              `The ${label} run ended without reporting any results (exit code ${outcome.code ?? 'unknown'}).`,
              outcome.log,
            ),
          );
        }
      }
    } catch (error) {
      summary.errors.push({
        kind: 'failedToStart',
        testProjectId: '',
        command: '',
        message: errorMessage(error),
        log: '',
      });
    } finally {
      flush();
      if (reportRoot) await rm(reportRoot, { recursive: true, force: true }).catch(() => undefined);
      const counts = countResults([...run.results.values()]);
      Object.assign(summary, {
        running: false,
        cancelled: run.token.cancelled,
        finishedAt: Date.now(),
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
      });
      this.deps.emit({
        type: 'done',
        runId: summary.runId,
        projectId: input.projectId,
        summary: { ...summary },
      });
    }
  }
}

/** Folds several picks in the same test project into one run of it, keeping first-seen order. */
function mergeTargets(targets: TestTarget[]): TestTarget[] {
  const merged = new Map<string, TestTarget>();
  for (const target of targets) {
    const existing = merged.get(target.testProjectId);
    if (!existing) {
      merged.set(target.testProjectId, {
        testProjectId: target.testProjectId,
        ...(target.files ? { files: [...target.files] } : {}),
        ...(target.tests ? { tests: [...target.tests] } : {}),
      });
      continue;
    }
    const wasAll = !existing.files?.length && !existing.tests?.length;
    const isAll = !target.files?.length && !target.tests?.length;
    if (wasAll || isAll) {
      merged.set(target.testProjectId, { testProjectId: target.testProjectId });
    } else {
      existing.files = [...(existing.files ?? []), ...(target.files ?? [])];
      existing.tests = [...(existing.tests ?? []), ...(target.tests ?? [])];
    }
  }
  return [...merged.values()];
}

async function readReports(
  plan: TestRunPlan,
  folderPath: string,
  startedAt: number,
): Promise<string[]> {
  const paths = [...(plan.reportFiles ?? [])];
  for (const search of plan.reportSearch ?? [])
    paths.push(...(await findReports(search, folderPath, startedAt)));
  const texts: string[] = [];
  for (const path of paths) {
    try {
      texts.push(await readFile(path, 'utf-8'));
    } catch {
      // The run never got as far as writing it.
    }
  }
  return texts;
}

async function findReports(
  search: ReportSearch,
  folderPath: string,
  startedAt: number,
): Promise<string[]> {
  const root = isAbsolute(search.root) ? search.root : join(folderPath, search.root);
  const found: string[] = [];
  const skip = new Set(['node_modules', '.git', '.gradle', 'src']);
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(full, childRel, depth + 1);
      } else if (entry.isFile() && matchesTestGlob(childRel, search.glob)) {
        if (search.freshOnly) {
          const info = await stat(full).catch(() => null);
          // A second of slack for filesystems with coarse timestamps.
          if (!info || info.mtimeMs < startedAt - 1_000) continue;
        }
        found.push(full);
      }
    }
  };
  await walk(root, '', 0);
  return found;
}

function runError(
  kind: TestRunError['kind'],
  project: TestProject,
  command: string,
  message: string,
  log: string,
): TestRunError {
  return { kind, testProjectId: project.id, command, message, log };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
