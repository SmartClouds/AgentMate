import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStackName } from '@runova/core';
import { encodeCoreError } from '../../../shared/coreErrors';
import type {
  JobInfo,
  RegistryAuth,
  ReviseStackRequest,
  StackAction,
  StackDetails,
  StackInfo,
  StackRevisionFiles,
  StackRevisionInfo,
  StackRevisionUpload,
  StackSource,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployAppRevealInput,
  DeployMakePrivateInput,
  DeployRevisionResult,
} from '../../../shared/deployAppStoreTypes';
import type {
  DeployComposeDiscovery,
  DeployStackCreateInput,
  DeployStackPreview,
  DeployStackPreviewInput,
  DeployStackRevisionInput,
  DeployStackUploadProgress,
  DeployStackUploadResult,
} from '../../../shared/deployStacksTypes';
import { type CoreHttpClient, CoreHttpError } from '../connection/coreHttp';
import { ADMIN_ROLES, callCore } from '../coreCalls';
import type { CoreLinks } from '../live/coreLinks';
import { type ComposeRegistries, registriesOfCompose } from '../registry/images';
import { explainCoreRefusal } from '../system';
import type { BuildContextOptions, BuildContextResult } from './buildContext';
import {
  discoverComposeFiles,
  dockerfilesOf,
  previewFromSource,
  previewStack,
  readStackSource,
  type StackSourceDeps,
} from './compose';

/**
 * A server's Apps (E07), on its lasting hub connection, with the files going up over REST since
 * a compose file and its .env can be larger than a hub message. An upload reads the project and
 * its environment again here rather than trusting what the wizard showed: the preview is what
 * the renderer saw, this is what goes to the server. The .env text (with the values) is built
 * here and only ever sent to the core.
 */

/** A build context over SSH can take a while; the core caps it at 256 MB unpacked. */
const CONTEXT_TIMEOUT_MS = 30 * 60_000;
const FILES_TIMEOUT_MS = 2 * 60_000;

export interface DeployStacksDeps {
  links: Pick<CoreLinks, 'call'>;
  roles: (serverId: string) => string[] | null;
  /** A REST call signed in with this computer's session (DeployService.withCoreHttp). */
  http: <T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ) => Promise<T>;
  source: StackSourceDeps;
  /** Packs the build context (buildContext.ts). */
  pack: (options: BuildContextOptions) => Promise<BuildContextResult>;
  progress?: (event: DeployStackUploadProgress) => void;
  /** Where packed contexts wait for their upload. */
  tempRoot?: () => string;
  /**
   * The registry sign-ins a deploy of this app sends for these registries (E08), or for every
   * registry when null (an image's host is only known on the server). They go with the deploy
   * request only; the core keeps the ones its images need in memory and a tmpfs DOCKER_CONFIG
   * for the job.
   */
  registryAuths?: (
    serverId: string,
    stackId: string,
    registries: string[] | null,
  ) => Promise<RegistryAuth[]>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class DeployStacks {
  constructor(private readonly deps: DeployStacksDeps) {}

  discover(projectId: string): Promise<DeployComposeDiscovery> {
    return discoverComposeFiles(this.deps.source, projectId);
  }

  preview(input: DeployStackPreviewInput): Promise<DeployStackPreview> {
    return previewStack(this.deps.source, input);
  }

  list(serverId: string): Promise<StackInfo[]> {
    return this.run(serverId, (hub) => hub.listStacks());
  }

  get(serverId: string, stackId: string): Promise<StackDetails> {
    return this.run(serverId, (hub) => hub.getStack(stackId));
  }

  files(serverId: string, stackId: string, revision: number): Promise<StackRevisionFiles> {
    return this.run(serverId, (hub) => hub.getStackRevisionFiles({ stackId, revision }));
  }

  /** A new app and its first revision. A name already taken by an app that never got files is reused. */
  async create(input: DeployStackCreateInput): Promise<DeployStackUploadResult> {
    const name = validateStackName(input.name);
    if (!name.ok) throw new Error(name.reason);
    const prepared = await this.prepare(input);
    const existing = (await this.list(input.serverId)).find((stack) => stack.name === name.value);
    if (existing && existing.revisionCount > 0) {
      throw new Error(`There is already an app called ${name.value} on this server.`);
    }
    const stack =
      existing ??
      (await this.run(input.serverId, (hub) =>
        hub.createStack({ name: name.value, source: prepared.source }),
      ));
    return this.send(input.serverId, stack.id, prepared);
  }

  /** A new revision of an existing app. */
  async upload(input: DeployStackRevisionInput): Promise<DeployStackUploadResult> {
    const prepared = await this.prepare(input);
    return this.send(input.serverId, input.stackId, prepared);
  }

  acknowledge(
    serverId: string,
    stackId: string,
    revision: number,
    riskIds: string[],
  ): Promise<StackRevisionInfo> {
    return this.run(serverId, (hub) =>
      hub.acknowledgeStackRisks({ stackId, revision, riskIds: unique(riskIds) }),
    );
  }

  /** A deploy, with this computer's sign-ins for the registries the revision pulls from. */
  async deploy(serverId: string, stackId: string, revision: number): Promise<JobInfo> {
    const registries = await this.signInsFor(serverId, stackId, revision);
    return this.run(serverId, (hub) =>
      registries.length > 0
        ? hub.deployStackWithRegistries({ stackId, revision, registries })
        : hub.deployStack({ stackId, revision }),
    );
  }

  async rollback(serverId: string, stackId: string, revision: number): Promise<JobInfo> {
    const registries = await this.signInsFor(serverId, stackId, revision);
    return this.run(serverId, (hub) =>
      registries.length > 0
        ? hub.rollbackStackWithRegistries({ stackId, revision, registries })
        : hub.rollbackStack({ stackId, revision }),
    );
  }

  /** The registries a revision pulls from, read from its compose file on the server. */
  async registriesOf(
    serverId: string,
    stackId: string,
    revision: number,
  ): Promise<ComposeRegistries> {
    const files = await this.files(serverId, stackId, revision);
    return registriesOfCompose(files.compose, files.envKeys);
  }

  /**
   * Without sign-ins the old hub methods are used, so a server whose core predates E08 still
   * deploys public images.
   */
  private async signInsFor(serverId: string, stackId: string, revision: number) {
    if (!this.deps.registryAuths) return [];
    const { registries, unresolved } = await this.registriesOf(serverId, stackId, revision);
    if (unresolved) return this.deps.registryAuths(serverId, stackId, null);
    if (registries.length === 0) return [];
    return this.deps.registryAuths(serverId, stackId, registries);
  }

  action(serverId: string, stackId: string, action: StackAction): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.runStackAction({ stackId, action }));
  }

  delete(serverId: string, stackId: string, removeVolumes: boolean): Promise<JobInfo> {
    return this.run(serverId, (hub) =>
      removeVolumes ? hub.deleteStackWithVolumes(stackId) : hub.deleteStack(stackId),
    );
  }

  /**
   * A new app whose files were made in this process (an App Store install) rather than read from
   * a project. Like `create`, a name taken by an app that never got files is reused.
   */
  async createFromFiles(
    serverId: string,
    name: string,
    description: string,
    upload: StackRevisionUpload,
  ): Promise<DeployStackUploadResult> {
    const checked = validateStackName(name);
    if (!checked.ok) throw new Error(checked.reason);
    const existing = (await this.list(serverId)).find((stack) => stack.name === checked.value);
    if (existing && existing.revisionCount > 0) {
      throw new Error(`There is already an app called ${checked.value} on this server.`);
    }
    const stack =
      existing ??
      (await this.run(serverId, (hub) => hub.createStack({ name: checked.value, description })));
    this.progress(serverId, 'uploading-files');
    const revision = await this.rest(serverId, (client, token) =>
      client.post<StackRevisionInfo>(
        `/api/v1/stacks/${encodeURIComponent(stack.id)}/revisions`,
        upload,
        { token, timeoutMs: FILES_TIMEOUT_MS },
      ),
    );
    this.progress(serverId, 'done');
    const details = await this.get(serverId, stack.id);
    return { stack: details.stack, revision };
  }

  /**
   * A revision copied on the server (its .env and files with it), then deployed when the server
   * found it ready with nothing left to acknowledge. Otherwise the revision comes back alone, so
   * the screen can say why.
   */
  async reviseAndDeploy(
    serverId: string,
    request: ReviseStackRequest,
  ): Promise<DeployRevisionResult> {
    const revision = await this.run(serverId, (hub) => hub.reviseStack(request));
    if (revision.state !== 'ready' || revision.unacknowledgedRisks.length > 0) {
      return { revision, job: null };
    }
    const job = await this.deploy(serverId, request.stackId, revision.number);
    return { revision, job };
  }

  /**
   * "Make private" (E13): what runs now (or the newest revision, when nothing is live) again,
   * with these services' ports on 127.0.0.1 through the same loopback override as any proxied
   * service. Public access goes through a site in Websites from then on.
   */
  async makePrivate(input: DeployMakePrivateInput): Promise<DeployRevisionResult> {
    const details = await this.get(input.serverId, input.stackId);
    const { stack } = details;
    const base =
      details.revisions.find((revision) => revision.number === stack.liveRevision) ??
      details.revisions[0];
    if (!base) throw new Error(`${stack.name} has no revision to start from yet.`);
    for (const service of input.services) {
      if (!base.services.includes(service)) {
        throw new Error(`${stack.name} has no service called ${service}.`);
      }
    }
    const added = input.services.filter((service) => !base.proxiedServices.includes(service));
    if (added.length === 0) {
      throw new Error(
        `${input.services.join(', ')} already publishes on 127.0.0.1 only in revision ${base.number}.`,
      );
    }
    return this.reviseAndDeploy(input.serverId, {
      stackId: stack.id,
      revision: base.number,
      proxiedServices: unique([...base.proxiedServices, ...input.services]),
      purpose: 'makePrivate',
    });
  }

  /** A revision's .env with its values: Admins only, after a step-up made here when asked. */
  revealEnv(input: DeployAppRevealInput) {
    return callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        if (input.password || input.totpCode) {
          await hub.stepUp({
            ...(input.password ? { password: input.password } : {}),
            ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          });
        }
        return hub.revealStackEnv({ stackId: input.stackId, revision: input.revision });
      },
      { stepUpFor: ADMIN_ROLES },
    );
  }

  /** Reads and checks everything an upload sends, before anything reaches the server. */
  private async prepare(input: DeployStackRevisionInput | DeployStackCreateInput) {
    this.progress(input.serverId, 'reading');
    const source = await readStackSource(this.deps.source, input);
    const preview = previewFromSource(source, input.proxiedServices, false);
    if (preview.blocking || preview.envText === null || !preview.project) {
      throw new Error(preview.blocking ?? 'The compose file could not be read.');
    }
    const acknowledged = new Set(input.acknowledgedRisks);
    const waiting = preview.requiresAcknowledgment.filter((id) => !acknowledged.has(id));
    if (waiting.length > 0) {
      throw new Error(
        `Acknowledge every risk before deploying. Still waiting: ${waiting.join(', ')}.`,
      );
    }
    const stackSource: StackSource = {
      projectId: source.project.id,
      projectName: source.project.name,
      composePath: source.composePath,
      ...(source.environment
        ? { environmentId: source.environment.id, environmentName: source.environment.name }
        : {}),
    };
    return {
      source: stackSource,
      composeDir: source.composeDir,
      upload: {
        compose: source.composeText,
        env: preview.envText,
        proxiedServices: preview.proxiedServices,
        acknowledgedRisks: unique(input.acknowledgedRisks),
        buildContext: preview.buildContext !== null,
        source: stackSource,
      } satisfies StackRevisionUpload,
      dockerfiles: dockerfilesOf(preview.project),
    };
  }

  private async send(
    serverId: string,
    stackId: string,
    prepared: Awaited<ReturnType<DeployStacks['prepare']>>,
  ): Promise<DeployStackUploadResult> {
    const base = `/api/v1/stacks/${encodeURIComponent(stackId)}/revisions`;
    const folder = prepared.upload.buildContext
      ? await mkdtemp(join(this.deps.tempRoot?.() ?? tmpdir(), 'runova-context-'))
      : null;
    try {
      // Packed first: a context that is too large is refused before the server gets anything.
      let packed: BuildContextResult | null = null;
      if (folder) {
        this.progress(serverId, 'packing');
        packed = await this.deps.pack({
          root: prepared.composeDir,
          output: join(folder, 'context.tar.gz'),
          alwaysInclude: prepared.dockerfiles,
        });
      }
      this.progress(serverId, 'uploading-files');
      let revision = await this.rest(serverId, (client, token) =>
        client.post<StackRevisionInfo>(base, prepared.upload, {
          token,
          timeoutMs: FILES_TIMEOUT_MS,
        }),
      );
      if (packed) {
        const archive = packed;
        this.progress(serverId, 'uploading-context', 0, archive.archiveBytes);
        revision = await this.rest(serverId, (client, token) =>
          client.putStream<StackRevisionInfo>(
            `${base}/${revision.number}/context`,
            createReadStream(archive.path),
            {
              token,
              contentType: 'application/gzip',
              contentLength: archive.archiveBytes,
              headers: { 'x-content-sha256': archive.sha256 },
              timeoutMs: CONTEXT_TIMEOUT_MS,
              onProgress: (sent) =>
                this.progress(serverId, 'uploading-context', sent, archive.archiveBytes),
            },
          ),
        );
      }
      this.progress(serverId, 'done');
      const details = await this.get(serverId, stackId);
      return { stack: details.stack, revision };
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true });
    }
  }

  private progress(
    serverId: string,
    phase: DeployStackUploadProgress['phase'],
    sentBytes?: number,
    totalBytes?: number,
  ): void {
    this.deps.progress?.({
      serverId,
      phase,
      ...(sentBytes === undefined ? {} : { sentBytes }),
      ...(totalBytes === undefined ? {} : { totalBytes }),
    });
  }

  /** A REST call whose refusal reads like the core's own words. */
  private async rest<T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.deps.http(serverId, work);
    } catch (error) {
      if (!(error instanceof CoreHttpError)) throw error;
      const said =
        error.body && typeof error.body === 'object' && 'message' in error.body
          ? String((error.body as { message: unknown }).message)
          : null;
      if (error.status === 403) {
        const roles = this.deps.roles(serverId);
        const which = roles && roles.length > 0 ? ` (${roles.join(', ')})` : '';
        throw new Error(
          encodeCoreError('forbidden', `Your role on this server${which} cannot upload apps.`),
        );
      }
      throw new Error(said ?? error.message);
    }
  }

  private async run<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    try {
      return await this.deps.links.call(serverId, work);
    } catch (error) {
      throw explainCoreRefusal(error, this.deps.roles(serverId), false);
    }
  }
}
