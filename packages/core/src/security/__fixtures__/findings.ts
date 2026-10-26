import type { ScannerRunResult, SecurityFinding, SecurityScanRecord } from '../types.js';
import { DEFAULT_SCAN_OPTIONS } from '../types.js';

/**
 * Builders for the normalized shapes the report and the scorer consume. A SecurityFinding has
 * eighteen fields and almost every test cares about two of them, so spelling the whole thing out
 * per case would bury the part that is actually under test.
 */

export function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'semgrep-1',
    scannerId: 'semgrep',
    ruleId: 'test.rule.id',
    title: 'A test finding',
    detail: 'Something worth looking at.',
    severity: 'medium',
    nativeSeverity: 'warning',
    kind: 'sast',
    file: 'src/app.ts',
    line: 12,
    endLine: null,
    excerpt: null,
    cwe: [],
    owasp: [],
    cve: null,
    packageName: null,
    installedVersion: null,
    fixedVersion: null,
    helpUri: null,
    remediation: null,
    redacted: false,
    ...overrides,
  };
}

/** `count` findings of one severity, with distinct ids so nothing collapses by accident. */
export function makeFindings(
  count: number,
  overrides: Partial<SecurityFinding> = {},
): SecurityFinding[] {
  return Array.from({ length: count }, (_, index) =>
    makeFinding({ id: 'semgrep-' + (index + 1), ...overrides }),
  );
}

export function makeRun(overrides: Partial<ScannerRunResult> = {}): ScannerRunResult {
  return {
    scannerId: 'semgrep',
    status: 'ok',
    transport: 'native',
    toolVersion: '1.2.3',
    findingCount: 1,
    durationMs: 12_000,
    exitCode: 0,
    truncated: false,
    error: null,
    warnings: [],
    log: null,
    ...overrides,
  };
}

export function makeRecord(overrides: Partial<SecurityScanRecord> = {}): SecurityScanRecord {
  return {
    id: 'scan-1',
    projectId: 'project-1',
    projectName: 'Runova',
    status: 'complete',
    verdict: 'caution',
    score: 82,
    findings: [],
    runs: [makeRun()],
    counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
    durationMs: 12_000,
    options: DEFAULT_SCAN_OPTIONS,
    createdAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}
