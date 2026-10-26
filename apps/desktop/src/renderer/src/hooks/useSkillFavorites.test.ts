import { bundledSkillsShDirectory } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FavoriteSkillRecord } from '../../../shared/apiTypes';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The starred-skills list is shared by every surface that draws a star, so what matters is the
 * call it sends the main process and the identity it hands back: a star lit by name has to unstar
 * the record that actually matched, and the toggle has to keep one identity or the memoized skill
 * grids re-render a thousand cards per keystroke.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { useSkillFavorites, usageFavoriteInput } = await import('./useSkillFavorites');

function favorite(overrides: Partial<FavoriteSkillRecord> = {}): FavoriteSkillRecord {
  return {
    skillId: 'anthropics/skills/pdf',
    name: 'pdf',
    source: 'skills-sh',
    sourceLabel: 'anthropics/skills',
    addedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('useSkillFavorites reading the list', () => {
  it('starts pending and ends with an empty list when nothing is starred', async () => {
    const { result } = renderHookWithProviders(() => useSkillFavorites());

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.favorites).toEqual([]);
    expect(result.current.isFavorite('anything')).toBe(false);
  });

  it('lights the star for a stored favorite by its id and by its bare name', async () => {
    const { result } = renderHookWithProviders(() => useSkillFavorites(), {
      bridge: { 'skills.listFavorites': [favorite()] },
    });

    await waitFor(() => expect(result.current.favorites).toHaveLength(1));
    // A usage row only knows `pdf`, a directory card knows the full id. Both are the same star.
    expect(result.current.isFavorite('anthropics/skills/pdf')).toBe(true);
    expect(result.current.isFavorite('pdf')).toBe(true);
    expect(result.current.isFavorite('docx')).toBe(false);
  });

  it('keeps one toggle identity so the memoized skill cards are not re-rendered', async () => {
    const { result, rerender } = renderHookWithProviders(() => useSkillFavorites(), {
      bridge: { 'skills.listFavorites': [favorite()] },
    });

    const first = result.current.toggleFavorite;
    await waitFor(() => expect(result.current.favorites).toHaveLength(1));
    rerender();

    expect(result.current.toggleFavorite).toBe(first);
  });
});

describe('useSkillFavorites starring and unstarring', () => {
  it('adds a skill that is not starred yet and says so', async () => {
    const added = [favorite({ skillId: 'vercel/skills/next', name: 'next' })];
    const { result, bridge } = renderHookWithProviders(() => useSkillFavorites(), {
      bridge: { 'skills.listFavorites': [], 'skills.addFavorite': added },
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    act(() =>
      result.current.toggleFavorite({
        skillId: 'vercel/skills/next',
        name: 'next',
        source: 'skills-sh',
        sourceLabel: 'vercel/skills',
      }),
    );

    await waitFor(() => expect(result.current.favorites).toEqual(added));
    expect(bridge.$fn('skills.addFavorite')).toHaveBeenCalledWith({
      skillId: 'vercel/skills/next',
      name: 'next',
      source: 'skills-sh',
      sourceLabel: 'vercel/skills',
    });
    expect(toast.success).toHaveBeenCalledWith('next favorited.');
  });

  it('unstars the record that actually matched, even when the star was lit by name', async () => {
    const stored = favorite();
    const { result, bridge } = renderHookWithProviders(() => useSkillFavorites(), {
      bridge: { 'skills.listFavorites': [stored], 'skills.removeFavorite': [] },
    });
    await waitFor(() => expect(result.current.favorites).toHaveLength(1));

    // What a Usage tab row knows: the bare name and nothing else.
    act(() =>
      result.current.toggleFavorite({
        skillId: 'pdf',
        name: 'pdf',
        source: 'local',
        sourceLabel: 'Used locally',
      }),
    );

    // Removing "pdf" would leave the stored `anthropics/skills/pdf` behind forever.
    await waitFor(() =>
      expect(bridge.$fn('skills.removeFavorite')).toHaveBeenCalledWith('anthropics/skills/pdf'),
    );
    expect(result.current.favorites).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith('pdf removed from favorites.');
  });

  it('reports a rejected write instead of pretending the star stuck', async () => {
    const { result, bridge } = renderHookWithProviders(() => useSkillFavorites(), {
      bridge: {
        'skills.listFavorites': [],
        'skills.addFavorite': () => Promise.reject(new Error('favorites.json is read-only')),
      },
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    act(() =>
      result.current.toggleFavorite({
        skillId: 'a/b/c',
        name: 'c',
        source: 'skills-sh',
        sourceLabel: 'a/b',
      }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('favorites.json is read-only'));
    expect(result.current.favorites).toEqual([]);
    expect(bridge.$fn('skills.addFavorite')).toHaveBeenCalledTimes(1);
  });

  it('reports the write as in flight while it is running', async () => {
    let release = (): void => undefined;
    const { result } = renderHookWithProviders(() => useSkillFavorites(), {
      bridge: {
        'skills.listFavorites': [],
        'skills.addFavorite': () =>
          new Promise((resolve) => {
            release = () => resolve([]);
          }),
      },
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    act(() =>
      result.current.toggleFavorite({
        skillId: 'a/b/c',
        name: 'c',
        source: 'skills-sh',
        sourceLabel: 'a/b',
      }),
    );

    await waitFor(() => expect(result.current.isSaving).toBe(true));
    act(() => release());
    await waitFor(() => expect(result.current.isSaving).toBe(false));
  });
});

describe('usageFavoriteInput', () => {
  it('resolves a bare invocation name back to the bundled skill it came from', () => {
    // Taken from the real bundled directory so the test moves with the snapshot.
    const unique = bundledSkillsShDirectory.find(
      (entry) => bundledSkillsShDirectory.filter((other) => other.name === entry.name).length === 1,
    );
    if (!unique) throw new Error('the bundled directory has no unambiguous skill name');

    expect(usageFavoriteInput(unique.name)).toEqual({
      skillId: unique.id,
      name: unique.name,
      source: 'skills-sh',
      sourceLabel: unique.repo,
      description: unique.description,
      owner: unique.owner,
      repo: unique.repo,
      url: unique.url,
      installCommand: unique.installCommand,
      official: unique.official,
    });
  });

  it('stores a name it cannot place as a local skill rather than guessing an owner', () => {
    expect(usageFavoriteInput('a-skill-nobody-published')).toEqual({
      skillId: 'a-skill-nobody-published',
      name: 'a-skill-nobody-published',
      source: 'local',
      sourceLabel: 'Used locally',
    });
  });
});
