import { describe, expect, it } from 'vitest';
import { makeFinding, makeFindings, makeRecord, makeRun } from './__fixtures__/findings.js';
import {
  buildFindingText,
  buildSecurityFixPrompt,
  buildSecurityJson,
  buildSecurityReportMarkdown,
} from './report.js';

describe('buildFindingText', () => {
  it('renders every field a finding can carry', () => {
    const text = buildFindingText(
      makeFinding({
        scannerId: 'trivy',
        ruleId: 'CVE-2021-23337',
        title: 'lodash: command injection via template',
        detail: 'lodash template allows command injection.',
        severity: 'high',
        kind: 'dependency',
        file: 'package-lock.json',
        line: 118,
        excerpt: '"lodash": "4.17.20"',
        cwe: ['CWE-77', 'CWE-94'],
        owasp: ['A06:2021'],
        cve: 'CVE-2021-23337',
        packageName: 'lodash',
        installedVersion: '4.17.20',
        fixedVersion: '4.17.21',
        helpUri: 'https://avd.aquasec.com/nvd/cve-2021-23337',
        remediation: 'Upgrade lodash to 4.17.21 or later.',
        redacted: true,
      }),
    );
    expect(text).toMatchInlineSnapshot(`
      "### [High] lodash: command injection via template

      - Location: \`package-lock.json:118\`
      - Rule: \`CVE-2021-23337\` (Trivy)
      - Type: Dependency
      - CWE: CWE-77, CWE-94
      - OWASP: A06:2021
      - CVE: CVE-2021-23337
      - Package: \`lodash@4.17.20\` (fixed in 4.17.21)
      - Reference: https://avd.aquasec.com/nvd/cve-2021-23337
      - Note: a matched secret was masked. Open the file to see the real value.

      lodash template allows command injection.

      \`\`\`json
      "lodash": "4.17.20"
      \`\`\`

      Suggested fix: Upgrade lodash to 4.17.21 or later."
    `);
  });

  it('renders the minimum a finding can have', () => {
    const text = buildFindingText(
      makeFinding({
        ruleId: 'js/xss',
        title: 'Reflected XSS',
        detail: '',
        severity: 'critical',
        file: null,
        line: null,
      }),
    );
    expect(text).toMatchInlineSnapshot(`
      "### [Critical] Reflected XSS

      - Location: \`repository-wide\`
      - Rule: \`js/xss\` (Semgrep)
      - Type: Code"
    `);
  });

  it('drops the line number when the tool did not report one', () => {
    const text = buildFindingText(makeFinding({ file: 'src/app.ts', line: null }));
    expect(text).toContain('- Location: `src/app.ts`');
  });

  it('does not print the detail twice when it is the title', () => {
    const text = buildFindingText(makeFinding({ title: 'Same words', detail: 'Same words' }));
    expect(text.match(/Same words/g)).toHaveLength(1);
  });

  it('picks a code fence from the file extension', () => {
    const fenced = (file: string): string =>
      buildFindingText(makeFinding({ file, excerpt: 'x' }))
        .split('\n')
        .find((line) => line.startsWith('```')) as string;
    expect(fenced('a.py')).toBe('```python');
    expect(fenced('a.tsx')).toBe('```tsx');
    expect(fenced('a.YAML')).toBe('```yaml');
    expect(fenced('Dockerfile')).toBe('```');
    // An unknown extension gets an unlabelled fence rather than a guess.
    expect(fenced('a.zig')).toBe('```');
  });

  it('names the scanner rather than its id where the registry knows it', () => {
    expect(buildFindingText(makeFinding({ scannerId: 'sonarqube' }))).toContain('(SonarQube)');
  });
});

describe('buildSecurityReportMarkdown', () => {
  it('leads with the verdict, the score and the severity counts', () => {
    const report = buildSecurityReportMarkdown(
      makeRecord({
        verdict: 'risky',
        score: 54,
        counts: { critical: 1, high: 0, medium: 3, low: 2, info: 0 },
        findings: makeFindings(1, { severity: 'critical' }),
      }),
    );
    expect(report).toContain('# Security scan: Runova');
    expect(report).toContain('**Needs attention** (score 54/100) - 1 critical, 3 medium, 2 low');
  });

  it('says so when a run did not finish', () => {
    const complete = buildSecurityReportMarkdown(makeRecord({ status: 'complete' }));
    expect(complete).not.toContain('so it may be incomplete');
    const cancelled = buildSecurityReportMarkdown(makeRecord({ status: 'cancelled' }));
    expect(cancelled).toContain('> This run finished as **cancelled**, so it may be incomplete.');
  });

  it('tabulates the scanners, with the failure reason next to the status', () => {
    const report = buildSecurityReportMarkdown(
      makeRecord({
        runs: [
          makeRun({ scannerId: 'semgrep', findingCount: 4, durationMs: 61_500 }),
          makeRun({
            scannerId: 'codeql',
            status: 'skipped',
            findingCount: 0,
            durationMs: 0,
            error: 'CodeQL is not installed.',
          }),
        ],
      }),
    );
    expect(report).toContain('| Semgrep | ok | 4 | 62s |');
    expect(report).toContain('| CodeQL | skipped: CodeQL is not installed. | 0 | 0s |');
  });

  it('refuses to call an empty report a clean bill of health', () => {
    const report = buildSecurityReportMarkdown(makeRecord({ findings: [] }));
    expect(report).toContain('## Findings');
    expect(report).toContain('That is not a guarantee of safety');
  });

  it('groups findings under a heading per severity, worst first', () => {
    const report = buildSecurityReportMarkdown(
      makeRecord({
        findings: [
          makeFinding({ id: '1', severity: 'low', title: 'A low one' }),
          makeFinding({ id: '2', severity: 'critical', title: 'A critical one' }),
          makeFinding({ id: '3', severity: 'critical', title: 'Another critical one' }),
        ],
      }),
    );
    const headings = report.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## Scanners', '## Critical (2)', '## Low (1)']);
  });

  it('includes the scan time, formatted for wherever it is being read', () => {
    const report = buildSecurityReportMarkdown(makeRecord());
    expect(report).toMatch(/\nScanned .+\.\n/);
  });
});

describe('buildSecurityFixPrompt', () => {
  it('front-loads the instructions before any finding', () => {
    const prompt = buildSecurityFixPrompt(
      makeRecord({ findings: makeFindings(1, { severity: 'high' }) }),
    );
    // The instruction has to survive truncation by whatever reads it, so it comes first.
    expect(prompt.startsWith('I ran security scanners on the "Runova" project.')).toBe(true);
    expect(prompt.indexOf('Please fix the findings below.')).toBeLessThan(
      prompt.indexOf('### [High]'),
    );
    expect(prompt).toContain('Summary: 1 medium (score 82/100).');
  });

  it('lists only the tools that actually ran', () => {
    const prompt = buildSecurityFixPrompt(
      makeRecord({
        runs: [
          makeRun({ scannerId: 'semgrep' }),
          makeRun({ scannerId: 'trivy', status: 'failed', error: 'exit 1' }),
          makeRun({ scannerId: 'codeql', status: 'skipped' }),
        ],
      }),
    );
    expect(prompt).toContain('Tools that ran: Semgrep.');
  });

  it('omits the tools line when nothing succeeded', () => {
    const prompt = buildSecurityFixPrompt(makeRecord({ runs: [makeRun({ status: 'timed-out' })] }));
    expect(prompt).not.toContain('Tools that ran:');
  });

  it('explains the masking only when a masked finding is actually included', () => {
    const redacted = makeFinding({ severity: 'critical', redacted: true });
    const withSecret = buildSecurityFixPrompt(makeRecord({ findings: [redacted] }));
    expect(withSecret).toContain('matched secret values are masked below');
    expect(withSecret).toContain('rotate it');

    const withoutSecret = buildSecurityFixPrompt(
      makeRecord({ findings: makeFindings(1, { severity: 'critical' }) }),
    );
    expect(withoutSecret).not.toContain('matched secret values are masked below');
  });

  it('caps the findings worst-first and counts what it left out', () => {
    const prompt = buildSecurityFixPrompt(
      makeRecord({
        findings: [
          ...makeFindings(3, { severity: 'low', file: 'src/low.ts' }),
          ...makeFindings(2, { severity: 'critical', file: 'src/critical.ts' }),
        ],
      }),
      { cap: 2 },
    );
    // Handing a model the low-severity notes and none of the criticals would be worse than
    // useless, so the cap is applied after the worst-first sort.
    expect(prompt).toContain('## Critical (2)');
    expect(prompt).not.toContain('## Low');
    expect(prompt).toContain('There are 3 further lower-severity findings not included here');
  });

  it('says nothing about omitted findings when everything fits', () => {
    const prompt = buildSecurityFixPrompt(
      makeRecord({ findings: makeFindings(2, { severity: 'high' }) }),
    );
    expect(prompt).not.toContain('further lower-severity findings');
  });

  it('still reads as a request when there is nothing to fix', () => {
    const prompt = buildSecurityFixPrompt(makeRecord({ findings: [] }));
    expect(prompt).toContain('Please fix the findings below.');
    expect(prompt).not.toContain('###');
  });
});

describe('buildSecurityJson', () => {
  it('emits the normalized findings and nothing that could hold a secret', () => {
    const record = makeRecord({ findings: makeFindings(2, { severity: 'high' }) });
    const parsed: unknown = JSON.parse(buildSecurityJson(record));
    expect(parsed).toEqual({
      project: 'Runova',
      createdAt: record.createdAt,
      status: 'complete',
      verdict: 'caution',
      score: 82,
      counts: record.counts,
      runs: record.runs,
      findings: record.findings,
    });
    // The scan options are deliberately not in the export, so nothing here has to be audited
    // for a token that got into a config field.
    expect(Object.keys(parsed as Record<string, unknown>)).not.toContain('options');
  });

  it('is indented, since a human reads this as often as a tool does', () => {
    expect(buildSecurityJson(makeRecord())).toContain('\n  "project": "Runova"');
  });
});
