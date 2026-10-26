import { describe, expect, it } from 'vitest';
import { LEGACY_CORE_PATHS } from '../deployLegacyNames.js';
import { type ComposeLintOptions, lintComposeProject, unacknowledgedRisks } from './lint.js';
import { parseComposeFile } from './parse.js';

function lint(lines: string[], options?: ComposeLintOptions) {
  const parsed = parseComposeFile(lines.join('\n'));
  if (!parsed.ok) throw new Error(parsed.reason);
  return lintComposeProject(parsed.project, options);
}

/** A tidy service with none of the low-level findings, to add one setting to at a time. */
function service(...settings: string[]): string[] {
  return [
    'services:',
    '  app:',
    '    image: nginx:1.27',
    '    restart: unless-stopped',
    '    healthcheck:',
    '      test: ["CMD", "true"]',
    ...settings.map((setting) => `    ${setting}`),
  ];
}

const ids = (risks: { id: string }[]) => risks.map((risk) => risk.id);

describe('lintComposeProject', () => {
  it('finds nothing in a tidy service', () => {
    expect(lint(service('volumes: ["./data:/data", "cache:/cache"]'))).toEqual([]);
  });

  it('flags the settings that hand the container the host', () => {
    const risks = lint(
      service(
        'privileged: true',
        'network_mode: host',
        'pid: host',
        'ipc: host',
        'uts: host',
        'userns_mode: host',
        'cgroup: host',
      ),
    );
    expect(risks.map((risk) => [risk.id, risk.severity])).toEqual([
      ['privileged:app', 'critical'],
      ['host-pid:app', 'critical'],
      ['host-network:app', 'high'],
      ['host-ipc:app', 'high'],
      ['host-userns:app', 'high'],
      ['host-uts:app', 'medium'],
      ['host-cgroup:app', 'medium'],
    ]);
  });

  it('classifies bind mounts by what they reach on the server', () => {
    const risks = lint(
      service(
        'volumes:',
        '  - /var/run/docker.sock:/var/run/docker.sock:ro',
        '  - /:/rootfs:ro',
        '  - /var/lib/runova-core:/core',
        '  - /etc/nginx:/etc/nginx',
        '  - /proc:/host/proc:ro',
        '  - ../../shared:/shared',
        '  - ~/.ssh:/root/.ssh:ro',
        '  - /etc/localtime:/etc/localtime:ro',
        '  - /srv/app/data:/data',
        '  - type: bind',
        '    source: /run',
        '    target: /host-run',
        '  - type: volume',
        '    source: cache',
        '    target: /cache',
      ),
    );
    expect(ids(lint(service('volumes:', `  - ${LEGACY_CORE_PATHS[0]}:/core`)))).toEqual([
      `core-data:app:${LEGACY_CORE_PATHS[0]}`,
    ]);
    expect(risks.map((risk) => [risk.id, risk.severity])).toEqual([
      ['docker-socket:app:/var/run/docker.sock', 'critical'],
      ['host-root:app:/', 'critical'],
      ['core-data:app:/var/lib/runova-core', 'critical'],
      ['sensitive-mount:app:/etc/nginx', 'critical'],
      ['sensitive-mount:app:/proc', 'high'],
      ['outside-project:app:../../shared', 'critical'],
      ['home-mount:app:~/.ssh', 'high'],
      ['docker-socket:app:/run', 'critical'],
    ]);
  });

  it('follows named volumes that bind a host folder', () => {
    const risks = lint([
      ...service('volumes: ["etc:/host-etc"]'),
      'volumes:',
      '  etc:',
      '    driver: local',
      '    driver_opts: { type: none, o: bind, device: /etc }',
    ]);
    expect(ids(risks)).toEqual(['core-data:app:/etc']);
    expect(risks[0].message).toMatch(/volume etc/);
  });

  it('lists each added capability, device and unconfined security option', () => {
    const risks = lint(
      service(
        'cap_add: [SYS_ADMIN, cap_net_admin, CHOWN, WAKE_ALARM]',
        'devices: ["/dev/fuse:/dev/fuse", "/dev/dri"]',
        'device_cgroup_rules: ["a *:* rwm"]',
        'security_opt:',
        '  - seccomp:unconfined',
        '  - apparmor=unconfined',
        '  - label:disable',
        '  - label=type:spc_t',
        '  - systempaths=unconfined',
        '  - no-new-privileges:true',
      ),
    );
    expect(risks.map((risk) => [risk.id, risk.severity])).toEqual([
      ['cap-add:app:SYS_ADMIN', 'critical'],
      ['cap-add:app:NET_ADMIN', 'high'],
      ['cap-add:app:CHOWN', 'low'],
      ['cap-add:app:WAKE_ALARM', 'high'],
      ['devices:app:/dev/fuse', 'high'],
      ['devices:app:/dev/dri', 'high'],
      ['device-cgroup-rule:app:a *:* rwm', 'high'],
      ['security-opt:app:seccomp=unconfined', 'high'],
      ['security-opt:app:apparmor=unconfined', 'high'],
      ['security-opt:app:label=disable', 'high'],
      ['security-opt:app:label=type:spc_t', 'high'],
      ['security-opt:app:systempaths=unconfined', 'high'],
    ]);
  });

  it('reports public ports unless the service sits behind the proxy', () => {
    const file = service(
      'ports: ["8080:80", "127.0.0.1:9000:9000", "0.0.0.0:53:53/udp", "10.0.0.5:2222:22", "${ADMIN}:81"]',
    );
    const risks = lint(file);
    expect(risks.map((risk) => [risk.id, risk.severity])).toEqual([
      ['public-port:app:*:8080:80/tcp', 'medium'],
      ['public-port:app:0.0.0.0:53:53/udp', 'medium'],
      ['public-port:app:10.0.0.5:2222:22/tcp', 'medium'],
      ['unreadable-port:app:4', 'medium'],
    ]);
    expect(ids(lint(file, { proxiedServices: ['app'] }))).toEqual(['unreadable-port:app:4']);
  });

  it('asks for labels on bind mounts only when SELinux enforces', () => {
    const file = service(
      'volumes: ["./data:/data", "./conf:/conf:ro,z", "./shared:/shared:Z", "named:/named"]',
    );
    expect(lint(file)).toEqual([]);
    expect(ids(lint(file, { selinuxEnforcing: true }))).toEqual(['selinux-label:app:data']);
    const long = service(
      'volumes:',
      '  - type: bind',
      '    source: ./x',
      '    target: /x',
      '    bind: { selinux: z }',
    );
    expect(lint(long, { selinuxEnforcing: true })).toEqual([]);
  });

  it('notes floating image tags, missing restart policies and healthchecks', () => {
    const risks = lint([
      'services:',
      '  a:',
      '    image: nginx',
      '  b:',
      '    image: nginx:latest',
      '    restart: "no"',
      '    healthcheck: { disable: true }',
      '  c:',
      '    image: registry.example.com:5000/team/app',
      '    deploy: { restart_policy: { condition: on-failure } }',
      '    healthcheck: { test: ["NONE"] }',
      '  d:',
      '    image: registry.example.com:5000/team/app:2.1',
      '    restart: always',
      '    healthcheck: { test: ["CMD", "true"] }',
      '  e:',
      '    image: nginx@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      '    restart: always',
      '    healthcheck: { test: ["CMD", "true"] }',
      '  f:',
      '    build: .',
      '    image: ${IMAGE}',
      '    restart: always',
      '    healthcheck: { test: ["CMD", "true"] }',
    ]);
    expect(risks.map((risk) => [risk.id, risk.severity])).toEqual([
      ['latest-tag:a:nginx', 'low'],
      ['no-restart:a', 'low'],
      ['no-healthcheck:a', 'low'],
      ['latest-tag:b:nginx:latest', 'low'],
      ['no-restart:b', 'low'],
      ['no-healthcheck:b', 'low'],
      ['latest-tag:c:registry.example.com:5000/team/app', 'low'],
      ['no-healthcheck:c', 'low'],
    ]);
  });

  it('flags files read from outside the upload', () => {
    const risks = lint([
      'include:',
      '  - ./other.yaml',
      '  - path: https://example.com/compose.yaml',
      'services:',
      '  app:',
      '    image: nginx:1.27',
      '    restart: always',
      '    healthcheck: { test: ["CMD", "true"] }',
      '    env_file: [.env, /etc/runova-core/core.json, { path: ../secrets.env, required: false }]',
      '    extends: { file: ../base.yaml, service: web }',
      '    build:',
      '      context: ../..',
      '      dockerfile: /etc/Dockerfile',
      '  remote:',
      '    build: https://github.com/example/app.git#main',
      '    restart: always',
      '    healthcheck: { test: ["CMD", "true"] }',
      'secrets:',
      '  shadow: { file: /etc/shadow }',
      '  local: { file: ./secret.txt }',
      'configs:',
      '  up: { file: ../config.json }',
    ]);
    expect(risks.map((risk) => [risk.id, risk.severity])).toEqual([
      ['include:-:./other.yaml', 'medium'],
      ['remote-include:-:https://example.com/compose.yaml', 'high'],
      ['host-file:-:secrets.shadow:/etc/shadow', 'high'],
      ['host-file:-:configs.up:../config.json', 'high'],
      ['env-file-outside:app:/etc/runova-core/core.json', 'high'],
      ['env-file-outside:app:../secrets.env', 'high'],
      ['extends-file:app:../base.yaml', 'medium'],
      ['build-outside:app:../..', 'high'],
      ['build-outside:app:/etc/Dockerfile', 'high'],
      ['remote-build:remote:https://github.com/example/app.git#main', 'medium'],
    ]);
  });

  it('gives every finding words to show, and ids that stay put until the file changes', () => {
    const file = service('privileged: true', 'volumes: ["/etc:/host-etc"]', 'ports: ["80:80"]');
    const first = lint(file);
    expect(ids(lint(file))).toEqual(ids(first));
    expect(
      ids(lint(service('privileged: true', 'volumes: ["/etc/ssl:/host-etc"]', 'ports: ["80:80"]'))),
    ).not.toEqual(ids(first));
    for (const risk of first) {
      expect(risk.message).toMatch(/^[A-Za-z].*[.]$/);
      expect(risk.advice).toMatch(/^[A-Z].*[.]$/);
      // The project's writing rule: no em dash in anything shown to people.
      expect(`${risk.message}${risk.advice}`).not.toContain(String.fromCodePoint(0x2014));
    }
    expect(new Set(ids(first)).size).toBe(first.length);
  });
});

describe('unacknowledgedRisks', () => {
  it('leaves out the findings already acknowledged', () => {
    const risks = lint(service('privileged: true', 'pid: host'));
    expect(ids(unacknowledgedRisks(risks, ['privileged:app']))).toEqual(['host-pid:app']);
    expect(unacknowledgedRisks(risks, new Set(ids(risks)))).toEqual([]);
  });
});
