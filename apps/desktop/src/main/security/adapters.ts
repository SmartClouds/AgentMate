import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ScanPhase,
  SecurityFinding,
  SecurityScannerId,
  SecurityScanOptions,
} from '@runova/core';
import { parseSarif, parseSonarIssues, parseStrixRun } from '@runova/core';
import { resolveCodeqlCommand } from './codeqlLocal';
import { type ScanCancelToken, spawnScan } from './exec';
import { fetchSonarFindings, waitForSonarTask } from './sonarApi';

/**
 * One adapter per scanner: how to invoke it, and how to read what it produced.
 *
 * The invocation and the parse are kept together because they are two halves of the same fact.
 * Trivy's `--format sarif` is what makes the shared SARIF parser applicable; change one and the
 * other has to change with it.
 */

export interface ScanContext {
  scannerId: SecurityScannerId;
  projectPath: string;
  /** Per-run scratch dir for this scanner. Nothing is ever written into the project. */
  workDir: string;
  options: SecurityScanOptions;
  token: ScanCancelToken;
  emit: (phase: ScanPhase, message: string) => void;
  /** Secrets pulled from settings, passed as env and never as argv. */
  config: SecurityScannerConfig;
  /** Container names registered here get force-removed on cancel. */
  registerContainer: (name: string) => void;
  runId: string;
}

export interface SecurityScannerConfig {
  sonarToken?: string | null;
  sonarUrl?: string | null;
  strixModel?: string | null;
  strixApiKey?: string | null;
}

export interface AdapterOutcome {
  findings: SecurityFinding[];
  exitCode: number | null;
  truncated: boolean;
  warnings: string[];
  transport: 'native' | 'docker';
  toolVersion: string | null;
  log: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the adapter itself decided the run failed, with a user-facing reason. */
  error: string | null;
}

export interface ScannerAdapter {
  id: SecurityScannerId;
  timeoutMs: number;
  run: (ctx: ScanContext) => Promise<AdapterOutcome>;
}

const MINUTE = 60_000;

/**
 * Directories that are never worth scanning. Semgrep honours .semgrepignore and skips these on
 * its own, but Trivy's filesystem scan does not, and left alone it will happily walk every
 * vendored dependency and flood the report.
 */
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target', '.venv'];

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Docker needs the host path as a single argv element. Docker Desktop resolves Windows drive
 * letters natively, so `E:\proj` is passed through as-is; the `/e/proj` form is a Toolbox relic
 * that no longer works.
 */
function bindMount(hostPath: string, containerPath: string, readOnly = true): string {
  return `${hostPath}:${containerPath}${readOnly ? ':ro' : ''}`;
}

/**
 * Semgrep and Strix are Python programs, and on Windows Python defaults its file encoding to the
 * system code page (cp1252 here). Semgrep's own rule metadata contains emoji, so writing the
 * SARIF report crashes with a UnicodeEncodeError and leaves a zero-byte file behind, which reads
 * downstream as "the scan produced nothing". UTF-8 mode is what makes the write succeed.
 */
function pythonEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extra };
}

function emptyOutcome(transport: 'native' | 'docker'): AdapterOutcome {
  return {
    findings: [],
    exitCode: null,
    truncated: false,
    warnings: [],
    transport,
    toolVersion: null,
    log: '',
    timedOut: false,
    cancelled: false,
    error: null,
  };
}

// --- Semgrep -----------------------------------------------------------------------------------

const semgrep: ScannerAdapter = {
  id: 'semgrep',
  timeoutMs: 10 * MINUTE,
  async run(ctx) {
    const output = join(ctx.workDir, 'results.sarif');
    ctx.emit('scanning', 'Running Semgrep');
    const result = await spawnScan({
      command: 'semgrep',
      args: [
        'scan',
        '--config',
        ctx.options.semgrepConfig,
        '--sarif',
        '--output',
        output,
        // Semgrep sends anonymized usage metrics by default. In a desktop app scanning private
        // code that needs to be an explicit choice, not a default, so it is always off.
        '--metrics=off',
        '--quiet',
        '.',
      ],
      cwd: ctx.projectPath,
      env: pythonEnv(),
      timeoutMs: semgrep.timeoutMs,
      token: ctx.token,
      onLine: (line) => ctx.emit('scanning', line),
    });

    ctx.emit('parsing', 'Reading Semgrep results');
    const parsed = await readJsonFile(output);
    const outcome = emptyOutcome('native');
    outcome.exitCode = result.code;
    outcome.log = result.log;
    outcome.timedOut = result.timedOut;
    outcome.cancelled = result.cancelled;

    if (parsed) {
      const sarif = parseSarif(parsed, {
        scannerId: 'semgrep',
        projectPath: ctx.projectPath,
        maxFindings: ctx.options.maxFindingsPerScanner,
        includeInfo: ctx.options.includeInfo,
      });
      outcome.findings = sarif.findings;
      outcome.truncated = sarif.truncated;
      outcome.warnings = sarif.warnings;
      outcome.toolVersion = sarif.toolVersion;
      return outcome;
    }

    // Exit 3 is specifically "could not fetch the ruleset", which is the single most common
    // Semgrep failure and has a concrete fix, so it gets its own message.
    if (result.code === 3) {
      outcome.error =
        'Semgrep could not reach its rule registry. Pick a local ruleset (p/security-audit) in the scan options, or check your network.';
    } else if (result.notFound) {
      outcome.error =
        'Semgrep could not be found. Install it from the Agent Tools page, then press Refresh there.';
    } else {
      outcome.error = 'Semgrep did not produce a report.';
    }
    return outcome;
  },
};

// --- Trivy -------------------------------------------------------------------------------------

const trivy: ScannerAdapter = {
  id: 'trivy',
  timeoutMs: 10 * MINUTE,
  async run(ctx) {
    const output = join(ctx.workDir, 'results.sarif');
    ctx.emit('scanning', 'Running Trivy');
    const result = await spawnScan({
      command: 'trivy',
      args: [
        'fs',
        '--scanners',
        ctx.options.trivyScanners.join(','),
        '--format',
        'sarif',
        '--output',
        output,
        '--skip-dirs',
        SKIP_DIRS.join(','),
        '--no-progress',
        '.',
      ],
      cwd: ctx.projectPath,
      timeoutMs: trivy.timeoutMs,
      token: ctx.token,
      onLine: (line) => ctx.emit('scanning', line),
    });

    ctx.emit('parsing', 'Reading Trivy results');
    const parsed = await readJsonFile(output);
    const outcome = emptyOutcome('native');
    outcome.exitCode = result.code;
    outcome.log = result.log;
    outcome.timedOut = result.timedOut;
    outcome.cancelled = result.cancelled;

    if (parsed) {
      const sarif = parseSarif(parsed, {
        scannerId: 'trivy',
        projectPath: ctx.projectPath,
        maxFindings: ctx.options.maxFindingsPerScanner,
        includeInfo: ctx.options.includeInfo,
      });
      outcome.findings = sarif.findings;
      outcome.truncated = sarif.truncated;
      outcome.warnings = sarif.warnings;
      outcome.toolVersion = sarif.toolVersion;
      return outcome;
    }

    outcome.error = result.notFound
      ? 'Trivy is not on PATH.'
      : 'Trivy did not produce a report. It may have failed to download its vulnerability database.';
    return outcome;
  },
};

// --- Bearer ------------------------------------------------------------------------------------

const CONTAINER_SCAN_ROOT = '/tmp/scan';

const bearer: ScannerAdapter = {
  id: 'bearer',
  timeoutMs: 15 * MINUTE,
  async run(ctx) {
    // Bearer has no native Windows build, so on win32 the only route is the container. Elsewhere
    // the native binary is preferred: the Docker bind mount is markedly slower, especially on
    // Windows/WSL2 where it goes through a 9p/virtiofs translation layer.
    const useDocker = process.platform === 'win32';
    const output = join(ctx.workDir, 'results.sarif');
    const outcome = emptyOutcome(useDocker ? 'docker' : 'native');

    ctx.emit('scanning', 'Running Bearer');
    let result: Awaited<ReturnType<typeof spawnScan>>;

    if (useDocker) {
      const containerName = `runova-scan-${ctx.runId}-bearer`;
      ctx.registerContainer(containerName);
      // The report goes to stdout and is redirected into the output file by the runner rather
      // than by a shell, so the container writes nothing and the project stays read-only.
      result = await spawnScan({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '--name',
          containerName,
          '-v',
          bindMount(ctx.projectPath, CONTAINER_SCAN_ROOT),
          'bearer/bearer:latest-amd64',
          'scan',
          CONTAINER_SCAN_ROOT,
          '--format',
          'sarif',
          '--output',
          '/dev/stdout',
        ],
        cwd: ctx.workDir,
        timeoutMs: bearer.timeoutMs,
        token: ctx.token,
        onLine: (line) => ctx.emit('scanning', line),
      });
      // Docker mixes the report into stdout with its own progress noise, so the JSON is carved
      // back out rather than assumed to be the whole stream.
      const start = result.log.indexOf('{');
      const end = result.log.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          const sarif = parseSarif(JSON.parse(result.log.slice(start, end + 1)), {
            scannerId: 'bearer',
            projectPath: ctx.projectPath,
            containerRoot: CONTAINER_SCAN_ROOT,
            maxFindings: ctx.options.maxFindingsPerScanner,
            includeInfo: ctx.options.includeInfo,
          });
          outcome.findings = sarif.findings;
          outcome.truncated = sarif.truncated;
          outcome.warnings = sarif.warnings;
          outcome.toolVersion = sarif.toolVersion;
        } catch {
          outcome.error = 'Bearer produced output that could not be read as SARIF.';
        }
      }
    } else {
      result = await spawnScan({
        command: 'bearer',
        args: ['scan', '.', '--format', 'sarif', '--output', output],
        cwd: ctx.projectPath,
        timeoutMs: bearer.timeoutMs,
        token: ctx.token,
        onLine: (line) => ctx.emit('scanning', line),
      });
      const parsed = await readJsonFile(output);
      if (parsed) {
        const sarif = parseSarif(parsed, {
          scannerId: 'bearer',
          projectPath: ctx.projectPath,
          maxFindings: ctx.options.maxFindingsPerScanner,
          includeInfo: ctx.options.includeInfo,
        });
        outcome.findings = sarif.findings;
        outcome.truncated = sarif.truncated;
        outcome.warnings = sarif.warnings;
        outcome.toolVersion = sarif.toolVersion;
      }
    }

    outcome.exitCode = result.code;
    outcome.log = result.log;
    outcome.timedOut = result.timedOut;
    outcome.cancelled = result.cancelled;

    // SARIF has no "critical" level, so Bearer's critical and high findings arrive
    // indistinguishable. Say so rather than quietly under-reporting severity.
    if (outcome.findings.length > 0) {
      outcome.warnings.push(
        'Bearer reports through SARIF, which has no critical level, so its critical findings appear here as high.',
      );
    } else if (!outcome.error) {
      if (
        /filesharing has been cancelled|drive is not shared|error during connect/i.test(result.log)
      ) {
        outcome.error =
          'Docker could not mount the project folder. Share this drive under Docker Desktop > Settings > Resources > File sharing.';
      } else if (result.notFound) {
        outcome.error = useDocker ? 'Docker is not on PATH.' : 'Bearer is not on PATH.';
      } else if (result.code !== 0 && result.code !== 1) {
        outcome.error = 'Bearer did not produce a report.';
      }
    }
    return outcome;
  },
};

// --- CodeQL ------------------------------------------------------------------------------------

const codeql: ScannerAdapter = {
  id: 'codeql',
  timeoutMs: 45 * MINUTE,
  async run(ctx) {
    const outcome = emptyOutcome('native');
    const language = ctx.options.codeqlLanguage;
    if (!language) {
      outcome.error = 'Pick a language for CodeQL in the scan options first.';
      return outcome;
    }

    // Either a codeql the user put on PATH, or the copy Runova downloaded into its tools
    // folder. Resolved per run rather than cached, since the managed copy can be installed or
    // removed while the app is open.
    const codeqlCommand = await resolveCodeqlCommand();
    if (!codeqlCommand) {
      outcome.error = 'CodeQL is not installed. Install it from the Agent Tools page.';
      return outcome;
    }

    // Short directory names on purpose: CodeQL nests several levels deep and a long scratch path
    // under AppData gets uncomfortably close to the Windows path limit.
    const dbPath = join(ctx.workDir, 'db');
    const output = join(ctx.workDir, 'results.sarif');

    ctx.emit('creating-database', `Building the CodeQL database for ${language}`);
    const createArgs = [
      'database',
      'create',
      dbPath,
      `--language=${language}`,
      `--source-root=${ctx.projectPath}`,
      '--overwrite',
    ];
    if (ctx.options.codeqlBuildCommand) {
      createArgs.push(`--command=${ctx.options.codeqlBuildCommand}`);
    }

    const create = await spawnScan({
      command: codeqlCommand,
      args: createArgs,
      cwd: ctx.workDir,
      timeoutMs: 30 * MINUTE,
      token: ctx.token,
      onLine: (line) => ctx.emit('creating-database', line),
    });

    outcome.log = create.log;
    outcome.timedOut = create.timedOut;
    outcome.cancelled = create.cancelled;
    outcome.exitCode = create.code;

    if (create.code !== 0) {
      // Exit 32 is "no code found", and it almost always means the wrong language was chosen or
      // a compiled language was selected without a build command.
      outcome.error =
        create.code === 32
          ? `CodeQL found no ${language} code to analyze. Check the language, and for compiled languages add a build command.`
          : create.notFound
            ? 'CodeQL is not on PATH.'
            : 'CodeQL could not build a database for this project.';
      return outcome;
    }
    if (create.cancelled) return outcome;

    ctx.emit('analyzing', 'Running CodeQL queries');
    const analyze = await spawnScan({
      command: codeqlCommand,
      args: [
        'database',
        'analyze',
        dbPath,
        '--format=sarif-latest',
        `--output=${output}`,
        // Without this a query that errors takes the whole analysis down; a partial result is
        // far more useful than none.
        '--no-sarif-include-query-help',
      ],
      cwd: ctx.workDir,
      timeoutMs: 15 * MINUTE,
      token: ctx.token,
      onLine: (line) => ctx.emit('analyzing', line),
    });

    outcome.log = create.log + '\n' + analyze.log;
    outcome.exitCode = analyze.code;
    outcome.timedOut = analyze.timedOut;
    outcome.cancelled = analyze.cancelled;

    ctx.emit('parsing', 'Reading CodeQL results');
    const parsed = await readJsonFile(output);
    if (parsed) {
      const sarif = parseSarif(parsed, {
        scannerId: 'codeql',
        projectPath: ctx.projectPath,
        maxFindings: ctx.options.maxFindingsPerScanner,
        includeInfo: ctx.options.includeInfo,
      });
      outcome.findings = sarif.findings;
      outcome.truncated = sarif.truncated;
      outcome.warnings = sarif.warnings;
      outcome.toolVersion = sarif.toolVersion;
      return outcome;
    }

    if (!outcome.cancelled) outcome.error = 'CodeQL did not produce a report.';
    return outcome;
  },
};

// --- SonarQube ---------------------------------------------------------------------------------

const sonarqube: ScannerAdapter = {
  id: 'sonarqube',
  timeoutMs: 35 * MINUTE,
  async run(ctx) {
    const outcome = emptyOutcome('docker');
    const token = ctx.config.sonarToken;
    const projectKey = ctx.options.sonarProjectKey;
    const hostUrl = ctx.config.sonarUrl || 'http://localhost:9000';

    if (!token) {
      outcome.error = 'Set a SonarQube token in the scan options first.';
      return outcome;
    }
    if (!projectKey || !/^[A-Za-z0-9_.:-]+$/.test(projectKey)) {
      outcome.error = 'Set a SonarQube project key (letters, digits, dot, dash, underscore).';
      return outcome;
    }

    const containerName = `runova-scan-${ctx.runId}-sonar`;
    ctx.registerContainer(containerName);

    // The scanner runs in a container and has to reach the SonarQube server, which is also a
    // container. Container-name DNS on a shared user network is the portable answer;
    // host.docker.internal works on Docker Desktop but not on native Linux without an extra
    // --add-host flag. These are genuinely two different URLs and conflating them is the classic
    // way this integration fails.
    const scannerUrl = 'http://runova-sonarqube:9000';
    const network = 'bridge';
    const onSharedNetwork = await ensureSonarNetwork(ctx);

    ctx.emit('scanning', 'Uploading analysis to SonarQube');
    const result = await spawnScan({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--name',
        containerName,
        ...(onSharedNetwork
          ? ['--network', SONAR_NETWORK]
          : ['--network', network, '--add-host=host.docker.internal:host-gateway']),
        '-v',
        bindMount(ctx.projectPath, CONTAINER_SCAN_ROOT),
        '-e',
        // The token goes through the environment, never argv, so it cannot show up in a process
        // listing on a shared machine.
        `SONAR_TOKEN=${token}`,
        'sonarsource/sonar-scanner-cli',
        `-Dsonar.projectKey=${projectKey}`,
        `-Dsonar.sources=${CONTAINER_SCAN_ROOT}`,
        `-Dsonar.host.url=${onSharedNetwork ? scannerUrl : 'http://host.docker.internal:9000'}`,
        // Keeps .scannerwork out of the user's repo, which would otherwise show up in git status.
        '-Dsonar.working.directory=/tmp/sonar-work',
      ],
      cwd: ctx.workDir,
      timeoutMs: 20 * MINUTE,
      token: ctx.token,
      onLine: (line) => ctx.emit('scanning', line),
    });

    outcome.exitCode = result.code;
    outcome.log = result.log;
    outcome.timedOut = result.timedOut;
    outcome.cancelled = result.cancelled;
    if (result.cancelled) return outcome;

    if (result.code !== 0) {
      outcome.error =
        'The SonarQube scanner failed. Check that the server is running on port 9000.';
      return outcome;
    }

    // Exit 0 means the report was uploaded, not that it was analyzed. Querying for issues now
    // would return the previous analysis, which is a silently wrong answer, so wait for the
    // server-side task to finish first.
    ctx.emit('waiting-for-task', 'Waiting for SonarQube to finish analyzing');
    const taskOk = await waitForSonarTask(hostUrl, token, projectKey, result.log, ctx.token);
    if (!taskOk.ok) {
      outcome.error = taskOk.error ?? 'SonarQube did not finish analyzing this project.';
      return outcome;
    }

    ctx.emit('fetching-results', 'Fetching findings from SonarQube');
    const fetched = await fetchSonarFindings(hostUrl, token, projectKey);
    if (fetched.error) {
      outcome.error = fetched.error;
      return outcome;
    }
    outcome.findings = parseSonarIssues(fetched.issues, fetched.hotspots, hostUrl).slice(
      0,
      ctx.options.maxFindingsPerScanner,
    );
    outcome.truncated = fetched.truncated;
    if (fetched.truncated) {
      outcome.warnings.push('SonarQube returned more findings than its API will page through.');
    }
    return outcome;
  },
};

const SONAR_NETWORK = 'runova-sonar';

/**
 * Put the scanner and the server on one user-defined network so the scanner can reach the server
 * by container name. Best effort: if the server container was not created by Runova this will
 * not apply, and the caller falls back to host.docker.internal.
 */
async function ensureSonarNetwork(ctx: ScanContext): Promise<boolean> {
  const create = await spawnScan({
    command: 'docker',
    args: ['network', 'create', SONAR_NETWORK],
    cwd: ctx.workDir,
    timeoutMs: 15_000,
    token: ctx.token,
  });
  // Exit 1 with "already exists" is the normal case after the first run.
  if (create.code !== 0 && !/already exists/i.test(create.log)) return false;

  const connect = await spawnScan({
    command: 'docker',
    args: ['network', 'connect', SONAR_NETWORK, 'runova-sonarqube'],
    cwd: ctx.workDir,
    timeoutMs: 15_000,
    token: ctx.token,
  });
  return connect.code === 0 || /already exists|already connected/i.test(connect.log);
}

// --- Strix -------------------------------------------------------------------------------------

const strix: ScannerAdapter = {
  id: 'strix',
  timeoutMs: 60 * MINUTE,
  async run(ctx) {
    const outcome = emptyOutcome('native');
    if (!ctx.config.strixApiKey || !ctx.config.strixModel) {
      outcome.error = 'Set a model and an LLM API key for Strix in the scan options first.';
      return outcome;
    }

    ctx.emit('scanning', 'Running Strix (this spends LLM tokens)');
    const result = await spawnScan({
      command: 'strix',
      args: ['--target', ctx.projectPath, '-n'],
      // Strix writes strix_runs/ relative to its cwd, so it runs from the scratch dir and is
      // pointed at the project with --target. This is the one adapter where cwd is not the
      // project, and it is what keeps the user's repo clean.
      cwd: ctx.workDir,
      env: pythonEnv({
        STRIX_LLM: ctx.config.strixModel,
        LLM_API_KEY: ctx.config.strixApiKey,
      }),
      timeoutMs: strix.timeoutMs,
      token: ctx.token,
      onLine: (line) => ctx.emit('scanning', line),
    });

    outcome.exitCode = result.code;
    outcome.log = result.log;
    outcome.timedOut = result.timedOut;
    outcome.cancelled = result.cancelled;

    ctx.emit('parsing', 'Reading Strix results');
    const runJson = await findStrixResults(join(ctx.workDir, 'strix_runs'));
    if (runJson) {
      outcome.findings = parseStrixRun(runJson).slice(0, ctx.options.maxFindingsPerScanner);
      return outcome;
    }

    // Exit 2 means "vulnerabilities found", which is a successful run, not a failure. Only treat
    // anything else as broken.
    if (result.code !== 0 && result.code !== 2 && !result.cancelled) {
      outcome.error = result.notFound ? 'Strix is not on PATH.' : 'Strix did not produce a report.';
    }
    return outcome;
  },
};

/** Strix writes a timestamped folder per run; the newest one is this run's. */
async function findStrixResults(runsDir: string): Promise<unknown | null> {
  try {
    const entries = await readdir(runsDir);
    const dirs: { path: string; mtime: number }[] = [];
    for (const entry of entries) {
      const full = join(runsDir, entry);
      const info = await stat(full);
      if (info.isDirectory()) dirs.push({ path: full, mtime: info.mtimeMs });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const dir of dirs) {
      for (const name of await readdir(dir.path)) {
        if (!name.endsWith('.json')) continue;
        const parsed = await readJsonFile(join(dir.path, name));
        if (parsed) return parsed;
      }
    }
  } catch {
    // No results directory means the run produced nothing, which the caller reports.
  }
  return null;
}

export const SCANNER_ADAPTERS: Record<SecurityScannerId, ScannerAdapter> = {
  semgrep,
  trivy,
  bearer,
  sonarqube,
  codeql,
  strix,
};
