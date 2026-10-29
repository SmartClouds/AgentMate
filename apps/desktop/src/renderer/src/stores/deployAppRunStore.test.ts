import { describe, expect, it, vi } from 'vitest';
import {
  SERVER,
  STACK_ID,
  sampleJob,
  sampleRevision,
  uploadResult,
} from '@/components/deploy/apps/testing/fixtures';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { appEnvFilesKey, useDeployAppEnvFilesStore } from './deployAppEnvFilesStore';
import {
  type AppDeployInput,
  emptyDraft,
  useDeployAppRunStore,
  wizardKey,
} from './deployAppRunStore';

/**
 * A New App deploy (upload, the server's findings, the deploy itself) runs from here rather than
 * from the wizard, so leaving the Deploy page neither loses it nor strands a step that waits for
 * the user, and coming back shows where it got to.
 */

const KEY = wizardKey(SERVER.id, null);

const INPUT: AppDeployInput = {
  serverId: SERVER.id,
  existingStackId: null,
  name: 'shop',
  projectId: 'proj-1',
  composePath: 'compose.yaml',
  environmentId: 'env-1',
  envFileIds: null,
  proxiedServices: ['web'],
  acknowledgedRisks: [],
};

const picks = () => useDeployAppEnvFilesStore.getState().picks;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const wizard = () => useDeployAppRunStore.getState().wizards[KEY];
const store = () => useDeployAppRunStore.getState();

function start(
  bridge: Record<string, unknown>,
  onSettled = vi.fn(),
): {
  bridge: FakeBridge;
  done: Promise<void>;
  onSettled: ReturnType<typeof vi.fn>;
} {
  const fake = installRunovaBridge(bridge);
  store().open(KEY, emptyDraft());
  return { bridge: fake, done: store().startDeploy(KEY, INPUT, onSettled), onSettled };
}

describe('deployAppRunStore', () => {
  it('opens a wizard once, and keeps its draft', () => {
    store().open(KEY, emptyDraft());
    store().setDraft(KEY, { step: 'expose', reached: 2 });
    store().open(KEY, emptyDraft());
    expect(wizard().draft.step).toBe('expose');
    expect(wizard().draft.reached).toBe(2);
    expect(wizard().run).toEqual({ phase: 'idle' });
  });

  it('uploads, then deploys, and follows the upload of its own server only', async () => {
    const upload = deferred<unknown>();
    const { bridge, done, onSettled } = start({
      'deployStacks.create': () => upload.promise,
      'deployStacks.deploy': sampleJob(),
    });
    expect(wizard().run).toEqual({ phase: 'uploading' });
    expect(wizard().draft.step).toBe('deploy');
    expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      name: 'shop',
      projectId: 'proj-1',
      composePath: 'compose.yaml',
      environmentId: 'env-1',
      proxiedServices: ['web'],
      acknowledgedRisks: [],
    });

    bridge.$emit('deployStacks.onUploadProgress', {
      serverId: SERVER.id,
      phase: 'packing',
    });
    bridge.$emit('deployStacks.onUploadProgress', { serverId: 'other', phase: 'done' });
    expect(wizard().progress?.phase).toBe('packing');

    upload.resolve(uploadResult());
    await done;
    expect(wizard().run).toMatchObject({ phase: 'running', job: { id: sampleJob().id } });
    expect(bridge.$fn('deployStacks.deploy')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      stackId: STACK_ID,
      revision: 1,
    });
    expect(onSettled).toHaveBeenCalled();

    // The upload is over, so a late event changes nothing.
    bridge.$emit('deployStacks.onUploadProgress', { serverId: SERVER.id, phase: 'reading' });
    expect(wizard().progress?.phase).toBe('packing');
  });

  it('sends a deploy again as a new revision of the app', async () => {
    const fake = installRunovaBridge({
      'deployStacks.upload': uploadResult(),
      'deployStacks.deploy': sampleJob(),
    });
    const key = wizardKey(SERVER.id, STACK_ID);
    store().open(key, emptyDraft());
    await store().startDeploy(key, { ...INPUT, existingStackId: STACK_ID });
    expect(fake.$fn('deployStacks.upload')).toHaveBeenCalledWith(
      expect.objectContaining({ stackId: STACK_ID, serverId: SERVER.id }),
    );
  });

  it('sends the picked env files and remembers them for the app once the files are up', async () => {
    const fake = installRunovaBridge({
      'deployStacks.create': uploadResult(),
      'deployStacks.deploy': sampleJob(),
    });
    store().open(KEY, emptyDraft());
    await store().startDeploy(KEY, { ...INPUT, envFileIds: ['f2'] });
    expect(fake.$fn('deployStacks.create')).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-1', envFileIds: ['f2'] }),
    );
    expect(picks()[appEnvFilesKey(SERVER.id, STACK_ID)]).toEqual({
      environmentId: 'env-1',
      envFileIds: ['f2'],
    });
  });

  it('forgets a remembered pick once every env file is used again', async () => {
    useDeployAppEnvFilesStore.getState().remember(SERVER.id, STACK_ID, 'env-1', ['f2']);
    installRunovaBridge({
      'deployStacks.upload': uploadResult(),
      'deployStacks.deploy': sampleJob(),
    });
    const key = wizardKey(SERVER.id, STACK_ID);
    store().open(key, emptyDraft());
    await store().startDeploy(key, { ...INPUT, existingStackId: STACK_ID });
    expect(picks()).toEqual({});
  });

  it('remembers nothing when the upload fails', async () => {
    const { done } = start({
      'deployStacks.create': async () => {
        throw new Error('The server is busy.');
      },
    });
    await done;
    expect(picks()).toEqual({});
  });

  it('waits for the server findings to be accepted, then deploys', async () => {
    const result = uploadResult({ unacknowledgedRisks: ['public-port:web'] });
    const { bridge, done } = start({
      'deployStacks.create': result,
      'deployStacks.acknowledge': sampleRevision({ number: 1, state: 'ready' }),
      'deployStacks.deploy': sampleJob(),
    });
    await done;
    expect(wizard().run).toEqual({ phase: 'confirm', result });

    await store().launch(KEY, result, ['public-port:web']);
    expect(bridge.$fn('deployStacks.acknowledge')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      stackId: STACK_ID,
      revision: 1,
      riskIds: ['public-port:web'],
    });
    expect(wizard().run.phase).toBe('running');
  });

  it('keeps a revision the server turned down', async () => {
    const result = uploadResult({ state: 'invalid', error: 'bad volume' });
    const { done } = start({ 'deployStacks.create': result });
    await done;
    expect(wizard().run).toEqual({ phase: 'invalid', result });
  });

  it('says why the upload failed', async () => {
    const { done } = start({
      'deployStacks.create': async () => {
        throw new Error('The build context is larger than 256 MB.');
      },
    });
    await done;
    expect(wizard().run).toEqual({
      phase: 'error',
      message: 'The build context is larger than 256 MB.',
    });
  });

  it('keeps the upload when the deploy fails, so it can be tried again on its own', async () => {
    const result = uploadResult();
    const { done } = start({
      'deployStacks.create': result,
      'deployStacks.deploy': async () => {
        throw new Error('The server is busy.');
      },
    });
    await done;
    expect(wizard().run).toEqual({ phase: 'error', message: 'The server is busy.', result });
  });

  it('starts one upload at a time', async () => {
    const upload = deferred<unknown>();
    const { bridge } = start({ 'deployStacks.create': () => upload.promise });
    await store().startDeploy(KEY, INPUT);
    expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledTimes(1);
  });

  it('forgets a wizard that is closed', () => {
    store().open(KEY, emptyDraft());
    store().reset(KEY);
    expect(wizard()).toBeUndefined();
  });
});
