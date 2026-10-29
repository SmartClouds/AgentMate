import { coreErrorMessage } from '@shared/coreErrors';
import { create } from 'zustand';
import type { InstallRequest } from '@/components/deploy/appStore/InstallSheet';
import {
  type ExposeStep,
  exposeOnDomain,
  initialExposeSteps,
  withStep,
} from '@/lib/deploy/sites/expose';

/**
 * App Store installs (E12), per server: the install, then with a domain the site, nginx and the
 * certificate. They run from here rather than from the App Store section, so leaving the Deploy
 * page loses neither the install nor its passwords. Those stay in memory only, never on disk,
 * for the card right after the install.
 */

export interface InstallSession {
  stackId: string;
  secrets: Record<string, string>;
  expose: { domain: string; steps: ExposeStep[] } | null;
  /** Why nothing was deployed, when the server refused the files. */
  notice: string | null;
  /** The section has opened the installed app once; it is not opened for the user again. */
  opened: boolean;
}

export interface AppStoreInstall {
  busy: boolean;
  error: string | null;
  session: InstallSession | null;
}

interface DeployAppStoreInstallState {
  installs: Record<string, AppStoreInstall>;
  install: (serverId: string, request: InstallRequest, onSettled?: () => void) => Promise<void>;
  /** Clears a refused install's message, for a fresh try. */
  clearError: (serverId: string) => void;
  markOpened: (serverId: string) => void;
  /** Forgets the install and its passwords. */
  dismiss: (serverId: string) => void;
}

const IDLE: AppStoreInstall = { busy: false, error: null, session: null };

export const useDeployAppStoreInstallStore = create<DeployAppStoreInstallState>((set, get) => {
  const patch = (
    serverId: string,
    change: (install: AppStoreInstall) => Partial<AppStoreInstall>,
  ) =>
    set((state) => {
      const install = state.installs[serverId] ?? IDLE;
      return { installs: { ...state.installs, [serverId]: { ...install, ...change(install) } } };
    });

  const step = (
    serverId: string,
    stackId: string,
    id: ExposeStep['id'],
    next: Partial<ExposeStep>,
  ) =>
    patch(serverId, ({ session }) =>
      session?.stackId === stackId && session.expose
        ? {
            session: {
              ...session,
              expose: { ...session.expose, steps: withStep(session.expose.steps, id, next) },
            },
          }
        : {},
    );

  /** The site in Websites, nginx applied, then the certificate: each its own step. */
  async function expose(
    serverId: string,
    stackId: string,
    request: InstallRequest,
    domain: string,
  ): Promise<void> {
    const render = request.check.render;
    const web = render?.web;
    const port =
      web && render.ports.find((p) => p.service === web.service && p.target === web.port);
    if (!port) {
      step(serverId, stackId, 'site', {
        state: 'failed',
        detail: 'The app has no web port to point at.',
      });
      return;
    }
    await exposeOnDomain(
      {
        serverId,
        domain,
        service: `${request.draft.name}-${web.service}`,
        port: port.published,
        certificate: request.draft.certificate,
        websocket: true,
      },
      (id, next) => step(serverId, stackId, id, next),
    );
  }

  return {
    installs: {},
    install: async (serverId, request, onSettled) => {
      if (get().installs[serverId]?.busy) return;
      patch(serverId, () => ({ busy: true, error: null }));
      try {
        const result = await window.runova.deployAppStore.install({
          serverId,
          templateId: request.template.id,
          version: request.draft.version,
          name: request.draft.name,
          params: request.check.params,
          secrets: request.check.secrets,
          domain: request.check.domain,
        });
        const stackId = result.stack.id;
        const domain = request.check.domain;
        patch(serverId, () => ({
          busy: false,
          session: {
            stackId,
            secrets: request.check.secrets,
            expose: domain ? { domain, steps: initialExposeSteps() } : null,
            notice: result.job
              ? null
              : (result.revision.error ?? 'The server refused the files, so nothing was deployed.'),
            opened: false,
          },
        }));
        onSettled?.();
        if (domain) {
          await expose(serverId, stackId, request, domain);
          onSettled?.();
        }
      } catch (failure) {
        patch(serverId, () => ({ busy: false, error: coreErrorMessage(failure) }));
      }
    },
    clearError: (serverId) => patch(serverId, () => ({ error: null })),
    markOpened: (serverId) =>
      patch(serverId, ({ session }) => (session ? { session: { ...session, opened: true } } : {})),
    dismiss: (serverId) =>
      set((state) => {
        const { [serverId]: _gone, ...rest } = state.installs;
        return { installs: rest };
      }),
  };
});
