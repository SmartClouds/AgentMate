import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import {
  buildWpProjectPrompt,
  createWpIgnoreRules,
  normalizeProjectWordPressLink,
  normalizeWpIgnore,
  type Project,
  planWpDeploy,
  planWpPull,
  WP_ROUTES,
  type WpFileMap,
  type WpHealthCheck,
  type WpItem,
  type WpItemRef,
  type WpLimits,
  type WpPlannedChange,
  type WpSiteInfo,
  type WpSkippedEntry,
  withoutWpProjectPrompt,
  withWpProjectPrompt,
  wpIgnoreLinesFor,
  wpItemKey,
  wpItemRoot,
  wpKeyTransportSecurity,
  wpMirrorPath,
} from '@agentmat/core';
import type {
  DeployWordPressCreateProjectInput,
  DeployWordPressDeployResult,
  DeployWordPressIgnoreInput,
  DeployWordPressItemsInput,
  DeployWordPressLeftOut,
  DeployWordPressLeftOutReason,
  DeployWordPressLinkProjectInput,
  DeployWordPressLinkProjectResult,
  DeployWordPressLocalChanges,
  DeployWordPressLocalItem,
  DeployWordPressPlan,
  DeployWordPressPlanInput,
  DeployWordPressPullResult,
  DeployWordPressRemoteFile,
  DeployWordPressRemoteFileInput,
  DeployWordPressRunInput,
  DeployWordPressWarning,
} from '../../../shared/deployWordPressTypes';
import { wordPressError, wordPressErrorCode } from '../../../shared/wordpressErrors';
import type { WpClient } from './client';
import { sha256Hex } from './crypto';
import { runDeploy } from './deployRun';
import { deniedReason, type WpHashCache, walkLocalItem } from './localManifest';
import { WpLocalWriter } from './localWriter';
import {
  assertItemFoldersEmpty,
  assertNewItems,
  itemsWithFiles,
  listLocalItems,
  newWpLink,
  requireLinkedProject,
  selectItems,
  type WpProjectsPort,
} from './projectLink';
import { runPull, type WpPullItemState } from './pullRun';
import { readRemoteManifest } from './remote';
import {
  cleanInfo,
  cleanItem,
  MAX_LISTED_ITEMS,
  sameWpSite,
  WordPressService,
  type WordPressServiceDeps,
  type WpReport,
  wpSiteOrigin,
} from './service';
import { cleanSiteText } from './siteText';
import type { StoredWpSite, WpBase } from './state';

/**
 * WordPress projects (E21) on top of the sites service: plans for pulls and deploys, running
 * them, a new project made from a site, its item list, its local changes and the site's copy of
 * one file for the diff view. A plan is kept in memory for 15 minutes; running it re-checks the
 * files it would touch, so nothing changed since the review is overwritten or sent.
 */

export interface WordPressProjectServiceDeps extends WordPressServiceDeps {
  projects: WpProjectsPort;
  planTtlMs?: number;
}

const PLAN_TTL_MS = 15 * 60_000;
const REMOTE_TEXT_MAX = 1024 * 1024;
const EXTERNAL_TIMEOUT_MS = 20_000;
const EXTERNAL_MAX_BYTES = 20 * 1024 * 1024;
const THEME_CORE = new Set(['style.css', 'index.php', 'functions.php']);

interface ItemState extends WpPullItemState {
  /** The site has the item. */
  onSite: boolean;
  /** The project folder has the item. */
  onDisk: boolean;
  siteItem: WpItem | null;
}

interface Gathered {
  info: WpSiteInfo;
  siteItems: WpItem[];
  items: ItemState[];
  leftOut: DeployWordPressLeftOut[];
  remoteLeftOut: DeployWordPressLeftOut[];
}

interface StoredPlan {
  plan: DeployWordPressPlan;
  projectRoot: string;
  items: ItemState[];
  limits: WpLimits;
  sitePublicKey: string;
  projectName: string;
}

const SKIP_REASONS: Partial<Record<WpSkippedEntry['reason'], DeployWordPressLeftOutReason>> = {
  symlink: 'symlink',
  tooLarge: 'tooLarge',
  tooMany: 'tooLarge',
  notUtf8: 'notUtf8',
};

function skippedReason(entry: WpSkippedEntry): DeployWordPressLeftOutReason {
  if (entry.reason === 'hardDenied') return deniedReason(entry.path);
  return SKIP_REASONS[entry.reason] ?? 'pathRejected';
}

/** A file kind guess for an item neither side has seen yet. */
function guessIsFile(item: WpItemRef): boolean {
  return item.kind !== 'theme' && item.slug.toLowerCase().endsWith('.php');
}

function plannedConflictsError(changes: readonly WpPlannedChange[], items: ItemState[]): Error {
  const isFile = new Map(items.map((state) => [wpItemKey(state.item), state.isFile]));
  const lines = changes.slice(0, 200).map((change) => {
    const path = wpMirrorPath(
      change.item,
      isFile.get(wpItemKey(change.item)) ?? false,
      change.path,
    );
    const what =
      change.remote === 'deleted'
        ? 'deleted on the site and changed here'
        : change.local === 'deleted'
          ? 'changed on the site and deleted here'
          : 'changed both here and on the site';
    return `${path}: ${what}`;
  });
  const summary =
    changes.length === 1
      ? '1 file changed both here and on the site.'
      : `${changes.length} files changed both here and on the site.`;
  return wordPressError('conflict', [summary, ...lines].join('\n'));
}

export class WordPressProjectService extends WordPressService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly hashes: WpHashCache = new Map();

  constructor(private readonly projectDeps: WordPressProjectServiceDeps) {
    super(projectDeps);
  }

  private get ttl(): number {
    return this.projectDeps.planTtlMs ?? PLAN_TTL_MS;
  }

  // Plans.

  async planPull(input: DeployWordPressPlanInput): Promise<DeployWordPressPlan> {
    return this.makePlan(input, 'pull');
  }

  async planDeploy(input: DeployWordPressPlanInput): Promise<DeployWordPressPlan> {
    return this.makePlan(input, 'deploy');
  }

  private async makePlan(
    input: DeployWordPressPlanInput,
    direction: 'pull' | 'deploy',
  ): Promise<DeployWordPressPlan> {
    const { project, link } = await requireLinkedProject(
      this.projectDeps.projects,
      input.projectId,
    );
    const items = selectItems(link, input.items);
    const site = await this.requireSite(link.siteId);
    const gathered = await this.withSite(site.id, (client) =>
      this.gather(client, site, project, items),
    );
    const snapshots = gathered.items.map((state) => ({
      item: state.item,
      isFile: state.isFile,
      // A missing folder deploys nothing (deleting a whole item is not something a deploy does);
      // a pull fills it in as new.
      local: state.onDisk || direction === 'pull' ? state.local : state.base,
      base: !state.onDisk && direction === 'pull' ? {} : state.base,
      // An item gone from the site pulls nothing (its local copy stays); a deploy recreates it.
      remote: state.onSite ? state.remote : direction === 'pull' ? null : {},
    }));
    const planned = direction === 'deploy' ? planWpDeploy(snapshots) : planWpPull(snapshots);
    const planId = randomUUID();
    const plan: DeployWordPressPlan = {
      planId,
      projectId: project.id,
      siteId: site.id,
      direction,
      changes: planned.changes,
      conflicts: planned.conflicts,
      leftOut: direction === 'deploy' ? gathered.leftOut : gathered.remoteLeftOut,
      warnings: this.warnings(site, gathered, planned.changes, direction),
      uploadBytes: planned.uploadBytes,
      downloadBytes: planned.downloadBytes,
      expiresAt: this.now() + this.ttl,
    };
    this.prunePlans();
    this.plans.set(planId, {
      plan,
      projectRoot: project.folderPath,
      items: gathered.items.map((state, index) => ({
        ...state,
        local: snapshots[index].local,
        base: snapshots[index].base,
      })),
      limits: gathered.info.limits,
      sitePublicKey: site.sitePublicKey,
      projectName: project.name,
    });
    return plan;
  }

  private warnings(
    site: StoredWpSite,
    gathered: Gathered,
    changes: readonly WpPlannedChange[],
    direction: 'pull' | 'deploy',
  ): DeployWordPressWarning[] {
    const warnings = new Set<DeployWordPressWarning>();
    if (wpKeyTransportSecurity(site) === 'plain-http') warnings.add('plainHttp');
    if (direction === 'pull') return [...warnings];
    if (site.scope === 'read') warnings.add('readOnlyScope');
    if (!gathered.info.guard.installed) warnings.add('noRescueGuard');
    if (gathered.info.loopback === 'failed') warnings.add('healthCheckUnavailable');
    const { stylesheet, template } = gathered.info.activeTheme;
    for (const state of gathered.items) {
      const touched = changes.filter((change) => wpItemKey(change.item) === wpItemKey(state.item));
      if (!state.onSite && touched.length > 0) warnings.add('createsItem');
      const removed = touched.filter(
        (change) =>
          change.action === 'deleteRemote' ||
          (change.action === 'conflict' && change.local === 'deleted'),
      );
      const main = state.siteItem?.mainFile;
      if (
        (state.siteItem?.active || state.siteItem?.networkActive) &&
        main &&
        removed.some(
          (change) => main === (state.isFile ? change.path : `${state.item.slug}/${change.path}`),
        )
      ) {
        warnings.add('deletesActivePluginMainFile');
      }
      if (
        state.item.kind === 'theme' &&
        (state.item.slug === stylesheet || state.item.slug === template) &&
        removed.some((change) => THEME_CORE.has(change.path))
      ) {
        warnings.add('touchesActiveThemeCore');
      }
    }
    return [...warnings];
  }

  /** Reads the site and the project folder for the given items. */
  private async gather(
    client: WpClient,
    site: StoredWpSite,
    project: Project,
    items: readonly WpItemRef[],
    signal?: AbortSignal,
  ): Promise<Gathered> {
    const info = cleanInfo((await client.call(WP_ROUTES.siteInfo, {}, { signal })).data);
    const listed = (await client.call(WP_ROUTES.itemsList, {}, { signal })).data.items;
    const siteItems = (Array.isArray(listed) ? listed : [])
      .slice(0, MAX_LISTED_ITEMS)
      .map(cleanItem)
      .filter((item): item is WpItem => item !== null);
    const base = await this.baseFor(project.id, site);
    const saved = normalizeProjectWordPressLink(project.wordpress)?.ignore;
    const gathered: Gathered = { info, siteItems, items: [], leftOut: [], remoteLeftOut: [] };
    for (const item of items) {
      const key = wpItemKey(item);
      const siteItem = siteItems.find((entry) => wpItemKey(entry) === key) ?? null;
      if (siteItem?.protected) {
        throw wordPressError(
          'itemProtected',
          `${wpItemRoot(item)} belongs to AgentMate Connector itself and is never synced.`,
        );
      }
      const remote = await readRemoteManifest(client, item, signal);
      const baseItem = base?.items[key];
      const isFile = remote.exists
        ? remote.isFile
        : (baseItem?.isFile ?? siteItem?.isFile ?? guessIsFile(item));
      const baseFiles = baseItem && baseItem.isFile === isFile ? baseItem.files : {};
      const walk = await walkLocalItem({
        projectRoot: project.folderPath,
        item,
        isFile,
        tracked: new Set([...Object.keys(baseFiles), ...Object.keys(remote.files)]),
        savedIgnore: wpIgnoreLinesFor(saved, item),
        hashes: this.hashes,
        signal,
      });
      const remoteFiles: WpFileMap = {};
      for (const [path, entry] of Object.entries(remote.files)) {
        if (walk.rules.excluded(path)) {
          gathered.remoteLeftOut.push({ item, path, reason: 'ignored' });
        } else {
          remoteFiles[path] = entry;
        }
      }
      for (const skipped of remote.skipped) {
        gathered.remoteLeftOut.push({ item, path: skipped.path, reason: skippedReason(skipped) });
      }
      gathered.leftOut.push(...walk.leftOut);
      gathered.items.push({
        item,
        isFile,
        local: walk.files,
        remote: remoteFiles,
        base: baseFiles,
        onSite: remote.exists,
        onDisk: walk.exists,
        siteItem,
      });
    }
    return gathered;
  }

  /** The project's base, when it was written for this very site. */
  private async baseFor(projectId: string, site: StoredWpSite): Promise<WpBase | null> {
    const base = await this.deps.bases.read(projectId);
    if (
      !base ||
      base.siteId !== site.id ||
      !sameWpSite(site, base.sitePublicKey, `${base.siteOrigin}/`)
    ) {
      return null;
    }
    return base;
  }

  /**
   * The stored plan, still kept: a run refused before it starts (conflicts without force, a
   * read-only key) can be retried with the same plan. The run itself takes it (usePlan).
   */
  private peekPlan(planId: string, direction: 'pull' | 'deploy'): StoredPlan {
    this.prunePlans();
    const stored = this.plans.get(planId);
    if (!stored || stored.plan.direction !== direction) {
      throw wordPressError(
        'planExpired',
        'That review is no longer current (they last 15 minutes). Review the changes again.',
      );
    }
    return stored;
  }

  /** Called once the run holds the site: from here on the plan is spent, whatever happens. */
  private usePlan(planId: string): void {
    this.plans.delete(planId);
  }

  private prunePlans(): void {
    const now = this.now();
    for (const [id, stored] of this.plans) {
      if (stored.plan.expiresAt <= now) this.plans.delete(id);
    }
  }

  private async writeBase(
    projectId: string,
    site: StoredWpSite,
    items: Map<string, WpFileMap>,
    isFile: Map<string, boolean>,
    keep: readonly WpItemRef[],
  ): Promise<WpBase> {
    const current = await this.baseFor(projectId, site);
    const kept = new Set(keep.map(wpItemKey));
    const next: WpBase = {
      version: 1,
      siteId: site.id,
      sitePublicKey: site.sitePublicKey,
      siteOrigin: wpSiteOrigin(site.restUrl),
      updatedAt: this.now(),
      items: Object.fromEntries(
        Object.entries(current?.items ?? {}).filter(([key]) => kept.has(key)),
      ),
    };
    for (const [key, files] of items) {
      next.items[key] = { isFile: isFile.get(key) ?? false, files };
    }
    await this.deps.bases.write(projectId, next);
    return next;
  }

  // Pull.

  async pull(input: DeployWordPressRunInput): Promise<DeployWordPressPullResult> {
    const stored = this.peekPlan(input.planId, 'pull');
    const { plan } = stored;
    const { link } = await requireLinkedProject(this.projectDeps.projects, plan.projectId);
    if (link.siteId !== plan.siteId) throw this.siteUnknown();
    return this.runOperation(
      input.operationId,
      plan.siteId,
      plan.projectId,
      'pull',
      (signal, report) => {
        this.usePlan(input.planId);
        return this.withSite(plan.siteId, async (client, site) => {
          const pulled = await this.applyPull(
            client,
            site,
            stored,
            input.resolutions ?? {},
            signal,
            report,
          );
          await this.writeBase(
            plan.projectId,
            site,
            pulled.bases,
            isFileMap(stored.items),
            link.items,
          );
          report('done', 1, 1);
          return {
            downloaded: pulled.downloaded,
            deletedLocal: pulled.deletedLocal,
            conflictCopies: pulled.conflictCopies,
            leftOut: plan.leftOut,
          };
        });
      },
    );
  }

  private applyPull(
    client: WpClient,
    _site: StoredWpSite,
    stored: Pick<StoredPlan, 'plan' | 'items' | 'projectRoot' | 'limits'>,
    resolutions: Record<string, 'keepLocal' | 'takeRemote'>,
    signal: AbortSignal,
    report: WpReport,
    writer: WpLocalWriter = new WpLocalWriter(stored.projectRoot),
  ) {
    return runPull({
      client,
      writer,
      projectRoot: stored.projectRoot,
      changes: stored.plan.changes,
      items: new Map(stored.items.map((state) => [wpItemKey(state.item), state])),
      resolutions,
      limits: stored.limits,
      signal,
      report,
      now: this.now,
    });
  }

  // Deploy.

  async deploy(input: DeployWordPressRunInput): Promise<DeployWordPressDeployResult> {
    const stored = this.peekPlan(input.planId, 'deploy');
    const { plan } = stored;
    const site = await this.requireSite(plan.siteId);
    if (site.scope === 'read') {
      throw wordPressError(
        'readOnly',
        'This connection can only read. Make a read-write key in wp-admin and connect again to deploy.',
      );
    }
    if (plan.conflicts.length > 0 && !input.force) {
      throw plannedConflictsError(plan.conflicts, stored.items);
    }
    const changes = plan.changes.filter((change) => change.action !== 'conflict' || input.force);
    if (changes.length === 0) {
      throw wordPressError('badRequest', 'There is nothing to deploy. Review the changes again.');
    }
    const touched = new Set(changes.map((change) => wpItemKey(change.item)));
    const items = stored.items.filter((state) => touched.has(wpItemKey(state.item)));
    const pending = await this.expectedBase(plan.projectId, site, stored, changes);

    return this.runOperation(
      input.operationId,
      site.id,
      plan.projectId,
      'deploy',
      (signal, report) => {
        this.usePlan(input.planId);
        return this.withSite(site.id, (client) =>
          runDeploy({
            client,
            projectRoot: stored.projectRoot,
            label: `AgentMate: ${cleanSiteText(stored.projectName, 80)}`,
            changes,
            items: items.map((state) => ({
              item: state.item,
              isFile: state.isFile,
              create: !state.onSite,
            })),
            local: new Map(stored.items.map((state) => [wpItemKey(state.item), state.local])),
            limits: stored.limits,
            force: input.force,
            signal,
            report,
            now: this.now,
            external: () => this.externalCheck(site, client),
            started: async (deployId) => {
              await this.deps.bases.writePending(plan.projectId, pending);
              await this.deps.state.setInflight({
                siteId: site.id,
                deployId,
                projectId: plan.projectId,
                operationId: input.operationId,
                startedAt: this.now(),
              });
            },
            ended: async (deployId, state) => {
              if (state === 'done') await this.deps.bases.promotePending(plan.projectId);
              else await this.deps.bases.dropPending(plan.projectId);
              await this.deps.state.clearInflight(site.id, deployId);
            },
          }),
        );
      },
    );
  }

  /** The base the project will have once the site says `done`. */
  private async expectedBase(
    projectId: string,
    site: StoredWpSite,
    stored: StoredPlan,
    changes: readonly WpPlannedChange[],
  ): Promise<WpBase> {
    const current = await this.baseFor(projectId, site);
    const next: WpBase = {
      version: 1,
      siteId: site.id,
      sitePublicKey: site.sitePublicKey,
      siteOrigin: wpSiteOrigin(site.restUrl),
      updatedAt: this.now(),
      items: { ...(current?.items ?? {}) },
    };
    for (const state of stored.items) {
      const key = wpItemKey(state.item);
      const files: WpFileMap = { ...state.base };
      // Paths both sides already agree on join the base too.
      for (const path of new Set([...Object.keys(state.local), ...Object.keys(state.remote)])) {
        const local = state.local[path];
        const remote = state.remote[path];
        if (local && remote && local.sha256 === remote.sha256) files[path] = local;
      }
      for (const change of changes) {
        if (wpItemKey(change.item) !== key) continue;
        const local = state.local[change.path];
        if (local) files[change.path] = local;
        else delete files[change.path];
      }
      next.items[key] = { isFile: state.isFile, files };
    }
    return next;
  }

  /** This computer's own GET of the home page; a 5xx is a failure, a failed GET says nothing. */
  private async externalCheck(site: StoredWpSite, client: WpClient): Promise<WpHealthCheck> {
    const basic = client.basicAuthHeader();
    try {
      const response = await this.deps.transport({
        url: site.siteUrl,
        method: 'GET',
        headers: {
          Accept: 'text/html',
          'Cache-Control': 'no-store',
          ...(basic ? { Authorization: basic } : {}),
        },
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        maxResponseBytes: EXTERNAL_MAX_BYTES,
      });
      const ok = response.status < 500;
      return {
        name: 'external',
        status: response.status,
        ok,
        detail: ok ? '' : `The home page answered with HTTP ${response.status}.`,
      };
    } catch (error) {
      if (wordPressErrorCode(error) === 'redirected') {
        return { name: 'external', status: null, ok: true, detail: 'The home page redirects.' };
      }
      return {
        name: 'external',
        status: null,
        ok: null,
        detail: 'This computer could not load the home page, so this check was skipped.',
      };
    }
  }

  // New projects and item lists.

  async createProject(input: DeployWordPressCreateProjectInput): Promise<Project> {
    const site = await this.requireSite(input.siteId);
    return this.runOperation(input.operationId, site.id, null, 'createProject', (signal, report) =>
      this.withSite(site.id, async (client) => {
        const existed = await stat(input.folderPath).catch(() => null);
        if (existed && !existed.isDirectory()) {
          throw wordPressError('folderNotEmpty', 'A file is in the way of that project folder.');
        }
        await assertItemFoldersEmpty(input.folderPath, input.items);
        const created = existed ? undefined : await mkdir(input.folderPath, { recursive: true });
        const writer = new WpLocalWriter(input.folderPath);
        try {
          report('manifest', 0, input.items.length);
          const scratch = { id: `new-${randomUUID()}`, folderPath: input.folderPath } as Project;
          const gathered = await this.gather(client, site, scratch, input.items, signal);
          const missing = gathered.items.filter((state) => !state.onSite);
          if (missing.length > 0) {
            throw wordPressError(
              'itemUnknown',
              `The site has no ${missing.map((state) => wpItemRoot(state.item)).join(', ')}.`,
            );
          }
          const items = gathered.items.map((state) => ({ ...state, base: {} }));
          const planned = planWpPull(items);
          const pulled = await this.applyPull(
            client,
            site,
            {
              plan: { changes: planned.changes } as DeployWordPressPlan,
              items,
              projectRoot: input.folderPath,
              limits: gathered.info.limits,
            },
            {},
            signal,
            report,
            writer,
          );
          const siteItems = input.items.map(
            (item) =>
              gathered.siteItems.find((entry) => wpItemKey(entry) === wpItemKey(item)) as WpItem,
          );
          const link = newWpLink(site.id, input.items, this.now());
          const project = await this.projectDeps.projects.create({
            name: input.name,
            folderPath: input.folderPath,
            description: input.description ?? '',
            tags: input.tags ?? [],
            agentType: input.agentType,
            notes: '',
            runCommands: [],
            websiteUrl: site.siteUrl,
            prompt: buildWpProjectPrompt(gathered.info, siteItems),
            wordpress: link,
          });
          await this.writeBase(project.id, site, pulled.bases, isFileMap(items), input.items);
          report('done', 1, 1);
          return project;
        } catch (error) {
          await writer.removeCreated();
          if (created) await rm(created, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }),
    );
  }

  async setProjectItems(input: DeployWordPressItemsInput): Promise<Project> {
    const { project, link } = await requireLinkedProject(
      this.projectDeps.projects,
      input.projectId,
    );
    const siteId = input.siteId ?? link.siteId;
    const site = await this.requireSite(siteId);
    return this.runOperation(input.operationId, site.id, project.id, 'items', (signal, report) =>
      this.withSite(site.id, async (client) => {
        const listed = (await client.call(WP_ROUTES.itemsList, {}, { signal })).data.items;
        const onSite = new Set(
          (Array.isArray(listed) ? listed : [])
            .slice(0, MAX_LISTED_ITEMS)
            .map(cleanItem)
            .filter((item): item is WpItem => item !== null && !item.protected)
            .map(wpItemKey),
        );
        const fresh = new Set((input.newItems ?? []).map(wpItemKey));
        const unknown = input.items.filter(
          (item) => !onSite.has(wpItemKey(item)) && !fresh.has(wpItemKey(item)),
        );
        if (unknown.length > 0) {
          throw wordPressError(
            'itemUnknown',
            `The site has no ${unknown.map((item) => wpItemRoot(item)).join(', ')}.`,
          );
        }
        const linked = new Set(link.items.map(wpItemKey));
        await assertNewItems({
          projectRoot: project.folderPath,
          items: input.items,
          newItems: input.newItems ?? [],
          linked,
          onSite,
        });
        if (siteId !== link.siteId) await this.relinkBase(project.id, site);

        // New items are linked as they are: there is nothing on the site to pull into them.
        const added = input.items.filter(
          (item) => !linked.has(wpItemKey(item)) && !fresh.has(wpItemKey(item)),
        );
        if (added.length > 0) {
          await assertItemFoldersEmpty(project.folderPath, added);
          const writer = new WpLocalWriter(project.folderPath);
          try {
            const gathered = await this.gather(client, site, project, added, signal);
            const items = gathered.items.map((state) => ({ ...state, base: {} }));
            const pulled = await this.applyPull(
              client,
              site,
              {
                plan: { changes: planWpPull(items).changes } as DeployWordPressPlan,
                items,
                projectRoot: project.folderPath,
                limits: gathered.info.limits,
              },
              {},
              signal,
              report,
              writer,
            );
            await this.writeBase(project.id, site, pulled.bases, isFileMap(items), input.items);
          } catch (error) {
            await writer.removeCreated();
            throw error;
          }
        } else {
          await this.writeBase(project.id, site, new Map(), new Map(), input.items);
        }
        const updated = await this.projectDeps.projects.setLink(
          project.id,
          newWpLink(site.id, input.items, this.now(), link.ignore),
        );
        this.dropPlans(project.id);
        report('done', 1, 1);
        return updated;
      }),
    );
  }

  /**
   * Saves what the user chose to leave out of this project's pulls and deploys, replacing the
   * whole list. A line that cannot be read is refused, naming the line, so a saved list always
   * compiles. Plans made with the old list are dropped, since they show the wrong files.
   */
  async setProjectIgnore(input: DeployWordPressIgnoreInput): Promise<Project> {
    const { project, link } = await requireLinkedProject(
      this.projectDeps.projects,
      input.projectId,
    );
    const ignore = normalizeWpIgnore(input.ignore, link.items);
    for (const [key, lines] of Object.entries(ignore ?? {})) {
      const checked = createWpIgnoreRules([{ source: key, text: lines.join('\n') }]);
      if (!checked.ok) {
        throw wordPressError(
          'badRequest',
          `Line ${checked.line} of the ignore list for ${key === '*' ? 'every item' : key} cannot be read: ${checked.reason}. Fix it and try again.`,
        );
      }
    }
    const { ignore: _old, ...rest } = link;
    const updated = await this.projectDeps.projects.setLink(
      project.id,
      ignore ? { ...rest, ignore } : rest,
    );
    this.dropPlans(project.id);
    return updated;
  }

  /** The theme and plugin folders in the project, for picking new ones to deploy. */
  async localItems(projectId: string): Promise<DeployWordPressLocalItem[]> {
    const project = await this.projectDeps.projects.get(projectId);
    if (!project) throw wordPressError('projectNotLinked', 'That project no longer exists.');
    const link = normalizeProjectWordPressLink(project.wordpress);
    return listLocalItems(project.folderPath, new Set((link?.items ?? []).map(wpItemKey)));
  }

  /** A relink keeps the base only when it is the same site (same key) under a new id. */
  private async relinkBase(projectId: string, site: StoredWpSite): Promise<void> {
    const base = await this.deps.bases.read(projectId);
    if (base && sameWpSite(site, base.sitePublicKey, `${base.siteOrigin}/`)) {
      await this.deps.bases.write(projectId, { ...base, siteId: site.id });
    } else {
      await this.deps.bases.remove(projectId);
    }
  }

  /**
   * Makes an existing project a WordPress project. Items whose folders are missing or empty are
   * pulled in now; one whose folder already holds files is linked without a pull, so nothing in
   * it is overwritten, and the next pull shows each file that differs from the site as a
   * conflict. The site's facts go into the project's prompt after what the user wrote.
   */
  async linkProject(
    input: DeployWordPressLinkProjectInput,
  ): Promise<DeployWordPressLinkProjectResult> {
    const project = await this.projectDeps.projects.get(input.projectId);
    if (!project) throw wordPressError('projectNotLinked', 'That project no longer exists.');
    if (normalizeProjectWordPressLink(project.wordpress)) {
      throw wordPressError('badRequest', 'This project is already linked to a WordPress site.');
    }
    const site = await this.requireSite(input.siteId);
    return this.runOperation(input.operationId, site.id, project.id, 'items', (signal, report) =>
      this.withSite(site.id, async (client) => {
        const folder = await stat(project.folderPath).catch(() => null);
        if (!folder?.isDirectory()) {
          throw wordPressError('badRequest', "This project's folder is missing.");
        }
        // Whatever an earlier link left behind belongs to another sync.
        await this.deps.bases.remove(project.id);
        report('manifest', 0, input.items.length);
        const gathered = await this.gather(client, site, project, input.items, signal);
        const fresh = new Set((input.newItems ?? []).map(wpItemKey));
        const missing = gathered.items.filter(
          (state) => !state.onSite && !fresh.has(wpItemKey(state.item)),
        );
        if (missing.length > 0) {
          throw wordPressError(
            'itemUnknown',
            `The site has no ${missing.map((state) => wpItemRoot(state.item)).join(', ')}.`,
          );
        }
        await assertNewItems({
          projectRoot: project.folderPath,
          items: input.items,
          newItems: input.newItems ?? [],
          linked: new Set(),
          onSite: new Set(
            gathered.items.filter((state) => state.onSite).map((s) => wpItemKey(s.item)),
          ),
        });
        const withFiles = await itemsWithFiles(project.folderPath, input.items);
        // A new item's files are the point: it is linked as it is, and reported apart.
        const notPulled = withFiles.filter((item) => !fresh.has(wpItemKey(item)));
        const kept = new Set(withFiles.map(wpItemKey));
        const items = gathered.items
          .filter((state) => !kept.has(wpItemKey(state.item)))
          .map((state) => ({ ...state, base: {} }));
        const writer = new WpLocalWriter(project.folderPath);
        try {
          const pulled = await this.applyPull(
            client,
            site,
            {
              plan: { changes: planWpPull(items).changes } as DeployWordPressPlan,
              items,
              projectRoot: project.folderPath,
              limits: gathered.info.limits,
            },
            {},
            signal,
            report,
            writer,
          );
          await this.writeBase(project.id, site, pulled.bases, isFileMap(items), input.items);
          const siteItems = input.items
            .map((item) => gathered.siteItems.find((entry) => wpItemKey(entry) === wpItemKey(item)))
            .filter((item): item is WpItem => item !== undefined);
          const updated = await this.projectDeps.projects.setLink(
            project.id,
            newWpLink(site.id, input.items, this.now()),
            {
              prompt: withWpProjectPrompt(
                project.prompt ?? '',
                buildWpProjectPrompt(gathered.info, siteItems),
              ),
              ...(project.websiteUrl ? {} : { websiteUrl: site.siteUrl }),
            },
          );
          this.dropPlans(project.id);
          report('done', 1, 1);
          return { project: updated, notPulled };
        } catch (error) {
          await writer.removeCreated();
          await this.deps.bases.remove(project.id);
          throw error;
        }
      }),
    );
  }

  async unlinkProject(projectId: string): Promise<Project> {
    const { project: current, link } = await requireLinkedProject(
      this.projectDeps.projects,
      projectId,
    );
    if (this.siteBusy(link.siteId)) {
      throw wordPressError(
        'operationBusy',
        'A pull or deploy for this site is still running. Wait for it to finish first.',
      );
    }
    // The site's facts in the prompt would only mislead agents once the link is gone.
    const prompt = current.prompt ?? '';
    const withoutSite = withoutWpProjectPrompt(prompt);
    const project = await this.projectDeps.projects.setLink(
      projectId,
      undefined,
      withoutSite === prompt ? undefined : { prompt: withoutSite },
    );
    await this.deps.bases.remove(projectId);
    this.dropPlans(projectId);
    return project;
  }

  private dropPlans(projectId: string): void {
    for (const [id, stored] of this.plans) {
      if (stored.plan.projectId === projectId) this.plans.delete(id);
    }
  }

  // Read-only views.

  async localChanges(projectId: string): Promise<DeployWordPressLocalChanges> {
    const { project, link } = await requireLinkedProject(this.projectDeps.projects, projectId);
    const base = await this.deps.bases.read(projectId);
    const counts = { added: 0, modified: 0, deleted: 0 };
    for (const item of link.items) {
      const baseItem = base?.items[wpItemKey(item)];
      const baseFiles = baseItem?.files ?? {};
      const walk = await walkLocalItem({
        projectRoot: project.folderPath,
        item,
        isFile: baseItem?.isFile ?? guessIsFile(item),
        tracked: new Set(Object.keys(baseFiles)),
        savedIgnore: wpIgnoreLinesFor(link.ignore, item),
        hashes: this.hashes,
      });
      if (!walk.exists) continue;
      for (const [path, entry] of Object.entries(walk.files)) {
        const was = baseFiles[path];
        if (!was) counts.added += 1;
        else if (was.sha256 !== entry.sha256) counts.modified += 1;
      }
      for (const path of Object.keys(baseFiles)) {
        if (!walk.files[path] && !walk.rules.excluded(path)) counts.deleted += 1;
      }
    }
    return { projectId, ...counts, checkedAt: this.now() };
  }

  async remoteFile(input: DeployWordPressRemoteFileInput): Promise<DeployWordPressRemoteFile> {
    const { link } = await requireLinkedProject(this.projectDeps.projects, input.projectId);
    selectItems(link, [input.item]);
    return this.withSite(link.siteId, async (client) => {
      const { data, blobs } = await client.call(WP_ROUTES.filesRead, {
        item: input.item,
        files: [{ path: input.path, offset: 0, length: REMOTE_TEXT_MAX }],
      });
      const result = Array.isArray(data.files) ? data.files[0] : undefined;
      if (!result || result.missing || result.path !== input.path) {
        return { text: null, binary: false, tooLarge: false, sha256: null };
      }
      const sha256 = /^[0-9a-f]{64}$/.test(result.sha256) ? result.sha256 : null;
      if (!Number.isSafeInteger(result.size) || result.size > REMOTE_TEXT_MAX) {
        return { text: null, binary: false, tooLarge: true, sha256 };
      }
      const bytes = blobs[0] ?? new Uint8Array(0);
      if (bytes.length !== result.size || sha256Hex(bytes) !== sha256) {
        throw wordPressError('internal', 'The site sent that file back wrong. Try again.');
      }
      let text: string | null = null;
      if (!bytes.includes(0)) {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          text = null;
        }
      }
      return { text, binary: text === null, tooLarge: false, sha256 };
    });
  }
}

function isFileMap(items: readonly { item: WpItemRef; isFile: boolean }[]): Map<string, boolean> {
  return new Map(items.map((state) => [wpItemKey(state.item), state.isFile]));
}
