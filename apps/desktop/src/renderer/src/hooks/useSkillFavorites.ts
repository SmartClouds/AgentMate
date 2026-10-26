import { bundledSkillsShDirectory } from '@runova/core';
import type { FavoriteSkillInput, FavoriteSkillRecord } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

/**
 * A usage row only knows the bare name the agent invoked (`frontend-design`), while the
 * directory knows it as `owner/repo/name`. Matching the two here means starring a skill from the
 * Usage tab lights the star up on its directory card too, and the favorite carries the install
 * command with it. Names that appear under more than one owner are left unresolved rather than
 * guessed at.
 */
const BUNDLED_BY_NAME = (() => {
  const byName = new Map<string, (typeof bundledSkillsShDirectory)[number] | null>();
  for (const entry of bundledSkillsShDirectory) {
    byName.set(entry.name, byName.has(entry.name) ? null : entry);
  }
  return byName;
})();

/** What starring an invocation from the Usage tab should store. */
export function usageFavoriteInput(skillName: string): FavoriteSkillInput {
  const bundled = BUNDLED_BY_NAME.get(skillName);
  if (bundled) {
    return {
      skillId: bundled.id,
      name: bundled.name,
      source: 'skills-sh',
      sourceLabel: bundled.repo,
      description: bundled.description,
      owner: bundled.owner,
      repo: bundled.repo,
      url: bundled.url,
      installCommand: bundled.installCommand,
      official: bundled.official,
    };
  }
  return {
    skillId: skillName,
    name: skillName,
    source: 'local',
    sourceLabel: 'Used locally',
  };
}

export interface SkillFavorites {
  favorites: FavoriteSkillRecord[];
  isPending: boolean;
  /** True for a skill already starred, by id or (for a usage row) by name. */
  isFavorite: (skillIdOrName: string) => boolean;
  toggleFavorite: (skill: FavoriteSkillInput) => void;
  isSaving: boolean;
}

/** The starred-skills list plus the star/unstar mutation, shared by every surface with a star. */
export function useSkillFavorites(): SkillFavorites {
  const queryClient = useQueryClient();

  const favoritesQuery = useQuery({
    queryKey: queryKeys.skillFavorites,
    queryFn: () => window.runova.skills.listFavorites(),
  });

  const favorites = useMemo(() => favoritesQuery.data ?? [], [favoritesQuery.data]);

  const favoriteKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const favorite of favorites) {
      keys.add(favorite.skillId);
      keys.add(favorite.name);
    }
    return keys;
  }, [favorites]);

  const mutation = useMutation({
    mutationFn: ({ skill, starred }: { skill: FavoriteSkillInput; starred: boolean }) =>
      starred
        ? window.runova.skills.removeFavorite(skill.skillId)
        : window.runova.skills.addFavorite(skill),
    onSuccess: (next, { skill, starred }) => {
      queryClient.setQueryData(queryKeys.skillFavorites, next);
      toast.success(starred ? `${skill.name} removed from favorites.` : `${skill.name} favorited.`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isFavorite = useCallback(
    (skillIdOrName: string) => favoriteKeys.has(skillIdOrName),
    [favoriteKeys],
  );

  // Read through a ref so the toggle keeps one identity for the life of the page: the skill
  // grids memoize their cards on it, and `mutate` is stable in react-query.
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const { mutate } = mutation;

  const toggleFavorite = useCallback(
    (skill: FavoriteSkillInput) => {
      // A usage row's star may be lit by name while the stored favorite carries the full id, so
      // unstarring resolves back to whichever record actually matched.
      const stored = favoritesRef.current.find(
        (f) => f.skillId === skill.skillId || f.name === skill.name,
      );
      mutate({ skill: stored ?? skill, starred: !!stored });
    },
    [mutate],
  );

  return {
    favorites,
    isPending: favoritesQuery.isPending,
    isFavorite,
    toggleFavorite,
    isSaving: mutation.isPending,
  };
}
