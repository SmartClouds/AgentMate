import { DEV_STACKS, getDevItem } from './catalog.js';
import type { InstallMode } from './recipes.js';
import { dependencyIds } from './status.js';
import type { DevConsent, DevItem, DevItemId, DevItemState, DevOs, DevStackId } from './types.js';

/**
 * Working out what "Install all missing" actually does. Some steps run inside the app, some need a
 * terminal or a download, and some can only run once those are done. Splitting them into three
 * lists up front is what lets the button run everything it can, say plainly what it cannot, and
 * pick up again when pressed a second time.
 */

export interface PlanEntry {
  item: DevItem;
  mode: InstallMode;
  state: DevItemState;
}

export interface InstallPlan {
  /** Run these inside the app, in this order. */
  steps: DevItemId[];
  /** The user does these by hand (a terminal, a download page), in dependency order. */
  manual: DevItemId[];
  /** Could run in the app, but need something in `manual` first. */
  deferred: DevItemId[];
}

/** States where the item is not there and nothing is already handling it. */
function needsWork(state: DevItemState): boolean {
  switch (state.kind) {
    case 'missing':
    case 'outdated':
    case 'failed':
    case 'blocked':
    case 'waiting-terminal':
    case 'unavailable':
      return true;
    default:
      return false;
  }
}

/** Whether this row is ready and has a newer version on offer. */
export function hasUpdate(state: DevItemState): boolean {
  return state.kind === 'installed' && state.update !== undefined;
}

/** An update that can be started now: not already handed to a terminal and waiting there. */
function updatable(state: DevItemState): boolean {
  return state.kind === 'installed' && state.update !== undefined && !state.update.waiting;
}

/** The items "Update all" would update, in checklist order. Optional items are included. */
export function updatableItemIds(entries: ReadonlyMap<DevItemId, PlanEntry>): DevItemId[] {
  return [...entries.values()]
    .filter((entry) => updatable(entry.state))
    .map((entry) => entry.item.id);
}

export interface UpdatePlan {
  /** Run these inside the app, in this order. */
  steps: DevItemId[];
  /** The person runs these in a terminal: they need a password or an admin prompt. */
  manual: DevItemId[];
}

/**
 * What updating these items does. Everything here is installed already, so unlike an install there
 * is no order to work out: a tool that needed another was only ever installed after it. The split
 * is the same one an install makes, between what the app runs and what has to go to a terminal.
 */
export function buildUpdatePlan(
  targets: readonly DevItemId[],
  entries: ReadonlyMap<DevItemId, PlanEntry>,
): UpdatePlan {
  const steps: DevItemId[] = [];
  const manual: DevItemId[] = [];
  for (const id of new Set(targets)) {
    const entry = entries.get(id);
    if (!entry || !updatable(entry.state)) continue;
    if (entry.mode.mode === 'in-app') steps.push(id);
    else if (entry.mode.mode === 'terminal') manual.push(id);
  }
  return { steps, manual };
}

/** The required items still to do, in checklist order. Optional items are only installed by name. */
export function missingItemIds(entries: ReadonlyMap<DevItemId, PlanEntry>): DevItemId[] {
  return [...entries.values()]
    .filter((entry) => !entry.item.optional && needsWork(entry.state))
    .map((entry) => entry.item.id);
}

export function buildInstallPlan(
  targets: readonly DevItemId[],
  entries: ReadonlyMap<DevItemId, PlanEntry>,
  os: DevOs,
): InstallPlan {
  // The plan only knows the items on this checklist, so a dependency outside it does not exist.
  const lookup = (id: DevItemId): DevItem | undefined => entries.get(id)?.item;
  const dependenciesOf = (entry: PlanEntry): DevItemId[] =>
    dependencyIds(entry.item, os, entry.mode, lookup);

  const order: DevItemId[] = [];
  const done = new Set<DevItemId>();
  const visiting = new Set<DevItemId>();

  const visit = (id: DevItemId, path: readonly DevItemId[]): void => {
    if (done.has(id)) return;
    const entry = entries.get(id);
    if (!entry || !needsWork(entry.state)) return;
    if (visiting.has(id)) {
      throw new Error(`Dependency cycle: ${[...path, id].join(' -> ')}`);
    }
    visiting.add(id);
    for (const dependency of dependenciesOf(entry)) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of new Set(targets)) visit(id, []);

  const steps: DevItemId[] = [];
  const manual: DevItemId[] = [];
  const deferred: DevItemId[] = [];
  const planned = new Set<DevItemId>();

  /** Whether a dependency will be in place by the time the item that needs it runs. */
  const resolved = (id: DevItemId): boolean => {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state.kind === 'installed') return true;
    if (entry.state.kind === 'installing' || entry.state.kind === 'queued') return true;
    return planned.has(id);
  };

  for (const id of order) {
    const entry = entries.get(id);
    if (!entry) continue;
    const ready = dependenciesOf(entry).every(resolved);
    switch (entry.mode.mode) {
      case 'bundled':
        // Arrives with its parent. It is "in place" once the parent is, so dependents can proceed.
        if (ready) planned.add(id);
        break;
      case 'in-app':
        if (ready) {
          steps.push(id);
          planned.add(id);
        } else {
          deferred.push(id);
        }
        break;
      default:
        // The user's own step. It counts as in place only after they have done it, which is a
        // later run of the plan, so nothing that depends on it is planned now.
        if (ready) manual.push(id);
        else deferred.push(id);
    }
  }

  return { steps, manual, deferred };
}

/** The agreements behind the steps that will run, each listed once, in the order they appear. */
export function collectConsents(stepIds: readonly DevItemId[]): DevConsent[] {
  const seen = new Set<string>();
  const consents: DevConsent[] = [];
  for (const id of stepIds) {
    const consent = getDevItem(id)?.consent;
    if (!consent || seen.has(consent.title)) continue;
    seen.add(consent.title);
    consents.push(consent);
  }
  return consents;
}

export interface StackSummary {
  stack: DevStackId;
  ready: number;
  total: number;
}

export interface SetupSummary {
  /** Required items only: optional ones are shown but never held against "ready". */
  total: number;
  ready: number;
  /** Required items whose probe has not answered yet. */
  checking: number;
  /** Required items that are not installed, ignoring those still being checked. */
  missing: number;
  /** Items of any kind that are ready and have a newer version. They are still counted as ready. */
  updates: number;
  stacks: StackSummary[];
  complete: boolean;
}

export function summarizeSetup(entries: readonly PlanEntry[]): SetupSummary {
  const required = entries.filter((entry) => !entry.item.optional);
  const ready = required.filter((entry) => entry.state.kind === 'installed').length;
  const checking = required.filter((entry) => entry.state.kind === 'checking').length;
  const missing = required.filter(
    (entry) =>
      entry.state.kind !== 'installed' &&
      entry.state.kind !== 'checking' &&
      entry.state.kind !== 'unknown',
  ).length;

  const stacks: StackSummary[] = [];
  for (const stack of DEV_STACKS) {
    const own = required.filter((entry) => entry.item.stack === stack.id);
    if (own.length === 0) continue;
    stacks.push({
      stack: stack.id,
      ready: own.filter((entry) => entry.state.kind === 'installed').length,
      total: own.length,
    });
  }

  return {
    total: required.length,
    ready,
    checking,
    missing,
    updates: entries.filter((entry) => hasUpdate(entry.state)).length,
    stacks,
    complete: required.length > 0 && ready === required.length,
  };
}
