import { describe, expect, it } from 'vitest';
import type { TestFrameworkId, TestProject, TestRef } from '../types.js';
import { formatCommand, getTestAdapter, planTestRun, readableCommand } from './index.js';
import type { ResolvedTarget, RunContext } from './types.js';

const win = (exists: string[] = []): RunContext => ({
  platform: 'win32',
  folderPath: 'C:\\work\\app',
  reportDir: 'C:\\tmp\\run1',
  exists: (path) => exists.includes(path),
});

const posix = (exists: string[] = []): RunContext => ({
  platform: 'linux',
  folderPath: '/work/app',
  reportDir: '/tmp/run1',
  exists: (path) => exists.includes(path),
});

const project = (
  framework: TestFrameworkId,
  root = '',
  meta?: Record<string, string>,
): TestProject => ({
  id: `${framework}:${root}`,
  framework,
  root,
  label: framework,
  ...(meta ? { meta } : {}),
});

const all: ResolvedTarget = { all: true, files: [], tests: [], expanded: [] };
const files = (...list: string[]): ResolvedTarget => ({
  all: false,
  files: list,
  tests: [],
  expanded: [],
});
const tests = (...refs: TestRef[]): ResolvedTarget => ({
  all: false,
  files: [],
  tests: refs,
  expanded: refs,
});

describe('JavaScript runners', () => {
  it('runs Vitest through the nearest local bin on Windows with a JSON report', () => {
    const plan = planTestRun(
      project('vitest', 'packages/core'),
      all,
      win(['node_modules/.bin/vitest.cmd']),
    );
    expect(plan).toEqual({
      command: '..\\..\\node_modules\\.bin\\vitest.cmd',
      args: [
        'run',
        '--reporter=verbose',
        '--reporter=json',
        '--outputFile.json=C:\\tmp\\run1\\vitest.json',
      ],
      cwd: 'packages/core',
      reportFiles: ['C:\\tmp\\run1\\vitest.json'],
    });
  });

  it('prefers a bin inside the package over one further up', () => {
    const plan = planTestRun(
      project('vitest', 'packages/core'),
      all,
      posix(['node_modules/.bin/vitest', 'packages/core/node_modules/.bin/vitest']),
    );
    expect(plan.command).toBe('./node_modules/.bin/vitest');
  });

  it('falls back to the package manager from the lockfile', () => {
    const run = (exists: string[]) => {
      const plan = planTestRun(project('vitest', 'web'), all, posix(exists));
      return [plan.command, ...plan.args.slice(0, plan.args.indexOf('run') + 1)].join(' ');
    };
    expect(run(['pnpm-lock.yaml'])).toBe('pnpm exec vitest run');
    expect(run(['web/yarn.lock'])).toBe('yarn vitest run');
    expect(run(['bun.lock'])).toBe('bunx vitest run');
    expect(run([])).toBe('npx --no-install vitest run');
  });

  it('narrows Vitest to files and to exact test names', () => {
    const ctx = posix(['node_modules/.bin/vitest']);
    expect(
      planTestRun(project('vitest', 'pkg'), files('pkg/src/a.test.ts'), ctx).args.slice(4),
    ).toEqual(['src/a.test.ts']);
    const plan = planTestRun(
      project('vitest', 'pkg'),
      tests(
        { file: 'pkg/src/a.test.ts', path: ['math', 'adds (x+1)'] },
        { file: 'pkg/src/b.test.ts', path: ['top'] },
        { file: 'pkg/src/a.test.ts', path: ['math', 'subtracts'] },
      ),
      ctx,
    );
    expect(plan.args.slice(4)).toEqual([
      'src/a.test.ts',
      'src/b.test.ts',
      '-t',
      // Vitest 3 and later join suite and test with " > ", older versions with a space.
      '^(?:math(?: | > )adds \\(x\\+1\\)|top|math(?: | > )subtracts)$',
    ]);
  });

  it('runs Jest with a JSON report and test locations', () => {
    const plan = planTestRun(
      project('jest'),
      tests({ file: 'src/a.test.js', path: ['a', 'b'] }),
      posix(['node_modules/.bin/jest']),
    );
    expect(plan).toEqual({
      files: [
        {
          path: '/tmp/run1/runova-jest-reporter.cjs',
          content: expect.stringContaining('onTestResult'),
        },
      ],
      command: './node_modules/.bin/jest',
      args: [
        '--watchAll=false',
        '--reporters=default',
        '--reporters=/tmp/run1/runova-jest-reporter.cjs',
        '--json',
        '--outputFile=/tmp/run1/jest.json',
        '--testLocationInResults',
        '--runTestsByPath',
        'src/a.test.js',
        '-t',
        '^(?:a b)$',
      ],
      cwd: '',
      reportFiles: ['/tmp/run1/jest.json'],
    });
  });

  it('runs Playwright with its config and file:line selections', () => {
    const plan = planTestRun(
      project('playwright', 'apps/desktop', { config: 'e2e/playwright.config.ts', testDir: 'e2e' }),
      tests(
        { file: 'apps/desktop/e2e/launch.e2e.ts', path: ['starts'], line: 26 },
        { file: 'apps/desktop/e2e/other.e2e.ts', path: ['no line'] },
      ),
      win(['apps/desktop/node_modules/.bin/playwright.cmd']),
    );
    expect(plan).toEqual({
      command: 'node_modules\\.bin\\playwright.cmd',
      args: [
        'test',
        '--reporter=list,json,C:\\tmp\\run1\\runova-playwright-reporter.cjs',
        '--config',
        'e2e/playwright.config.ts',
        'e2e/launch.e2e.ts:26',
        'e2e/other.e2e.ts',
      ],
      cwd: 'apps/desktop',
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: 'C:\\tmp\\run1\\playwright.json' },
      reportFiles: ['C:\\tmp\\run1\\playwright.json'],
      files: [
        {
          path: 'C:\\tmp\\run1\\runova-playwright-reporter.cjs',
          content: expect.stringContaining('onTestEnd'),
        },
      ],
    });
  });

  it('greps Playwright titles only when no selected test has a line to go by', () => {
    const plan = planTestRun(
      project('playwright'),
      tests({ file: 'tests/a.spec.ts', path: ['flow', 'logs in'] }),
      posix(['node_modules/.bin/playwright']),
    );
    expect(plan.args).toEqual([
      'test',
      '--reporter=list,json,/tmp/run1/runova-playwright-reporter.cjs',
      'tests/a.spec.ts',
      '-g',
      '(?:logs in)$',
    ]);
  });

  it('runs Mocha with the JSON reporter writing to a file', () => {
    const plan = planTestRun(
      project('mocha'),
      tests({ file: 'test/a.spec.js', path: ['suite', 'case'] }),
      posix(['node_modules/.bin/mocha']),
    );
    expect(plan.args).toEqual([
      '--reporter',
      'json',
      '--reporter-option',
      'output=/tmp/run1/mocha.json',
      'test/a.spec.js',
      '--grep',
      '^(?:suite case)$',
    ]);
  });
});

describe('Python runners', () => {
  it('runs pytest from the project virtualenv with node ids', () => {
    const plan = planTestRun(
      project('pytest', 'api'),
      tests(
        {
          file: 'api/tests/test_a.py',
          path: ['TestA', 'test_one'],
          selector: 'tests/test_a.py::TestA::test_one',
        },
        { file: 'api/tests/test_b.py', path: ['test_param', '[2]'] },
      ),
      win(['api/.venv/Scripts/python.exe']),
    );
    expect(plan).toEqual({
      command: '.venv\\Scripts\\python.exe',
      args: [
        '-m',
        'pytest',
        '--junitxml=C:\\tmp\\run1\\pytest.xml',
        '-o',
        'junit_family=xunit1',
        'tests/test_a.py::TestA::test_one',
        'tests/test_b.py::test_param[2]',
      ],
      cwd: 'api',
      reportFiles: ['C:\\tmp\\run1\\pytest.xml'],
    });
  });

  it('uses python3 on POSIX when there is no virtualenv, and a venv further up when there is', () => {
    expect(planTestRun(project('pytest'), all, posix()).command).toBe('python3');
    expect(planTestRun(project('pytest', 'svc'), all, posix(['venv/bin/python'])).command).toBe(
      '../venv/bin/python',
    );
    expect(planTestRun(project('pytest'), all, win()).command).toBe('python');
  });

  it('runs unittest verbosely with dotted names', () => {
    expect(planTestRun(project('unittest'), files('tests/test_api.py'), posix()).args).toEqual([
      '-m',
      'unittest',
      '-v',
      'tests.test_api',
    ]);
    expect(
      planTestRun(
        project('unittest'),
        tests({
          file: 'tests/test_api.py',
          path: ['ApiTest', 'test_get'],
          selector: 'tests.test_api.ApiTest.test_get',
        }),
        posix(),
      ).args,
    ).toEqual(['-m', 'unittest', '-v', 'tests.test_api.ApiTest.test_get']);
  });
});

describe('compiled language runners', () => {
  it('runs go test with JSON events, packages and an exact -run pattern', () => {
    expect(planTestRun(project('go', 'svc'), all, posix())).toEqual({
      command: 'go',
      args: ['test', '-json', './...'],
      cwd: 'svc',
    });
    expect(
      planTestRun(
        project('go', 'svc'),
        tests(
          { file: 'svc/calc/calc_test.go', path: ['TestAdd'] },
          { file: 'svc/calc/calc_test.go', path: ['TestSub', 'zero'] },
          { file: 'svc/main_test.go', path: ['TestMain2'] },
        ),
        posix(),
      ).args,
    ).toEqual(['test', '-json', '-run', '^(?:TestAdd|TestSub|TestMain2)$', './calc', '.']);
    expect(planTestRun(project('go'), files('pkg/a/a_test.go'), posix()).args).toEqual([
      'test',
      '-json',
      './pkg/a',
    ]);
  });

  it('runs cargo test without stopping at the first failing crate', () => {
    expect(planTestRun(project('cargo', 'crates/p'), all, posix()).args).toEqual([
      'test',
      '--no-fail-fast',
    ]);
    expect(
      planTestRun(
        project('cargo', 'crates/p'),
        tests({ file: 'crates/p/src/lib.rs', path: ['tests', 'adds'], selector: 'tests::adds' }),
        posix(),
      ).args,
    ).toEqual(['test', '--no-fail-fast', '--', '--exact', 'tests::adds']);
    expect(planTestRun(project('cargo'), files('tests/api.rs'), posix()).args).toEqual([
      'test',
      '--no-fail-fast',
      '--test',
      'api',
    ]);
  });

  it('runs dotnet test with a TRX logger and a name filter', () => {
    const plan = planTestRun(
      project('dotnet', 'tests/App.Tests'),
      tests(
        {
          file: 'tests/App.Tests/CartTests.cs',
          path: ['CartTests', 'Adds'],
          selector: 'Shop.CartTests.Adds',
        },
        { file: 'tests/App.Tests/CartTests.cs', path: ['CartTests', 'Small', '(n: 5)'] },
      ),
      win(),
    );
    expect(plan).toEqual({
      command: 'dotnet',
      args: [
        'test',
        '--logger',
        'trx',
        '--results-directory',
        'C:\\tmp\\run1',
        '--filter',
        'FullyQualifiedName=Shop.CartTests.Adds|FullyQualifiedName~.CartTests.Small',
      ],
      cwd: 'tests/App.Tests',
      reportSearch: [{ root: 'C:\\tmp\\run1', glob: '*.trx', freshOnly: false }],
    });
  });

  it('runs Dart and Flutter with their JSON protocols', () => {
    expect(
      planTestRun(
        project('dart'),
        tests({ file: 'test/a_test.dart', path: ['group', 'works'] }),
        posix(),
      ),
    ).toEqual({
      command: 'dart',
      args: ['test', '--reporter', 'json', 'test/a_test.dart', '--name', '^(?:group works)$'],
      cwd: '',
    });
    expect(
      planTestRun(project('flutter', 'mobile'), files('mobile/test/w_test.dart'), win()).args,
    ).toEqual(['test', '--machine', 'test/w_test.dart']);
  });

  it('runs PHPUnit, RSpec, Gradle and Maven', () => {
    expect(
      planTestRun(
        project('phpunit'),
        tests({
          file: 'tests/UserTest.php',
          path: ['UserTest', 'testCreates'],
          selector: 'App\\UserTest::testCreates',
        }),
        posix(['vendor/bin/phpunit']),
      ),
    ).toEqual({
      command: './vendor/bin/phpunit',
      args: [
        '--log-junit',
        '/tmp/run1/phpunit.xml',
        '--filter',
        '/(?:UserTest::testCreates)(?:\\s|$)/',
      ],
      cwd: '',
      reportFiles: ['/tmp/run1/phpunit.xml'],
    });

    expect(
      planTestRun(
        project('rspec', 'api'),
        tests({ file: 'api/spec/user_spec.rb', path: ['User', 'works'], line: 5 }),
        posix(['api/Gemfile']),
      ),
    ).toEqual({
      command: 'bundle',
      args: [
        'exec',
        'rspec',
        '--format',
        'progress',
        '--format',
        'json',
        '--out',
        '/tmp/run1/rspec.json',
        'spec/user_spec.rb:5',
      ],
      cwd: 'api',
      reportFiles: ['/tmp/run1/rspec.json'],
    });

    expect(
      planTestRun(
        project('gradle', '', { wrapper: 'true' }),
        tests({
          file: 'src/test/java/a/CartTest.java',
          path: ['CartTest', 'adds'],
          selector: 'a.CartTest.adds',
        }),
        win(),
      ),
    ).toEqual({
      command: 'gradlew.bat',
      args: ['cleanTest', 'test', '--continue', '--tests', 'a.CartTest.adds'],
      cwd: '',
      reportSearch: [{ root: '', glob: '**/build/test-results/test/*.xml', freshOnly: true }],
    });
    expect(planTestRun(project('gradle'), all, posix()).command).toBe('gradle');

    expect(
      planTestRun(
        project('maven'),
        tests(
          {
            file: 'src/test/java/a/CartTest.java',
            path: ['CartTest', 'adds'],
            selector: 'a.CartTest.adds',
          },
          {
            file: 'src/test/java/a/CartTest.java',
            path: ['CartTest', 'totals'],
            selector: 'a.CartTest.totals',
          },
        ),
        posix(['mvnw']),
      ),
    ).toEqual({
      command: './mvnw',
      args: ['test', '-Dtest=CartTest#adds+totals', '-Dsurefire.failIfNoSpecifiedTests=false'],
      cwd: '',
      reportSearch: [{ root: '', glob: '**/target/surefire-reports/TEST-*.xml', freshOnly: true }],
    });
  });
});

describe('formatCommand', () => {
  it('quotes arguments with spaces or shell characters for display', () => {
    expect(formatCommand({ command: 'go', args: ['test', '-run', '^(?:A|B)$', './my pkg'] })).toBe(
      "go test -run '^(?:A|B)$' './my pkg'",
    );
  });
});

describe('getTestAdapter', () => {
  it('has an adapter for every framework', () => {
    const ids: TestFrameworkId[] = [
      'vitest',
      'jest',
      'playwright',
      'mocha',
      'pytest',
      'unittest',
      'go',
      'cargo',
      'dotnet',
      'dart',
      'flutter',
      'phpunit',
      'rspec',
      'gradle',
      'maven',
    ];
    for (const id of ids) expect(getTestAdapter(id).framework).toBe(id);
  });
});

describe('readableCommand', () => {
  const human = (
    framework: TestFrameworkId,
    target: ResolvedTarget,
    ctx: RunContext,
    meta?: Record<string, string>,
  ) => readableCommand(planTestRun(project(framework, '', meta), target, ctx), ctx.reportDir);

  it('leaves out the reporter flags and report paths the panel adds for itself', () => {
    const one = tests({ file: 'src/a.test.ts', path: ['math', 'adds'] });
    expect(human('vitest', one, win(['node_modules/.bin/vitest.cmd']))).toBe(
      "node_modules\\.bin\\vitest.cmd run src/a.test.ts -t '^(?:math(?: | > )adds)$'",
    );
    expect(human('jest', one, posix(['node_modules/.bin/jest']))).toBe(
      "./node_modules/.bin/jest --watchAll=false --runTestsByPath src/a.test.ts -t '^(?:math adds)$'",
    );
    expect(human('playwright', all, posix(['node_modules/.bin/playwright']))).toBe(
      './node_modules/.bin/playwright test',
    );
    expect(human('mocha', all, posix(['node_modules/.bin/mocha']))).toBe(
      './node_modules/.bin/mocha',
    );
    expect(human('pytest', files('tests/test_a.py'), posix())).toBe(
      'python3 -m pytest tests/test_a.py',
    );
    expect(human('go', all, posix())).toBe('go test ./...');
    expect(human('dotnet', all, win())).toBe('dotnet test');
    expect(human('dart', all, posix())).toBe('dart test');
    expect(human('flutter', all, posix())).toBe('flutter test');
    expect(human('phpunit', all, posix())).toBe('phpunit');
    expect(human('rspec', all, posix())).toBe('rspec --format progress');
  });
});
