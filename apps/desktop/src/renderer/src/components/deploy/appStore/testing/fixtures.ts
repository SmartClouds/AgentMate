import { findCatalogTemplate, generateCatalogSecrets, renderCatalogApp } from '@runova/core';
import type {
  StackDetails,
  StackInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { STACK_ID, sampleJob, sampleRevision, sampleStack, T0 } from '../../apps/testing/fixtures';
import { SERVER, signedIn } from '../../security/testing/fixtures';

/** Installed App Store apps for the tests: their compose files rendered by the real catalog. */

export { SERVER, STACK_ID };

export function installedCompose(
  templateId: string,
  options: { version?: string; params?: Record<string, unknown>; domain?: string | null } = {},
) {
  const template = findCatalogTemplate(templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const secrets = generateCatalogSecrets(template.secrets);
  const result = renderCatalogApp(template, {
    version: options.version,
    params: options.params,
    secrets,
    domain: options.domain ?? null,
  });
  if (!result.ok) throw new Error(result.reason);
  return { compose: result.render.compose, env: result.render.env, render: result.render };
}

export function storeStack(name: string, extra: Partial<StackInfo> = {}): StackInfo {
  return sampleStack({
    name,
    description: `${name === 'cache' ? 'Redis' : 'PostgreSQL'} from the App Store`,
    source: undefined,
    ...extra,
  });
}

export function storeDetails(
  name: string,
  envKeys: string[],
  extra: Partial<StackDetails> = {},
): StackDetails {
  return {
    stack: storeStack(name),
    revisions: [
      sampleRevision({ envKeys, services: [name], proxiedServices: [name] }),
      sampleRevision({
        number: 1,
        state: 'superseded',
        envKeys,
        jobId: '55555555-5555-4555-8555-555555555555',
        createdAtUnixMs: T0,
      }),
    ],
    services: [],
    ...extra,
  };
}

/** A server with a Redis from the App Store on it, live at revision 2. */
export function storeBridge(roles: string[] = ['owner']): Record<string, unknown> {
  const redis = installedCompose('redis', { params: { port: 16379 } });
  return {
    'deploy.access': signedIn(roles),
    'deployStacks.list': [storeStack('cache'), sampleStack({ id: 'other', name: 'shop' })],
    'deployStacks.get': storeDetails('cache', Object.keys(redis.env)),
    'deployStacks.files': { number: 2, compose: redis.compose, envKeys: Object.keys(redis.env) },
    'deployJobs.watch': async () => 'log-1',
    'deployJobs.unwatch': async () => true,
    'deployAppStore.install': async () => ({
      stack: storeStack('redis', { id: STACK_ID, liveRevision: undefined, revisionCount: 1 }),
      revision: sampleRevision({ number: 1, state: 'ready', steps: [], jobId: undefined }),
      job: sampleJob(),
    }),
  };
}
