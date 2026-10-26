import type { Project, WpItemRef } from '@runova/core';
import { wpItemKey } from '@runova/core';

/**
 * Which projects a site's theme or plugin can go into, and what adding, removing or moving it
 * means for each. A project is linked to one site at most and always syncs at least one item,
 * so the last item never leaves a project on its own: the project is unlinked instead.
 */

/** A project linked to a different site. It can't take this site's items. */
export interface OtherSiteChoice {
  project: Project;
  siteId: string;
}

export interface ProjectChoices {
  /** Linked to this site and not holding the item yet. Adding changes their item list. */
  siteProjects: Project[];
  /** Plain projects. Adding links them to this site with just this item. */
  unlinked: Project[];
  /** Linked to another site, so they can't be picked. */
  otherSite: OtherSiteChoice[];
  /** Already sync the item. Never offered as a target. */
  holding: Project[];
}

export type AddItemPlan =
  | { kind: 'items'; items: WpItemRef[] }
  | { kind: 'link'; items: WpItemRef[] };

export type RemoveItemPlan = { kind: 'items'; items: WpItemRef[] } | { kind: 'unlink' };

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function holds(project: Project, item: WpItemRef): boolean {
  const key = wpItemKey(item);
  return (project.wordpress?.items ?? []).some((entry) => wpItemKey(entry) === key);
}

function sortInto(
  projects: readonly Project[],
  siteId: string,
  isHolding: (project: Project) => boolean,
): ProjectChoices {
  const choices: ProjectChoices = { siteProjects: [], unlinked: [], otherSite: [], holding: [] };
  for (const project of projects) {
    const link = project.wordpress;
    if (isHolding(project)) choices.holding.push(project);
    else if (!link) choices.unlinked.push(project);
    else if (link.siteId === siteId) choices.siteProjects.push(project);
    else choices.otherSite.push({ project, siteId: link.siteId });
  }
  choices.siteProjects.sort(byName);
  choices.unlinked.sort(byName);
  choices.holding.sort(byName);
  choices.otherSite.sort((a, b) => byName(a.project, b.project));
  return choices;
}

/** Sorts every project into the groups above, each by name. */
export function projectChoicesFor(
  projects: readonly Project[],
  siteId: string,
  item: WpItemRef,
): ProjectChoices {
  return sortInto(projects, siteId, (project) => holds(project, item));
}

/** The same groups for something that is not on the site yet, so no project holds it. */
export function projectChoicesForSite(
  projects: readonly Project[],
  siteId: string,
): ProjectChoices {
  return sortInto(projects, siteId, () => false);
}

/**
 * What adding the item to a project does. Throws for a project linked to another site, or one
 * that already syncs the item.
 */
export function addItemPlan(project: Project, siteId: string, item: WpItemRef): AddItemPlan {
  if (holds(project, item)) throw new Error(`${project.name} already syncs ${item.slug}.`);
  const link = project.wordpress;
  if (!link) return { kind: 'link', items: [item] };
  if (link.siteId !== siteId) throw new Error(`${project.name} is linked to another site.`);
  return { kind: 'items', items: [...link.items, item] };
}

/**
 * What taking the item out of a project does: a shorter item list, or an unlink when it is the
 * last one. Throws when the project doesn't sync the item.
 */
export function removeItemPlan(project: Project, item: WpItemRef): RemoveItemPlan {
  const link = project.wordpress;
  if (!link || !holds(project, item)) {
    throw new Error(`${project.name} doesn't sync ${item.slug}.`);
  }
  const key = wpItemKey(item);
  const items = link.items.filter((entry) => wpItemKey(entry) !== key);
  return items.length === 0 ? { kind: 'unlink' } : { kind: 'items', items };
}
