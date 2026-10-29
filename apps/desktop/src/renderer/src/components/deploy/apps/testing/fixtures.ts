import type {
  JobInfo,
  StackDetails,
  StackInfo,
  StackRevisionInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployComposeDiscovery,
  DeployStackPreview,
  DeployStackUploadResult,
} from '@shared/deployStacksTypes';
import { SERVER, signedIn } from '../../security/testing/fixtures';

/** A server with a shop app on it, and a project with a compose file, for the Apps tests. */

export { SERVER };

export const T0 = Date.now() - 10 * 60_000;
export const STACK_ID = '33333333-3333-4333-8333-333333333333';
export const JOB_ID = '44444444-4444-4444-8444-444444444444';

export function sampleStack(extra: Partial<StackInfo> = {}): StackInfo {
  return {
    id: STACK_ID,
    name: 'shop',
    status: 'running',
    createdAtUnixMs: T0,
    updatedAtUnixMs: T0,
    revisionCount: 2,
    liveRevision: 2,
    source: {
      projectId: 'proj-1',
      projectName: 'Shop',
      composePath: 'compose.yaml',
      environmentId: 'env-1',
      environmentName: 'Production',
    },
    runningContainers: 2,
    containers: 2,
    ...extra,
  };
}

export function sampleRevision(extra: Partial<StackRevisionInfo> = {}): StackRevisionInfo {
  return {
    stackId: STACK_ID,
    number: 2,
    state: 'live',
    createdAtUnixMs: T0 + 60_000,
    composeSha256: 'ab'.repeat(32),
    envKeys: ['DATABASE_URL', 'API_TOKEN'],
    services: ['web', 'db'],
    proxiedServices: ['web'],
    hasBuildContext: false,
    steps: [
      {
        kind: 'validate',
        state: 'succeeded',
        startedAtUnixMs: T0,
        finishedAtUnixMs: T0 + 800,
        firstLogSeq: 2,
        lastLogSeq: 3,
      },
      {
        kind: 'pull',
        state: 'succeeded',
        startedAtUnixMs: T0 + 800,
        finishedAtUnixMs: T0 + 5_000,
        firstLogSeq: 4,
        lastLogSeq: 5,
      },
      { kind: 'build', state: 'skipped' },
      {
        kind: 'up',
        state: 'succeeded',
        startedAtUnixMs: T0 + 5_000,
        finishedAtUnixMs: T0 + 9_000,
        firstLogSeq: 6,
        lastLogSeq: 7,
      },
      {
        kind: 'health',
        state: 'succeeded',
        startedAtUnixMs: T0 + 9_000,
        finishedAtUnixMs: T0 + 10_000,
        firstLogSeq: 8,
        lastLogSeq: 8,
      },
    ],
    findings: [],
    acknowledgedRisks: [],
    unacknowledgedRisks: [],
    bindings: [
      { service: 'web', target: 80, protocol: 'tcp', hostIp: '127.0.0.1', published: '8080' },
    ],
    createdBy: 'maria',
    jobId: JOB_ID,
    deployedAtUnixMs: T0,
    finishedAtUnixMs: T0 + 10_000,
    ...extra,
  };
}

export function sampleDetails(extra: Partial<StackDetails> = {}): StackDetails {
  return {
    stack: sampleStack(),
    revisions: [
      sampleRevision(),
      sampleRevision({
        number: 1,
        state: 'superseded',
        jobId: '55555555-5555-4555-8555-555555555555',
        createdAtUnixMs: T0,
      }),
    ],
    services: [
      {
        name: 'web',
        image: 'nginx:1.29',
        ports: [
          { service: 'web', target: 80, protocol: 'tcp', hostIp: '127.0.0.1', published: '8080' },
        ],
        containers: [
          {
            id: 'c1',
            name: 'shop-web-1',
            image: 'nginx:1.29',
            imageId: 'sha256:1',
            state: 'running',
            status: 'Up 5 minutes',
            health: 'healthy',
            createdAtUnixMs: T0,
            ports: [{ privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 8080 }],
            composeProject: 'shop',
            composeService: 'web',
          },
        ],
      },
      { name: 'db', image: 'postgres:17', ports: [], containers: [] },
    ],
    ...extra,
  };
}

export function sampleJob(extra: Partial<JobInfo> = {}): JobInfo {
  return {
    id: JOB_ID,
    kind: 'stackDeploy',
    title: 'Deploy shop revision 3',
    state: 'running',
    createdAtUnixMs: Date.now(),
    logLines: 0,
    cancellable: true,
    ...extra,
  };
}

export const DISCOVERY: DeployComposeDiscovery = {
  projectId: 'proj-1',
  projectName: 'Shop',
  files: [
    { path: 'compose.yaml', services: 2 },
    {
      path: 'deploy/docker-compose.broken.yml',
      services: null,
      error: 'The compose file is not valid YAML.',
    },
  ],
  truncated: false,
};

export function samplePreview(extra: Partial<DeployStackPreview> = {}): DeployStackPreview {
  const web = {
    service: 'web',
    index: 0,
    hostIp: null,
    published: '8080',
    target: 80,
    protocol: 'tcp' as const,
    exposure: 'all-interfaces' as const,
    name: null,
    appProtocol: null,
  };
  return {
    projectName: 'Shop',
    composePath: 'compose.yaml',
    composeName: null,
    services: [
      {
        name: 'web',
        image: 'nginx:1.29',
        builds: false,
        ports: [web],
        publishes: true,
        hostNetwork: false,
      },
      {
        name: 'db',
        image: 'postgres:17',
        builds: false,
        ports: [],
        publishes: false,
        hostNetwork: false,
      },
    ],
    envKeys: ['DATABASE_URL', 'API_TOKEN'],
    envFiles: ['.env.production'],
    missingVariables: [],
    proxiedServices: ['web'],
    bindings: [{ ...web, hostIp: '127.0.0.1', exposure: 'loopback' }],
    overrideText: 'services:\n  web:\n    ports: !override\n      - target: 80\n',
    risks: [
      {
        id: 'privileged:db',
        rule: 'privileged',
        severity: 'critical',
        service: 'db',
        message: 'db runs privileged.',
        advice: 'Grant only the capabilities it needs.',
      },
      {
        id: 'no-healthcheck:web',
        rule: 'no-healthcheck',
        severity: 'low',
        service: 'web',
        message: 'web has no healthcheck.',
        advice: 'Add a healthcheck.',
      },
    ],
    requiresAcknowledgment: ['privileged:db'],
    buildContext: null,
    blocking: null,
    ...extra,
  };
}

export function uploadResult(revision: Partial<StackRevisionInfo> = {}): DeployStackUploadResult {
  return {
    stack: sampleStack({ status: 'new', liveRevision: undefined, revisionCount: 1 }),
    revision: sampleRevision({
      number: 1,
      state: 'ready',
      steps: [],
      jobId: undefined,
      ...revision,
    }),
  };
}

export function appsBridge(roles: string[] = ['owner']): Record<string, unknown> {
  return {
    'deploy.access': signedIn(roles),
    'deployStacks.list': [sampleStack()],
    'deployStacks.get': sampleDetails(),
    'deployStacks.discover': DISCOVERY,
    'deployStacks.preview': samplePreview(),
    'deployStacks.files': {
      number: 2,
      compose: 'services:\n  web:\n    image: nginx:1.29\n',
      envKeys: ['DATABASE_URL'],
      override: 'services:\n  web:\n    ports: !override\n',
    },
    'deployJobs.watch': async () => 'log-1',
    'deployJobs.unwatch': async () => true,
    'projects.list': [
      { id: 'proj-1', name: 'Shop', folderPath: 'C:\\work\\Shop' },
      { id: 'proj-2', name: 'Blog', folderPath: 'C:\\work\\blog' },
    ],
    'environments.list': [
      {
        id: 'env-1',
        projectId: 'proj-1',
        name: 'Production',
        kind: 'production',
        order: 0,
        files: [{ id: 'f1', fileName: '.env.production', keyCount: 2, updatedAt: T0 }],
        credentials: [],
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: 'env-2',
        projectId: 'proj-1',
        name: 'Staging',
        kind: 'staging',
        order: 1,
        files: [
          { id: 's1', fileName: '.env', keyCount: 5, updatedAt: T0 },
          { id: 's2', fileName: '.env.staging', keyCount: 3, updatedAt: T0 },
          { id: 's3', fileName: '.env.local', keyCount: 1, updatedAt: T0 },
        ],
        credentials: [],
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: 'env-3',
        projectId: 'proj-1',
        name: 'Preview',
        kind: 'development',
        order: 2,
        files: [],
        credentials: [],
        createdAt: T0,
        updatedAt: T0,
      },
    ],
  };
}
