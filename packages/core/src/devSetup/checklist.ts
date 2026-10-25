import {
  DEV_STACKS,
  displayName,
  getDevItem,
  itemsForStacks,
  normalizeDevSetupStacks,
} from './catalog.js';
import { hasUpdate, type PlanEntry, type SetupSummary, summarizeSetup } from './plan.js';
import { type DevSetupEnvironment, type InstallMode, selectRecipe } from './recipes.js';
import { deriveItemState } from './status.js';
import type {
  DevDetection,
  DevItem,
  DevItemId,
  DevItemJob,
  DevItemState,
  DevStack,
  DevUpdateCheck,
} from './types.js';
import { meetsMinimum } from './version.js';

/**
 * Everything the checklist shows, worked out from three plain inputs: which stacks are chosen,
 * what the machine looks like, and what the probes and the installer have said so far. Both the
 * page and the installer build the checklist this way, so they cannot disagree about a row.
 */

export interface ChecklistRow {
  item: DevItem;
  /** The item's name as this OS knows it. */
  name: string;
  /** How the app would install it here. */
  mode: InstallMode;
  state: DevItemState;
}

export interface ChecklistGroup {
  stack: DevStack;
  rows: ChecklistRow[];
  /** Required items installed, and required items in all. Optional rows are never counted. */
  ready: number;
  total: number;
  /** Rows, optional ones included, that have a newer version available. */
  updates: number;
}

export interface Checklist {
  rows: ChecklistRow[];
  groups: ChecklistGroup[];
  /** The same rows keyed by id, in order, for the install plan. */
  entries: Map<DevItemId, PlanEntry>;
  summary: SetupSummary;
}

export interface ChecklistInput {
  stacks: readonly string[];
  environment: DevSetupEnvironment;
  /** By item id. A missing key means that probe has not answered yet. */
  detections: Readonly<Record<DevItemId, DevDetection | undefined>>;
  /** What the installer is doing for each item. */
  jobs?: Readonly<Record<DevItemId, DevItemJob | undefined>>;
  /**
   * What the update check has found, by item id. Optional: the nav badge builds a checklist
   * without it, and a row whose source has not answered simply shows no update yet.
   */
  updates?: Readonly<Record<DevItemId, DevUpdateCheck | undefined>>;
}

export function buildChecklist(input: ChecklistInput): Checklist {
  const { environment, detections, jobs = {} } = input;
  const items = itemsForStacks(input.stacks, environment.os);
  const byId = new Map(items.map((item) => [item.id, item]));

  /** Whether another item is in place right now. Undefined while its probe has not answered. */
  const readiness = (id: DevItemId): boolean | undefined => {
    const status = jobs[id]?.status;
    // Something being installed is not there yet, whatever the last probe saw.
    if (status === 'installing' || status === 'queued') return false;
    const detection = detections[id];
    if (!detection) return undefined;
    const item = byId.get(id) ?? getDevItem(id);
    if (detection.state !== 'found' || !item) return false;
    return meetsMinimum(detection.version, item.minVersion);
  };

  const rows: ChecklistRow[] = items.map((item) => {
    const detection = detections[item.id];
    // A tool that is already there is brought up to date, not installed again, and the two are
    // different commands (`winget upgrade`, not `winget install`).
    const mode = selectRecipe(item, {
      ...environment,
      intent: detection?.state === 'found' ? 'update' : 'install',
    });
    return {
      item,
      name: displayName(item, environment.os),
      mode,
      state: deriveItemState({
        item,
        os: environment.os,
        mode,
        detection,
        job: jobs[item.id],
        readiness,
        update: input.updates?.[item.id],
      }),
    };
  });

  const entries = new Map<DevItemId, PlanEntry>(
    rows.map((row) => [row.item.id, { item: row.item, mode: row.mode, state: row.state }]),
  );

  const chosen = new Set<string>(normalizeDevSetupStacks(input.stacks));
  const groups: ChecklistGroup[] = DEV_STACKS.filter((stack) => chosen.has(stack.id)).map(
    (stack) => {
      const own = rows.filter((row) => row.item.stack === stack.id);
      const required = own.filter((row) => !row.item.optional);
      return {
        stack,
        rows: own,
        ready: required.filter((row) => row.state.kind === 'installed').length,
        total: required.length,
        updates: own.filter((row) => hasUpdate(row.state)).length,
      };
    },
  );

  return { rows, groups, entries, summary: summarizeSetup([...entries.values()]) };
}
