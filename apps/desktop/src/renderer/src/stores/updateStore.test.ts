import { beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  closeUpdateDialog,
  initUpdateStatusListener,
  openUpdateDialog,
  useUpdateStore,
} from './updateStore';

let bridge: FakeBridge;

function state() {
  return useUpdateStore.getState();
}

beforeEach(() => {
  bridge = installRunovaBridge();
  useUpdateStore.setState({ status: { state: 'idle' }, dialogOpen: false });
});

describe('useUpdateStore', () => {
  it('starts idle with the dialog closed', () => {
    expect(state()).toEqual({ status: { state: 'idle' }, dialogOpen: false });
  });

  it('opens and closes the dialog', () => {
    openUpdateDialog();
    expect(state().dialogOpen).toBe(true);
    closeUpdateDialog();
    expect(state().dialogOpen).toBe(false);
  });
});

describe('initUpdateStatusListener', () => {
  it('mirrors every status the main process pushes', () => {
    initUpdateStatusListener();
    bridge.$emit('app.onUpdateStatus', { state: 'downloading', percent: 40 });
    expect(state().status).toEqual({ state: 'downloading', percent: 40 });
    bridge.$emit('app.onUpdateStatus', { state: 'ready', version: '1.2.0' });
    expect(state().status).toEqual({ state: 'ready', version: '1.2.0' });
  });

  it('leaves the dialog as the user left it', () => {
    initUpdateStatusListener();
    openUpdateDialog();
    bridge.$emit('app.onUpdateStatus', { state: 'checking' });
    expect(state().dialogOpen).toBe(true);
  });

  it('stops listening once its cleanup runs', () => {
    initUpdateStatusListener()();
    expect(bridge.$listenerCount('app.onUpdateStatus')).toBe(0);
    bridge.$emit('app.onUpdateStatus', { state: 'ready', version: '9.9.9' });
    expect(state().status).toEqual({ state: 'idle' });
  });
});
