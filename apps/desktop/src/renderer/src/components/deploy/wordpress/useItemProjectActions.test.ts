import type { Project, WpItemRef } from '@agentmat/core';
import type { DeployWordPressLinkProjectResult } from '@shared/deployWordPressTypes';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { wpProject, wpSite } from './testing/fixtures';
import { useItemProjectActions } from './useItemProjectActions';

/**
 * Adding, taking out and moving a site's theme or plugin between projects. A move adds first and
 * removes second, so a failed add leaves both projects as they were.
 */

const SITE = wpSite().id;
const THEME: WpItemRef = { kind: 'theme', slug: 'crumb-child' };
const PLUGIN: WpItemRef = { kind: 'plugin', slug: 'oven-timer' };
const UUID = /^[0-9a-f-]{36}$/;

function linked(id: string, name: string, items: WpItemRef[], siteId = SITE): Project {
  return wpProject({ id, name, wordpress: { siteId, items, linkedAt: '2026-10-01T00:00:00Z' } });
}

function plain(id: string, name: string): Project {
  return wpProject({ id, name, wordpress: undefined });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(bridge: Record<string, unknown>, projects: Project[] = []) {
  const view = renderHookWithProviders(() => useItemProjectActions(SITE), { bridge });
  view.queryClient.setQueryData(queryKeys.projects, projects);
  return view;
}

describe('useItemProjectActions', () => {
  it('adds the item to a project linked to the site, keeping its other items', async () => {
    const target = linked('b', 'Bakery shop', [PLUGIN]);
    const updated = linked('b', 'Bakery shop', [PLUGIN, THEME]);
    const { result, bridge, queryClient } = setup({ 'deployWordPress.setProjectItems': updated }, [
      target,
    ]);

    let outcome: Awaited<ReturnType<typeof result.current.add>> | undefined;
    await act(async () => {
      outcome = await result.current.add(target, THEME);
    });

    expect(outcome).toEqual({ ok: true });
    expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
      operationId: expect.stringMatching(UUID),
      projectId: 'b',
      items: [PLUGIN, THEME],
    });
    expect(queryClient.getQueryData(queryKeys.projects)).toEqual([updated]);
    expect(result.current.operationId).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(useWordPressOperationStore.getState().runs).toEqual({});
  });

  it('links a plain project with just the item and puts the linked project in the cache', async () => {
    const target = plain('b', 'Loose');
    const linkedResult: DeployWordPressLinkProjectResult = {
      project: linked('b', 'Loose', [THEME]),
      notPulled: [THEME],
    };
    const { result, bridge, queryClient } = setup({ 'deployWordPress.linkProject': linkedResult }, [
      target,
    ]);

    let outcome: Awaited<ReturnType<typeof result.current.add>> | undefined;
    await act(async () => {
      outcome = await result.current.add(target, THEME);
    });

    expect(outcome).toEqual({ ok: true, notPulled: [THEME] });
    expect(bridge.$fn('deployWordPress.linkProject')).toHaveBeenCalledWith({
      operationId: expect.stringMatching(UUID),
      projectId: 'b',
      siteId: SITE,
      items: [THEME],
    });
    expect(queryClient.getQueryData(queryKeys.projects)).toEqual([linkedResult.project]);
  });

  it('shows the running operation while an add is in flight', async () => {
    const call = deferred<Project>();
    const target = linked('b', 'Bakery shop', [PLUGIN]);
    const { result } = setup({ 'deployWordPress.setProjectItems': () => call.promise }, [target]);

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.add(target, THEME);
    });

    await waitFor(() => expect(result.current.busy).toBe(true));
    const id = result.current.operationId;
    expect(id).toMatch(UUID);
    expect(useWordPressOperationStore.getState().runs[id as string]?.status).toBe('running');

    await act(async () => {
      call.resolve(linked('b', 'Bakery shop', [PLUGIN, THEME]));
      await pending;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.operationId).toBeNull();
  });

  it('keeps a failed add on screen with its reason until reset', async () => {
    const target = linked('b', 'Bakery shop', [PLUGIN]);
    const { result } = setup(
      {
        'deployWordPress.setProjectItems': async () => {
          throw new Error('[wp:operationBusy] A pull from this site is still running.');
        },
      },
      [target],
    );

    let outcome: Awaited<ReturnType<typeof result.current.add>> | undefined;
    await act(async () => {
      outcome = await result.current.add(target, THEME);
    });

    expect(outcome).toEqual({ ok: false, error: 'A pull from this site is still running.' });
    const id = result.current.operationId as string;
    expect(useWordPressOperationStore.getState().runs[id]?.status).toBe('failed');

    act(() => result.current.reset());
    expect(result.current.operationId).toBeNull();
    expect(useWordPressOperationStore.getState().runs[id]).toBeUndefined();
  });

  it('refuses a project linked to another site without calling anything', async () => {
    const target = linked('b', 'Elsewhere', [PLUGIN], 'site-other');
    const { result, bridge } = setup({}, [target]);

    let outcome: Awaited<ReturnType<typeof result.current.add>> | undefined;
    await act(async () => {
      outcome = await result.current.add(target, THEME);
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome?.error).toBeTruthy();
    expect(() => bridge.$fn('deployWordPress.setProjectItems')).toThrow();
    expect(() => bridge.$fn('deployWordPress.linkProject')).toThrow();
  });

  it('takes the item out of a project that keeps others', async () => {
    const source = linked('a', 'Bakery theme', [THEME, PLUGIN]);
    const { result, bridge } = setup(
      { 'deployWordPress.setProjectItems': linked('a', 'Bakery theme', [PLUGIN]) },
      [source],
    );

    let outcome: Awaited<ReturnType<typeof result.current.remove>> | undefined;
    await act(async () => {
      outcome = await result.current.remove(source, THEME);
    });

    expect(outcome).toEqual({ ok: true });
    expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
      operationId: expect.stringMatching(UUID),
      projectId: 'a',
      items: [PLUGIN],
    });
  });

  it('unlinks the project when the item is its last one', async () => {
    const source = linked('a', 'Bakery theme', [THEME]);
    const unlinked = plain('a', 'Bakery theme');
    const { result, bridge, queryClient } = setup({ 'deployWordPress.unlinkProject': unlinked }, [
      source,
    ]);

    let outcome: Awaited<ReturnType<typeof result.current.remove>> | undefined;
    await act(async () => {
      outcome = await result.current.remove(source, THEME);
    });

    expect(outcome).toEqual({ ok: true });
    expect(bridge.$fn('deployWordPress.unlinkProject')).toHaveBeenCalledWith('a');
    expect(() => bridge.$fn('deployWordPress.setProjectItems')).toThrow();
    expect(queryClient.getQueryData(queryKeys.projects)).toEqual([unlinked]);
  });

  it('says why an unlink failed', async () => {
    const source = linked('a', 'Bakery theme', [THEME]);
    const { result } = setup(
      {
        'deployWordPress.unlinkProject': async () => {
          throw new Error('The project folder is gone.');
        },
      },
      [source],
    );

    let outcome: Awaited<ReturnType<typeof result.current.remove>> | undefined;
    await act(async () => {
      outcome = await result.current.remove(source, THEME);
    });

    expect(outcome).toEqual({ ok: false, error: 'The project folder is gone.' });
    expect(result.current.busy).toBe(false);
  });

  it('moves by adding to the new project before taking it out of the old one', async () => {
    const from = linked('a', 'Bakery theme', [THEME]);
    const to = plain('b', 'Loose');
    const { result, bridge, queryClient } = setup(
      {
        'deployWordPress.linkProject': { project: linked('b', 'Loose', [THEME]), notPulled: [] },
        'deployWordPress.unlinkProject': plain('a', 'Bakery theme'),
      },
      [from, to],
    );

    let outcome: Awaited<ReturnType<typeof result.current.move>> | undefined;
    await act(async () => {
      outcome = await result.current.move(from, to, THEME);
    });

    expect(outcome).toEqual({ ok: true, notPulled: [] });
    const link = bridge.$fn('deployWordPress.linkProject');
    const unlink = bridge.$fn('deployWordPress.unlinkProject');
    expect(link).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'b', items: [THEME] }));
    expect(unlink).toHaveBeenCalledWith('a');
    expect(link.mock.invocationCallOrder[0]).toBeLessThan(unlink.mock.invocationCallOrder[0]);
    const cached = queryClient.getQueryData<Project[]>(queryKeys.projects) ?? [];
    expect(cached.map((project) => [project.id, project.wordpress?.items])).toEqual([
      ['a', undefined],
      ['b', [THEME]],
    ]);
  });

  it('moves between two projects on the site with two item changes, add first', async () => {
    const from = linked('a', 'Bakery theme', [THEME, PLUGIN]);
    const to = linked('b', 'Bakery shop', [PLUGIN]);
    const { result, bridge } = setup(
      {
        'deployWordPress.setProjectItems': async (input: { projectId: string }) =>
          input.projectId === 'b'
            ? linked('b', 'Bakery shop', [PLUGIN, THEME])
            : linked('a', 'Bakery theme', [PLUGIN]),
      },
      [from, to],
    );

    let outcome: Awaited<ReturnType<typeof result.current.move>> | undefined;
    await act(async () => {
      outcome = await result.current.move(from, to, THEME);
    });

    expect(outcome).toEqual({ ok: true });
    const calls = bridge.$fn('deployWordPress.setProjectItems').mock.calls;
    expect(calls.map(([input]) => [input.projectId, input.items])).toEqual([
      ['b', [PLUGIN, THEME]],
      ['a', [PLUGIN]],
    ]);
  });

  it('never takes the item out of the old project when the add fails', async () => {
    const from = linked('a', 'Bakery theme', [THEME]);
    const to = plain('b', 'Loose');
    const { result, bridge } = setup(
      {
        'deployWordPress.linkProject': async () => {
          throw new Error('[wp:operationBusy] A pull from this site is still running.');
        },
      },
      [from, to],
    );

    let outcome: Awaited<ReturnType<typeof result.current.move>> | undefined;
    await act(async () => {
      outcome = await result.current.move(from, to, THEME);
    });

    expect(outcome).toEqual({ ok: false, error: 'A pull from this site is still running.' });
    expect(() => bridge.$fn('deployWordPress.unlinkProject')).toThrow();
    expect(() => bridge.$fn('deployWordPress.setProjectItems')).toThrow();
    expect(result.current.operationId).toMatch(UUID);
  });

  it('says the item is in both projects when the remove fails after the add worked', async () => {
    const from = linked('a', 'Bakery theme', [THEME]);
    const to = plain('b', 'Loose');
    const { result } = setup(
      {
        'deployWordPress.linkProject': { project: linked('b', 'Loose', [THEME]), notPulled: [] },
        'deployWordPress.unlinkProject': async () => {
          throw new Error('The project folder is gone.');
        },
      },
      [from, to],
    );

    let outcome: Awaited<ReturnType<typeof result.current.move>> | undefined;
    await act(async () => {
      outcome = await result.current.move(from, to, THEME);
    });

    expect(outcome).toEqual({
      ok: false,
      partial: true,
      notPulled: [],
      error: "Added to Loose, but it's still in Bakery theme. The project folder is gone.",
    });
    expect(result.current.busy).toBe(false);
  });
});
