import type {
  ContainerList,
  ContainerPortInfo,
  ContainerSummary,
  StackDetails,
  StackInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it } from 'vitest';
import { classifyContainer, findContainer, privateChange, publicAddress } from './makePrivate';

const container = (extra: Partial<ContainerSummary> = {}): ContainerSummary => ({
  id: 'c1',
  name: 'shop-web-1',
  image: 'nginx:1.29',
  imageId: 'sha256:1',
  state: 'running',
  status: 'Up',
  health: 'none',
  createdAtUnixMs: 1,
  ports: [],
  composeProject: 'shop',
  composeService: 'web',
  ...extra,
});

const PORT: ContainerPortInfo = {
  containerId: 'c1',
  containerName: 'shop-web-1',
  image: 'nginx:1.29',
  protocol: 'tcp',
  hostAddress: '0.0.0.0',
  hostPort: 8080,
  containerPort: 80,
  scope: 'public',
  firewall: 'bypassed',
};

const STACK = { id: 's1', name: 'shop' } as StackInfo;
const details = (ids: string[]): StackDetails =>
  ({
    stack: STACK,
    revisions: [],
    services: [{ name: 'web', containers: ids.map((id) => container({ id })), ports: [] }],
  }) as StackDetails;

describe('make private', () => {
  it('finds the container by id or name', () => {
    const list: ContainerList = {
      groups: [{ project: 'shop', containers: [container()] }],
    } as ContainerList;
    expect(findContainer(list, PORT)?.id).toBe('c1');
    expect(findContainer(list, { ...PORT, containerId: 'x', containerName: 'y' })).toBeNull();
  });

  it('calls a container Runova deployed an app, by the app listing it', () => {
    expect(classifyContainer(container(), [STACK], details(['c1']))).toEqual({
      kind: 'stack',
      stack: STACK,
      service: 'web',
    });
  });

  it('does not trust a compose project name alone', () => {
    expect(classifyContainer(container(), [STACK], details(['other']))).toEqual({
      kind: 'compose',
      project: 'shop',
      service: 'web',
    });
    expect(classifyContainer(container(), [], null)).toMatchObject({ kind: 'compose' });
    expect(classifyContainer(container({ composeProject: undefined }), [STACK], null)).toEqual({
      kind: 'run',
    });
    expect(classifyContainer(null, [STACK], null)).toEqual({ kind: 'run' });
  });

  it('writes the change to make for compose and for docker run', () => {
    expect(privateChange({ kind: 'compose', project: 'shop', service: 'web' }, PORT)).toBe(
      'services:\n  web:\n    ports:\n      - "127.0.0.1:8080:80"',
    );
    expect(privateChange({ kind: 'run' }, { ...PORT, protocol: 'udp' })).toBe(
      'docker run -p 127.0.0.1:8080:80/udp ... nginx:1.29',
    );
    expect(publicAddress({ ...PORT, hostAddress: '::' })).toBe('[::]:8080');
  });
});
