import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestResult, TestRunEvent, TestTarget } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverWorkspaceTests } from './discovery';
import { write } from './fakeRunners';
import { TestRunManager } from './runner';

/**
 * The Tests panel against the real toolchains, one tiny project each with a passing and a failing
 * test. Slow (compilers, package restores), so it only runs when asked:
 *
 *   RUNOVA_REAL_RUNNERS=1 pnpm --filter @runova/desktop exec vitest run realRunners
 *
 * A toolchain that is not installed is skipped rather than failed.
 */

const enabled = process.env.RUNOVA_REAL_RUNNERS === '1';

function installed(command: string, args: string[]): boolean {
  if (!enabled) return false;
  try {
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : command,
      process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args,
      {
        stdio: 'ignore',
        timeout: 60_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runova-real-runner-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

async function runAll(
  targets: TestTarget[] = [],
): Promise<{ results: TestResult[]; events: TestRunEvent[] }> {
  const events: TestRunEvent[] = [];
  const manager = new TestRunManager({
    emit: (event) => events.push(event),
    timeoutMs: 10 * 60_000,
  });
  const discovery = await discoverWorkspaceTests(root);
  manager.start({ projectId: 'real', folderPath: root, discovery, targets });
  await manager.whenIdle('real');
  const done = events[events.length - 1];
  if (done.type === 'done' && done.summary.errors.length > 0) {
    throw new Error(`run errors: ${JSON.stringify(done.summary.errors, null, 2)}`);
  }
  return { results: manager.lastRun('real')?.results ?? [], events };
}

const statusOf = (results: TestResult[]) =>
  Object.fromEntries(
    results
      .filter((result) => result.path.length > 0)
      .map((result) => [result.path.join(' > '), result.status]),
  );

describe.skipIf(!installed('python', ['-m', 'pytest', '--version']))('pytest', () => {
  it('runs a pytest project and a single test from it', async () => {
    await write(join(root, 'pytest.ini'), '[pytest]\n');
    await write(
      join(root, 'tests', 'test_math.py'),
      'def test_adds():\n    assert 1 + 1 == 2\n\n\nclass TestBroken:\n    def test_fails(self):\n        assert 1 == 2\n',
    );
    const { results } = await runAll();
    expect(statusOf(results)).toEqual({ test_adds: 'passed', 'TestBroken > test_fails': 'failed' });
    const failure = results.find((result) => result.status === 'failed');
    expect(failure).toMatchObject({ file: 'tests/test_math.py', line: 6 });
    expect(failure?.message).toMatch(/assert 1 == 2/);

    const single = await runAll([
      { testProjectId: 'pytest:', tests: [{ file: 'tests/test_math.py', path: ['test_adds'] }] },
    ]);
    expect(statusOf(single.results)).toEqual({ test_adds: 'passed' });
  }, 120_000);
});

describe.skipIf(!installed('python', ['--version']))('unittest', () => {
  it('runs unittest verbosely and attaches tracebacks', async () => {
    await write(join(root, 'tests', '__init__.py'), '');
    await write(
      join(root, 'tests', 'test_math.py'),
      'import unittest\n\n\nclass MathCase(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(2, 1 + 1)\n\n    def test_fails(self):\n        self.assertEqual(1, 2)\n',
    );
    const { results } = await runAll();
    expect(statusOf(results)).toEqual({
      'MathCase > test_adds': 'passed',
      'MathCase > test_fails': 'failed',
    });
    expect(results.find((result) => result.status === 'failed')?.message).toBe(
      'AssertionError: 1 != 2',
    );
  }, 120_000);
});

describe.skipIf(!installed('go', ['version']))('go', () => {
  it('runs go test with JSON events, subtests included', async () => {
    await write(join(root, 'go.mod'), 'module example.com/real\n\ngo 1.21\n');
    await write(
      join(root, 'calc', 'calc_test.go'),
      [
        'package calc',
        '',
        'import "testing"',
        '',
        'func TestAdd(t *testing.T) {',
        '\tt.Run("zero", func(t *testing.T) {})',
        '}',
        '',
        'func TestFails(t *testing.T) {',
        '\tt.Errorf("want %d", 3)',
        '}',
        '',
      ].join('\n'),
    );
    const { results } = await runAll();
    expect(statusOf(results)).toEqual({
      TestAdd: 'passed',
      'TestAdd > zero': 'passed',
      TestFails: 'failed',
    });
    expect(results.find((result) => result.status === 'failed')?.message).toContain('want 3');
  }, 300_000);
});

describe.skipIf(!installed('dotnet', ['--version']))('dotnet', () => {
  it('runs an xUnit project through the TRX logger', async () => {
    await write(
      join(root, 'Real.Tests', 'Real.Tests.csproj'),
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>',
        '  <ItemGroup>',
        '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
        '    <PackageReference Include="xunit" Version="2.9.3" />',
        '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    await write(
      join(root, 'Real.Tests', 'MathTests.cs'),
      [
        'using Xunit;',
        '',
        'namespace Real.Tests;',
        '',
        'public class MathTests',
        '{',
        '    [Fact]',
        '    public void Adds() => Assert.Equal(2, 1 + 1);',
        '',
        '    [Fact]',
        '    public void Fails() => Assert.Equal(3, 1 + 1);',
        '}',
      ].join('\n'),
    );
    const { results } = await runAll();
    expect(statusOf(results)).toEqual({
      'MathTests > Adds': 'passed',
      'MathTests > Fails': 'failed',
    });
  }, 600_000);
});

describe.skipIf(!installed('dart', ['--version']))('dart', () => {
  it('runs dart test with the JSON reporter', async () => {
    await write(
      join(root, 'pubspec.yaml'),
      'name: real\nenvironment:\n  sdk: ^3.0.0\ndev_dependencies:\n  test: ^1.25.0\n',
    );
    await write(
      join(root, 'test', 'math_test.dart'),
      "import 'package:test/test.dart';\n\nvoid main() {\n  group('math', () {\n    test('adds', () => expect(1 + 1, 2));\n    test('fails', () => expect(1, 2));\n  });\n}\n",
    );
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'dart',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'dart', 'pub', 'get'] : ['pub', 'get'],
      {
        cwd: root,
        stdio: 'ignore',
      },
    );
    const { results } = await runAll();
    expect(statusOf(results)).toEqual({ 'math > adds': 'passed', 'math > fails': 'failed' });
  }, 300_000);
});

describe.skipIf(!installed('flutter', ['--version']))('flutter', () => {
  it('runs flutter test --machine', async () => {
    await write(
      join(root, 'pubspec.yaml'),
      'name: real_flutter\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
    );
    await write(
      join(root, 'test', 'widget_test.dart'),
      "import 'package:flutter_test/flutter_test.dart';\n\nvoid main() {\n  test('adds', () => expect(1 + 1, 2));\n  test('fails', () => expect(1, 2));\n}\n",
    );
    const { results } = await runAll();
    expect(statusOf(results)).toEqual({ adds: 'passed', fails: 'failed' });
  }, 600_000);
});
