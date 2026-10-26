import { LEGACY_CORE_PATHS } from '../deployLegacyNames.js';
import { dockerCleanPath } from '../dockerignore.js';
import type { ComposeProject } from './parse.js';
import { analyzeComposePorts, type ComposeServicePorts } from './ports.js';

/**
 * Finds what in a compose file reaches past the container: privileged mode, the host's
 * namespaces, the Docker socket and system folders, added capabilities and devices, switched-off
 * confinement, ports published on public interfaces, and files read from outside the upload.
 * Also the quieter problems that make deploys unreliable: floating tags, no restart policy, no
 * healthcheck, and SELinux labels on servers that enforce it.
 *
 * Every finding has an id built from its rule, its service and what it concerns (a path, a
 * capability, a port), so it stays the same for the same file and changes when that part of
 * the file does. The app asks for an acknowledgment per id and records it in the audit trail.
 */

export type ComposeRiskSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ComposeRiskRule =
  | 'privileged'
  | 'host-pid'
  | 'host-network'
  | 'host-ipc'
  | 'host-userns'
  | 'host-uts'
  | 'host-cgroup'
  | 'docker-socket'
  | 'host-root'
  | 'core-data'
  | 'sensitive-mount'
  | 'outside-project'
  | 'home-mount'
  | 'selinux-label'
  | 'cap-add'
  | 'devices'
  | 'device-cgroup-rule'
  | 'security-opt'
  | 'public-port'
  | 'unreadable-port'
  | 'latest-tag'
  | 'no-restart'
  | 'no-healthcheck'
  | 'include'
  | 'remote-include'
  | 'extends-file'
  | 'env-file-outside'
  | 'build-outside'
  | 'remote-build'
  | 'host-file';

export interface ComposeRisk {
  /** Stable for the same finding in the same file; what an acknowledgment is recorded against. */
  id: string;
  rule: ComposeRiskRule;
  severity: ComposeRiskSeverity;
  /** The service it concerns, or null for the file as a whole. */
  service: string | null;
  /** What was found, in one sentence. */
  message: string;
  /** What it allows, and what to do instead. */
  advice: string;
}

export interface ComposeLintOptions {
  /**
   * Services the app will put behind the proxy. The loopback override binds their ports to
   * 127.0.0.1, so those ports are not reported as public.
   */
  proxiedServices?: readonly string[];
  /** The server enforces SELinux, so bind mounts need a :z or :Z label to be readable. */
  selinuxEnforcing?: boolean;
}

type Add = (risk: ComposeRisk) => void;

function risk(
  rule: ComposeRiskRule,
  severity: ComposeRiskSeverity,
  service: string | null,
  subject: string | null,
  message: string,
  advice: string,
): ComposeRisk {
  const id =
    subject === null ? `${rule}:${service ?? '-'}` : `${rule}:${service ?? '-'}:${subject}`;
  return { id, rule, severity, service, message, advice };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

/** The checks that turn on one of the host's namespaces, in the order they are reported. */
const HOST_SETTINGS: {
  key: string;
  rule: ComposeRiskRule;
  severity: ComposeRiskSeverity;
  message: (service: string) => string;
  advice: string;
}[] = [
  {
    key: 'privileged',
    rule: 'privileged',
    severity: 'critical',
    message: (s) => `${s} runs privileged.`,
    advice:
      'A privileged container can do anything root can on the server: read every file, load kernel modules, reach every device. Grant only the capabilities it needs with cap_add instead.',
  },
  {
    key: 'pid',
    rule: 'host-pid',
    severity: 'critical',
    message: (s) => `${s} shares the server's process list (pid: host).`,
    advice:
      'It can see every process on the server and, as root, signal or trace them. Leave pid unset unless the tool truly needs it.',
  },
  {
    key: 'network_mode',
    rule: 'host-network',
    severity: 'high',
    message: (s) => `${s} uses the server's network directly (network_mode: host).`,
    advice:
      "Everything it listens on is reachable on all of the server's addresses, and neither the proxy nor a loopback binding can contain it. Publish the ports it needs instead.",
  },
  {
    key: 'ipc',
    rule: 'host-ipc',
    severity: 'high',
    message: (s) => `${s} shares the server's shared memory (ipc: host).`,
    advice: "It can read and disturb other processes' shared memory. Leave ipc unset.",
  },
  {
    key: 'userns_mode',
    rule: 'host-userns',
    severity: 'high',
    message: (s) => `${s} turns off user namespace remapping (userns_mode: host).`,
    advice:
      'Root in the container is then root on the server wherever the two meet. Leave userns_mode unset.',
  },
  {
    key: 'uts',
    rule: 'host-uts',
    severity: 'medium',
    message: (s) => `${s} shares the server's hostname (uts: host).`,
    advice: "It can change the server's hostname. Leave uts unset.",
  },
  {
    key: 'cgroup',
    rule: 'host-cgroup',
    severity: 'medium',
    message: (s) => `${s} uses the server's control groups (cgroup: host).`,
    advice:
      "It can see the server's control groups and the limits of other containers. Leave cgroup unset.",
  },
];

/** Container runtime sockets, the folders that hold them, and /run, which holds them all. */
const SOCKET_PATHS = [
  '/run',
  '/var/run',
  '/run/docker.sock',
  '/var/run/docker.sock',
  '/run/docker',
  '/var/run/docker',
  '/run/containerd',
  '/var/run/containerd',
  '/run/podman',
  '/var/run/podman',
  '/run/crio',
  '/var/run/crio',
];

/**
 * Where the Runova core keeps its binary, settings, data and socket, and where a core from
 * before the rename kept them (links to the new ones once a server has migrated).
 */
const CORE_PATHS = [
  '/var/lib/runova-core',
  '/etc/runova-core',
  '/opt/runova-core',
  '/run/runova-core',
  ...LEGACY_CORE_PATHS,
];

/** System folders. A writable mount lets a container change the server; read-only, read secrets. */
const SENSITIVE_PATHS = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
  '/home',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/var/lib',
  '/var/log',
  '/var/spool',
];

/** Read-only mounts that images routinely ask for and that give nothing away. */
const HARMLESS_READ_ONLY = ['/etc/localtime', '/etc/timezone', '/usr/share/zoneinfo'];

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

type PathRule = Extract<
  ComposeRiskRule,
  'docker-socket' | 'host-root' | 'core-data' | 'sensitive-mount' | 'outside-project' | 'home-mount'
>;

/** What a host path reaches, worst first, or null when it is an ordinary folder. */
function classifyHostPath(
  source: string,
  readOnly: boolean,
): { rule: PathRule; severity: ComposeRiskSeverity; path: string } | null {
  if (source === '~' || source.startsWith('~/')) {
    return { rule: 'home-mount', severity: 'high', path: source };
  }
  if (!source.startsWith('/')) {
    const cleaned = dockerCleanPath(source);
    return cleaned === '..' || cleaned.startsWith('../')
      ? { rule: 'outside-project', severity: 'critical', path: cleaned }
      : null;
  }
  const path = dockerCleanPath(source);
  if (path === '/') return { rule: 'host-root', severity: 'critical', path };
  if (SOCKET_PATHS.some((socket) => within(path, socket))) {
    return { rule: 'docker-socket', severity: 'critical', path };
  }
  if (CORE_PATHS.some((core) => within(path, core) || within(core, path))) {
    return { rule: 'core-data', severity: 'critical', path };
  }
  if (readOnly && HARMLESS_READ_ONLY.some((harmless) => within(path, harmless))) return null;
  if (SENSITIVE_PATHS.some((folder) => within(path, folder))) {
    return { rule: 'sensitive-mount', severity: readOnly ? 'high' : 'critical', path };
  }
  return null;
}

interface Mount {
  source: string;
  readOnly: boolean;
  labelled: boolean;
  /** The named volume that binds this host path, when it came through one. */
  volume: string | null;
}

/** A named volume that the local driver turns into a bind mount of a host folder. */
function volumeDevice(data: Record<string, unknown>, name: string): string | null {
  const volumes = data.volumes;
  if (!isRecord(volumes)) return null;
  const volume = volumes[name];
  if (!isRecord(volume) || !isRecord(volume.driver_opts)) return null;
  if (volume.driver !== undefined && volume.driver !== 'local') return null;
  const { o, device } = volume.driver_opts;
  if (typeof device !== 'string' || !/(^|,)\s*r?bind\s*(,|$)/.test(String(o ?? ''))) return null;
  return device;
}

function serviceMounts(
  definition: Record<string, unknown>,
  data: Record<string, unknown>,
): Mount[] {
  const mounts: Mount[] = [];
  const named = (name: string, readOnly: boolean) => {
    const device = volumeDevice(data, name);
    if (device) mounts.push({ source: device, readOnly, labelled: true, volume: name });
  };
  for (const entry of asList(definition.volumes)) {
    if (typeof entry === 'string') {
      const parts = entry.split(':');
      if (parts.length < 2 || parts[0] === '') continue;
      const options = parts.length > 2 ? parts[2].split(',') : [];
      const readOnly = options.includes('ro');
      const source = parts[0];
      if (/^[/.~]/.test(source)) {
        mounts.push({
          source,
          readOnly,
          labelled: options.includes('z') || options.includes('Z'),
          volume: null,
        });
      } else {
        named(source, readOnly);
      }
    } else if (isRecord(entry) && typeof entry.source === 'string') {
      const readOnly = entry.read_only === true;
      if (entry.type === 'bind') {
        const selinux = isRecord(entry.bind) ? entry.bind.selinux : undefined;
        mounts.push({
          source: entry.source,
          readOnly,
          labelled: selinux === 'z' || selinux === 'Z',
          volume: null,
        });
      } else if (entry.type === 'volume' || entry.type === undefined) {
        named(entry.source, readOnly);
      }
    }
  }
  return mounts;
}

function mountRisk(service: string, mount: Mount): ComposeRisk | null {
  const found = classifyHostPath(mount.source, mount.readOnly);
  if (!found) return null;
  const { rule, severity, path } = found;
  const through = mount.volume ? ` through the volume ${mount.volume}` : '';
  const texts: Record<PathRule, [string, string]> = {
    'docker-socket': [
      `${service} mounts ${path}${through}, which reaches the Docker socket.`,
      'Whoever controls the container can then start a privileged one and take over the server. Read-only does not help, since the API is reached through the socket. Mount it only for tools you trust completely.',
    ],
    'host-root': [
      `${service} mounts the server's whole filesystem (/)${through}.`,
      'The container can read every file on the server, keys and passwords included, and change them unless the mount is read-only. Mount only the folders it needs.',
    ],
    'core-data': [
      `${service} mounts ${path}${through}, which holds Runova's own server files.`,
      "The core's database, keys and program live there, and a container that reaches them can take over the core. Mount a folder of the app's own instead.",
    ],
    'sensitive-mount': [
      `${service} mounts the server folder ${path}${mount.readOnly ? ' read-only' : ''}${through}.`,
      mount.readOnly
        ? 'Even read-only it can read the configuration and credentials kept there. Mount a narrower path, or copy what it needs into the project.'
        : 'A writable mount lets the container change the server itself. Mount a narrower path read-only, or copy what it needs into the project.',
    ],
    'outside-project': [
      `${service} mounts ${path}${through}, which leads outside the app's folder.`,
      "On the server the app's folder sits inside Runova's data, so a path with .. can reach the core's own files. Keep bind mounts inside the project.",
    ],
    'home-mount': [
      `${service} mounts ${path}${through} from a home folder.`,
      "On the server that is root's home, with its SSH keys. Use a path inside the project instead.",
    ],
  };
  const [message, advice] = texts[rule];
  return risk(rule, severity, service, path, message, advice);
}

/** The capabilities Docker grants every container anyway. */
const DEFAULT_CAPABILITIES = new Set([
  'CHOWN',
  'DAC_OVERRIDE',
  'FSETID',
  'FOWNER',
  'MKNOD',
  'NET_RAW',
  'SETGID',
  'SETUID',
  'SETFCAP',
  'SETPCAP',
  'NET_BIND_SERVICE',
  'SYS_CHROOT',
  'KILL',
  'AUDIT_WRITE',
]);

/** Capabilities that are known ways out of a container. */
const ESCAPE_CAPABILITIES = new Set([
  'ALL',
  'SYS_ADMIN',
  'SYS_MODULE',
  'SYS_RAWIO',
  'SYS_PTRACE',
  'SYS_BOOT',
  'DAC_READ_SEARCH',
  'MAC_ADMIN',
  'MAC_OVERRIDE',
  'BPF',
]);

/** Capabilities that change settings the whole server shares. */
const SERVER_CAPABILITIES = new Set([
  'NET_ADMIN',
  'SYS_TIME',
  'SYSLOG',
  'SYS_RESOURCE',
  'LINUX_IMMUTABLE',
  'AUDIT_CONTROL',
  'AUDIT_READ',
  'IPC_OWNER',
  'WAKE_ALARM',
  'BLOCK_SUSPEND',
]);

function capabilityRisk(service: string, raw: unknown): ComposeRisk | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const capability = raw.toUpperCase().replace(/^CAP_/, '');
  const message =
    capability === 'ALL'
      ? `${service} adds every capability (cap_add: ALL).`
      : `${service} adds the capability ${capability}.`;
  if (ESCAPE_CAPABILITIES.has(capability)) {
    return risk(
      'cap-add',
      'critical',
      service,
      capability,
      message,
      'With it, root in the container can break out to the server. Remove it, or give the tool a server of its own.',
    );
  }
  if (SERVER_CAPABILITIES.has(capability)) {
    return risk(
      'cap-add',
      'high',
      service,
      capability,
      message,
      'It reaches past the container into settings the whole server shares. Keep it only if the service needs it.',
    );
  }
  if (DEFAULT_CAPABILITIES.has(capability)) {
    return risk(
      'cap-add',
      'low',
      service,
      capability,
      message,
      'Docker already grants it, so this line changes nothing and can go.',
    );
  }
  return risk(
    'cap-add',
    'medium',
    service,
    capability,
    message,
    'Docker leaves it out by default for a reason. Keep it only if the service needs it.',
  );
}

const UNCONFINED: Record<string, [string, string]> = {
  'seccomp=unconfined': [
    'turns off its system call filter (seccomp=unconfined)',
    'The filter blocks the kernel calls containers have no use for, which are the ones escapes rely on. Remove the option, or pass a custom profile.',
  ],
  'apparmor=unconfined': [
    'runs without an AppArmor profile (apparmor=unconfined)',
    'AppArmor keeps a compromised container away from the rest of the server. Remove the option.',
  ],
  'label=disable': [
    'turns off SELinux separation (label=disable)',
    'SELinux keeps a compromised container away from the rest of the server. Label its mounts with :z or :Z instead.',
  ],
  'label=type:spc_t': [
    'runs as a super privileged SELinux container (spc_t)',
    'That type is exempt from SELinux separation. Remove the option.',
  ],
  'systempaths=unconfined': [
    'can see all of /proc and /sys (systempaths=unconfined)',
    'Docker masks the parts of /proc and /sys that let a container change the kernel. Remove the option.',
  ],
};

/** `key:value` and `key=value` are the same option to Docker. */
function normalizeSecurityOption(option: string): string {
  const separator = option.search(/[:=]/);
  return separator < 0 ? option : `${option.slice(0, separator)}=${option.slice(separator + 1)}`;
}

function portRisks(service: string, ports: ComposeServicePorts, proxied: boolean, add: Add): void {
  if (!proxied) {
    for (const binding of ports.bindings) {
      if (binding.exposure === 'loopback') continue;
      const where = binding.hostIp === null ? 'every interface' : binding.hostIp;
      const as = binding.published === null ? 'a port Docker picks' : `port ${binding.published}`;
      add(
        risk(
          'public-port',
          'medium',
          service,
          `${binding.hostIp ?? '*'}:${binding.published ?? 'any'}:${binding.target}/${binding.protocol}`,
          `${service} publishes ${binding.target}/${binding.protocol} on ${where} as ${as}.`,
          "Published ports skip the server's firewall. Put the service behind the proxy, which binds it to 127.0.0.1 only, or bind it to 127.0.0.1 yourself if nothing outside the server needs it.",
        ),
      );
    }
  }
  for (const problem of ports.problems) {
    add(
      risk(
        'unreadable-port',
        'medium',
        service,
        String(problem.index),
        `${service} has a port entry that could not be read. ${problem.reason}`,
        'Until it can be read there is no telling where it is published. Set the variables it uses, or write the port out.',
      ),
    );
  }
}

const REMOTE = /^([a-z][a-z0-9+.-]*:\/\/|git@|github\.com\/)/i;

const leavesProject = (path: string): boolean => {
  if (path.startsWith('/') || path.startsWith('~')) return true;
  const cleaned = dockerCleanPath(path);
  return cleaned === '..' || cleaned.startsWith('../');
};

function fileRisks(service: string, definition: Record<string, unknown>, add: Add): void {
  for (const entry of asList(definition.env_file)) {
    const path = typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined;
    if (typeof path === 'string' && leavesProject(path)) {
      add(
        risk(
          'env-file-outside',
          'high',
          service,
          path,
          `${service} reads environment variables from ${path}.`,
          "That file is outside the project, so the container gets whatever it holds, such as the core's own settings. Keep env files in the project, or use the app's environment.",
        ),
      );
    }
  }

  const { extends: base } = definition;
  if (isRecord(base) && typeof base.file === 'string') {
    add(
      risk(
        'extends-file',
        'medium',
        service,
        base.file,
        `${service} extends a service from ${base.file}.`,
        'Only the compose file, its .env and the build context are uploaded, so the server cannot read that file. Copy the service into this file.',
      ),
    );
  }

  const { build } = definition;
  const sources: string[] = [];
  if (typeof build === 'string') sources.push(build);
  if (isRecord(build)) {
    if (typeof build.context === 'string') sources.push(build.context);
    if (typeof build.dockerfile === 'string') sources.push(build.dockerfile);
    if (isRecord(build.additional_contexts)) {
      for (const value of Object.values(build.additional_contexts)) {
        if (
          typeof value === 'string' &&
          !/^(docker-image|oci-layout|service|target):/.test(value)
        ) {
          sources.push(value);
        }
      }
    }
  }
  for (const source of sources) {
    if (REMOTE.test(source)) {
      add(
        risk(
          'remote-build',
          'medium',
          service,
          source,
          `${service} builds from ${source}.`,
          'The source is fetched at deploy time, so whoever controls it controls what runs. Build from the project instead.',
        ),
      );
    } else if (leavesProject(source)) {
      add(
        risk(
          'build-outside',
          'high',
          service,
          source,
          `${service} builds from ${source}, outside the project.`,
          "Docker would send that part of the server's disk to the builder. Keep the build context and Dockerfile inside the project.",
        ),
      );
    }
  }
}

function imageRisks(service: string, definition: Record<string, unknown>, add: Add): void {
  const { image } = definition;
  if (typeof image === 'string' && image !== '' && !image.includes('$') && !image.includes('@')) {
    const last = image.slice(image.lastIndexOf('/') + 1);
    const colon = last.lastIndexOf(':');
    const tag = colon < 0 ? null : last.slice(colon + 1);
    if (tag === null || tag === 'latest') {
      add(
        risk(
          'latest-tag',
          'low',
          service,
          image,
          tag === null
            ? `${service} uses ${image} without a tag, so Docker pulls :latest.`
            : `${service} uses ${image}, which follows whatever was published last.`,
          'Each deploy may pull a different version, and a rollback cannot bring the old one back. Pin a version such as nginx:1.27, or a digest.',
        ),
      );
    }
  }

  const { restart, deploy } = definition;
  const policy = isRecord(deploy) && deploy.restart_policy !== undefined;
  if ((restart === undefined || restart === 'no') && !policy) {
    add(
      risk(
        'no-restart',
        'low',
        service,
        null,
        `${service} has no restart policy.`,
        'It stays down after a crash or a server reboot. Add restart: unless-stopped.',
      ),
    );
  }

  const { healthcheck } = definition;
  const test = isRecord(healthcheck) ? healthcheck.test : undefined;
  const none = Array.isArray(test) && test[0] === 'NONE';
  if (!isRecord(healthcheck) || healthcheck.disable === true || none) {
    add(
      risk(
        'no-healthcheck',
        'low',
        service,
        null,
        `${service} has no healthcheck.`,
        'Unless its image defines one, a deploy cannot tell when the service is ready, and a hung service looks healthy. Add a healthcheck that tests what the service does.',
      ),
    );
  }
}

function lintService(
  service: string,
  definition: Record<string, unknown>,
  ports: ComposeServicePorts,
  data: Record<string, unknown>,
  options: { proxied: boolean; selinux: boolean },
  add: Add,
): void {
  for (const setting of HOST_SETTINGS) {
    const value = definition[setting.key];
    const on = setting.key === 'privileged' ? value === true || value === 'true' : value === 'host';
    if (on)
      add(
        risk(
          setting.rule,
          setting.severity,
          service,
          null,
          setting.message(service),
          setting.advice,
        ),
      );
  }

  for (const mount of serviceMounts(definition, data)) {
    const found = mountRisk(service, mount);
    if (found) add(found);
    if (options.selinux && mount.volume === null && !mount.labelled) {
      const path = dockerCleanPath(mount.source);
      add(
        risk(
          'selinux-label',
          'low',
          service,
          path,
          `${service} bind-mounts ${path} without :z or :Z.`,
          'With SELinux enforcing, the container cannot read it. Add :z if other containers share the folder, or :Z if only this one uses it.',
        ),
      );
    }
  }

  for (const capability of asList(definition.cap_add)) {
    const found = capabilityRisk(service, capability);
    if (found) add(found);
  }

  for (const device of asList(definition.devices)) {
    const path =
      typeof device === 'string'
        ? device.split(':')[0]
        : isRecord(device)
          ? device.source
          : undefined;
    if (typeof path !== 'string' || path === '') continue;
    add(
      risk(
        'devices',
        'high',
        service,
        path,
        `${service} gets direct access to the device ${path}.`,
        'Through a device a container can often reach the kernel. Pass only the devices the service needs, such as one GPU.',
      ),
    );
  }
  for (const rule of asList(definition.device_cgroup_rules)) {
    if (typeof rule !== 'string') continue;
    add(
      risk(
        'device-cgroup-rule',
        'high',
        service,
        rule,
        `${service} is allowed devices by the rule "${rule}".`,
        'Device rules let the container create and use device files. Remove the rule unless the service needs it.',
      ),
    );
  }

  for (const option of asList(definition.security_opt)) {
    if (typeof option !== 'string') continue;
    const normalized = normalizeSecurityOption(option);
    const found = UNCONFINED[normalized];
    if (found) {
      add(risk('security-opt', 'high', service, normalized, `${service} ${found[0]}.`, found[1]));
    }
  }

  portRisks(service, ports, options.proxied, add);
  fileRisks(service, definition, add);
  imageRisks(service, definition, add);
}

function lintTopLevel(data: Record<string, unknown>, add: Add): void {
  for (const entry of asList(data.include)) {
    const paths = typeof entry === 'string' ? [entry] : isRecord(entry) ? asList(entry.path) : [];
    for (const path of paths) {
      if (typeof path !== 'string') continue;
      if (REMOTE.test(path) || path.startsWith('oci://')) {
        add(
          risk(
            'remote-include',
            'high',
            null,
            path,
            `The file includes ${path} from the network.`,
            'It is fetched at deploy time, so whoever controls it controls what runs. Copy it into this file.',
          ),
        );
      } else {
        add(
          risk(
            'include',
            'medium',
            null,
            path,
            `The file includes ${path}.`,
            'Only the compose file, its .env and the build context are uploaded, so the server cannot read included files. Merge it into this file.',
          ),
        );
      }
    }
  }

  for (const kind of ['secrets', 'configs'] as const) {
    const section = data[kind];
    if (!isRecord(section)) continue;
    for (const [name, item] of Object.entries(section)) {
      if (!isRecord(item) || typeof item.file !== 'string' || !leavesProject(item.file)) continue;
      const reach = classifyHostPath(item.file, true);
      const severe =
        reach !== null && ['host-root', 'docker-socket', 'core-data'].includes(reach.rule);
      add(
        risk(
          'host-file',
          severe ? 'critical' : 'high',
          null,
          `${kind}.${name}:${item.file}`,
          `The ${kind === 'secrets' ? 'secret' : 'config'} ${name} reads ${item.file} from the server.`,
          'Every container that uses it can read that file. Keep secret and config files inside the project.',
        ),
      );
    }
  }
}

/** Every finding in the project, file-wide ones first, then service by service in file order. */
export function lintComposeProject(
  project: ComposeProject,
  options: ComposeLintOptions = {},
): ComposeRisk[] {
  const risks: ComposeRisk[] = [];
  const seen = new Set<string>();
  const add: Add = (found) => {
    if (seen.has(found.id)) return;
    seen.add(found.id);
    risks.push(found);
  };
  lintTopLevel(project.data, add);
  const proxied = new Set(options.proxiedServices ?? []);
  const ports = analyzeComposePorts(project);
  for (const [index, { name, definition }] of project.services.entries()) {
    lintService(
      name,
      definition,
      ports[index],
      project.data,
      { proxied: proxied.has(name), selinux: options.selinuxEnforcing === true },
      add,
    );
  }
  return risks;
}

/** The findings still waiting for an acknowledgment. */
export function unacknowledgedRisks(
  risks: readonly ComposeRisk[],
  acknowledged: Iterable<string>,
): ComposeRisk[] {
  const done = new Set(acknowledged);
  return risks.filter((found) => !done.has(found.id));
}
