import { describe, expect, it } from 'vitest';
import {
  appEnvFilesKey,
  rememberedEnvFiles,
  useDeployAppEnvFilesStore,
} from './deployAppEnvFilesStore';

/**
 * The env files an app was last deployed from, kept on this computer so deploying it again
 * starts from the same files.
 */

const store = () => useDeployAppEnvFilesStore.getState();

describe('deployAppEnvFilesStore', () => {
  it('remembers a pick per server and app, and the newest one wins', () => {
    store().remember('srv-1', 'app-1', 'env-1', ['f1']);
    store().remember('srv-1', 'app-1', 'env-1', ['f2', 'f3']);
    store().remember('srv-2', 'app-1', 'env-9', ['f9']);
    expect(store().picks).toEqual({
      [appEnvFilesKey('srv-1', 'app-1')]: { environmentId: 'env-1', envFileIds: ['f2', 'f3'] },
      [appEnvFilesKey('srv-2', 'app-1')]: { environmentId: 'env-9', envFileIds: ['f9'] },
    });
  });

  it('forgets the pick when every file applies, or there is no environment', () => {
    store().remember('srv-1', 'app-1', 'env-1', ['f1']);
    store().remember('srv-1', 'app-1', 'env-1', null);
    expect(store().picks).toEqual({});
    store().remember('srv-1', 'app-1', 'env-1', ['f1']);
    store().remember('srv-1', 'app-1', null, ['f1']);
    expect(store().picks).toEqual({});
  });

  it('gives the pick back only for the environment it was made in', () => {
    store().remember('srv-1', 'app-1', 'env-1', ['f1']);
    expect(rememberedEnvFiles('srv-1', 'app-1', 'env-1')).toEqual(['f1']);
    expect(rememberedEnvFiles('srv-1', 'app-1', 'env-2')).toBeNull();
    expect(rememberedEnvFiles('srv-1', 'app-1', null)).toBeNull();
    expect(rememberedEnvFiles('srv-1', 'app-2', 'env-1')).toBeNull();
  });

  it('keeps the picks between visits', () => {
    store().remember('srv-1', 'app-1', 'env-1', ['f1']);
    const saved = JSON.parse(localStorage.getItem('runova-deploy-app-env-files') ?? '{}');
    expect(saved.state.picks[appEnvFilesKey('srv-1', 'app-1')]).toEqual({
      environmentId: 'env-1',
      envFileIds: ['f1'],
    });
  });
});
