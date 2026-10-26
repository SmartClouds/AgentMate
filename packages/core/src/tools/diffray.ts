import { DIFFRAY_DOC_MODELS, DIFFRAY_EXECUTOR_MODELS } from '../models/catalog.js';
import type { AgentType } from '../types/index.js';
import type { ToolSettingsAction, ToolSettingsValues } from './types.js';

export const DIFFRAY_TOOL_ID = 'diffray';
export const DIFFRAY_WEBSITE_URL = 'https://diffray.ai/cli';
export const DIFFRAY_GITHUB_APP_URL = 'https://diffray.ai/integrations/github/';
export const DIFFRAY_REPOSITORY_URL = 'https://github.com/diffray/diffray';
export const DIFFRAY_PROJECT_CONFIG_FILE = '.diffray.json';

export const DIFFRAY_AGENTS = [
  {
    id: 'general',
    label: 'Quality',
    description: 'Readability, simplicity, and code smells',
  },
  {
    id: 'bug-hunter',
    label: 'Bugs',
    description: 'Logic errors, nulls, and edge cases',
  },
  {
    id: 'security-scan',
    label: 'Security',
    description: 'Vulnerabilities and leaked secrets',
  },
  {
    id: 'performance-check',
    label: 'Performance',
    description: 'Slow paths and memory leaks',
  },
  {
    id: 'consistency-check',
    label: 'Consistency',
    description: 'Naming and pattern drift',
  },
] as const;

export type DiffrayAgentId = (typeof DIFFRAY_AGENTS)[number]['id'];

export const DIFFRAY_EXECUTORS = [
  {
    id: 'claude-cli',
    label: 'Claude Code',
    description: 'Uses your Claude Code login',
  },
  {
    id: 'cursor-agent-cli',
    label: 'Cursor Agent',
    description: 'Uses your Cursor subscription',
  },
  {
    id: 'opencode-cli',
    label: 'OpenCode',
    description: 'Multi-provider OpenCode CLI',
  },
  {
    id: 'codex-cli',
    label: 'Codex',
    description: 'OpenAI Codex CLI',
  },
] as const;

export type DiffrayExecutorId = (typeof DIFFRAY_EXECUTORS)[number]['id'];

export const DIFFRAY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type DiffraySeverity = (typeof DIFFRAY_SEVERITIES)[number];

const EXECUTOR_DEFAULT = { value: '', label: 'Executor default' };

/** Model choices per executor, the executor's own default first. Names come from the catalog. */
export const DIFFRAY_MODELS: Record<DiffrayExecutorId, { value: string; label: string }[]> = {
  'claude-cli': [EXECUTOR_DEFAULT, ...DIFFRAY_EXECUTOR_MODELS['claude-cli']],
  'cursor-agent-cli': [EXECUTOR_DEFAULT, ...DIFFRAY_EXECUTOR_MODELS['cursor-agent-cli']],
  'opencode-cli': [EXECUTOR_DEFAULT, ...DIFFRAY_EXECUTOR_MODELS['opencode-cli']],
  'codex-cli': [EXECUTOR_DEFAULT, ...DIFFRAY_EXECUTOR_MODELS['codex-cli']],
};

export interface DiffrayModelTradeoff {
  /** Model id as diffray's docs write it, not the wizard's option value. */
  model: string;
  speed: 'fast' | 'moderate';
  quality: 'Good' | 'Very Good' | 'Excellent' | 'Outstanding';
  /** Rough relative price, 1 is cheapest. */
  cost: 1 | 2 | 3;
  costLabel: 'Low' | 'Medium' | 'High';
  bestFor: string;
  /** Called out in the docs as the sweet spot. */
  recommended?: boolean;
}

/** The performance vs quality table from diffray's docs, shown as a hint on the engine step. */
export const DIFFRAY_MODEL_TRADEOFFS: DiffrayModelTradeoff[] = [
  {
    model: DIFFRAY_DOC_MODELS.haiku,
    speed: 'fast',
    quality: 'Good',
    cost: 1,
    costLabel: 'Low',
    bestFor: 'Daily development, large PRs',
  },
  {
    model: DIFFRAY_DOC_MODELS.sonnet,
    speed: 'moderate',
    quality: 'Excellent',
    cost: 2,
    costLabel: 'Medium',
    bestFor: 'Most use cases, balanced approach',
  },
  {
    model: DIFFRAY_DOC_MODELS.opus,
    speed: 'fast',
    quality: 'Outstanding',
    cost: 3,
    costLabel: 'High',
    bestFor: 'Optimal balance of speed and quality, security, critical bugs',
    recommended: true,
  },
  {
    model: DIFFRAY_DOC_MODELS.codex,
    speed: 'fast',
    quality: 'Very Good',
    cost: 2,
    costLabel: 'Medium',
    bestFor: 'General purpose, cost-effective',
  },
  {
    model: DIFFRAY_DOC_MODELS.opencodeNano,
    speed: 'fast',
    quality: 'Good',
    cost: 1,
    costLabel: 'Low',
    bestFor: 'Quick reviews, prototyping',
  },
];

export type DiffrayReviewScope =
  | 'working-tree'
  | 'base-branch'
  | 'last-commits'
  | 'files'
  | 'codebase';

export interface DiffrayReviewInput {
  scope: DiffrayReviewScope;
  baseRef?: string;
  commitCount?: number;
  files?: string[];
  fullFiles?: boolean;
  agentIds: string[];
  executor: string;
  model?: string;
  severities: string[];
  skipValidation: boolean;
  stream: boolean;
  /** Codebase scope only: how many files each `diffray review` pass gets. */
  filesPerPass?: number;
  /** Ask the CLI for machine-readable findings instead of the terminal report. */
  jsonOutput?: boolean;
}

/** Shells Runova's terminal opens with, which differ in how they redirect output to a file. */
export type DiffrayShellKind = 'powershell' | 'posix';

export const DIFFRAY_DEFAULT_JSON_FILE = 'diffray-report.json';

/**
 * Extensions diffray can actually reason about. Data files, lockfiles, images, and binaries
 * are left out: they burn context without producing findings.
 */
const SOURCE_EXTENSIONS = new Set([
  'astro',
  'bash',
  'c',
  'cc',
  'cjs',
  'clj',
  'cpp',
  'cs',
  'cts',
  'dart',
  'ex',
  'exs',
  'fs',
  'go',
  'groovy',
  'h',
  'hpp',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'lua',
  'm',
  'mjs',
  'mm',
  'mts',
  'php',
  'pl',
  'proto',
  'ps1',
  'psm1',
  'py',
  'r',
  'rb',
  'rs',
  'scala',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vb',
  'vue',
  'zsh',
]);

/** Directories nobody wants reviewed: dependencies, build output, and caches. */
const IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  '__pycache__',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
  'vendor',
  'venv',
]);

const TEST_DIRECTORIES = new Set(['__mocks__', '__tests__', 'e2e', 'spec', 'test', 'tests']);

export interface DiffrayCodebaseFilter {
  /** Repo-relative folder to stay inside. Empty means the whole repository. */
  folder?: string;
  /** Test and spec files are noisy in a whole-codebase pass, so they are out by default. */
  includeTests?: boolean;
}

export interface DiffrayCodebaseFolder {
  path: string;
  fileCount: number;
}

/** Every pass is one `diffray review`, and the CLI runs one agent per file batch. */
export const DIFFRAY_DEFAULT_FILES_PER_PASS = 10;
export const DIFFRAY_MAX_FILES_PER_PASS = 40;

/**
 * npm installs diffray as a .cmd shim on Windows, so each command goes through cmd.exe and
 * its 8191 character line limit. Leave room to spare.
 */
const MAX_COMMAND_CHARS = 6000;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeFolder(folder: string | undefined): string {
  return toPosixPath(folder?.trim() ?? '').replace(/^\/+|\/+$/g, '');
}

export function isDiffrayTestFile(path: string): boolean {
  const segments = toPosixPath(path).split('/');
  const name = segments.pop() ?? '';
  if (segments.some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))) return true;
  return /\.(test|spec)\.[^.]+$/i.test(name);
}

/** True when diffray reviewing the whole file is likely to be worth the tokens. */
export function isDiffraySourceFile(path: string): boolean {
  const normalized = toPosixPath(path);
  if (!normalized || normalized.startsWith('../')) return false;
  const segments = normalized.split('/');
  const name = segments.pop() ?? '';
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  // Generated and bundled output reads like source but is not worth reviewing.
  if (name.endsWith('.d.ts') || /\.(min|bundle|generated)\./i.test(name)) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function filterDiffrayCodebaseFiles(
  paths: readonly string[],
  filter: DiffrayCodebaseFilter = {},
): string[] {
  const folder = normalizeFolder(filter.folder);
  const prefix = folder ? `${folder}/` : '';
  const matched = new Set<string>();
  for (const raw of paths) {
    const path = toPosixPath(raw);
    if (prefix && !path.startsWith(prefix)) continue;
    if (!isDiffraySourceFile(path)) continue;
    if (!filter.includeTests && isDiffrayTestFile(path)) continue;
    matched.add(path);
  }
  return [...matched].sort((a, b) => a.localeCompare(b));
}

/**
 * Folders worth offering as a review target, with the file count each one holds. Only the top
 * two levels: deeper than that the picker turns into a file tree, which is not the point here.
 */
export function diffrayCodebaseFolders(
  paths: readonly string[],
  filter: Omit<DiffrayCodebaseFilter, 'folder'> = {},
  maxDepth = 2,
): DiffrayCodebaseFolder[] {
  const counts = new Map<string, number>();
  for (const path of filterDiffrayCodebaseFiles(paths, filter)) {
    const segments = path.split('/');
    segments.pop();
    for (let depth = 1; depth <= Math.min(maxDepth, segments.length); depth += 1) {
      const folder = segments.slice(0, depth).join('/');
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, fileCount]) => ({ path, fileCount }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Splits files into review passes. A pass ends at `filesPerPass` files or when the command
 * would outgrow the shell's line limit, whichever comes first.
 */
export function chunkDiffrayFiles(
  files: readonly string[],
  filesPerPass = DIFFRAY_DEFAULT_FILES_PER_PASS,
  overheadChars = 120,
): string[][] {
  const perPass = Math.max(1, Math.min(DIFFRAY_MAX_FILES_PER_PASS, Math.round(filesPerPass)));
  const budget = Math.max(200, MAX_COMMAND_CHARS - overheadChars);
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 1;
    if (batch.length > 0 && (batch.length >= perPass || length + cost > budget)) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const ALL_AGENT_IDS: readonly string[] = DIFFRAY_AGENTS.map((agent) => agent.id);

function quoteArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function isDiffrayExecutorId(value: string): value is DiffrayExecutorId {
  return DIFFRAY_EXECUTORS.some((executor) => executor.id === value);
}

export function defaultDiffrayExecutorForAgentType(agentType: AgentType): DiffrayExecutorId {
  if (agentType === 'cursor') return 'cursor-agent-cli';
  if (agentType === 'opencode') return 'opencode-cli';
  if (agentType === 'codex') return 'codex-cli';
  return 'claude-cli';
}

export function allDiffrayAgentIds(): string[] {
  return [...ALL_AGENT_IDS];
}

export function allDiffraySeverities(): DiffraySeverity[] {
  return [...DIFFRAY_SEVERITIES];
}

/**
 * Builds the `diffray review` command for a wizard run. Flags that match defaults
 * (every agent, every severity) are omitted so the command stays short.
 */
export function buildDiffrayReviewCommand(input: DiffrayReviewInput): string {
  const parts = ['diffray', 'review'];

  if (input.scope === 'base-branch' && input.baseRef?.trim()) {
    parts.push('--base', input.baseRef.trim());
  } else if (input.scope === 'last-commits') {
    const n = Math.max(1, Math.min(50, Math.round(input.commitCount ?? 3)));
    parts.push('--base', `HEAD~${n}`);
  } else if (input.scope === 'files' && input.files && input.files.length > 0) {
    parts.push('--files', input.files.join(','));
    if (input.fullFiles) parts.push('--full');
  } else if (input.scope === 'codebase' && input.files && input.files.length > 0) {
    // Whole-file review, so no --base here: the CLI rejects --full together with --base.
    parts.push('--files', input.files.join(','), '--full');
  }

  parts.push(...diffrayReviewFlags(input));
  return parts.map(quoteArg).join(' ');
}

/**
 * Everything after the scope flags, unquoted. Kept separate from the command so the codebase
 * runner script can splat the same flags around a file list it works out at run time.
 */
export function diffrayReviewFlags(input: DiffrayReviewInput): string[] {
  const parts: string[] = [];

  const selectedAgents = input.agentIds.filter((id) => ALL_AGENT_IDS.includes(id));
  if (selectedAgents.length > 0 && selectedAgents.length < ALL_AGENT_IDS.length) {
    // The CLI takes one comma-separated list. Repeating the flag makes its parser hand the
    // option an array, and diffray then splits a non-string and gives up.
    parts.push('--agent', selectedAgents.join(','));
  }

  if (input.executor.trim()) {
    parts.push('--executor', input.executor.trim());
  }

  const model = input.model?.trim();
  if (model) parts.push('--model', model);

  const selectedSeverities = input.severities.filter((severity) =>
    (DIFFRAY_SEVERITIES as readonly string[]).includes(severity),
  );
  if (selectedSeverities.length > 0 && selectedSeverities.length < DIFFRAY_SEVERITIES.length) {
    parts.push('--severity', selectedSeverities.join(','));
  }

  if (input.skipValidation) parts.push('--skip-validation');
  if (input.jsonOutput) parts.push('--json');
  // Streamed progress goes to the same stdout the JSON report is captured from, so it would
  // land in the file and break the parse.
  else if (input.stream) parts.push('--stream');

  return parts;
}

/**
 * Numbers the report file per pass, so a multi-pass codebase review does not overwrite
 * itself: `diffray-report.json` becomes `diffray-report-2.json` for the second pass.
 */
export function diffrayJsonFileForPass(fileName: string, pass: number, passCount: number): string {
  const trimmed = fileName.trim() || DIFFRAY_DEFAULT_JSON_FILE;
  const withExtension = /\.json$/i.test(trimmed) ? trimmed : `${trimmed}.json`;
  if (passCount <= 1) return withExtension;
  return withExtension.replace(/\.json$/i, `-${pass}.json`);
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Sends stdout to a file. Windows terminals open Windows PowerShell, where both `>` (UTF-16)
 * and `Out-File -Encoding utf8` (UTF-8 with a BOM) produce a file that JSON parsers choke on,
 * so the report is written through .NET instead.
 */
export function redirectDiffrayCommandToFile(
  command: string,
  filePath: string,
  shell: DiffrayShellKind,
): string {
  if (shell === 'powershell') {
    const target = `(Join-Path $PWD ${quotePowerShellLiteral(filePath)})`;
    return `${command} | Out-String | ForEach-Object { [IO.File]::WriteAllText(${target}, $_) }`;
  }
  return `${command} > ${quoteArg(filePath)}`;
}

export interface DiffrayCommandPlan {
  /** One entry per `diffray review` invocation, in the order they should run. */
  commands: string[];
  /** Report files the run writes, empty unless JSON output is on. */
  reportFiles: string[];
}

/**
 * How long everything around the file list is, so a batch can be sized against the real command
 * rather than a guess. The probe uses a one character path and the widest report name a run can
 * produce, which leaves the estimate a little pessimistic and never short.
 */
function diffrayPassOverheadChars(
  input: DiffrayReviewInput,
  shell: DiffrayShellKind,
  jsonFileName: string,
): number {
  const probe = buildDiffrayReviewCommand({ ...input, files: ['x'] });
  const wrapped = input.jsonOutput
    ? redirectDiffrayCommandToFile(probe, diffrayJsonFileForPass(jsonFileName, 999, 999), shell)
    : probe;
  return wrapped.length - 1;
}

/**
 * Plans a run. Every scope but `codebase` is a single command; a codebase review is split into
 * passes so no single invocation drowns the agents (or the shell) in files.
 */
export function planDiffrayReview(
  input: DiffrayReviewInput,
  options: { shell?: DiffrayShellKind; jsonFileName?: string } = {},
): DiffrayCommandPlan {
  const shell = options.shell ?? 'posix';
  const fileName = options.jsonFileName?.trim() || DIFFRAY_DEFAULT_JSON_FILE;
  const batches =
    input.scope === 'codebase'
      ? chunkDiffrayFiles(
          input.files ?? [],
          input.filesPerPass,
          diffrayPassOverheadChars(input, shell, fileName),
        )
      : [input.files ?? []];

  const commands: string[] = [];
  const reportFiles: string[] = [];
  batches.forEach((files, index) => {
    const command = buildDiffrayReviewCommand({ ...input, files });
    if (!input.jsonOutput) {
      commands.push(command);
      return;
    }
    const reportFile = diffrayJsonFileForPass(fileName, index + 1, batches.length);
    reportFiles.push(reportFile);
    commands.push(redirectDiffrayCommandToFile(command, reportFile, shell));
  });
  return { commands, reportFiles };
}

/** Chains passes into one line the user can run with a single Enter. */
export function joinDiffrayCommands(commands: readonly string[]): string {
  // `;` rather than `&&`: it works in PowerShell 5.1, pwsh, bash, zsh, and fish alike, and a
  // failed pass should not stop the ones after it.
  return commands.join('; ');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alternation(values: Iterable<string>): string {
  return [...values].map(escapeRegex).join('|');
}

/**
 * The same rules `isDiffraySourceFile` and `isDiffrayTestFile` apply, as regexes a shell can use.
 * They are generated from the sets above rather than written out twice, so the script keeps
 * matching what the wizard previewed.
 */
export const DIFFRAY_FILE_PATTERNS = {
  source: `\\.(${alternation(SOURCE_EXTENSIONS)})$`,
  ignored: `(^|/)(${alternation(IGNORED_DIRECTORIES)})/`,
  test: `(^|/)(${alternation(TEST_DIRECTORIES)})/|\\.(test|spec)\\.[^.]+$`,
  generated: `\\.d\\.ts$|\\.(min|bundle|generated)\\.`,
} as const;

export interface DiffrayCodebaseScriptOptions {
  shell?: DiffrayShellKind;
  /** Project name, for the header comment. */
  label?: string;
  /** Keeps two projects from sharing one script file. */
  scriptId?: string;
  jsonFileName?: string;
  folder?: string;
  includeTests?: boolean;
  /** Files the user unchecked in the wizard. */
  skipFiles?: readonly string[];
}

export interface DiffrayRunScript {
  fileName: string;
  content: string;
  /** Runs the script once it is on disk. Takes the path the file was written to. */
  commandFor: (scriptPath: string) => string;
  /** What a single pass ends up looking like, for the preview in the wizard. */
  samplePassCommand: string;
}

function quotePosixLiteral(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powerShellCodebaseScript(
  input: DiffrayReviewInput,
  options: DiffrayCodebaseScriptOptions,
  reportFile: string,
): string {
  const ps = quotePowerShellLiteral;
  const flags = diffrayReviewFlags(input).map(ps).join(', ');
  const skip = (options.skipFiles ?? []).map(ps).join(', ');
  return `# diffray whole-file review for ${options.label?.trim() || 'this project'}, written by Runova.
# The file list is worked out here instead of being pasted onto the prompt, so the command
# you run stays one line long. Ctrl+C stops the run.
$ErrorActionPreference = 'Continue'

$perPass = ${Math.max(1, Math.min(DIFFRAY_MAX_FILES_PER_PASS, Math.round(input.filesPerPass ?? DIFFRAY_DEFAULT_FILES_PER_PASS)))}
$maxChars = ${MAX_COMMAND_CHARS}
$folder = ${ps(normalizeFolder(options.folder))}
$includeTests = $${options.includeTests ? 'true' : 'false'}
$reportFile = ${ps(input.jsonOutput ? reportFile : '')}
$sourcePattern = ${ps(DIFFRAY_FILE_PATTERNS.source)}
$ignoredPattern = ${ps(DIFFRAY_FILE_PATTERNS.ignored)}
$testPattern = ${ps(DIFFRAY_FILE_PATTERNS.test)}
$generatedPattern = ${ps(DIFFRAY_FILE_PATTERNS.generated)}
$flags = @(${flags})
$skip = @(${skip})

$files = @(git -c core.quotepath=off ls-files --cached --others --exclude-standard |
  ForEach-Object { $_ -replace '\\\\', '/' } |
  Where-Object { $_ -match $sourcePattern } |
  Where-Object { $_ -notmatch $ignoredPattern -and $_ -notmatch $generatedPattern } |
  Where-Object { $includeTests -or $_ -notmatch $testPattern } |
  Where-Object { $folder -eq '' -or $_.StartsWith($folder + '/') } |
  Where-Object { $skip -notcontains $_ } |
  Sort-Object -Unique)

if ($files.Count -eq 0) {
  Write-Host 'No source files matched. Check the folder and the test filter.' -ForegroundColor Yellow
  exit 1
}

# One pass per batch: diffray goes through a .cmd shim on Windows, and cmd.exe refuses a
# command line past 8191 characters, so the batch is capped by length as well as by count.
$batches = New-Object System.Collections.ArrayList
$current = New-Object System.Collections.ArrayList
$length = 0
foreach ($file in $files) {
  if ($current.Count -gt 0 -and ($current.Count -ge $perPass -or ($length + $file.Length + 1) -gt $maxChars)) {
    [void]$batches.Add(($current -join ','))
    $current.Clear()
    $length = 0
  }
  [void]$current.Add($file)
  $length += $file.Length + 1
}
if ($current.Count -gt 0) { [void]$batches.Add(($current -join ',')) }

Write-Host ("diffray: {0} files in {1} passes" -f $files.Count, $batches.Count) -ForegroundColor Cyan
$failed = @()
$started = Get-Date
for ($i = 0; $i -lt $batches.Count; $i++) {
  $label = "pass {0}/{1}" -f ($i + 1), $batches.Count
  # Indexing has to happen before the call: PowerShell reads $batches[$i] in an argument list
  # as the array followed by a literal [$i].
  $batch = $batches[$i]
  Write-Host ''
  Write-Host "=== diffray $label ===" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  if ($reportFile -eq '') {
    diffray review --files $batch --full @flags
  } else {
    $name = if ($batches.Count -eq 1) { $reportFile } else { $reportFile -replace '\\.json$', ("-{0}.json" -f ($i + 1)) }
    $out = Join-Path $PWD $name
    # Both > and Out-File add a BOM or UTF-16 that JSON parsers choke on, hence .NET here.
    diffray review --files $batch --full @flags | Out-String | ForEach-Object { [IO.File]::WriteAllText($out, $_) }
    Write-Host "wrote $name"
  }
  if ($LASTEXITCODE -ne 0) {
    $failed += ($i + 1)
    Write-Host "$label exited with code $LASTEXITCODE" -ForegroundColor Yellow
  }
}

$elapsed = (Get-Date) - $started
Write-Host ''
if ($failed.Count -gt 0) {
  Write-Host ("Finished in {0:hh\\:mm\\:ss}. Failed passes: {1}" -f $elapsed, ($failed -join ', ')) -ForegroundColor Yellow
} else {
  Write-Host ("All {0} passes finished in {1:hh\\:mm\\:ss}." -f $batches.Count, $elapsed) -ForegroundColor Green
}
`;
}

function posixCodebaseScript(
  input: DiffrayReviewInput,
  options: DiffrayCodebaseScriptOptions,
  reportFile: string,
): string {
  const sh = quotePosixLiteral;
  const flags = diffrayReviewFlags(input).map(sh).join(' ');
  const skip = (options.skipFiles ?? []).map(sh).join(' ');
  return `#!/usr/bin/env bash
# diffray whole-file review for ${options.label?.trim() || 'this project'}, written by Runova.
# The file list is worked out here instead of being pasted onto the prompt, so the command
# you run stays one line long. Ctrl+C stops the run.

per_pass=${Math.max(1, Math.min(DIFFRAY_MAX_FILES_PER_PASS, Math.round(input.filesPerPass ?? DIFFRAY_DEFAULT_FILES_PER_PASS)))}
max_chars=${MAX_COMMAND_CHARS}
folder=${sh(normalizeFolder(options.folder))}
include_tests=${options.includeTests ? '1' : '0'}
report_file=${sh(input.jsonOutput ? reportFile : '')}
source_pattern=${sh(DIFFRAY_FILE_PATTERNS.source)}
ignored_pattern=${sh(DIFFRAY_FILE_PATTERNS.ignored)}
test_pattern=${sh(DIFFRAY_FILE_PATTERNS.test)}
generated_pattern=${sh(DIFFRAY_FILE_PATTERNS.generated)}
flags=(${flags})
skip=(${skip})

files=()
while IFS= read -r path; do
  files+=("$path")
done < <(
  git -c core.quotepath=off ls-files --cached --others --exclude-standard |
    tr '\\\\' '/' |
    grep -Ei "$source_pattern" |
    grep -Eiv "$ignored_pattern" |
    grep -Eiv "$generated_pattern" |
    { if [ "$include_tests" = "1" ]; then cat; else grep -Eiv "$test_pattern"; fi; } |
    { if [ -n "$folder" ]; then grep -E "^$folder/"; else cat; fi; } |
    { if [ \${#skip[@]} -gt 0 ]; then grep -Fxv -f <(printf '%s\\n' "\${skip[@]}"); else cat; fi; } |
    sort -u
)

if [ \${#files[@]} -eq 0 ]; then
  printf 'No source files matched. Check the folder and the test filter.\\n'
  exit 1
fi

# One pass per batch, capped by length as well as by count so a long file list cannot
# outgrow the shell's limit on a single command line.
batches=()
current=''
count=0
for file in "\${files[@]}"; do
  if [ $count -gt 0 ] && { [ $count -ge $per_pass ] || [ $(( \${#current} + \${#file} + 1 )) -gt $max_chars ]; }; then
    batches+=("$current")
    current=''
    count=0
  fi
  if [ -z "$current" ]; then current="$file"; else current="$current,$file"; fi
  count=$(( count + 1 ))
done
[ -n "$current" ] && batches+=("$current")

total=\${#batches[@]}
printf 'diffray: %d files in %d passes\\n' "\${#files[@]}" "$total"
failed=()
start=$SECONDS
for i in "\${!batches[@]}"; do
  printf '\\n=== diffray pass %d/%d ===\\n' "$(( i + 1 ))" "$total"
  status=0
  if [ -z "$report_file" ]; then
    diffray review --files "\${batches[$i]}" --full "\${flags[@]}" || status=$?
  else
    if [ "$total" -eq 1 ]; then name="$report_file"; else name="\${report_file%.json}-$(( i + 1 )).json"; fi
    diffray review --files "\${batches[$i]}" --full "\${flags[@]}" > "$name" || status=$?
    printf 'wrote %s\\n' "$name"
  fi
  if [ $status -ne 0 ]; then
    failed+=("$(( i + 1 ))")
    printf 'pass %d/%d exited with code %d\\n' "$(( i + 1 ))" "$total" "$status"
  fi
done

elapsed=$(( SECONDS - start ))
printf '\\n'
if [ \${#failed[@]} -gt 0 ]; then
  printf 'Finished in %dm %ds. Failed passes: %s\\n' "$(( elapsed / 60 ))" "$(( elapsed % 60 ))" "\${failed[*]}"
else
  printf 'All %d passes finished in %dm %ds.\\n' "$total" "$(( elapsed / 60 ))" "$(( elapsed % 60 ))"
fi
`;
}

/**
 * A whole-codebase review as a script the terminal runs with one short command. The file list is
 * resolved by the script at run time, so hundreds of paths never touch the prompt, and the passes
 * are batched there too, which keeps every `diffray review` inside the shell's line limit.
 */
export function buildDiffrayCodebaseScript(
  input: DiffrayReviewInput,
  options: DiffrayCodebaseScriptOptions = {},
): DiffrayRunScript {
  const shell = options.shell ?? 'posix';
  const reportFile = diffrayJsonFileForPass(
    options.jsonFileName?.trim() || DIFFRAY_DEFAULT_JSON_FILE,
    1,
    1,
  );
  const perPass = Math.max(
    1,
    Math.min(
      DIFFRAY_MAX_FILES_PER_PASS,
      Math.round(input.filesPerPass ?? DIFFRAY_DEFAULT_FILES_PER_PASS),
    ),
  );
  const samplePassCommand = [
    'diffray',
    'review',
    '--files',
    `"<${perPass} files>"`,
    '--full',
    ...diffrayReviewFlags(input).map(quoteArg),
  ].join(' ');
  const suffix = (options.scriptId ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
  const stem = suffix ? `diffray-review-${suffix}` : 'diffray-review';

  if (shell === 'powershell') {
    return {
      fileName: `${stem}.ps1`,
      content: powerShellCodebaseScript(input, options, reportFile),
      // -ExecutionPolicy Bypass because a machine left on the Restricted default refuses to run
      // the file at all, and -NoProfile keeps someone's prompt setup out of the report.
      commandFor: (scriptPath) =>
        `powershell -NoProfile -ExecutionPolicy Bypass -File ${quoteArg(scriptPath)}`,
      samplePassCommand,
    };
  }
  return {
    fileName: `${stem}.sh`,
    content: posixCodebaseScript(input, options, reportFile),
    // `bash <file>` rather than `./file`, so the script does not need an executable bit.
    commandFor: (scriptPath) => `bash ${quoteArg(scriptPath)}`,
    samplePassCommand,
  };
}

export function buildDiffrayProjectConfig(values: ToolSettingsValues): ToolSettingsAction {
  const executor = String(values.executor || 'claude-cli');
  const excludeTests = Boolean(values.excludeTests);
  const config: Record<string, unknown> = {
    executor: isDiffrayExecutorId(executor) ? executor : 'claude-cli',
    concurrency: 6,
  };
  if (excludeTests) {
    config.excludePatterns = [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.test.js',
      '**/*.spec.js',
      '**/__tests__/**',
      'dist/**',
      'node_modules/**',
    ];
  }
  return {
    kind: 'write-project-file',
    relativePath: DIFFRAY_PROJECT_CONFIG_FILE,
    content: `${JSON.stringify(config, null, 2)}\n`,
  };
}
