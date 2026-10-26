import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParsedTestResult, TestFrameworkId, TestProject } from '../types.js';
import { createStreamParser, parseTestReport } from './index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf-8');

const project = (framework: TestFrameworkId, meta?: Record<string, string>): TestProject => ({
  id: `${framework}:`,
  framework,
  root: '',
  label: framework,
  ...(meta ? { meta } : {}),
});

/** Feeds output line by line and keeps the last result reported for each test. */
function stream(framework: TestFrameworkId, text: string, meta?: Record<string, string>) {
  const parser = createStreamParser(project(framework, meta));
  if (!parser) throw new Error(`${framework} has no stream parser`);
  const seen = new Map<string, ParsedTestResult>();
  const keep = (results: ParsedTestResult[]) => {
    for (const result of results)
      seen.set(`${result.file ?? result.dir}|${result.path.join('>')}`, result);
  };
  for (const line of text.split(/\r?\n/)) keep(parser.push(line));
  keep(parser.finish());
  return { results: [...seen.values()], parser };
}

const brief = (results: ParsedTestResult[]) =>
  results.map((result) => `${result.status} ${result.path.join(' > ')}`);

describe('Vitest and Jest reports', () => {
  it('reads the Vitest JSON report', () => {
    const results = parseTestReport('vitest', fixture('vitest.json'));
    expect(brief(results)).toEqual([
      'passed math > adds',
      'failed math > nested > fails on purpose',
      'skipped math > skipped one',
      'passed top level',
    ]);
    expect(results[1]).toMatchObject({
      file: 'C:/work/js/src/math.test.js',
      message: 'AssertionError: expected { a: 1 } to deeply equal { a: 2 }',
    });
    expect(results[1].stack).toMatch(/^ {4}at C:\/work\/js\/src\/math\.test\.js:10:24/);
    expect(results[0].durationMs).toBeCloseTo(1.32, 1);
  });

  it('reads the Jest JSON report with locations', () => {
    const results = parseTestReport('jest', fixture('jest.json'));
    expect(brief(results)).toEqual([
      'passed math > adds',
      'failed math > nested > fails on purpose',
      'skipped math > skipped one',
      'passed top level',
    ]);
    expect(results[0]).toMatchObject({ line: 2, file: expect.stringMatching(/math\.test\.cjs$/) });
    expect(results[1].message).toBe(
      'Error: expect(received).toEqual(expected) // deep equality\n\n- Expected  - 1\n+ Received  + 1\n\n  Object {\n-   "a": 2,\n+   "a": 1,\n  }',
    );
  });

  it('turns a suite that failed to load into a file level failure', () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: '/w/src/broken.test.ts',
          status: 'failed',
          message: 'SyntaxError: Unexpected token (3:4)',
          assertionResults: [],
        },
      ],
    });
    expect(parseTestReport('vitest', report)).toEqual([
      {
        file: '/w/src/broken.test.ts',
        path: [],
        status: 'failed',
        message: 'SyntaxError: Unexpected token (3:4)',
      },
    ]);
  });

  it('returns nothing for an empty or broken report', () => {
    expect(parseTestReport('vitest', '')).toEqual([]);
    expect(parseTestReport('jest', '{"testResults":')).toEqual([]);
  });
});

describe('Playwright and Mocha reports', () => {
  it('reads Playwright suites relative to the test folder and strips color codes', () => {
    const results = parseTestReport('playwright', fixture('playwright.json'));
    expect(brief(results)).toEqual([
      'passed flow > passes',
      'failed flow > fails on purpose',
      'skipped flow > skipped one',
    ]);
    expect(results[1]).toMatchObject({
      file: 'C:/work/js/e2e/flow.spec.js',
      line: 4,
      message:
        'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "b"\nReceived: "a"',
    });
  });

  it('reads Mocha JSON with full titles', () => {
    const results = parseTestReport('mocha', fixture('mocha.json'));
    expect(results.map((result) => `${result.status} ${result.fullName}`)).toEqual([
      'passed top level',
      'passed math adds',
      'skipped math skipped one',
      'failed math nested fails on purpose',
    ]);
    expect(results[3]).toMatchObject({
      path: ['fails on purpose'],
      message: expect.stringMatching(/^Expected values to be strictly deep-equal:/),
    });
  });
});

describe('Python output', () => {
  it('reads pytest JUnit XML with files, lines and parameter variants', () => {
    const results = parseTestReport('pytest', fixture('pytest-junit.xml'));
    expect(brief(results)).toEqual([
      'passed test_adds',
      'failed TestNested > test_fails_on_purpose',
      'skipped TestNested > test_skipped',
      'passed test_param > [1]',
      'failed test_param > [2]',
    ]);
    expect(results[1]).toMatchObject({ file: 'tests\\test_math.py', line: 9 });
    expect(results[1].message).toMatch(/^AssertionError: assert \{'a': 1\} == \{'a': 2\}/);
    expect(results[1].stack).toContain('tests\\test_math.py:10: AssertionError');
    expect(results[2].message).toBe('later');
    expect(results[4].message).toBe('assert 2 < 2');
  });

  it('streams unittest verbose output and attaches tracebacks', () => {
    const { results } = stream('unittest', fixture('unittest.txt'));
    expect(brief(results)).toEqual([
      'passed MathCase > test_adds',
      'failed MathCase > test_errors',
      'failed MathCase > test_fails',
      'skipped MathCase > test_skipped',
    ]);
    expect(results[1]).toMatchObject({
      file: 'tests/test_unit.py',
      selector: 'tests.test_unit.MathCase.test_errors',
      message: 'RuntimeError: boom',
    });
    expect(results[1].stack).toContain('raise RuntimeError("boom")');
    expect(results[2].message).toBe('AssertionError: 1 != 2');
  });

  it('reads the older unittest line shape without the method in parentheses', () => {
    const { results } = stream('unittest', 'test_adds (tests.test_unit.MathCase) ... ok\n');
    expect(results).toEqual([
      {
        file: 'tests/test_unit.py',
        path: ['MathCase', 'test_adds'],
        selector: 'tests.test_unit.MathCase.test_adds',
        status: 'passed',
      },
    ]);
  });
});

describe('Go events', () => {
  it('streams results per package folder with the test output as the message', () => {
    const { results, parser } = stream('go', fixture('go-test.jsonl'), {
      module: 'example.com/fx',
    });
    expect(brief(results)).toEqual([
      'passed TestAdd',
      'failed TestFails',
      'passed TestSub > zero',
      'failed TestSub > broken_case',
      'failed TestSub',
      'skipped TestSkipped',
    ]);
    expect(results[1]).toMatchObject({
      dir: 'calc',
      message: 'calc_test.go:12: expected 3, got 2',
    });
    expect(results[3].message).toBe('calc_test.go:17: sub failed');
    expect(results[5].message).toBe('calc_test.go:21: later');
    expect(parser.display?.(fixture('go-test.jsonl').split('\n')[3])).toBe(
      '--- PASS: TestAdd (0.00s)',
    );
  });

  it('reports a package that failed to build against its folder', () => {
    const { results } = stream('go', fixture('go-build-fail.jsonl'), { module: 'example.com/fx' });
    expect(results).toEqual([
      {
        dir: 'broken',
        path: [],
        status: 'failed',
        message:
          '# example.com/fx/broken [example.com/fx/broken.test]\nbroken\\broken_test.go:5:28: undefined: undefinedThing',
      },
    ]);
  });
});

describe('Cargo output', () => {
  const output = [
    '   Compiling fx v0.1.0 (/work/fx)',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.50s',
    '     Running unittests src/lib.rs (target/debug/deps/fx-1234)',
    '',
    'running 3 tests',
    'test tests::adds ... ok',
    'test tests::fails ... FAILED',
    'test tests::later ... ignored, not ready',
    '',
    'failures:',
    '',
    '---- tests::fails stdout ----',
    '',
    "thread 'tests::fails' panicked at src/lib.rs:12:9:",
    'assertion `left == right` failed',
    '  left: 2',
    ' right: 3',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    '',
    '',
    'failures:',
    '    tests::fails',
    '',
    'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
    '     Running tests/api.rs (target/debug/deps/api-5678)',
    '',
    'running 1 test',
    'test works ... ok',
    '',
    '   Doc-tests fx',
    '',
    'running 1 test',
    'test src/lib.rs - add (line 3) ... ok',
  ].join('\n');

  it('streams libtest lines and attaches the panic message', () => {
    const { results } = stream('cargo', output);
    expect(brief(results)).toEqual([
      'passed tests > adds',
      'failed tests > fails',
      'skipped tests > later',
      'passed works',
    ]);
    expect(results[1]).toMatchObject({
      selector: 'tests::fails',
      message:
        "thread 'tests::fails' panicked at src/lib.rs:12:9:\nassertion `left == right` failed\n  left: 2\n right: 3",
    });
    expect(results[0].file).toBeUndefined();
    expect(results[3]).toMatchObject({ file: 'tests/api.rs', selector: 'works' });
  });
});

describe('.NET TRX', () => {
  it('reads outcomes, durations, messages and theory variants', () => {
    const results = parseTestReport('dotnet', fixture('dotnet.trx'));
    expect(brief(results)).toEqual([
      'passed MathTests > Adds',
      'failed MathTests > FailsOnPurpose',
      'failed MathTests > Small > (n: 5)',
      'skipped MathTests > Skipped',
      'passed MathTests > Small > (n: 1)',
    ]);
    expect(results[0]).toMatchObject({ selector: 'Fx.Tests.MathTests.Adds' });
    expect(results[0].durationMs).toBeCloseTo(88.8, 1);
    expect(results[1].message).toBe(
      'Assert.Equal() Failure: Values differ\nExpected: 3\nActual:   2',
    );
    expect(results[1].stack).toMatch(/^ {3}at Fx\.Tests\.MathTests\.FailsOnPurpose\(\)/);
    expect(results[2].selector).toBeUndefined();
    expect(results[3].message).toBe('later');
  });
});

describe('Dart and Flutter events', () => {
  it('streams the Dart JSON reporter with group paths', () => {
    const { results } = stream('dart', fixture('dart.jsonl'));
    expect(brief(results)).toEqual([
      'passed math > adds',
      'failed math > nested > fails on purpose',
      'skipped math > skipped one',
      'passed top level',
    ]);
    expect(results[1]).toMatchObject({
      file: 'test\\math_test.dart',
      line: 10,
      message:
        "Expected: {'a': 2}\n  Actual: {'a': 1}\n   Which: at location ['a'] is <1> instead of <2>",
    });
  });

  it('streams flutter --machine output and uses the root location for widget tests', () => {
    const { results } = stream('flutter', fixture('flutter.jsonl'));
    expect(brief(results)).toEqual([
      'passed counter > renders text',
      'failed counter > fails on purpose',
    ]);
    expect(results[0]).toMatchObject({ file: 'C:/work/flutter_fx/test/widget_test.dart', line: 6 });
    expect(results[1].message).toBe('Expected: <2>\n  Actual: <1>');
  });

  it('reports a file that failed to load', () => {
    const lines = [
      '{"suite":{"id":0,"platform":"vm","path":"test/bad_test.dart"},"type":"suite","time":0}',
      '{"test":{"id":1,"name":"loading test/bad_test.dart","suiteID":0,"groupIDs":[],"metadata":{"skip":false},"line":null,"url":null},"type":"testStart","time":1}',
      '{"testID":1,"error":"Failed to load \\"test/bad_test.dart\\": Error: Expected \';\' after this.","stackTrace":"","isFailure":false,"type":"error","time":2}',
      '{"testID":1,"result":"error","skipped":false,"hidden":true,"type":"testDone","time":3}',
    ].join('\n');
    expect(stream('dart', lines).results).toEqual([
      {
        file: 'test/bad_test.dart',
        path: [],
        status: 'failed',
        message: 'Failed to load "test/bad_test.dart": Error: Expected \';\' after this.',
      },
    ]);
  });
});

describe('PHPUnit, RSpec and JUnit XML', () => {
  it('reads PHPUnit JUnit logs with data sets', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="default" tests="4">
    <testsuite name="App\\Tests\\UserTest" file="/w/tests/UserTest.php" tests="4">
      <testcase name="testCreates" file="/w/tests/UserTest.php" line="6" class="App\\Tests\\UserTest" classname="App.Tests.UserTest" assertions="1" time="0.010"/>
      <testcase name="testFails" file="/w/tests/UserTest.php" line="9" class="App\\Tests\\UserTest" classname="App.Tests.UserTest" time="0.002">
        <failure type="PHPUnit\\Framework\\ExpectationFailedException">App\\Tests\\UserTest::testFails
Failed asserting that 1 matches expected 2.

/w/tests/UserTest.php:10</failure>
      </testcase>
      <testcase name="testLater" file="/w/tests/UserTest.php" line="13" class="App\\Tests\\UserTest" classname="App.Tests.UserTest" time="0"><skipped/></testcase>
      <testsuite name="App\\Tests\\UserTest::testData" tests="1">
        <testcase name="testData with data set #0" file="/w/tests/UserTest.php" line="16" class="App\\Tests\\UserTest" classname="App.Tests.UserTest" time="0.001"/>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`;
    const results = parseTestReport('phpunit', xml);
    expect(brief(results)).toEqual([
      'passed UserTest > testCreates',
      'failed UserTest > testFails',
      'skipped UserTest > testLater',
      'passed UserTest > testData > with data set #0',
    ]);
    expect(results[0]).toMatchObject({
      file: '/w/tests/UserTest.php',
      line: 6,
      selector: 'App\\Tests\\UserTest::testCreates',
      durationMs: 10,
    });
    expect(results[1].message).toBe('Failed asserting that 1 matches expected 2.');
    expect(results[1].stack).toBe('/w/tests/UserTest.php:10');
  });

  it('reads RSpec JSON', () => {
    const json = JSON.stringify({
      examples: [
        {
          id: './spec/user_spec.rb[1:1:1]',
          description: 'joins names',
          full_description: 'User #name joins names',
          status: 'passed',
          file_path: './spec/user_spec.rb',
          line_number: 5,
          run_time: 0.0012,
        },
        {
          id: './spec/user_spec.rb[1:1:2]',
          description: 'counts',
          full_description: 'User #name counts',
          status: 'failed',
          file_path: './spec/user_spec.rb',
          line_number: 9,
          run_time: 0.002,
          exception: {
            class: 'RSpec::Expectations::ExpectationNotMetError',
            message: '\nexpected: 2\n     got: 1\n\n(compared using ==)\n',
            backtrace: ["./spec/user_spec.rb:10:in `block (3 levels) in <top (required)>'"],
          },
        },
        {
          description: 'later',
          full_description: 'User later',
          status: 'pending',
          file_path: './spec/user_spec.rb',
          line_number: 13,
        },
      ],
    });
    const results = parseTestReport('rspec', json);
    expect(results).toEqual([
      {
        file: './spec/user_spec.rb',
        line: 5,
        path: ['joins names'],
        fullName: 'User #name joins names',
        status: 'passed',
        durationMs: 1.2,
      },
      {
        file: './spec/user_spec.rb',
        line: 9,
        path: ['counts'],
        fullName: 'User #name counts',
        status: 'failed',
        durationMs: 2,
        message: 'expected: 2\n     got: 1\n\n(compared using ==)',
        stack: "./spec/user_spec.rb:10:in `block (3 levels) in <top (required)>'",
      },
      {
        file: './spec/user_spec.rb',
        line: 13,
        path: ['later'],
        fullName: 'User later',
        status: 'skipped',
      },
    ]);
  });

  it('reads Gradle and Maven JUnit XML, including nested classes and parameterized runs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.CartTest" tests="4" skipped="1" failures="1" errors="0">
  <testcase name="addsItem()" classname="com.acme.CartTest" time="0.012"/>
  <testcase name="totals()" classname="com.acme.CartTest" time="0.002">
    <failure message="org.opentest4j.AssertionFailedError: expected: &lt;3&gt; but was: &lt;2&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;3&gt; but was: &lt;2&gt;
	at app//com.acme.CartTest.totals(CartTest.java:14)</failure>
  </testcase>
  <testcase name="later()" classname="com.acme.CartTest" time="0"><skipped/></testcase>
  <testcase name="sizes(int)[1]" classname="com.acme.CartTest" time="0.001"/>
  <testcase name="deep" classname="com.acme.CartTest$Inner" time="0.001"><error message="boom" type="java.lang.IllegalStateException">java.lang.IllegalStateException: boom</error></testcase>
</testsuite>`;
    for (const framework of ['gradle', 'maven'] as const) {
      const results = parseTestReport(framework, xml);
      expect(brief(results)).toEqual([
        'passed CartTest > addsItem',
        'failed CartTest > totals',
        'skipped CartTest > later',
        'passed CartTest > sizes > [1]',
        'failed CartTest > Inner > deep',
      ]);
      expect(results[0]).toMatchObject({ selector: 'com.acme.CartTest.addsItem', durationMs: 12 });
      expect(results[1].message).toBe(
        'org.opentest4j.AssertionFailedError: expected: <3> but was: <2>',
      );
      expect(results[3].selector).toBeUndefined();
      expect(results[4]).toMatchObject({
        selector: 'com.acme.CartTest$Inner.deep',
        message: 'boom',
      });
    }
  });
});

describe('vitest stream', () => {
  it('reports each test from the verbose reporter as it finishes', () => {
    const { results } = stream(
      'vitest',
      [
        ' RUN  v3.0.0 /repo',
        ' ✓ src/math.test.ts > math > adds 2ms',
        ' × src/math.test.ts > math > breaks 3ms',
        ' ↓ |unit| src/math.test.ts > math > later',
        ' Test Files  1 failed (1)',
      ].join('\n'),
    );
    expect(results.map((r) => [r.file, r.path.join(' > '), r.status])).toEqual([
      ['src/math.test.ts', 'math > adds', 'passed'],
      ['src/math.test.ts', 'math > breaks', 'failed'],
      ['src/math.test.ts', 'math > later', 'skipped'],
    ]);
  });
});

describe('jest stream', () => {
  it('reports a test file as soon as its results line arrives', () => {
    const entry = {
      name: '/repo/src/a.test.ts',
      assertionResults: [
        {
          title: 'adds',
          ancestorTitles: ['math'],
          status: 'passed',
          duration: 2,
          failureMessages: [],
        },
        { title: 'breaks', ancestorTitles: ['math'], status: 'failed', failureMessages: ['boom'] },
      ],
    };
    const { results, parser } = stream(
      'jest',
      `noise
@@runova-jest ${JSON.stringify(entry)}
more noise`,
    );
    expect(results.map((r) => [r.path.join(' > '), r.status])).toEqual([
      ['math > adds', 'passed'],
      ['math > breaks', 'failed'],
    ]);
    expect(parser.display?.('@@runova-jest {}')).toBeNull();
    expect(parser.display?.('PASS src/a.test.ts')).toBe('PASS src/a.test.ts');
  });
});

describe('playwright stream', () => {
  const line = (entry: Record<string, unknown>) => `@@runova-playwright ${JSON.stringify(entry)}`;

  it('reports each test as it ends, with its file, line and failure', () => {
    const { results } = stream(
      'playwright',
      [
        'Running 3 tests using 1 worker',
        line({
          file: 'E:\repo\apps\desktop\e2e\boot.e2e.ts',
          line: 12,
          path: ['boot', 'opens the window'],
          status: 'passed',
          expected: 'passed',
          duration: 1200,
        }),
        '  ok 1 e2e\boot.e2e.ts:12:3 › boot › opens the window (1.2s)',
        line({
          file: 'E:\repo\apps\desktop\e2e\boot.e2e.ts',
          line: 20,
          path: ['boot', 'reports no page error'],
          status: 'failed',
          expected: 'passed',
          duration: 900,
          message: 'Error: boom',
          stack: 'Error: boom\n    at boot.e2e.ts:20:5',
        }),
        line({
          file: 'E:\repo\apps\desktop\e2e\boot.e2e.ts',
          line: 30,
          path: ['boot', 'left out'],
          status: 'skipped',
          expected: 'skipped',
          duration: 0,
        }),
      ].join('\n'),
    );
    expect(results.map((result) => [result.path.join(' > '), result.status, result.line])).toEqual([
      ['boot > opens the window', 'passed', 12],
      ['boot > reports no page error', 'failed', 20],
      ['boot > left out', 'skipped', 30],
    ]);
    expect(results[0].file).toBe('E:\repo\apps\desktop\e2e\boot.e2e.ts');
    expect(results[1].message).toBe('Error: boom');
    expect(results[1].stack).toBe('    at boot.e2e.ts:20:5');
  });

  it('passes a test that was expected to fail, and hides its own lines from the output', () => {
    const { results, parser } = stream(
      'playwright',
      line({
        file: '/repo/e2e/a.e2e.ts',
        line: 3,
        path: ['known break'],
        status: 'failed',
        expected: 'failed',
        duration: 5,
      }),
    );
    expect(results.map((result) => result.status)).toEqual(['passed']);
    expect(parser.display?.('@@runova-playwright {}')).toBeNull();
    expect(parser.display?.('  ok 1 e2e/a.e2e.ts:3:1 › known break')).toBe(
      '  ok 1 e2e/a.e2e.ts:3:1 › known break',
    );
  });
});
