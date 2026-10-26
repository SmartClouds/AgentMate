import { describe, expect, it } from 'vitest';
import { CODEQL_SARIF, SEMGREP_SARIF, TRIVY_SARIF } from './__fixtures__/sarif.js';
import {
  normalizeArtifactUri,
  type ParseSarifOptions,
  parseSarif,
  scrapeTrivyMessage,
} from './sarif.js';

const SEMGREP: ParseSarifOptions = { scannerId: 'semgrep' };

/** A SARIF log with one result, so a single corner of the format can be varied at a time. */
function oneResult(result: unknown, driver: unknown = { name: 'semgrep' }): unknown {
  return { runs: [{ tool: { driver }, results: [result] }] };
}

describe('parseSarif with real tool output', () => {
  it('reads a Semgrep result end to end', () => {
    const { findings, truncated, warnings, toolVersion } = parseSarif(SEMGREP_SARIF, SEMGREP);
    expect(truncated).toBe(false);
    expect(warnings).toEqual([]);
    expect(toolVersion).toBe('1.86.0');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      id: 'semgrep-1',
      scannerId: 'semgrep',
      ruleId: 'javascript.express.security.audit.xss.direct-response-write',
      // shortDescription is "Semgrep Finding: <rule id>", which says nothing, so the message wins.
      title: 'Detected directly writing to a response.',
      detail: 'Detected directly writing to a response. Use a template engine.',
      severity: 'high',
      nativeSeverity: 'error',
      kind: 'sast',
      file: 'src/routes/home.ts',
      line: 42,
      endLine: 43,
      // The trailing \r from a CRLF checkout is stripped, the leading indent is not.
      excerpt: '  res.send(req.query.name)',
      cwe: ['CWE-79'],
      owasp: ['A03:2021'],
      cve: null,
      packageName: null,
      installedVersion: null,
      fixedVersion: null,
      helpUri: 'https://semgrep.dev/r/xss.direct-response-write',
      remediation: 'Use a template engine that escapes by default.',
      redacted: false,
    });
  });

  it('reads a CodeQL result, including rule metadata hidden under tool.extensions', () => {
    const { findings, toolVersion } = parseSarif(CODEQL_SARIF, {
      scannerId: 'codeql',
      projectPath: 'E:\\work\\app',
    });
    expect(toolVersion).toBe('2.26.4+202509');
    expect(findings[0]).toMatchObject({
      ruleId: 'js/sql-injection',
      // The numeric property, not the "warning" level, decides the severity.
      severity: 'critical',
      nativeSeverity: 'warning',
      title: 'Database query built from user-controlled sources',
      cwe: ['CWE-089'],
      // %SRCROOT% resolved, then the project root stripped off the front.
      file: 'server/db.js',
      line: 7,
      endLine: null,
      remediation: '# SQL injection\n\nUse parameterized queries.',
      helpUri: 'https://codeql.github.com/codeql-query-help/javascript/js-sql-injection/',
    });
  });

  it('reads a Trivy result, scraping the prose and dropping its boilerplate', () => {
    const { findings } = parseSarif(TRIVY_SARIF, {
      scannerId: 'trivy',
      containerRoot: '/tmp/scan',
    });
    expect(findings[0]).toMatchObject({
      id: 'trivy-1',
      ruleId: 'CVE-2021-23337',
      cve: 'CVE-2021-23337',
      // The severity word only exists as a bare rule tag.
      severity: 'high',
      nativeSeverity: 'HIGH',
      kind: 'dependency',
      file: 'package-lock.json',
      line: 118,
      packageName: 'lodash',
      installedVersion: '4.17.20',
      fixedVersion: '4.17.21',
      helpUri: 'https://avd.aquasec.com/nvd/cve-2021-23337',
      // The labelled lines and the markdown table are already structured fields above.
      detail: 'lodash template allows command injection.',
      remediation: 'Upgrade lodash to 4.17.21 or later.',
    });
  });
});

describe('parseSarif severity precedence', () => {
  it('prefers the numeric security-severity over everything else', () => {
    const log = oneResult(
      { ruleId: 'r', level: 'note' },
      {
        name: 'semgrep',
        rules: [
          {
            id: 'r',
            properties: { tags: ['LOW'], 'security-severity': '9.1' },
            defaultConfiguration: { level: 'none' },
          },
        ],
      },
    );
    expect(parseSarif(log, SEMGREP).findings[0].severity).toBe('critical');
  });

  it('prefers a Trivy severity tag over the SARIF level', () => {
    const log = oneResult(
      { ruleId: 'r', level: 'warning' },
      { name: 'Trivy', rules: [{ id: 'r', properties: { tags: ['CRITICAL'] } }] },
    );
    const finding = parseSarif(log, { scannerId: 'trivy' }).findings[0];
    expect(finding.severity).toBe('critical');
    expect(finding.nativeSeverity).toBe('CRITICAL');
  });

  it('falls back to the level, then the rule default, then the caller fallback', () => {
    const level = parseSarif(oneResult({ ruleId: 'r', level: 'error' }), SEMGREP);
    expect(level.findings[0].severity).toBe('high');

    const ruleDefault = parseSarif(
      oneResult(
        { ruleId: 'r' },
        { name: 'semgrep', rules: [{ id: 'r', defaultConfiguration: { level: 'note' } }] },
      ),
      SEMGREP,
    );
    expect(ruleDefault.findings[0].severity).toBe('low');
    expect(ruleDefault.findings[0].nativeSeverity).toBe('note');

    const nothing = parseSarif(oneResult({ ruleId: 'r' }), {
      scannerId: 'bearer',
      fallbackSeverity: 'critical',
    });
    // Bearer's criticals arrive as plain warnings, so the caller gets to pick the floor.
    expect(nothing.findings[0].severity).toBe('critical');
    expect(nothing.findings[0].nativeSeverity).toBeNull();
  });

  it('drops info findings unless the caller asks for them', () => {
    const log = oneResult({ ruleId: 'r', level: 'none' });
    expect(parseSarif(log, SEMGREP).findings).toHaveLength(0);
    expect(parseSarif(log, { ...SEMGREP, includeInfo: true }).findings).toHaveLength(1);
  });
});

describe('parseSarif rule resolution', () => {
  const rules = [
    { id: 'driver-0', shortDescription: { text: 'From the driver' } },
    { id: 'driver-1', shortDescription: { text: 'Second driver rule' } },
  ];
  const extensions = [
    { name: 'pack', rules: [{ id: 'ext-0', shortDescription: { text: 'From the extension' } }] },
  ];

  it('resolves a component-scoped rule index against tool.extensions', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'CodeQL', rules }, extensions },
          results: [{ rule: { id: 'ext-0', index: 0, toolComponent: { index: 1 } } }],
        },
      ],
    };
    expect(parseSarif(log, { scannerId: 'codeql' }).findings[0].title).toBe('From the extension');
  });

  it('resolves a driver-scoped ruleIndex', () => {
    const log = {
      runs: [{ tool: { driver: { name: 'semgrep', rules } }, results: [{ ruleIndex: 1 }] }],
    };
    const finding = parseSarif(log, SEMGREP).findings[0];
    expect(finding.title).toBe('Second driver rule');
    // With no ruleId on the result, the resolved rule's own id is what the report shows.
    expect(finding.ruleId).toBe('driver-1');
  });

  it('falls back to looking the rule up by id when no index is given', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'semgrep', rules }, extensions },
          results: [{ ruleId: 'ext-0' }],
        },
      ],
    };
    // The id map is built from the driver and every extension, which is why this resolves at all.
    expect(parseSarif(log, SEMGREP).findings[0].title).toBe('From the extension');
  });

  it('names the finding after the driver when there is no rule at all', () => {
    const log = oneResult({ message: { text: 'Something happened.' } }, { name: 'bearer' });
    expect(parseSarif(log, { scannerId: 'bearer' }).findings[0].ruleId).toBe('bearer');

    const nameless = parseSarif(oneResult({ message: { text: 'x' } }, {}), SEMGREP);
    expect(nameless.findings[0].ruleId).toBe('unknown');
  });
});

describe('parseSarif titles and details', () => {
  it('uses the rule name when there is no description or message', () => {
    const log = oneResult(
      { ruleId: 'r' },
      { name: 'semgrep', rules: [{ id: 'r', name: 'Readable rule name' }] },
    );
    expect(parseSarif(log, SEMGREP).findings[0].title).toBe('Readable rule name');
  });

  it('falls back to the last segment of a dotted rule id', () => {
    const log = oneResult({ ruleId: 'python.lang.security.audit.dangerous-subprocess-use' });
    expect(parseSarif(log, SEMGREP).findings[0].title).toBe('dangerous-subprocess-use');

    const plain = parseSarif(oneResult({ ruleId: 'js/xss' }), SEMGREP);
    expect(plain.findings[0].title).toBe('js/xss');
  });

  it('keeps a short leading clause whole rather than cutting at an early full stop', () => {
    // "No. " would otherwise make a two-character title, so the cut only applies past column 20.
    const log = oneResult({
      ruleId: 'r',
      message: { text: 'No. This is the part that actually explains the problem.' },
    });
    expect(parseSarif(log, SEMGREP).findings[0].title).toBe(
      'No. This is the part that actually explains the problem.',
    );
  });

  it('truncates a very long title', () => {
    const log = oneResult({ ruleId: 'r', message: { text: 'x'.repeat(400) } });
    const title = parseSarif(log, SEMGREP).findings[0].title;
    expect(title).toHaveLength(163);
    expect(title.endsWith('...')).toBe(true);
  });

  it('prefers the fuller description when the message is just its opening', () => {
    const log = oneResult(
      { ruleId: 'r', message: { text: 'Use a parameterized query.' } },
      {
        name: 'semgrep',
        rules: [
          {
            id: 'r',
            fullDescription: { text: 'Use a parameterized query. Concatenating input is unsafe.' },
          },
        ],
      },
    );
    expect(parseSarif(log, SEMGREP).findings[0].detail).toBe(
      'Use a parameterized query. Concatenating input is unsafe.',
    );
  });

  it('leaves the detail empty rather than inventing one', () => {
    const finding = parseSarif(oneResult({ ruleId: 'r' }), SEMGREP).findings[0];
    expect(finding.detail).toBe('');
    expect(finding.remediation).toBeNull();
  });
});

describe('parseSarif locations', () => {
  it('reports no location at all when the result has none', () => {
    const finding = parseSarif(oneResult({ ruleId: 'r', level: 'error' }), SEMGREP).findings[0];
    expect(finding).toMatchObject({ file: null, line: null, endLine: null, excerpt: null });
  });

  it('handles a region with only a start line', () => {
    const log = oneResult({
      ruleId: 'r',
      locations: [
        { physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 3 } } },
      ],
    });
    expect(parseSarif(log, SEMGREP).findings[0]).toMatchObject({
      file: 'a.ts',
      line: 3,
      endLine: null,
    });
  });

  it('handles a location with no region, and a snippet from the context region', () => {
    const log = oneResult({
      ruleId: 'r',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'a.ts' },
            contextRegion: { snippet: { text: 'const x = 1;  ' } },
          },
        },
      ],
    });
    expect(parseSarif(log, SEMGREP).findings[0]).toMatchObject({
      file: 'a.ts',
      line: null,
      excerpt: 'const x = 1;',
    });
  });

  it('uses only the first location, since the report shows one line per finding', () => {
    const log = oneResult({
      ruleId: 'r',
      locations: [
        { physicalLocation: { artifactLocation: { uri: 'first.ts' }, region: { startLine: 1 } } },
        { physicalLocation: { artifactLocation: { uri: 'second.ts' }, region: { startLine: 2 } } },
      ],
    });
    expect(parseSarif(log, SEMGREP).findings[0].file).toBe('first.ts');
  });
});

describe('parseSarif skips and caps', () => {
  it('skips result kinds that are not findings', () => {
    for (const kind of ['pass', 'notApplicable', 'informational', 'open']) {
      const log = oneResult({ ruleId: 'r', kind, level: 'error' });
      expect(parseSarif(log, SEMGREP).findings, kind).toHaveLength(0);
    }
    // 'fail' is the only kind that means "this is a finding", and it is also the default.
    expect(parseSarif(oneResult({ ruleId: 'r', kind: 'fail' }), SEMGREP).findings).toHaveLength(1);
  });

  it('skips a result the user already dismissed', () => {
    const log = oneResult({
      ruleId: 'r',
      level: 'error',
      suppressions: [{ kind: 'inSource', justification: 'nosemgrep' }],
    });
    expect(parseSarif(log, SEMGREP).findings).toHaveLength(0);
    // An empty array is not a suppression.
    expect(parseSarif(oneResult({ ruleId: 'r', suppressions: [] }), SEMGREP).findings).toHaveLength(
      1,
    );
  });

  it('stops at maxFindings and says so', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'semgrep' } },
          results: [{ ruleId: 'a' }, { ruleId: 'b' }, { ruleId: 'c' }],
        },
      ],
    };
    const outcome = parseSarif(log, { ...SEMGREP, maxFindings: 2 });
    expect(outcome.findings.map((f) => f.ruleId)).toEqual(['a', 'b']);
    expect(outcome.truncated).toBe(true);
  });

  it('stops across runs, not just within one', () => {
    const log = {
      runs: [
        { tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'a' }] },
        { tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'b' }] },
      ],
    };
    const outcome = parseSarif(log, { ...SEMGREP, maxFindings: 1 });
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.truncated).toBe(true);
  });
});

describe('parseSarif across multiple runs', () => {
  it('merges runs, numbers ids continuously and keeps the first tool version', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'semgrep', version: '1.0.0' } },
          results: [{ ruleId: 'a', level: 'error' }],
        },
        {
          tool: { driver: { name: 'semgrep', version: '9.9.9' } },
          results: [
            { ruleId: 'b', level: 'error' },
            { ruleId: 'c', level: 'error' },
          ],
        },
      ],
    };
    const outcome = parseSarif(log, SEMGREP);
    expect(outcome.findings.map((f) => f.id)).toEqual(['semgrep-1', 'semgrep-2', 'semgrep-3']);
    expect(outcome.toolVersion).toBe('1.0.0');
  });

  it('prefers semanticVersion over version', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'x', version: '1.0.0', semanticVersion: '1.0.0-beta.2' } },
          results: [],
        },
      ],
    };
    expect(parseSarif(log, SEMGREP).toolVersion).toBe('1.0.0-beta.2');
  });

  it('resolves rules per run, so one run cannot borrow another run rule metadata', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'semgrep', rules: [{ id: 'r', name: 'First run rule' }] } },
          results: [{ ruleId: 'r' }],
        },
        { tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'r' }] },
      ],
    };
    const titles = parseSarif(log, SEMGREP).findings.map((f) => f.title);
    expect(titles).toEqual(['First run rule', 'r']);
  });

  it('warns when the tool reported a partial run', () => {
    const log = {
      runs: [
        {
          tool: { driver: { name: 'semgrep' } },
          invocations: [{ executionSuccessful: false }],
          results: [{ ruleId: 'r' }],
        },
      ],
    };
    const outcome = parseSarif(log, SEMGREP);
    expect(outcome.warnings).toEqual([
      'The tool reported a partial run, so some files may not have been analyzed.',
    ]);
    // A partial run still contributes whatever it did find.
    expect(outcome.findings).toHaveLength(1);
  });

  it('keeps identical results as separate findings with distinct ids', () => {
    // Two matches of one rule on one line is what a tool reports when it found two data flows.
    // Collapsing them here would hide the second, so they are deliberately not deduplicated.
    const result = {
      ruleId: 'r',
      level: 'error',
      locations: [
        { physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 4 } } },
      ],
    };
    const log = { runs: [{ tool: { driver: { name: 'semgrep' } }, results: [result, result] }] };
    const findings = parseSarif(log, SEMGREP).findings;
    expect(findings.map((f) => f.id)).toEqual(['semgrep-1', 'semgrep-2']);
  });
});

describe('parseSarif with malformed input', () => {
  it('reports a missing runs array instead of throwing', () => {
    const expected = {
      findings: [],
      truncated: false,
      warnings: ['No SARIF runs in the output.'],
      toolVersion: null,
    };
    expect(parseSarif({}, SEMGREP)).toEqual(expected);
    expect(parseSarif(null, SEMGREP)).toEqual(expected);
    expect(parseSarif(undefined, SEMGREP)).toEqual(expected);
    // What a truncated file leaves behind once JSON.parse has already failed upstream.
    expect(parseSarif('{"runs":[{"tool"', SEMGREP)).toEqual(expected);
    expect(parseSarif({ runs: {} }, SEMGREP)).toEqual(expected);
    expect(parseSarif([], SEMGREP)).toEqual(expected);
  });

  it('survives runs and results that are empty or missing', () => {
    expect(parseSarif({ runs: [] }, SEMGREP).findings).toEqual([]);
    expect(parseSarif({ runs: [{}] }, SEMGREP).findings).toEqual([]);
    expect(parseSarif({ runs: [{ tool: {}, results: [] }] }, SEMGREP).findings).toEqual([]);
    expect(parseSarif({ runs: [{ results: null }] }, SEMGREP).findings).toEqual([]);
  });

  it('keeps a finding whose fields are the wrong type', () => {
    // A crafted or half-written SARIF should still produce a row the user can look at, rather
    // than losing the whole run to one bad field.
    const log = oneResult({ ruleId: 'r', level: 'error', locations: [{}], message: {} });
    const finding = parseSarif(log, SEMGREP).findings[0];
    expect(finding).toMatchObject({ ruleId: 'r', severity: 'high', file: null, title: 'r' });
  });

  it('ignores rule entries with no id when building the lookup map', () => {
    const log = oneResult(
      { ruleId: 'r' },
      {
        name: 'semgrep',
        rules: [{ shortDescription: { text: 'orphan' } }, { id: 'r', name: 'R' }],
      },
    );
    expect(parseSarif(log, SEMGREP).findings[0].title).toBe('R');
  });
});

describe('normalizeArtifactUri', () => {
  it('passes a project-relative POSIX path through', () => {
    expect(normalizeArtifactUri('src/app.ts', SEMGREP)).toEqual({
      file: 'src/app.ts',
      warning: null,
    });
  });

  it('returns nothing for a missing uri', () => {
    expect(normalizeArtifactUri(undefined, SEMGREP)).toEqual({ file: null, warning: null });
  });

  it('strips a container mount point', () => {
    const opts: ParseSarifOptions = { scannerId: 'bearer', containerRoot: '/tmp/scan' };
    expect(normalizeArtifactUri('/tmp/scan/src/app.ts', opts).file).toBe('src/app.ts');
    // A finding on the mount point itself is about the project as a whole, not about a file.
    expect(normalizeArtifactUri('/tmp/scan', opts).file).toBeNull();
    // A path that merely starts with the same characters is not inside the mount.
    expect(normalizeArtifactUri('/tmp/scanner/app.ts', opts).file).toBe('tmp/scanner/app.ts');
  });

  it('strips a host project path, ignoring drive-letter case', () => {
    const opts: ParseSarifOptions = { scannerId: 'semgrep', projectPath: 'E:\\Runova' };
    expect(normalizeArtifactUri('e:/Runova/src/app.ts', opts).file).toBe('src/app.ts');
    expect(normalizeArtifactUri('E:\\Runova\\src\\app.ts', opts).file).toBe('src/app.ts');
    expect(normalizeArtifactUri('file:///E:/Runova/src/app.ts', opts).file).toBe('src/app.ts');
  });

  it('tolerates a trailing slash on either configured root', () => {
    const opts: ParseSarifOptions = {
      scannerId: 'bearer',
      containerRoot: '/tmp/scan/',
      projectPath: 'E:/Runova/',
    };
    expect(normalizeArtifactUri('/tmp/scan/a.ts', opts).file).toBe('a.ts');
    expect(normalizeArtifactUri('E:/Runova/b.ts', opts).file).toBe('b.ts');
  });

  it('decodes percent escapes and keeps a malformed one rather than losing the finding', () => {
    expect(normalizeArtifactUri('src/my%20file.ts', SEMGREP).file).toBe('src/my file.ts');
    expect(normalizeArtifactUri('src/100%.ts', SEMGREP).file).toBe('src/100%.ts');
  });

  it('follows a uriBaseId chain', () => {
    const bases = {
      '%SRCROOT%': { uri: 'app/', uriBaseId: 'WORKSPACE' },
      WORKSPACE: { uri: 'E:/work/' },
    };
    // The chain is applied outermost-first, so the two bases join in the right order. Without a
    // projectPath the joined path is an absolute one, which is then reduced to its file name.
    const noRoot = normalizeArtifactUri('src/a.ts', SEMGREP, '%SRCROOT%', bases);
    expect(noRoot.warning).toContain('E:/work/app/src/a.ts');
    expect(
      normalizeArtifactUri(
        'src/a.ts',
        { scannerId: 'semgrep', projectPath: 'E:/work/app' },
        '%SRCROOT%',
        bases,
      ).file,
    ).toBe('src/a.ts');
    // An unknown base id is simply no prefix.
    expect(normalizeArtifactUri('src/a.ts', SEMGREP, 'NOPE', bases).file).toBe('src/a.ts');
  });

  it('tidies leading dot slashes, doubled slashes and leading slashes', () => {
    expect(normalizeArtifactUri('./src//app.ts', SEMGREP).file).toBe('src/app.ts');
    expect(normalizeArtifactUri('/src/app.ts', SEMGREP).file).toBe('src/app.ts');
  });

  it('reduces a path that escapes the project to its file name, and warns', () => {
    const traversal = normalizeArtifactUri('../../etc/passwd', SEMGREP);
    expect(traversal.file).toBe('passwd');
    expect(traversal.warning).toContain('Path outside the project');

    // An absolute path on another drive is the same problem arriving a different way.
    const absolute = normalizeArtifactUri('C:/Windows/System32/drivers/etc/hosts', SEMGREP);
    expect(absolute.file).toBe('hosts');
    expect(absolute.warning).toContain('Path outside the project');
  });

  it('surfaces the path warning through parseSarif', () => {
    const log = oneResult({
      ruleId: 'r',
      level: 'error',
      locations: [{ physicalLocation: { artifactLocation: { uri: '../outside/a.ts' } } }],
    });
    const outcome = parseSarif(log, SEMGREP);
    expect(outcome.findings[0].file).toBe('a.ts');
    expect(outcome.warnings).toHaveLength(1);
  });
});

describe('scrapeTrivyMessage', () => {
  it('lifts the labelled lines out of the message prose', () => {
    const message = [
      'Package: github.com/example/pkg',
      'Installed Version: v1.2.3',
      'Vulnerability CVE-2024-0001',
      'Severity: CRITICAL',
      'Fixed Version: v1.2.4',
      'Link: [CVE-2024-0001](https://avd.aquasec.com/nvd/cve-2024-0001)',
    ].join('\n');
    expect(scrapeTrivyMessage(message)).toEqual({
      packageName: 'github.com/example/pkg',
      installedVersion: 'v1.2.3',
      fixedVersion: 'v1.2.4',
      // The URL is pulled out of the markdown link, so the report can use it as an href.
      link: 'https://avd.aquasec.com/nvd/cve-2024-0001',
    });
  });

  it('keeps a bare link as it is', () => {
    expect(scrapeTrivyMessage('Link: https://example.com/advisory').link).toBe(
      'https://example.com/advisory',
    );
  });

  it('leaves missing labels null rather than failing the finding', () => {
    expect(scrapeTrivyMessage('Something went wrong.')).toEqual({
      packageName: null,
      installedVersion: null,
      fixedVersion: null,
      link: null,
    });
  });

  it('is only applied to Trivy output', () => {
    const log = oneResult({ ruleId: 'r', level: 'error', message: { text: 'Package: lodash' } });
    expect(parseSarif(log, SEMGREP).findings[0].packageName).toBeNull();
  });
});
