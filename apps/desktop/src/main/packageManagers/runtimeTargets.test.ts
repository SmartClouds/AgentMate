import { describe, expect, it } from 'vitest';
import {
  isNewer,
  lowerBound,
  parseDartConstraint,
  parsePackageManagerPin,
  parseSimpleRange,
  parseTargetFramework,
  readGlobalJsonSdk,
  readPubspecEnvironment,
  readTargetFramework,
  rewriteEngine,
  rewriteGlobalJsonSdk,
  rewritePackageManager,
  rewritePubspecEnvironment,
  rewriteTargetFramework,
  samePrecision,
} from './runtimeTargets';

/**
 * Every rewrite here edits one value in a file someone else wrote, so the tests check two things
 * each time: the value moved, and nothing else in the file did.
 */

describe('version precision', () => {
  it('cuts the latest version to the precision of the current one', () => {
    expect(samePrecision('24.11.1', '20')).toBe('24');
    expect(samePrecision('24.11.1', '20.1')).toBe('24.11');
    expect(samePrecision('24.11.1', '20.1.0')).toBe('24.11.1');
  });

  it('only calls a version newer when it is newer at that precision', () => {
    expect(isNewer('24.11.1', '20')).toBe(true);
    expect(isNewer('24.11.1', '24')).toBe(false);
    expect(isNewer('10.0', '8.0')).toBe(true);
    expect(isNewer('3.13.5', '3.13.5')).toBe(false);
    expect(isNewer('3.13.5', '3.14.0')).toBe(false);
  });
});

describe('package.json', () => {
  it('reads a packageManager pin, dropping the integrity hash', () => {
    expect(parsePackageManagerPin('bun@1.2.3')).toEqual({ kind: 'bun', version: '1.2.3' });
    expect(parsePackageManagerPin('pnpm@9.15.0+sha512.abc')).toEqual({
      kind: 'pnpm',
      version: '9.15.0',
    });
    expect(parsePackageManagerPin('yarn@4.5.0')).toEqual({ kind: 'yarn', version: '4.5.0' });
  });

  it('ignores a pin it does not know or that is not a string', () => {
    expect(parsePackageManagerPin('deno@2.0.0')).toBeNull();
    expect(parsePackageManagerPin('bun')).toBeNull();
    expect(parsePackageManagerPin(42)).toBeNull();
    expect(parsePackageManagerPin(undefined)).toBeNull();
  });

  it('reads the simple engines ranges and refuses the rest', () => {
    expect(parseSimpleRange('>=20')).toEqual({ operator: '>=', version: '20' });
    expect(parseSimpleRange('^22.1')).toEqual({ operator: '^', version: '22.1' });
    expect(parseSimpleRange('~1.1.0')).toEqual({ operator: '~', version: '1.1.0' });
    expect(parseSimpleRange('20.11.0')).toEqual({ operator: '', version: '20.11.0' });
    expect(parseSimpleRange('>=18 <22')).toBeNull();
    expect(parseSimpleRange('18 || 20')).toBeNull();
    expect(lowerBound('>=18 <22')).toBe('18');
    expect(lowerBound('latest')).toBeNull();
  });

  it('rewrites the packageManager value and keeps the rest of the file', () => {
    const source = '{\r\n  "name": "web",\r\n  "packageManager": "bun@1.1.0"\r\n}\r\n';
    expect(rewritePackageManager(source, 'bun@1.3.2')).toBe(
      '{\r\n  "name": "web",\r\n  "packageManager": "bun@1.3.2"\r\n}\r\n',
    );
    expect(rewritePackageManager('{ "name": "web" }', 'bun@1.3.2')).toBeNull();
  });

  it('rewrites one engine and leaves the other alone', () => {
    const source = '{\n  "engines": {\n    "node": ">=20",\n    "bun": ">=1.1"\n  }\n}\n';
    expect(rewriteEngine(source, 'bun', '>=1.3')).toBe(
      '{\n  "engines": {\n    "node": ">=20",\n    "bun": ">=1.3"\n  }\n}\n',
    );
    expect(rewriteEngine(source, 'node', '>=24')).toContain('"node": ">=24"');
    expect(rewriteEngine('{ "engines": { "node": "20" } }', 'bun', '1')).toBeNull();
  });

  it('does not touch a dependency that happens to be called node', () => {
    const source = '{ "dependencies": { "node": "20.0.0" }, "engines": { "node": "20" } }';
    expect(rewriteEngine(source, 'node', '24')).toBe(
      '{ "dependencies": { "node": "20.0.0" }, "engines": { "node": "24" } }',
    );
  });
});

describe('.NET target frameworks', () => {
  it('reads .NET target frameworks, with and without a platform', () => {
    expect(parseTargetFramework('net8.0')).toEqual({ version: '8.0', suffix: '' });
    expect(parseTargetFramework('net9.0-android')).toEqual({ version: '9.0', suffix: '-android' });
    expect(parseTargetFramework('net8.0-windows10.0.19041.0')).toEqual({
      version: '8.0',
      suffix: '-windows10.0.19041.0',
    });
    expect(parseTargetFramework('netcoreapp3.1')).toEqual({ version: '3.1', suffix: '' });
  });

  it('leaves .NET Framework and netstandard out', () => {
    expect(parseTargetFramework('net48')).toBeNull();
    expect(parseTargetFramework('net472')).toBeNull();
    expect(parseTargetFramework('netstandard2.0')).toBeNull();
  });

  it('reads a single target, or a list it will only report', () => {
    expect(readTargetFramework('<TargetFramework>net8.0</TargetFramework>')).toEqual({
      declared: 'net8.0',
      multiple: false,
    });
    expect(readTargetFramework('<TargetFrameworks>net8.0;net9.0</TargetFrameworks>')).toEqual({
      declared: 'net8.0;net9.0',
      multiple: true,
    });
    expect(readTargetFramework('<Project />')).toBeNull();
  });

  it('skips a target framework that is commented out', () => {
    const xml = [
      '<Project>',
      '  <!-- <TargetFramework>net6.0</TargetFramework> -->',
      '  <PropertyGroup>',
      '    <TargetFramework>net8.0</TargetFramework>',
      '  </PropertyGroup>',
      '</Project>',
    ].join('\r\n');
    expect(readTargetFramework(xml)?.declared).toBe('net8.0');
    const rewritten = rewriteTargetFramework(xml, 'net10.0');
    expect(rewritten).toBe(xml.replace('<TargetFramework>net8.0<', '<TargetFramework>net10.0<'));
    expect(rewritten).toContain('<!-- <TargetFramework>net6.0</TargetFramework> -->');
  });

  it('has nothing to rewrite in a multi-target list', () => {
    expect(
      rewriteTargetFramework('<TargetFrameworks>net8.0;net9.0</TargetFrameworks>', 'net10.0'),
    ).toBeNull();
  });

  it('reads and rewrites the global.json SDK pin in place', () => {
    const source =
      '{\n  "sdk": {\n    "version": "8.0.404",\n    "rollForward": "latestFeature"\n  }\n}\n';
    expect(readGlobalJsonSdk(source)).toBe('8.0.404');
    expect(rewriteGlobalJsonSdk(source, '10.0.100')).toBe(source.replace('8.0.404', '10.0.100'));
    expect(readGlobalJsonSdk('{ "msbuild-sdks": {} }')).toBeNull();
    expect(readGlobalJsonSdk('not json')).toBeNull();
    expect(rewriteGlobalJsonSdk('{ "msbuild-sdks": {} }', '10.0.100')).toBeNull();
  });
});

describe('pubspec environment', () => {
  const PUBSPEC = [
    'name: app',
    '# The SDK the app is built with',
    'environment:',
    '  sdk: ^3.11.5 # keep in step with CI',
    "  flutter: '>=3.38.0'",
    '',
    'dependencies:',
    '  sdk: ^9.9.9',
    '',
  ].join('\n');

  it('reads only the values under environment', () => {
    expect(readPubspecEnvironment(PUBSPEC)).toEqual({ sdk: '^3.11.5', flutter: "'>=3.38.0'" });
    expect(readPubspecEnvironment('name: app\n')).toEqual({});
  });

  it('rewrites one value and keeps its indent and comment', () => {
    expect(rewritePubspecEnvironment(PUBSPEC, 'sdk', '^3.13.5')).toBe(
      PUBSPEC.replace('sdk: ^3.11.5 #', 'sdk: ^3.13.5 #'),
    );
    expect(rewritePubspecEnvironment(PUBSPEC, 'flutter', "'>=3.47.7'")).toBe(
      PUBSPEC.replace("'>=3.38.0'", "'>=3.47.7'"),
    );
  });

  it('keeps Windows line endings', () => {
    const crlf = PUBSPEC.replace(/\n/g, '\r\n');
    expect(rewritePubspecEnvironment(crlf, 'sdk', '^3.13.5')).toBe(
      crlf.replace('^3.11.5', '^3.13.5'),
    );
  });

  it('returns null when environment has no such key', () => {
    expect(rewritePubspecEnvironment('environment:\n  sdk: ^3.0.0\n', 'flutter', '1')).toBeNull();
    expect(rewritePubspecEnvironment('name: app\n', 'sdk', '^3.0.0')).toBeNull();
  });

  it('moves each constraint form pub writes, keeping its quotes', () => {
    expect(parseDartConstraint('^3.11.5')?.next('3.13.5')).toBe('^3.13.5');
    expect(parseDartConstraint("'>=3.4.0 <4.0.0'")?.next('4.1.0')).toBe("'>=4.1.0 <5.0.0'");
    expect(parseDartConstraint('">=3.4.0"')?.next('3.13.5')).toBe('">=3.13.5"');
    expect(parseDartConstraint('^3.11.5')?.lower).toBe('3.11.5');
    expect(parseDartConstraint("'>=3.4.0 <4.0.0'")?.lower).toBe('3.4.0');
  });

  it('refuses constraints it would have to guess about', () => {
    expect(parseDartConstraint('any')).toBeNull();
    expect(parseDartConstraint("'>=3.4.0 <3.9.0 || ^4.0.0'")).toBeNull();
    // Unquoted, YAML would read the leading > as a folded block, so it is not a real constraint.
    expect(parseDartConstraint('>=3.4.0 <4.0.0')).toBeNull();
  });
});
