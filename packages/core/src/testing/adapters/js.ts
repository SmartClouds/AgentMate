import { toPosix } from '../paths.js';
import type { ParsedTestResult, TestProject, TestRef } from '../types.js';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  cleanText,
  compact,
  escapeRegex,
  exactNames,
  filesOf,
  fromProject,
  nodeRunner,
  parseJson,
  reportPath,
  splitStack,
  stripAnsi,
  unique,
} from './shared.js';
import type { ResolvedTarget, StreamParser, TestAdapter } from './types.js';

const fullName = (ref: TestRef): string => ref.path.join(' ');

/**
 * Vitest 3 and later match `-t` against "suite > test", older versions against "suite test", so
 * the pattern accepts either separator between the names.
 */
function vitestNames(refs: readonly TestRef[]): string {
  const names = unique(refs.map((ref) => ref.path.map(escapeRegex).join('(?: | > )')));
  return `^(?:${names.join('|')})$`;
}

function selectionArgs(
  project: TestProject,
  target: ResolvedTarget,
): { files: string[]; names: string[] } {
  if (target.all) return { files: [], names: [] };
  return {
    files: unique([
      ...target.files.map((file) => fromProject(project, file)),
      ...filesOf(project, target.tests),
    ]),
    names: target.tests.map(fullName),
  };
}

export const vitestAdapter: TestAdapter = {
  framework: 'vitest',
  plan(project, target, ctx) {
    const { command, prefix } = nodeRunner(project, 'vitest', ctx);
    const report = reportPath(ctx, 'vitest.json');
    const { files, names } = selectionArgs(project, target);
    return {
      command,
      args: [
        ...prefix,
        'run',
        '--reporter=verbose',
        '--reporter=json',
        `--outputFile.json=${report}`,
        ...files,
        ...(names.length > 0 ? ['-t', vitestNames(target.tests)] : []),
      ],
      cwd: project.root,
      reportFiles: [report],
    };
  },
  parseReport: parseJestLikeReport,
  stream: () => vitestStream(),
};

const JEST_MARK = '@@runova-jest ';

/**
 * Jest only writes its JSON report when every file is done, and its text output has no reliable
 * per-test lines. This reporter prints each test file's results the moment that file finishes.
 */
const JEST_REPORTER = `class RunovaReporter {
  onTestResult(_test, result) {
    try {
      const entry = {
        name: result.testFilePath,
        status: result.numFailingTests > 0 ? 'failed' : 'passed',
        message: result.failureMessage || '',
        assertionResults: result.testResults.map((t) => ({
          title: t.title,
          ancestorTitles: t.ancestorTitles,
          status: t.status,
          duration: t.duration,
          failureMessages: t.failureMessages,
          location: t.location,
        })),
      };
      process.stdout.write(${JSON.stringify(JEST_MARK)} + JSON.stringify(entry) + '\\n');
    } catch {}
  }
}
module.exports = RunovaReporter;
`;

function jestStream(): StreamParser {
  return {
    push(line) {
      const at = line.indexOf(JEST_MARK);
      if (at < 0) return [];
      try {
        const entry = parseJson(line.slice(at + JEST_MARK.length));
        return parseJestLikeReport(JSON.stringify({ testResults: [entry] }));
      } catch {
        return [];
      }
    },
    finish: () => [],
    display: (line) => (line.includes(JEST_MARK) ? null : line),
  };
}

export const jestAdapter: TestAdapter = {
  framework: 'jest',
  plan(project, target, ctx) {
    const { command, prefix } = nodeRunner(project, 'jest', ctx);
    const report = reportPath(ctx, 'jest.json');
    const reporter = reportPath(ctx, 'runova-jest-reporter.cjs');
    const { files, names } = selectionArgs(project, target);
    return {
      command,
      args: [
        ...prefix,
        '--watchAll=false',
        '--reporters=default',
        `--reporters=${reporter}`,
        '--json',
        `--outputFile=${report}`,
        '--testLocationInResults',
        ...(files.length > 0 ? ['--runTestsByPath', ...files] : []),
        ...(names.length > 0 ? ['-t', exactNames(names)] : []),
      ],
      cwd: project.root,
      reportFiles: [report],
      files: [{ path: reporter, content: JEST_REPORTER }],
    };
  },
  parseReport: parseJestLikeReport,
  stream: () => jestStream(),
};

/**
 * The JSON report only exists once the run ends, so every test would sit at "running" until then.
 * The verbose reporter prints one line per finished test ("✓ src/a.test.ts > suite > test 2ms"),
 * which lets each result land as it happens. The report still arrives last and fills in messages.
 */
const VITEST_LINE =
  /^\s*([✓✔×✗✘↓⤳])\s+(?:\|[^|]*\|\s+)?(\S+?\.[cm]?[jt]sx?) > (.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/;

function vitestStream(): StreamParser {
  return {
    push(line) {
      const match = VITEST_LINE.exec(stripAnsi(line));
      if (!match) return [];
      const [, mark, file, names] = match;
      const status =
        mark === '✓' || mark === '✔'
          ? 'passed'
          : mark === '↓' || mark === '⤳'
            ? 'skipped'
            : 'failed';
      return [{ file, path: names.split(' > '), status }];
    },
    finish: () => [],
  };
}

/** Vitest's JSON reporter writes the same shape Jest does. */
function parseJestLikeReport(text: string): ParsedTestResult[] {
  const report = asRecord(parseJson(text));
  const out: ParsedTestResult[] = [];
  for (const fileResult of asArray(report.testResults).map(asRecord)) {
    const file = asString(fileResult.name);
    const assertions = asArray(fileResult.assertionResults).map(asRecord);
    if (assertions.length === 0) {
      const message = cleanText(asString(fileResult.message));
      if (asString(fileResult.status) === 'failed' && message) {
        out.push(compact({ file, path: [], status: 'failed', message }));
      }
      continue;
    }
    for (const assertion of assertions) {
      const title = asString(assertion.title) ?? '';
      const ancestors = asArray(assertion.ancestorTitles).filter(
        (entry): entry is string => typeof entry === 'string',
      );
      const failure = asArray(assertion.failureMessages).find(
        (entry) => typeof entry === 'string',
      ) as string | undefined;
      out.push(
        compact({
          file,
          path: [...ancestors, title],
          status: jsStatus(asString(assertion.status)),
          durationMs: asNumber(assertion.duration),
          line: asNumber(asRecord(assertion.location).line),
          ...splitStack(failure),
        }),
      );
    }
  }
  return out;
}

function jsStatus(status: string | undefined): ParsedTestResult['status'] {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

const PLAYWRIGHT_MARK = '@@runova-playwright ';

/**
 * Playwright writes its JSON report only once the whole run is over, and a suite that drives a real
 * app can take many minutes. This reporter prints a line for every test the moment it ends, so the
 * panel can tick results off as they come in.
 */
const PLAYWRIGHT_REPORTER = `class RunovaReporter {
  onTestEnd(test, result) {
    try {
      const error = result.error || {};
      const entry = {
        file: test.location && test.location.file,
        line: test.location && test.location.line,
        // titlePath() is ['', project, file, ...titles].
        path: test.titlePath().slice(3),
        status: result.status,
        expected: test.expectedStatus,
        duration: result.duration,
        message: error.message || '',
        stack: error.stack || '',
      };
      process.stdout.write(${JSON.stringify(PLAYWRIGHT_MARK)} + JSON.stringify(entry) + '\\n');
    } catch {}
  }
}
module.exports = RunovaReporter;
`;

function playwrightStream(): StreamParser {
  return {
    push(line) {
      const at = line.indexOf(PLAYWRIGHT_MARK);
      if (at < 0) return [];
      const entry = asRecord(parseJson(line.slice(at + PLAYWRIGHT_MARK.length)));
      const path = asArray(entry.path).filter(
        (title): title is string => typeof title === 'string',
      );
      if (path.length === 0) return [];
      const status = asString(entry.status);
      return [
        compact({
          file: asString(entry.file),
          path,
          line: asNumber(entry.line),
          // A test marked `fail` is expected to fail, so only an unexpected outcome is a failure.
          status:
            status === 'skipped'
              ? ('skipped' as const)
              : status === asString(entry.expected)
                ? ('passed' as const)
                : ('failed' as const),
          durationMs: asNumber(entry.duration),
          message: cleanText(asString(entry.message)),
          stack: splitStack(asString(entry.stack)).stack,
        }),
      ];
    },
    finish: () => [],
    display: (line) => (line.includes(PLAYWRIGHT_MARK) ? null : line),
  };
}

export const playwrightAdapter: TestAdapter = {
  framework: 'playwright',
  plan(project, target, ctx) {
    const { command, prefix } = nodeRunner(project, 'playwright', ctx);
    const report = reportPath(ctx, 'playwright.json');
    const reporter = reportPath(ctx, 'runova-playwright-reporter.cjs');
    const config = project.meta?.config;
    const selection: string[] = [];
    const unlined: string[] = [];
    if (!target.all) {
      selection.push(...target.files.map((file) => fromProject(project, file)));
      for (const ref of target.tests) {
        const file = fromProject(project, ref.file);
        if (ref.line) selection.push(`${file}:${ref.line}`);
        else {
          selection.push(file);
          unlined.push(ref.path[ref.path.length - 1] ?? '');
        }
      }
    }
    return {
      command,
      args: [
        ...prefix,
        'test',
        `--reporter=list,json,${reporter}`,
        ...(config && !/^playwright\.config\.[cm]?[jt]s$/.test(config) ? ['--config', config] : []),
        ...unique(selection),
        ...(unlined.length > 0 && unlined.length === target.tests.length
          ? ['-g', `(?:${unique(unlined).map(escapeRegex).join('|')})$`]
          : []),
      ],
      cwd: project.root,
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report },
      reportFiles: [report],
      files: [{ path: reporter, content: PLAYWRIGHT_REPORTER }],
    };
  },
  stream: () => playwrightStream(),
  parseReport(text) {
    const report = asRecord(parseJson(text));
    const rootDir = asString(asRecord(report.config).rootDir);
    const out: ParsedTestResult[] = [];
    const walk = (suite: Record<string, unknown>, titles: string[]): void => {
      for (const spec of asArray(suite.specs).map(asRecord)) {
        const tests = asArray(spec.tests).map(asRecord);
        const statuses = tests.map((test) => asString(test.status));
        const failing = tests.find((test) => asString(test.status) === 'unexpected');
        const lastResult = (test: Record<string, unknown> | undefined) => {
          const results = asArray(test?.results).map(asRecord);
          return results[results.length - 1];
        };
        const error = asRecord(lastResult(failing)?.error);
        const specFile = asString(spec.file);
        out.push(
          compact({
            file:
              specFile && rootDir ? `${toPosix(rootDir).replace(/\/$/, '')}/${specFile}` : specFile,
            path: [...titles, asString(spec.title) ?? ''],
            line: asNumber(spec.line),
            status:
              failing !== undefined
                ? 'failed'
                : statuses.length > 0 && statuses.every((status) => status === 'skipped')
                  ? 'skipped'
                  : 'passed',
            durationMs: tests.reduce(
              (sum, test) => sum + (asNumber(lastResult(test)?.duration) ?? 0),
              0,
            ),
            message: cleanText(asString(error.message)),
            stack: splitStack(asString(error.stack)).stack,
          }),
        );
      }
      for (const child of asArray(suite.suites).map(asRecord)) {
        walk(child, [...titles, asString(child.title) ?? '']);
      }
    };
    // The top level suites are files; their titles are paths, not describe blocks.
    for (const fileSuite of asArray(report.suites).map(asRecord)) walk(fileSuite, []);
    return out;
  },
};

export const mochaAdapter: TestAdapter = {
  framework: 'mocha',
  plan(project, target, ctx) {
    const { command, prefix } = nodeRunner(project, 'mocha', ctx);
    const report = reportPath(ctx, 'mocha.json');
    const { files, names } = selectionArgs(project, target);
    return {
      command,
      args: [
        ...prefix,
        '--reporter',
        'json',
        '--reporter-option',
        `output=${report}`,
        ...files,
        ...(names.length > 0 ? ['--grep', exactNames(names)] : []),
      ],
      cwd: project.root,
      reportFiles: [report],
    };
  },
  parseReport(text) {
    const report = asRecord(parseJson(text));
    const key = (entry: Record<string, unknown>) =>
      `${asString(entry.file)}\u0000${asString(entry.fullTitle)}`;
    const pending = new Set(asArray(report.pending).map(asRecord).map(key));
    return asArray(report.tests)
      .map(asRecord)
      .map((test) => {
        const err = asRecord(test.err);
        const failed = typeof err.message === 'string' || typeof err.stack === 'string';
        return compact({
          file: asString(test.file),
          path: [asString(test.title) ?? ''],
          fullName: asString(test.fullTitle),
          status: failed ? 'failed' : pending.has(key(test)) ? 'skipped' : 'passed',
          durationMs: asNumber(test.duration),
          message: failed ? cleanText(asString(err.message)) : undefined,
          stack: failed ? splitStack(asString(err.stack)).stack : undefined,
        } satisfies ParsedTestResult);
      });
  },
};
