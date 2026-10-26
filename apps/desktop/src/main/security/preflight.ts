import type { ScannerPreflight, ScannerRequirement, SecurityScannerId } from '@runova/core';
import { codeqlLanguageNeedsBuild, getAgentToolDefinition, SECURITY_SCANNERS } from '@runova/core';
import type { SecurityScannerConfig } from './adapters';
import { getCodeqlStatus } from './codeqlLocal';
import { probe } from './exec';
import { getSonarStatus, validateSonarToken } from './sonarApi';

/**
 * What has to be true before a scanner can run, checked before the user presses the button rather
 * than discovered halfway through a 45-minute run.
 *
 * Every unmet requirement carries a remedy and an action, so the UI can offer "install it" or
 * "start Docker" instead of just reporting a failure the user has to go diagnose.
 */

interface PreflightInput {
  projectPath: string;
  config: SecurityScannerConfig;
  codeqlLanguage: string | null;
  codeqlBuildCommand: string | null;
  sonarProjectKey: string | null;
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; key: string; value: ScannerPreflight[] } | null = null;

function ok(
  id: ScannerRequirement['id'],
  label: string,
  detail?: string | null,
): ScannerRequirement {
  return {
    id,
    label,
    status: 'ok',
    blocking: true,
    remedy: '',
    action: { kind: 'none' },
    detail: detail ?? null,
  };
}

function unmet(
  id: ScannerRequirement['id'],
  label: string,
  remedy: string,
  action: ScannerRequirement['action'],
  blocking = true,
  detail: string | null = null,
): ScannerRequirement {
  return { id, label, status: 'unmet', blocking, remedy, action, detail };
}

/** `docker --version` succeeds while the daemon is down, so both are genuinely needed. */
async function checkDocker(): Promise<ScannerRequirement> {
  const installed = await probe('docker', ['--version']);
  if (!installed.ok) {
    return unmet('docker-running', 'Docker is available', 'Install Docker Desktop and start it.', {
      kind: 'start-docker',
    });
  }
  const running = await probe('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (!running.ok) {
    return unmet(
      'docker-running',
      'Docker is available',
      'Docker is installed but not running. Start Docker Desktop.',
      { kind: 'start-docker' },
    );
  }
  return ok('docker-running', 'Docker is available', running.stdout || null);
}

async function checkBinary(
  scannerId: SecurityScannerId,
  toolId: string,
): Promise<ScannerRequirement> {
  const tool = getAgentToolDefinition(toolId);
  const detect = tool?.detectCommand;
  if (!detect) return ok('binary', 'Installed');

  const result = await probe(detect.command, detect.args);
  if (result.ok) {
    const version = /\d+\.\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0] ?? null;
    return ok('binary', `${tool?.name ?? scannerId} is installed`, version);
  }
  return unmet(
    'binary',
    `${tool?.name ?? scannerId} is installed`,
    `Install ${tool?.name ?? scannerId} from the Agent Tools page.`,
    { kind: 'install-tool', toolId },
  );
}

async function requirementsFor(
  scannerId: SecurityScannerId,
  input: PreflightInput,
): Promise<ScannerRequirement[]> {
  const scanner = SECURITY_SCANNERS.find((s) => s.id === scannerId);
  if (!scanner) return [];

  switch (scannerId) {
    case 'semgrep':
    case 'trivy':
      return [await checkBinary(scannerId, scanner.toolId)];

    case 'bearer': {
      // Bearer has no Windows build, so on win32 Docker is the only route and the binary check
      // is irrelevant. Elsewhere the native binary is preferred and Docker is the fallback.
      if (process.platform === 'win32') return [await checkDocker()];
      const binary = await checkBinary(scannerId, scanner.toolId);
      if (binary.status === 'ok') return [binary];
      const docker = await checkDocker();
      return docker.status === 'ok' ? [docker] : [binary];
    }

    case 'codeql': {
      // CodeQL is the one scanner that can be installed into Runova's own tools folder rather
      // than onto PATH, so the plain PATH probe is not the whole answer here.
      const codeql = await getCodeqlStatus();
      const requirements: ScannerRequirement[] = [
        codeql.installed
          ? ok(
              'binary',
              'CodeQL is installed',
              codeql.version
                ? `${codeql.version}${codeql.onPath ? '' : ' (managed by Runova)'}`
                : null,
            )
          : unmet(
              'binary',
              'CodeQL is installed',
              'Runova can download CodeQL for you from its card on the Agent Tools page.',
              { kind: 'install-tool', toolId: scanner.toolId },
            ),
      ];
      if (!input.codeqlLanguage) {
        requirements.push(
          unmet(
            'language',
            'A language is selected',
            'Pick the language CodeQL should analyze in the scan options.',
            { kind: 'configure', scannerId: 'codeql' },
          ),
        );
      } else if (codeqlLanguageNeedsBuild(input.codeqlLanguage) && !input.codeqlBuildCommand) {
        // CodeQL exits 32 with "no code found" for a compiled language with no build to watch,
        // which is its single most common failure, so it is caught here instead.
        requirements.push(
          unmet(
            'language',
            'A build command is set',
            `${input.codeqlLanguage} is compiled, so CodeQL needs a build command to watch.`,
            { kind: 'configure', scannerId: 'codeql' },
          ),
        );
      } else {
        requirements.push(ok('language', 'A language is selected', input.codeqlLanguage));
      }
      return requirements;
    }

    case 'sonarqube': {
      const requirements: ScannerRequirement[] = [await checkDocker()];
      const url = input.config.sonarUrl || 'http://localhost:9000';
      const status = await getSonarStatus(url);
      if (status === 'up') {
        requirements.push(ok('sonar-server', 'The SonarQube server is up', url));
      } else {
        requirements.push(
          unmet(
            'sonar-server',
            'The SonarQube server is up',
            status === 'starting'
              ? 'SonarQube is still starting. First boot takes a couple of minutes.'
              : 'Start the SonarQube container from its card on the Agent Tools page.',
            { kind: 'start-container', toolId: 'sonarqube' },
            // A starting server is not a blocker: the run polls for it.
            status !== 'starting',
          ),
        );
      }

      if (!input.config.sonarToken) {
        requirements.push(
          unmet(
            'sonar-token',
            'A SonarQube token is set',
            'Create a token in SonarQube under My Account > Security, then paste it into the scan options.',
            { kind: 'configure', scannerId: 'sonarqube' },
          ),
        );
      } else if (status === 'up') {
        const valid = await validateSonarToken(url, input.config.sonarToken);
        requirements.push(
          valid
            ? ok('sonar-token', 'A SonarQube token is set')
            : unmet(
                'sonar-token',
                'A SonarQube token is set',
                'That token was rejected. Create a new one in SonarQube and paste it again.',
                { kind: 'configure', scannerId: 'sonarqube' },
              ),
        );
      }
      return requirements;
    }

    case 'strix': {
      const requirements = [await checkBinary(scannerId, scanner.toolId), await checkDocker()];
      if (!input.config.strixApiKey || !input.config.strixModel) {
        requirements.push(
          unmet(
            'llm-api-key',
            'A model and API key are set',
            'Strix drives an LLM, so it needs a model and your API key. Set them in the scan options.',
            { kind: 'configure', scannerId: 'strix' },
          ),
        );
      } else {
        requirements.push(
          ok('llm-api-key', 'A model and API key are set', input.config.strixModel),
        );
      }
      return requirements;
    }

    default:
      return [];
  }
}

export async function checkAllPreflight(input: PreflightInput): Promise<ScannerPreflight[]> {
  // Probing six scanners means a dozen child processes and two HTTP calls, so a short cache keeps
  // the tab responsive when the user toggles scanners on and off.
  const key = JSON.stringify(input);
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const value = await Promise.all(
    SECURITY_SCANNERS.map(async (scanner): Promise<ScannerPreflight> => {
      const requirements = await requirementsFor(scanner.id, input);
      return {
        scannerId: scanner.id,
        ready: !requirements.some((r) => r.status === 'unmet' && r.blocking),
        requirements,
      };
    }),
  );

  cache = { at: Date.now(), key, value };
  return value;
}

export function clearPreflightCache(): void {
  cache = null;
}
