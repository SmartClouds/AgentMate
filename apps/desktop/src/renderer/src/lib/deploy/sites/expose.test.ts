import { describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import {
  type ExposeRequest,
  type ExposeStep,
  exposeOnDomain,
  initialExposeSteps,
  withStep,
} from './expose';

/** Putting a port on a domain: the site in Websites, nginx applied, then the certificate. */

const REQUEST: ExposeRequest = {
  serverId: 'srv-1',
  domain: 'api.example.com',
  service: 'shop-api',
  port: 8091,
  certificate: true,
  websocket: true,
};

const SAVED = { problems: [], site: { settings: {} } };
const APPLIED = { applied: true, problems: [], warnings: [] };

async function run(overrides: Record<string, unknown>, request: ExposeRequest = REQUEST) {
  const bridge = installRunovaBridge(overrides);
  let steps: ExposeStep[] = initialExposeSteps();
  const outcome = await exposeOnDomain(request, (id, next) => {
    steps = withStep(steps, id, next);
  });
  const state = (id: ExposeStep['id']) => steps.find((step) => step.id === id);
  return { bridge, outcome, steps, state };
}

describe('initialExposeSteps', () => {
  it('starts on the site, with nginx and the certificate waiting their turn', () => {
    expect(initialExposeSteps().map((step) => [step.id, step.label, step.state])).toEqual([
      ['site', 'Add the site in Websites', 'running'],
      ['apply', 'Apply nginx', 'waiting'],
      ['certificate', 'Ask for a certificate', 'waiting'],
    ]);
  });
});

describe('withStep', () => {
  it('changes one step and leaves the others alone', () => {
    const steps = withStep(initialExposeSteps(), 'apply', { state: 'done', detail: 'ok' });
    expect(steps[1]).toMatchObject({ id: 'apply', state: 'done', detail: 'ok' });
    expect(steps[0].state).toBe('running');
  });
});

describe('exposeOnDomain', () => {
  it('saves a site for the port, applies nginx and asks for a certificate', async () => {
    const { bridge, outcome, state } = await run({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': APPLIED,
      'deployCerts.issue': { id: 'job-cert' },
    });
    expect(outcome).toEqual({ ok: true, siteId: 'api-example-com' });
    expect(bridge.$fn('deploySites.save')).toHaveBeenCalledWith('srv-1', {
      id: 'api-example-com',
      domains: ['api.example.com'],
      upstream: {
        kind: 'servicePort',
        service: 'shop-api',
        port: 8091,
        verifyCertificate: true,
        sendUpstreamHost: false,
      },
      websocket: true,
      gzip: true,
      http2: true,
      redirectToHttps: false,
    });
    expect(bridge.$fn('deploySites.applyChanges')).toHaveBeenCalledWith('srv-1');
    expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      siteId: 'api-example-com',
      acceptTermsOfService: true,
      staging: false,
    });
    expect(state('site')).toMatchObject({
      state: 'done',
      detail: 'Site api-example-com forwards to 127.0.0.1:8091.',
    });
    expect(state('apply')?.state).toBe('done');
    expect(state('certificate')?.state).toBe('done');
  });

  it('keeps the service label within what the core takes', async () => {
    const { bridge } = await run(
      { 'deploySites.save': SAVED, 'deploySites.applyChanges': APPLIED },
      { ...REQUEST, service: 'x'.repeat(80), certificate: false },
    );
    const settings = bridge.$fn('deploySites.save').mock.calls[0][1];
    expect(settings.upstream.service).toHaveLength(63);
  });

  it('passes the WebSocket choice on', async () => {
    const { bridge } = await run(
      { 'deploySites.save': SAVED, 'deploySites.applyChanges': APPLIED },
      { ...REQUEST, websocket: false, certificate: false },
    );
    expect(bridge.$fn('deploySites.save').mock.calls[0][1].websocket).toBe(false);
  });

  it('skips the certificate when none was asked for', async () => {
    const { bridge, outcome, state } = await run(
      { 'deploySites.save': SAVED, 'deploySites.applyChanges': APPLIED },
      { ...REQUEST, certificate: false },
    );
    expect(outcome.ok).toBe(true);
    expect(state('certificate')).toMatchObject({
      state: 'skipped',
      detail: "Add one later from the site's SSL tab in Websites.",
    });
    expect(() => bridge.$fn('deployCerts.issue')).toThrow();
  });

  it('stops at the site when the core refuses it, with its reasons', async () => {
    const { bridge, outcome, state } = await run({
      'deploySites.save': {
        problems: [{ field: 'domains[0]', message: 'api.example.com is used by the site shop.' }],
      },
    });
    expect(outcome.ok).toBe(false);
    expect(state('site')).toMatchObject({
      state: 'failed',
      detail: 'api.example.com is used by the site shop.',
    });
    expect(state('apply')?.state).toBe('waiting');
    expect(() => bridge.$fn('deploySites.applyChanges')).toThrow();
  });

  it('marks nginx as failed when it keeps its old configuration', async () => {
    const { outcome, state } = await run({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': {
        applied: false,
        problems: [],
        warnings: [],
        error: 'nginx -t failed.',
      },
    });
    expect(outcome.ok).toBe(false);
    expect(state('site')?.state).toBe('done');
    expect(state('apply')).toMatchObject({ state: 'failed', detail: 'nginx -t failed.' });
    expect(state('certificate')?.state).toBe('waiting');
  });

  it('marks the certificate as failed when the request throws', async () => {
    const { outcome, state } = await run({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': APPLIED,
      'deployCerts.issue': () => Promise.reject(new Error('Rate limited.')),
    });
    expect(outcome.ok).toBe(false);
    expect(state('apply')?.state).toBe('done');
    expect(state('certificate')).toMatchObject({ state: 'failed', detail: 'Rate limited.' });
  });
});
