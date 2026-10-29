import { coreErrorMessage } from '@shared/coreErrors';
import { suggestId } from './draft';

/**
 * Putting a port of this server on a domain: a site in Websites that forwards the domain to
 * 127.0.0.1 on that port, nginx applied, then a Let's Encrypt certificate. Each is its own step,
 * so the screen can say how far it got and which one failed.
 */

export type ExposeStepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface ExposeStep {
  id: 'site' | 'apply' | 'certificate';
  label: string;
  state: ExposeStepState;
  detail?: string;
}

export interface ExposeRequest {
  serverId: string;
  domain: string;
  /** A label for the upstream: letters, digits, '.', '_' and '-'. Cut to 63 characters. */
  service: string;
  /** The published port on 127.0.0.1 that nginx forwards to. */
  port: number;
  /** Ask Let's Encrypt for a certificate once nginx serves the site (its terms accepted). */
  certificate: boolean;
  websocket: boolean;
}

export interface ExposeOutcome {
  /** True when every step that ran went through. */
  ok: boolean;
  siteId: string;
}

export function initialExposeSteps(): ExposeStep[] {
  return [
    { id: 'site', label: 'Add the site in Websites', state: 'running' },
    { id: 'apply', label: 'Apply nginx', state: 'waiting' },
    { id: 'certificate', label: 'Ask for a certificate', state: 'waiting' },
  ];
}

export function withStep(
  steps: ExposeStep[],
  id: ExposeStep['id'],
  next: Partial<ExposeStep>,
): ExposeStep[] {
  return steps.map((step) => (step.id === id ? { ...step, ...next } : step));
}

export async function exposeOnDomain(
  request: ExposeRequest,
  onStep: (id: ExposeStep['id'], next: Partial<ExposeStep>) => void,
): Promise<ExposeOutcome> {
  const { serverId, domain, port } = request;
  const siteId = suggestId(domain);
  let at: ExposeStep['id'] = 'site';
  try {
    const saved = await window.runova.deploySites.save(serverId, {
      id: siteId,
      domains: [domain],
      upstream: {
        kind: 'servicePort',
        // A label the core takes (letters, digits, '.', '_', '-', at most 63).
        service: request.service.slice(0, 63),
        port,
        verifyCertificate: true,
        sendUpstreamHost: false,
      },
      websocket: request.websocket,
      gzip: true,
      http2: true,
      redirectToHttps: false,
    });
    if (!saved.site) {
      throw new Error(
        saved.problems.map((item) => item.message).join(' ') || 'nginx refused the site.',
      );
    }
    onStep('site', { state: 'done', detail: `Site ${siteId} forwards to 127.0.0.1:${port}.` });
    at = 'apply';
    onStep('apply', { state: 'running' });
    const applied = await window.runova.deploySites.applyChanges(serverId);
    if (!applied.applied) throw new Error(applied.error ?? 'nginx kept its old configuration.');
    onStep('apply', { state: 'done' });
    if (!request.certificate) {
      onStep('certificate', {
        state: 'skipped',
        detail: "Add one later from the site's SSL tab in Websites.",
      });
      return { ok: true, siteId };
    }
    at = 'certificate';
    onStep('certificate', { state: 'running' });
    await window.runova.deployCerts.issue({
      serverId,
      siteId,
      acceptTermsOfService: true,
      staging: false,
    });
    onStep('certificate', {
      state: 'done',
      detail: "Let's Encrypt is checking the domain. The site's SSL tab shows when it arrives.",
    });
    return { ok: true, siteId };
  } catch (failure) {
    onStep(at, { state: 'failed', detail: coreErrorMessage(failure) });
    return { ok: false, siteId };
  }
}
