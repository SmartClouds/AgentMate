import { Document, YAMLSeq } from 'yaml';
import type { ComposeProject } from './parse.js';
import { analyzeComposePorts, type ComposePortBinding } from './ports.js';

/**
 * The override file that keeps services behind the proxy off the public interfaces: every port
 * they publish is bound to 127.0.0.1 instead, so nginx on the same server reaches them and
 * nothing outside does. The user's compose file stays untouched; the core passes this file to
 * `docker compose` after it.
 *
 * It has to use Compose's `!override` tag. A plain override file merges `ports:` by adding to the
 * list, so the original binding on every interface would survive next to the loopback one.
 * `!override` replaces the list instead, which needs Docker Compose 2.24.4 or later.
 *
 * The bindings are written out in full (long syntax, one per port, ranges expanded) from the
 * file as read with the stack's environment, which is what Compose sees on the server.
 */

export const MIN_COMPOSE_VERSION_FOR_OVERRIDE = '2.24.4';

export const LOOPBACK_HOST_IP = '127.0.0.1';

const HEADER = [
  ' Written by Runova: services behind the proxy publish their ports on 127.0.0.1 only.',
  ' !override replaces their ports rather than adding to them (Docker Compose 2.24.4 or later).',
].join('\n');

export interface LoopbackOverride {
  /** The override file. */
  text: string;
  /** Each binding of the proxied services as it is once the override applies. */
  rebound: ComposePortBinding[];
  /** Proxied services that publish no port, so the proxy has nothing on loopback to reach. */
  unpublished: string[];
}

export type LoopbackOverrideResult =
  | { ok: true; override: LoopbackOverride }
  | { ok: false; reason: string; service?: string };

/** Whether `docker compose version` output names a version that understands `!override`. */
export function composeSupportsOverride(version: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  const needed = MIN_COMPOSE_VERSION_FOR_OVERRIDE.split('.').map(Number);
  for (let part = 0; part < 3; part++) {
    if (actual[part] !== needed[part]) return actual[part] > needed[part];
  }
  return true;
}

/**
 * The override that binds every published port of these services to 127.0.0.1. Refuses, with a
 * reason, a service it cannot do that for: one that does not exist, one on the host's network,
 * or one with a port entry it cannot read.
 */
export function renderLoopbackOverride(
  project: ComposeProject,
  services: readonly string[],
): LoopbackOverrideResult {
  const wanted = new Set(services);
  const known = new Set(project.services.map((service) => service.name));
  for (const name of wanted) {
    if (!known.has(name)) {
      return {
        ok: false,
        service: name,
        reason: `There is no service called ${name} in the compose file.`,
      };
    }
  }

  const document = new Document({ services: {} });
  document.commentBefore = HEADER;
  const rebound: ComposePortBinding[] = [];
  const unpublished: string[] = [];
  for (const ports of analyzeComposePorts(project)) {
    const { service } = ports;
    if (!wanted.has(service)) continue;
    if (ports.hostNetwork) {
      return {
        ok: false,
        service,
        reason: `${service} uses network_mode: host, so it listens on the server's own addresses and has no ports to bind to 127.0.0.1. Remove network_mode: host to put it behind the proxy.`,
      };
    }
    const [problem] = ports.problems;
    if (problem) {
      return {
        ok: false,
        service,
        reason: `The ports of ${service} can't be bound to 127.0.0.1 until every entry can be read. ${problem.reason}`,
      };
    }
    if (ports.bindings.length === 0) {
      unpublished.push(service);
      continue;
    }
    const list = new YAMLSeq();
    list.tag = '!override';
    for (const binding of ports.bindings) {
      const loopback: ComposePortBinding = {
        ...binding,
        hostIp: LOOPBACK_HOST_IP,
        exposure: 'loopback',
      };
      rebound.push(loopback);
      list.items.push(document.createNode(longSyntax(loopback)));
    }
    document.setIn(['services', service, 'ports'], list);
  }
  return { ok: true, override: { text: document.toString(), rebound, unpublished } };
}

/** Compose interpolates override files too, so a literal `$` is written as `$$`. */
const literal = (text: string) => text.replaceAll('$', () => '$$');

function longSyntax(binding: ComposePortBinding): Record<string, unknown> {
  return {
    target: binding.target,
    ...(binding.published === null ? {} : { published: binding.published }),
    host_ip: LOOPBACK_HOST_IP,
    protocol: binding.protocol,
    ...(binding.name === null ? {} : { name: literal(binding.name) }),
    ...(binding.appProtocol === null ? {} : { app_protocol: literal(binding.appProtocol) }),
  };
}
