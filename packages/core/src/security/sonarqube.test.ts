import { describe, expect, it } from 'vitest';
import {
  parseSonarIssues,
  type SonarHotspot,
  type SonarIssue,
  sonarComponentToFile,
} from './sonarqube.js';

const SERVER = 'http://localhost:9000';

/** A vulnerability, which is the shape that always survives the security filter. */
function issue(overrides: Partial<SonarIssue> = {}): SonarIssue {
  return {
    key: 'AZ-1',
    rule: 'javasecurity:S3649',
    severity: 'MAJOR',
    component: 'runova:src/db/query.ts',
    line: 31,
    message: 'Change this code to not construct SQL queries directly from user-controlled data.',
    type: 'VULNERABILITY',
    ...overrides,
  };
}

describe('sonarComponentToFile', () => {
  it('drops the project key prefix', () => {
    expect(sonarComponentToFile('runova:src/db/query.ts')).toBe('src/db/query.ts');
  });

  it('keeps a component that has no prefix', () => {
    expect(sonarComponentToFile('src/db/query.ts')).toBe('src/db/query.ts');
  });

  it('only splits on the first colon, since a path can contain one', () => {
    expect(sonarComponentToFile('proj:src/a:b.ts')).toBe('src/a:b.ts');
  });

  it('returns null for nothing usable', () => {
    expect(sonarComponentToFile(undefined)).toBeNull();
    expect(sonarComponentToFile('')).toBeNull();
    // A project-level issue has no path after the key.
    expect(sonarComponentToFile('runova:')).toBeNull();
    expect(sonarComponentToFile('runova:   ')).toBeNull();
  });
});

describe('parseSonarIssues security filter', () => {
  it('keeps vulnerabilities and security hotspot issues', () => {
    const findings = parseSonarIssues(
      [issue({ type: 'VULNERABILITY' }), issue({ type: 'security_hotspot' })],
      [],
    );
    expect(findings).toHaveLength(2);
  });

  it('keeps an issue whose impacts mention security', () => {
    const findings = parseSonarIssues(
      [issue({ type: 'CODE_SMELL', impacts: [{ softwareQuality: 'SECURITY', severity: 'HIGH' }] })],
      [],
    );
    expect(findings).toHaveLength(1);
  });

  it('keeps an issue tagged with a security taxonomy', () => {
    for (const tag of ['cwe', 'cwe-89', 'owasp-a3', 'sans-top25-insecure', 'security']) {
      const findings = parseSonarIssues([issue({ type: 'CODE_SMELL', tags: [tag] })], []);
      expect(findings, tag).toHaveLength(1);
    }
  });

  it('drops the ordinary code smells that would otherwise drown the report', () => {
    // Sonar reports every naming and complexity note it can find, and a thousand of those would
    // bury the handful of findings this report exists for.
    const findings = parseSonarIssues(
      [
        issue({ type: 'CODE_SMELL', tags: ['convention', 'brain-overload'] }),
        issue({ type: 'BUG', tags: [] }),
        issue({ type: undefined, tags: undefined }),
        issue({
          type: 'CODE_SMELL',
          impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'LOW' }],
        }),
      ],
      [],
    );
    expect(findings).toEqual([]);
  });
});

describe('parseSonarIssues severity', () => {
  it('prefers the security impact over the legacy severity field', () => {
    // A MAJOR maintainability smell and a MAJOR vulnerability are not the same thing, so when
    // both fields are present the security impact is the one that means something.
    const [finding] = parseSonarIssues(
      [
        issue({
          severity: 'MINOR',
          impacts: [
            { softwareQuality: 'MAINTAINABILITY', severity: 'LOW' },
            { softwareQuality: 'SECURITY', severity: 'BLOCKER' },
          ],
        }),
      ],
      [],
    );
    expect(finding.severity).toBe('critical');
    expect(finding.nativeSeverity).toBe('BLOCKER');
  });

  it('falls back to the legacy severity, then to the first impact, then to medium', () => {
    const [legacy] = parseSonarIssues([issue({ severity: 'CRITICAL' })], []);
    expect(legacy.severity).toBe('high');
    expect(legacy.nativeSeverity).toBe('CRITICAL');

    const [impact] = parseSonarIssues(
      [
        issue({
          severity: undefined,
          tags: ['security'],
          impacts: [{ softwareQuality: 'RELIABILITY', severity: 'HIGH' }],
        }),
      ],
      [],
    );
    expect(impact.severity).toBe('high');

    const [neither] = parseSonarIssues([issue({ severity: undefined })], []);
    expect(neither.severity).toBe('medium');
    expect(neither.nativeSeverity).toBeNull();
  });
});

describe('parseSonarIssues findings', () => {
  it('normalizes an issue into the shared finding shape', () => {
    const [finding] = parseSonarIssues(
      [issue({ tags: ['cwe-89', 'owasp-a3', 'sql'] })],
      [],
      SERVER,
    );
    expect(finding).toEqual({
      id: 'sonarqube-1',
      scannerId: 'sonarqube',
      ruleId: 'javasecurity:S3649',
      title: 'Change this code to not construct SQL queries directly from user-controlled data.',
      detail: 'Change this code to not construct SQL queries directly from user-controlled data.',
      severity: 'medium',
      nativeSeverity: 'MAJOR',
      kind: 'sast',
      file: 'src/db/query.ts',
      line: 31,
      endLine: null,
      // The issues API does not return source, and one request per finding is not worth it.
      excerpt: null,
      cwe: ['CWE-89'],
      owasp: ['owasp-a3'],
      cve: null,
      packageName: null,
      installedVersion: null,
      fixedVersion: null,
      helpUri: 'http://localhost:9000/coding_rules?open=javasecurity%3AS3649',
      remediation: null,
      redacted: false,
    });
  });

  it('uses only the first line of a multi-line message as the title', () => {
    const [finding] = parseSonarIssues([issue({ message: 'First line.\nSecond line.' })], []);
    expect(finding.title).toBe('First line.');
    expect(finding.detail).toBe('First line.\nSecond line.');
  });

  it('falls back to the rule id when there is no message, and to "sonar" with no rule', () => {
    const [named] = parseSonarIssues([issue({ message: undefined })], []);
    expect(named.title).toBe('javasecurity:S3649');

    const [unnamed] = parseSonarIssues([issue({ message: undefined, rule: undefined })], []);
    expect(unnamed.ruleId).toBe('sonar');
    expect(unnamed.title).toBe('sonar');
  });

  it('builds no help link without a server url, and tolerates a trailing slash on one', () => {
    expect(parseSonarIssues([issue()], [])[0].helpUri).toBeNull();
    expect(parseSonarIssues([issue()], [], 'http://localhost:9000/')[0].helpUri).toBe(
      'http://localhost:9000/coding_rules?open=javasecurity%3AS3649',
    );
  });

  it('reads CWE tags in either spelling and leaves other tags out', () => {
    const [finding] = parseSonarIssues(
      [issue({ tags: ['cwe-79', 'CWE89', 'cwe-not-a-number', 'unpredictable'] })],
      [],
    );
    expect(finding.cwe).toEqual(['CWE-79', 'CWE-89']);
    expect(finding.owasp).toEqual([]);
  });
});

describe('parseSonarIssues hotspots', () => {
  function hotspot(overrides: Partial<SonarHotspot> = {}): SonarHotspot {
    return {
      key: 'AY-9',
      ruleKey: 'typescript:S2245',
      component: 'runova:src/rand.ts',
      line: 4,
      message: 'Make sure that using this pseudorandom number generator is safe here.',
      vulnerabilityProbability: 'HIGH',
      securityCategory: 'weak-cryptography',
      ...overrides,
    };
  }

  it('normalizes a hotspot as needing review rather than as a confirmed bug', () => {
    const [finding] = parseSonarIssues([], [hotspot()], SERVER);
    expect(finding).toMatchObject({
      id: 'sonarqube-1',
      ruleId: 'typescript:S2245',
      severity: 'high',
      nativeSeverity: 'HIGH',
      kind: 'hotspot',
      file: 'src/rand.ts',
      line: 4,
      detail:
        'Make sure that using this pseudorandom number generator is safe here.\n\nCategory: weak-cryptography',
      helpUri: 'http://localhost:9000/security_hotspots?hotspots=AY-9',
      remediation: 'Sonar flags this as worth a human review rather than a confirmed bug.',
    });
  });

  it('maps the vulnerability probability, defaulting to low', () => {
    const probabilities: [string | undefined, string][] = [
      ['HIGH', 'high'],
      ['MEDIUM', 'medium'],
      ['LOW', 'low'],
      [undefined, 'low'],
      ['nonsense', 'low'],
    ];
    for (const [probability, expected] of probabilities) {
      const [finding] = parseSonarIssues([], [hotspot({ vulnerabilityProbability: probability })]);
      expect(finding.severity, String(probability)).toBe(expected);
    }
  });

  it('omits the category section and the link when the server did not send them', () => {
    const [finding] = parseSonarIssues(
      [],
      [hotspot({ securityCategory: undefined, key: undefined, message: undefined })],
      SERVER,
    );
    expect(finding.detail).toBe('');
    expect(finding.title).toBe('typescript:S2245');
    expect(finding.helpUri).toBeNull();
  });

  it('never filters hotspots, since needing review is the whole point of them', () => {
    const findings = parseSonarIssues([], [hotspot({ ruleKey: undefined })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('sonar-hotspot');
  });

  it('numbers issues and hotspots in one sequence, skipping the issues it dropped', () => {
    const findings = parseSonarIssues(
      [issue({ type: 'CODE_SMELL', tags: [] }), issue()],
      [hotspot(), hotspot()],
    );
    // The dropped smell does not burn an id, so the ids stay dense.
    expect(findings.map((f) => f.id)).toEqual(['sonarqube-1', 'sonarqube-2', 'sonarqube-3']);
  });

  it('returns nothing for two empty lists', () => {
    expect(parseSonarIssues([], [])).toEqual([]);
  });
});
