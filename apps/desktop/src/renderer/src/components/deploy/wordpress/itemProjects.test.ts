import type { WpItemRef } from '@agentmat/core';
import { describe, expect, it } from 'vitest';
import { addItemPlan, projectChoicesFor, removeItemPlan } from './itemProjects';
import { wpProject, wpSite } from './testing/fixtures';

/**
 * A site's theme or plugin can go into a project linked to the same site, or into a plain
 * project (which links it), but never into one linked to another site. The last item never
 * leaves a project on its own: taking it out unlinks the project.
 */

const SITE = wpSite().id;
const THEME: WpItemRef = { kind: 'theme', slug: 'crumb-child' };
const PLUGIN: WpItemRef = { kind: 'plugin', slug: 'oven-timer' };

function linked(id: string, name: string, items: WpItemRef[], siteId = SITE) {
  return wpProject({ id, name, wordpress: { siteId, items, linkedAt: '2026-10-01T00:00:00Z' } });
}

function plain(id: string, name: string) {
  return wpProject({ id, name, wordpress: undefined });
}

describe('projectChoicesFor', () => {
  it('sorts every project into its group', () => {
    const holder = linked('a', 'Holder', [THEME]);
    const sibling = linked('b', 'Sibling', [PLUGIN]);
    const loose = plain('c', 'Loose');
    const elsewhere = linked('d', 'Elsewhere', [PLUGIN], 'site-other');

    const choices = projectChoicesFor([holder, sibling, loose, elsewhere], SITE, THEME);

    expect(choices.holding).toEqual([holder]);
    expect(choices.siteProjects).toEqual([sibling]);
    expect(choices.unlinked).toEqual([loose]);
    expect(choices.otherSite).toEqual([{ project: elsewhere, siteId: 'site-other' }]);
  });

  it('puts a project holding the item in holding whatever else is true of it', () => {
    const elsewhere = linked('d', 'Elsewhere', [THEME], 'site-other');
    const choices = projectChoicesFor([elsewhere], SITE, THEME);
    expect(choices.holding).toEqual([elsewhere]);
    expect(choices.otherSite).toEqual([]);
  });

  it('matches the item by kind and slug, not slug alone', () => {
    const samePluginSlug = linked('a', 'Same slug', [{ kind: 'plugin', slug: 'crumb-child' }]);
    const choices = projectChoicesFor([samePluginSlug], SITE, THEME);
    expect(choices.holding).toEqual([]);
    expect(choices.siteProjects).toEqual([samePluginSlug]);
  });

  it('orders each group by name, ignoring case', () => {
    const projects = [
      plain('1', 'cherry'),
      plain('2', 'Apple'),
      plain('3', 'banana'),
      linked('4', 'zeta', [PLUGIN]),
      linked('5', 'Alpha', [PLUGIN]),
      linked('6', 'Mid', [PLUGIN], 'site-x'),
      linked('7', 'early', [PLUGIN], 'site-y'),
      linked('8', 'Second', [THEME]),
      linked('9', 'first', [THEME]),
    ];

    const choices = projectChoicesFor(projects, SITE, THEME);

    expect(choices.unlinked.map((p) => p.name)).toEqual(['Apple', 'banana', 'cherry']);
    expect(choices.siteProjects.map((p) => p.name)).toEqual(['Alpha', 'zeta']);
    expect(choices.otherSite.map((c) => c.project.name)).toEqual(['early', 'Mid']);
    expect(choices.holding.map((p) => p.name)).toEqual(['first', 'Second']);
  });

  it('gives empty groups for no projects', () => {
    expect(projectChoicesFor([], SITE, THEME)).toEqual({
      siteProjects: [],
      unlinked: [],
      otherSite: [],
      holding: [],
    });
  });
});

describe('addItemPlan', () => {
  it('appends the item to a project linked to the same site', () => {
    expect(addItemPlan(linked('a', 'A', [PLUGIN]), SITE, THEME)).toEqual({
      kind: 'items',
      items: [PLUGIN, THEME],
    });
  });

  it('links a plain project with just the item', () => {
    expect(addItemPlan(plain('a', 'A'), SITE, THEME)).toEqual({ kind: 'link', items: [THEME] });
  });

  it('refuses a project linked to another site', () => {
    expect(() => addItemPlan(linked('a', 'A', [PLUGIN], 'site-other'), SITE, THEME)).toThrow();
  });

  it('refuses a project that already syncs the item', () => {
    expect(() => addItemPlan(linked('a', 'A', [THEME]), SITE, THEME)).toThrow();
  });
});

describe('removeItemPlan', () => {
  it('drops the item and keeps the rest in order', () => {
    expect(
      removeItemPlan(
        linked('a', 'A', [PLUGIN, THEME, { kind: 'mu-plugin', slug: 'x.php' }]),
        THEME,
      ),
    ).toEqual({
      kind: 'items',
      items: [PLUGIN, { kind: 'mu-plugin', slug: 'x.php' }],
    });
  });

  it('unlinks the project when the item is its last one', () => {
    expect(removeItemPlan(linked('a', 'A', [THEME]), THEME)).toEqual({ kind: 'unlink' });
  });

  it('refuses a project that does not sync the item', () => {
    expect(() => removeItemPlan(linked('a', 'A', [PLUGIN]), THEME)).toThrow();
    expect(() => removeItemPlan(plain('a', 'A'), THEME)).toThrow();
  });
});
