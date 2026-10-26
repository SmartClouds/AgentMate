import type {
  ContainerList,
  ContainerPortInfo,
  ContainerSummary,
  StackDetails,
  StackInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * "Make private" for a container port the exposure view flags (E13). A container from an
 * Runova app is redeployed with that service on 127.0.0.1; anything else is shown the change
 * to make where it was started, since Runova did not start it and cannot redeploy it.
 */

export type MakePrivateTarget =
  | { kind: 'stack'; stack: StackInfo; service: string }
  | { kind: 'compose'; project: string; service: string }
  | { kind: 'run' };

export function findContainer(
  list: ContainerList,
  port: ContainerPortInfo,
): ContainerSummary | null {
  for (const group of list.groups) {
    for (const container of group.containers) {
      if (container.id === port.containerId || container.name === port.containerName) {
        return container;
      }
    }
  }
  return null;
}

/**
 * Whose container it is. A compose project is a Runova app only when an app of that name
 * lists this very container among its services: another compose project can share the name.
 */
export function classifyContainer(
  container: ContainerSummary | null,
  stacks: readonly StackInfo[],
  details: StackDetails | null,
): MakePrivateTarget {
  if (!container?.composeProject) return { kind: 'run' };
  const service = container.composeService ?? container.name;
  const stack = stacks.find((item) => item.name === container.composeProject);
  if (stack && details && details.stack.id === stack.id) {
    const owner = details.services.find((item) =>
      item.containers.some((member) => member.id === container.id),
    );
    if (owner) return { kind: 'stack', stack, service: owner.name };
  }
  return { kind: 'compose', project: container.composeProject, service };
}

const portPair = (port: ContainerPortInfo) =>
  `${port.hostPort}${port.hostPortTo ? `-${port.hostPortTo}` : ''}:${port.containerPort}${port.containerPortTo ? `-${port.containerPortTo}` : ''}`;

/** The edit that keeps the port on the server only, for a container Runova did not start. */
export function privateChange(target: MakePrivateTarget, port: ContainerPortInfo): string {
  const protocol = port.protocol === 'udp' ? '/udp' : '';
  const binding = `127.0.0.1:${portPair(port)}${protocol}`;
  if (target.kind === 'run') {
    return `docker run -p ${binding} ... ${port.image}`;
  }
  return ['services:', `  ${target.service}:`, '    ports:', `      - "${binding}"`].join('\n');
}

/** How the port is reached now, as the exposure view writes it. */
export function publicAddress(port: ContainerPortInfo): string {
  const host = port.hostAddress.includes(':') ? `[${port.hostAddress}]` : port.hostAddress;
  return `${host}:${port.hostPort}`;
}
