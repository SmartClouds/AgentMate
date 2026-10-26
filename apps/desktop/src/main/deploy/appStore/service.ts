import {
  catalogAcknowledged,
  findCatalogTemplate,
  readCatalogInstall,
  renderCatalogApp,
  renderCatalogUpdate,
} from '@runova/core';
import type {
  DeployAppInstallInput,
  DeployAppInstallResult,
  DeployAppRevealInput,
  DeployAppUpdateInput,
  DeployRevisionResult,
} from '../../../shared/deployAppStoreTypes';
import type { DeployStacks } from '../stacks/service';

/**
 * The App Store (E12) on top of the Apps (E07). An install renders the compose file and the .env
 * here from the template and what was picked, refuses anything the linter would still want
 * acknowledged, and goes up through the same upload and deploy job as any app. An update renders
 * the compose file of the newer images and has the server copy the live revision with it: the
 * .env with the app's passwords never leaves the server for that.
 */

export type AppStoreStacks = Pick<
  DeployStacks,
  'createFromFiles' | 'deploy' | 'get' | 'files' | 'reviseAndDeploy' | 'revealEnv'
>;

export interface DeployAppStoreDeps {
  stacks: AppStoreStacks;
}

export class DeployAppStore {
  constructor(private readonly deps: DeployAppStoreDeps) {}

  async install(input: DeployAppInstallInput): Promise<DeployAppInstallResult> {
    const template = findCatalogTemplate(input.templateId);
    if (!template) throw new Error(`The App Store has no app called ${input.templateId}.`);
    const result = renderCatalogApp(template, {
      version: input.version,
      params: input.params,
      secrets: input.secrets,
      domain: input.domain,
    });
    if (!result.ok) throw new Error(result.reason);
    const { render } = result;
    if (render.unacknowledged.length > 0) {
      // Never true for a shipped template (a catalog test holds every one to it).
      throw new Error(
        `${template.name} has findings nobody reviewed: ${render.unacknowledged.map((risk) => risk.id).join(', ')}.`,
      );
    }
    const created = await this.deps.stacks.createFromFiles(
      input.serverId,
      input.name,
      `${template.name} from the App Store`,
      {
        compose: render.compose,
        env: render.envFile,
        // Every port is on 127.0.0.1 in the file already; the override holds them there too.
        proxiedServices: [...new Set(render.ports.map((port) => port.service))],
        acknowledgedRisks: catalogAcknowledged(template, render),
        buildContext: false,
      },
    );
    const { revision } = created;
    if (revision.state !== 'ready' || revision.unacknowledgedRisks.length > 0) {
      return { ...created, job: null };
    }
    const job = await this.deps.stacks.deploy(input.serverId, created.stack.id, revision.number);
    return { ...created, job };
  }

  async update(input: DeployAppUpdateInput): Promise<DeployRevisionResult> {
    const details = await this.deps.stacks.get(input.serverId, input.stackId);
    const base =
      details.revisions.find((revision) => revision.number === details.stack.liveRevision) ??
      details.revisions[0];
    if (!base) throw new Error(`${details.stack.name} has no revision to update from.`);
    const files = await this.deps.stacks.files(input.serverId, input.stackId, base.number);
    const read = readCatalogInstall(files.compose);
    if (!read.ok) throw new Error(read.reason);
    const update = renderCatalogUpdate(read.install, input.version);
    if (!update.ok) throw new Error(update.reason);
    const missing = update.envKeys.filter((key) => !base.envKeys.includes(key));
    if (missing.length > 0) {
      throw new Error(
        `This version reads ${missing.join(', ')}, which ${details.stack.name} was not installed with. Install it again as a new app instead.`,
      );
    }
    if (update.unacknowledged.length > 0) {
      throw new Error(
        `The new version has findings nobody reviewed: ${update.unacknowledged.map((risk) => risk.id).join(', ')}.`,
      );
    }
    return this.deps.stacks.reviseAndDeploy(input.serverId, {
      stackId: input.stackId,
      revision: base.number,
      proxiedServices: base.proxiedServices,
      compose: update.compose,
      acknowledgedRisks: update.acknowledged,
      purpose: 'update',
    });
  }

  /** The app's passwords and keys from its .env on the server (Admins, after a step-up). */
  async revealSecrets(input: DeployAppRevealInput): Promise<Record<string, string>> {
    const entries = await this.deps.stacks.revealEnv(input);
    return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  }
}
