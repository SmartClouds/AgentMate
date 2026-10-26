import type { FavoriteSkillRecord, SkillAuditRecord } from '@shared/apiTypes';
import { useMemo, useState } from 'react';
import {
  ChartSimple,
  Copy,
  Download,
  ExternalLink,
  Search,
  Shield,
  Star,
} from '@/components/icons';
import {
  CARD_GRID,
  CatalogCardShimmer,
  Chip,
  EmptyState,
  GLASS_CARD,
  SearchPill,
} from '@/components/pageKit';
import { SkillAuditVerdictBadge } from '@/components/skills/SkillAuditReport';
import { SkillCatalogCard } from '@/components/skills/SkillCatalogCard';
import { SkillFavoriteButton } from '@/components/skills/SkillFavoriteButton';
import type { SkillSecurityTarget } from '@/components/skills/SkillSecurityDialog';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { SkillFavorites } from '@/hooks/useSkillFavorites';
import { cn } from '@/lib/utils';

/** How each kind of favorite is labelled on its card. */
const SOURCE_BADGE: Record<FavoriteSkillRecord['source'], string> = {
  'skills-sh': 'skills.sh',
  repository: 'Repository',
  installed: 'Installed',
  local: 'Local',
};

/** The security check a favorite supports, or null for one with nothing to read. */
function securityTargetFor(favorite: FavoriteSkillRecord): SkillSecurityTarget | null {
  if (favorite.source === 'skills-sh' && favorite.repo) {
    return {
      skillId: favorite.skillId,
      skillName: favorite.name,
      target: { kind: 'github', repo: favorite.repo, skillName: favorite.name },
    };
  }
  if (favorite.source === 'repository' && favorite.repositoryId) {
    return {
      skillId: favorite.skillId,
      skillName: favorite.name,
      target: {
        kind: 'repository',
        repositoryId: favorite.repositoryId,
        skillId: favorite.skillId,
      },
    };
  }
  if (favorite.source === 'installed') {
    return {
      skillId: favorite.skillId,
      skillName: favorite.name,
      target: { kind: 'installed', projectId: null, skillId: favorite.skillId },
    };
  }
  return null;
}

/**
 * The Favorites tab: every starred skill in one place, with the same install, check and open
 * actions its card carries in the tab it was starred from.
 */
export function SkillFavoritesTab({
  favorites,
  auditBySkillId,
  usageBySkillName,
  onInstall,
  onCheckSecurity,
  onCopyInstallCommand,
}: {
  favorites: SkillFavorites;
  auditBySkillId: Map<string, SkillAuditRecord>;
  /** Invocation counts keyed by skill name, so a card can show how often it is actually used. */
  usageBySkillName: Map<string, number>;
  onInstall: (favorite: FavoriteSkillRecord) => void;
  onCheckSecurity: (target: SkillSecurityTarget) => void;
  onCopyInstallCommand: (command: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return favorites.favorites;
    return favorites.favorites.filter(
      (favorite) =>
        favorite.name.toLowerCase().includes(query) ||
        favorite.sourceLabel.toLowerCase().includes(query) ||
        (favorite.description ?? '').toLowerCase().includes(query),
    );
  }, [favorites.favorites, search]);

  if (favorites.isPending) {
    return (
      <div className="@container/grid">
        <div className={CARD_GRID} role="status" aria-label="Loading favorites">
          {Array.from({ length: 3 }, (_, index) => (
            <CatalogCardShimmer key={index} />
          ))}
        </div>
      </div>
    );
  }

  if (favorites.favorites.length === 0) {
    return (
      <div className={GLASS_CARD}>
        <EmptyState
          size="lg"
          icon={Star}
          title="No favorites yet."
          description="Use the star on any skill in the Directory, Repositories or Usage tab to keep it here."
        />
      </div>
    );
  }

  return (
    <div className="@container/grid flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-3 py-2')}>
        <SearchPill
          label="Search favorites"
          placeholder="Search favorites…"
          value={search}
          onValueChange={setSearch}
          className="min-w-56 flex-1"
        />
        <p className="text-xs text-muted-foreground">
          {favorites.favorites.length} starred skill
          {favorites.favorites.length === 1 ? '' : 's'}
        </p>
      </div>

      {filtered.length > 0 && (
        <div className={CARD_GRID}>
          {filtered.map((favorite) => {
            const audit = auditBySkillId.get(favorite.skillId);
            const uses = usageBySkillName.get(favorite.name) ?? 0;
            const securityTarget = securityTargetFor(favorite);
            const installable = favorite.source === 'skills-sh' || favorite.source === 'repository';
            return (
              <SkillCatalogCard
                key={favorite.skillId}
                title={favorite.name}
                official={favorite.official}
                trailing={
                  <SkillFavoriteButton
                    starred
                    onToggle={() => favorites.toggleFavorite(favorite)}
                    className="-mr-1.5 -mt-1 shrink-0"
                  />
                }
                description={favorite.description ?? 'No description saved for this skill.'}
                chips={
                  <>
                    <Chip tone="primary">{SOURCE_BADGE[favorite.source]}</Chip>
                    {uses > 0 && (
                      <Chip>
                        <ChartSimple className="h-3 w-3" />
                        {uses} use{uses === 1 ? '' : 's'}
                      </Chip>
                    )}
                    {audit && (
                      <SkillAuditVerdictBadge verdict={audit.verdict} score={audit.score} />
                    )}
                  </>
                }
                meta={
                  <>
                    {favorite.sourceLabel} · starred{' '}
                    {new Date(favorite.addedAt).toLocaleDateString()}
                  </>
                }
                actions={
                  <>
                    {installable && (
                      <Button size="sm" onClick={() => onInstall(favorite)}>
                        <Download /> Install
                      </Button>
                    )}
                    <div className="ml-auto flex items-center gap-0.5">
                      {favorite.installCommand && (
                        <SimpleTooltip label="Copy the install command">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Copy the install command for ${favorite.name}`}
                            onClick={() => onCopyInstallCommand(favorite.installCommand!)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </SimpleTooltip>
                      )}
                      {securityTarget && (
                        <SimpleTooltip label="Check this skill for unsafe instructions">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Check ${favorite.name} for unsafe instructions`}
                            onClick={() => onCheckSecurity(securityTarget)}
                          >
                            <Shield className="h-3.5 w-3.5" />
                          </Button>
                        </SimpleTooltip>
                      )}
                      {favorite.url && (
                        <SimpleTooltip label="Open on skills.sh">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Open ${favorite.name} on skills.sh`}
                            onClick={() => void window.runova.shell.openExternal(favorite.url!)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </SimpleTooltip>
                      )}
                    </div>
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {filtered.length === 0 && (
        <div className={GLASS_CARD}>
          <EmptyState
            size="sm"
            icon={Search}
            title="Nothing found"
            description="No favorites match your search."
          />
        </div>
      )}
    </div>
  );
}
