import type { SkillRepositorySourceType, UiProInstallMethod } from '@runova/core';
import {
  buildUiProUninstallCommands,
  bundledSkillsShDirectory,
  getCliDefinition,
  SKILL_RISK_CATEGORIES,
  SKILLS_SH_SNAPSHOT_DATE,
  UI_UX_PRO_MAX_AI_TARGETS,
  UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID,
} from '@runova/core';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ChartSimple,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderOpen,
  Globe,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import {
  CARD_GRID,
  CatalogCardShimmer,
  CatalogSplit,
  Chip,
  EmptyState,
  FilterChip,
  GLASS_CARD,
  PillTabs,
  RepositorySourceIcon,
  SECTION_HEADING,
  SearchPill,
  SideNavRow,
} from '@/components/pageKit';
import { AdHocSkillScanner } from '@/components/skills/AdHocSkillScanner';
import { SkillAuditReport, SkillAuditVerdictBadge } from '@/components/skills/SkillAuditReport';
import { SkillCatalogCard } from '@/components/skills/SkillCatalogCard';
import { SkillFavoriteButton } from '@/components/skills/SkillFavoriteButton';
import { SkillFavoritesTab } from '@/components/skills/SkillFavoritesTab';
import {
  SkillSecurityDialog,
  type SkillSecurityTarget,
} from '@/components/skills/SkillSecurityDialog';
import { SkillUsageTab } from '@/components/skills/SkillUsageTab';
import { UiUxProMaxCard } from '@/components/skills/UiUxProMaxCard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useSkillFavorites } from '@/hooks/useSkillFavorites';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type {
  FavoriteSkillRecord,
  InstalledSkillRecord,
  SkillAuditRecord,
  SkillsShSearchResult,
  SkillUpdateInfo,
} from '../../../shared/apiTypes';

const SOURCE_TYPES: { value: SkillRepositorySourceType; label: string }[] = [
  { value: 'url', label: 'URL (JSON index)' },
  { value: 'git', label: 'Git repository' },
  { value: 'local-folder', label: 'Local folder' },
];

type SkillsShSearchMode = 'bundled' | 'live';
type SkillsTab = 'directory' | 'featured' | 'marketplace' | 'favorites' | 'usage' | 'security';

/** How a stored audit's source is labelled in the history list. */
const AUDIT_SOURCE_LABEL: Record<SkillAuditRecord['sourceKind'], string> = {
  repository: 'Repository',
  installed: 'Installed',
  github: 'GitHub',
  folder: 'Local folder',
};

/** How many skill cards to mount at once. Rendering the full bundled catalog (~1k glass cards)
 * freezes Electron/Chromium on open; page in chunks instead. */
const SKILL_GRID_PAGE_SIZE = 36;

/** A card/modal-ready skill.sh entry. `description` is absent for live results until fetched. */
interface SkillsShDisplayEntry {
  id: string;
  name: string;
  owner: string;
  repo: string;
  official: boolean;
  url: string;
  installCommand: string;
  installsLabel: string;
  description?: string;
}

/**
 * The Repository picker's default: every repository's skills in one grid, so the tab shows what
 * is available without making the user pick a repository first.
 */
const ALL_REPOSITORIES = '__all__';

/** What the install picker modal is currently installing, and where it came from. */
type InstallTarget =
  | { kind: 'repo'; repositoryId: string; skillId: string; skillName: string }
  | { kind: 'skillsSh'; skill: SkillsShDisplayEntry };

const installsFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Agent ids the `skills` CLI recognizes. Labels come from CLI_REGISTRY. */
const SKILLS_CLI_AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-code', cliId: 'claude-code' },
  { value: 'codex', cliId: 'codex-cli' },
  { value: 'cursor', cliId: 'cursor-cli' },
  { value: 'opencode', cliId: 'opencode' },
  { value: 'gemini-cli', cliId: 'gemini-cli' },
].map((agent) => ({
  value: agent.value,
  label: getCliDefinition(agent.cliId)?.label ?? agent.value,
}));
const ALL_SKILLS_CLI_AGENTS = SKILLS_CLI_AGENT_OPTIONS.map((a) => a.value);

/**
 * The `uipro` CLI names the same agents differently, so its installed records still answer to the
 * Global Skills filter above.
 */
const UI_PRO_AGENT_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor',
  opencode: 'opencode',
  'gemini-cli': 'gemini',
};

/** Lowercased search blobs built once when this chunk loads, so typing doesn't re-lower 1k descriptions. */
const BUNDLED_SH_SEARCH_INDEX = bundledSkillsShDirectory.map((s) => ({
  skill: s,
  haystack: `${s.name}\n${s.owner}\n${s.repo}\n${s.description}`.toLowerCase(),
}));

function agentLabel(value: string): string {
  if (value === 'all') return 'Every assistant';
  return (
    SKILLS_CLI_AGENT_OPTIONS.find((o) => o.value === value)?.label ??
    UI_UX_PRO_MAX_AI_TARGETS.find((t) => t.value === value)?.label ??
    value
  );
}

function liveResultToDisplayEntry(r: SkillsShSearchResult): SkillsShDisplayEntry {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    repo: r.repo,
    official: r.official,
    url: r.url,
    installCommand: r.installCommand,
    installsLabel: installsFormatter.format(r.installs),
  };
}

const SkillsShDirectoryCard = memo(function SkillsShDirectoryCard({
  skill,
  audit,
  starred,
  onInstall,
  onView,
  onCheckSecurity,
  onToggleFavorite,
}: {
  skill: SkillsShDisplayEntry;
  /** Last security check for this skill, when it has one. */
  audit: SkillAuditRecord | undefined;
  starred: boolean;
  onInstall: (skill: SkillsShDisplayEntry) => void;
  onView: (skill: SkillsShDisplayEntry) => void;
  onCheckSecurity: (skill: SkillsShDisplayEntry) => void;
  onToggleFavorite: (skill: SkillsShDisplayEntry) => void;
}): React.JSX.Element {
  return (
    <SkillCatalogCard
      title={skill.name}
      official={skill.official}
      trailing={
        <SkillFavoriteButton
          starred={starred}
          onToggle={() => onToggleFavorite(skill)}
          className="-mr-1.5 -mt-1 shrink-0"
        />
      }
      description={skill.description ?? 'Click View for the full description.'}
      chips={
        <>
          <Chip tone={skill.official ? 'primary' : 'neutral'}>
            {skill.official ? 'Official' : 'Community'}
          </Chip>
          <Chip>{skill.installsLabel} installs</Chip>
          {audit && <SkillAuditVerdictBadge verdict={audit.verdict} score={audit.score} />}
        </>
      }
      meta={skill.repo}
      actions={
        <>
          <Button size="sm" onClick={() => onInstall(skill)}>
            <Download /> Install
          </Button>
          <Button variant="soft" size="sm" onClick={() => onView(skill)}>
            <Eye /> View
          </Button>
          <div className="ml-auto flex items-center gap-0.5">
            <SimpleTooltip label="Check this skill for unsafe instructions">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Check ${skill.name} for unsafe instructions`}
                onClick={() => onCheckSecurity(skill)}
              >
                <Shield className="h-3.5 w-3.5" />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Open on skills.sh">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Open ${skill.name} on skills.sh`}
                onClick={() => void window.runova.shell.openExternal(skill.url)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </SimpleTooltip>
          </div>
        </>
      }
    />
  );
});

/** The marketplace grid's shimmer while a repository index lands. */
function SkillGridSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div className={CARD_GRID} role="status" aria-label={label}>
      {Array.from({ length: 6 }, (_, i) => (
        <CatalogCardShimmer key={i} />
      ))}
    </div>
  );
}

/**
 * A checkable row in the install picker. Picked rows take the primary tint with an inset ring,
 * since the global border colour would win over a tinted border utility.
 */
function pickerRow(checked: boolean): string {
  return cn(
    'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 ring-1 ring-inset transition-colors',
    checked
      ? 'bg-primary/10 ring-primary/40'
      : 'bg-foreground/[0.03] ring-transparent hover:bg-foreground/[0.06]',
  );
}

/** "Show more" under a paged grid, as a soft pill. */
function ShowMoreButton({
  remaining,
  onClick,
}: {
  remaining: number;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <div className="flex justify-center pt-1">
      <Button variant="soft" onClick={onClick}>
        Show more ({remaining} remaining)
      </Button>
    </div>
  );
}

export default function SkillsPage(): React.JSX.Element {
  const location = useLocation();
  const navState = location.state as { repositoryId?: string; query?: string } | null;
  const queryClient = useQueryClient();
  const openTerminalSession = useTerminalStore((s) => s.openSession);
  const favorites = useSkillFavorites();
  const toggleFavorite = favorites.toggleFavorite;

  const [selectedRepoId, setSelectedRepoId] = useState<string>(
    navState?.repositoryId ?? ALL_REPOSITORIES,
  );
  const [search, setSearch] = useState(navState?.query ?? '');
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [repoSourceType, setRepoSourceType] = useState<SkillRepositorySourceType>('local-folder');
  const [repoSource, setRepoSource] = useState('');
  const [debouncedRepoSource, setDebouncedRepoSource] = useState('');
  const [shMode, setShMode] = useState<SkillsShSearchMode>('bundled');
  const [shSearch, setShSearch] = useState('');
  const [shDebouncedSearch, setShDebouncedSearch] = useState('');
  const [shOfficialOnly, setShOfficialOnly] = useState(false);
  const [shSelected, setShSelected] = useState<SkillsShDisplayEntry | null>(null);

  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const [installPickerProjectIds, setInstallPickerProjectIds] = useState<Set<string>>(new Set());
  const [installGlobally, setInstallGlobally] = useState(false);
  const [installPickerSearch, setInstallPickerSearch] = useState('');
  const [globalSkillsModalOpen, setGlobalSkillsModalOpen] = useState(false);
  const [globalSkillsAgentFilter, setGlobalSkillsAgentFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<SkillsTab>('directory');
  const [securitySubject, setSecuritySubject] = useState<SkillSecurityTarget | null>(null);
  const [auditDetail, setAuditDetail] = useState<SkillAuditRecord | null>(null);
  const [directoryVisibleCount, setDirectoryVisibleCount] = useState(SKILL_GRID_PAGE_SIZE);
  const [marketplaceVisibleCount, setMarketplaceVisibleCount] = useState(SKILL_GRID_PAGE_SIZE);

  useEffect(() => {
    const timer = setTimeout(() => setShDebouncedSearch(shSearch), 350);
    return () => clearTimeout(timer);
  }, [shSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRepoSource(repoSource), 300);
    return () => clearTimeout(timer);
  }, [repoSource]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });

  const filteredProjectsForPicker = useMemo(() => {
    const projects = projectsQuery.data ?? [];
    const q = installPickerSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.folderPath.toLowerCase().includes(q),
    );
  }, [projectsQuery.data, installPickerSearch]);

  const reposQuery = useQuery({
    queryKey: queryKeys.repositories,
    queryFn: () => window.runova.skills.listRepositories(),
  });

  const showingAllRepos = selectedRepoId === ALL_REPOSITORIES;

  // A repository that was selected and then removed falls back to the all-repositories view.
  useEffect(() => {
    if (showingAllRepos || !reposQuery.data) return;
    if (!reposQuery.data.some((r) => r.id === selectedRepoId)) setSelectedRepoId(ALL_REPOSITORIES);
  }, [reposQuery.data, selectedRepoId, showingAllRepos]);

  const repoCount = reposQuery.data?.length ?? 0;

  const visibleRepos = useMemo(() => {
    const repos = reposQuery.data ?? [];
    return showingAllRepos ? repos : repos.filter((r) => r.id === selectedRepoId);
  }, [reposQuery.data, selectedRepoId, showingAllRepos]);

  // One query per visible repository, sharing the same cache keys the single-repository view uses,
  // so a refresh or a watched folder change updates both views. Only fetch while the marketplace
  // tab is open; the default directory tab should not index every repo on page load.
  const repoIndexes = useQueries({
    queries: visibleRepos.map((repo) => ({
      queryKey: queryKeys.repositoryIndex(repo.id),
      queryFn: () => window.runova.skills.getRepositoryIndex(repo.id),
      enabled: activeTab === 'marketplace',
    })),
    combine: (results) => ({
      isPending: results.some((r) => r.isPending),
      entries: results.flatMap((result, i) =>
        (result.data?.skills ?? []).map((skill) => ({ skill, repo: visibleRepos[i] })),
      ),
      failed: results.flatMap((result, i) =>
        result.error ? [{ repo: visibleRepos[i], message: result.error.message }] : [],
      ),
    }),
  });

  // What the folder in the path field actually contains, so the dialog can report it before the
  // user commits to adding it.
  const folderPreviewQuery = useQuery({
    queryKey: queryKeys.localSkillFolderPreview(debouncedRepoSource),
    queryFn: () => window.runova.skills.previewLocalRepository(debouncedRepoSource),
    enabled: addRepoOpen && repoSourceType === 'local-folder' && debouncedRepoSource.trim() !== '',
    staleTime: 0,
  });
  // Ignored for URL/git sources, whose cached preview would otherwise linger after a type switch.
  const folderPreview = repoSourceType === 'local-folder' ? folderPreviewQuery.data : undefined;

  // Local-folder repositories are watched in the main process: a skill added to (or deleted from)
  // the folder refreshes the marketplace on its own.
  useEffect(
    () =>
      window.runova.skills.onRepositoryChanged((repositoryId) => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.repositoryIndex(repositoryId),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.localSkillFolderPreviews });
      }),
    [queryClient],
  );

  const addRepoMutation = useMutation({
    mutationFn: () =>
      window.runova.skills.addRepository({
        name: repoName.trim() || (folderPreview?.suggestedName ?? ''),
        sourceType: repoSourceType,
        source: repoSource.trim(),
      }),
    onSuccess: (repo) => {
      toast.success('Repository added.');
      setAddRepoOpen(false);
      setRepoName('');
      setRepoSource('');
      setDebouncedRepoSource('');
      setSelectedRepoId(repo.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const removeRepoMutation = useMutation({
    mutationFn: (id: string) => window.runova.skills.removeRepository(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
      setSelectedRepoId(ALL_REPOSITORIES);
    },
  });

  // Refreshes the selected repository, or every one of them in the all-repositories view.
  const refreshRepoMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => window.runova.skills.refreshRepository(id)),
      );
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      return { count: results.length - (failure ? 1 : 0), failure };
    },
    onSuccess: ({ count, failure }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositoryIndexes });
      if (failure) {
        const reason = failure.reason;
        toast.error(reason instanceof Error ? reason.message : String(reason));
      } else {
        toast.success(count === 1 ? 'Repository refreshed.' : `${count} repositories refreshed.`);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const installBatchMutation = useMutation({
    mutationFn: async ({ projectIds, global }: { projectIds: string[]; global: boolean }) => {
      if (!installTarget)
        return { succeeded: [] as (string | null)[], failed: [] as (string | null)[] };
      const targets: (string | null)[] = global ? [...projectIds, null] : projectIds;

      if (installTarget.kind === 'skillsSh') {
        const skill = installTarget.skill;
        const agents = ALL_SKILLS_CLI_AGENTS;
        const projectById = new Map((projectsQuery.data ?? []).map((p) => [p.id, p]));
        const succeeded: (string | null)[] = [];
        const failed: (string | null)[] = [];
        let firstFailureMessage: string | undefined;
        for (const target of targets) {
          const project = target === null ? null : projectById.get(target);
          try {
            // Always the exact command skills.sh publishes for this skill, no extra flags. A
            // global install is just the same command run from the home directory instead of a
            // project folder, which is where the `skills` CLI puts its global skills.
            openTerminalSession({
              title: `Install ${skill.name}`,
              initialInput: skill.installCommand,
              cwd: project?.folderPath,
              projectId: project?.id,
            });
            await window.runova.skills.recordSkillsShInstall({
              projectId: target,
              owner: skill.owner,
              repo: skill.repo,
              skillName: skill.name,
              agents,
            });
            succeeded.push(target);
          } catch (error) {
            failed.push(target);
            firstFailureMessage ??= error instanceof Error ? error.message : String(error);
          }
        }
        return { succeeded, failed, firstFailureMessage, skillsSh: true };
      }

      const results = await Promise.allSettled(
        targets.map((projectId) =>
          window.runova.skills.install({
            projectId,
            repositoryId: installTarget.repositoryId,
            skillId: installTarget.skillId,
          }),
        ),
      );
      const succeeded = targets.filter((_, i) => results[i].status === 'fulfilled');
      const failed = targets.filter((_, i) => results[i].status === 'rejected');
      const firstFailureReason = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      )?.reason;
      const firstFailureMessage =
        firstFailureReason instanceof Error ? firstFailureReason.message : undefined;
      return { succeeded, failed, firstFailureMessage, skillsSh: false };
    },
    onSuccess: ({ succeeded, failed, firstFailureMessage, skillsSh }) => {
      for (const target of succeeded) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(target) });
        if (target === null)
          void queryClient.invalidateQueries({ queryKey: queryKeys.skillUpdates(null) });
      }
      if (succeeded.length > 0 && skillsSh) {
        toast.info(
          succeeded.length === 1
            ? 'Press Enter in the terminal to install the skill.'
            : `Press Enter in each of the ${succeeded.length} terminals opened to install the skill.`,
        );
      } else if (succeeded.length > 0) {
        toast.success(
          `Installed to ${succeeded.length} location${succeeded.length === 1 ? '' : 's'}.`,
        );
      }
      if (failed.length > 0) {
        toast.error(
          `Failed to install to ${failed.length} location${failed.length === 1 ? '' : 's'}.` +
            (firstFailureMessage ? ` ${firstFailureMessage}` : ''),
        );
      }
      if (failed.length === 0) {
        setInstallTarget(null);
        setInstallPickerProjectIds(new Set());
        setInstallGlobally(false);
        setInstallPickerSearch('');
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repoIndexes.entries;
    return repoIndexes.entries.filter(
      ({ skill: s, repo }) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)) ||
        repo.name.toLowerCase().includes(q),
    );
  }, [repoIndexes.entries, search]);

  const visibleMarketplaceSkills = useMemo(
    () => filteredSkills.slice(0, marketplaceVisibleCount),
    [filteredSkills, marketplaceVisibleCount],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search or repo filter starts the grid back at the first page
  useEffect(() => {
    setMarketplaceVisibleCount(SKILL_GRID_PAGE_SIZE);
  }, [search, selectedRepoId]);

  const bundledShResults = useMemo(() => {
    const q = shDebouncedSearch.trim().toLowerCase();
    return BUNDLED_SH_SEARCH_INDEX.filter(({ skill, haystack }) => {
      if (shOfficialOnly && !skill.official) return false;
      if (!q) return true;
      return haystack.includes(q);
    }).map(({ skill }) => skill);
  }, [shDebouncedSearch, shOfficialOnly]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: any change to the search, filter or mode starts the grid back at the first page
  useEffect(() => {
    setDirectoryVisibleCount(SKILL_GRID_PAGE_SIZE);
  }, [shDebouncedSearch, shOfficialOnly, shMode]);

  const liveShSearchQuery = useQuery({
    queryKey: queryKeys.skillsShSearch(shDebouncedSearch.trim().toLowerCase()),
    queryFn: () => window.runova.skills.searchSkillsSh(shDebouncedSearch.trim()),
    enabled: shMode === 'live' && shDebouncedSearch.trim().length >= 2,
  });

  const liveShResults = useMemo(() => {
    const results = (liveShSearchQuery.data ?? []).map(liveResultToDisplayEntry);
    return shOfficialOnly ? results.filter((s) => s.official) : results;
  }, [liveShSearchQuery.data, shOfficialOnly]);

  const filteredShSkills: SkillsShDisplayEntry[] =
    shMode === 'live' ? liveShResults : bundledShResults;

  const visibleShSkills = useMemo(
    () => filteredShSkills.slice(0, directoryVisibleCount),
    [filteredShSkills, directoryVisibleCount],
  );

  const shDetailQuery = useQuery({
    queryKey: queryKeys.skillsShDetail(shSelected?.id ?? ''),
    queryFn: () => window.runova.skills.getSkillsShDetail(shSelected!.id),
    enabled: !!shSelected && shSelected.description === undefined,
  });

  const shModalDescription = shSelected?.description ?? shDetailQuery.data?.description ?? null;
  const shModalInstallsLabel = shDetailQuery.data?.installsLabel ?? shSelected?.installsLabel ?? '';

  const globalInstalledQuery = useQuery({
    queryKey: queryKeys.installedSkills(null),
    queryFn: () => window.runova.skills.listInstalled(null),
  });

  // One row per skill that has ever been checked, so cards can show their last verdict without
  // anyone having to open the dialog again.
  const latestAuditsQuery = useQuery({
    queryKey: queryKeys.skillAuditsLatest,
    queryFn: () => window.runova.skills.latestAuditPerSkill(),
  });

  const auditBySkillId = useMemo(
    () => new Map((latestAuditsQuery.data ?? []).map((audit) => [audit.skillId, audit])),
    [latestAuditsQuery.data],
  );

  const auditHistoryQuery = useQuery({
    queryKey: queryKeys.skillAudits,
    queryFn: () => window.runova.skills.listAudits({ limit: 200 }),
    enabled: activeTab === 'security',
  });

  // The first scan streams every session transcript, so it only runs once the user is on a tab
  // that shows the counts. Later scans read the appended bytes and are cheap.
  const usageQuery = useQuery({
    queryKey: queryKeys.skillUsage,
    queryFn: () => window.runova.skills.getUsage(),
    enabled: activeTab === 'usage' || activeTab === 'favorites',
    staleTime: 60_000,
  });

  const rescanUsageMutation = useMutation({
    mutationFn: () => window.runova.skills.rescanUsage(),
    onSuccess: (report) => {
      queryClient.setQueryData(queryKeys.skillUsage, report);
      toast.success(`Read ${report.filesScanned} session${report.filesScanned === 1 ? '' : 's'}.`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const usageBySkillName = useMemo(
    () => new Map((usageQuery.data?.stats ?? []).map((stat) => [stat.skill, stat.count])),
    [usageQuery.data],
  );

  const removeAuditMutation = useMutation({
    mutationFn: (id: string) => window.runova.skills.removeAudit(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAudits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAuditsLatest });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const clearAuditsMutation = useMutation({
    mutationFn: () => window.runova.skills.clearAudits(),
    onSuccess: () => {
      toast.success('Security check history cleared.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAudits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAuditsLatest });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const globalSkillUpdatesQuery = useQuery({
    queryKey: queryKeys.skillUpdates(null),
    queryFn: () => window.runova.skills.checkForUpdates(null),
    enabled: (globalInstalledQuery.data?.length ?? 0) > 0,
  });

  const globalSkillUpdateBySkillId = useMemo(
    () => new Map((globalSkillUpdatesQuery.data ?? []).map((u) => [u.skillId, u])),
    [globalSkillUpdatesQuery.data],
  );

  const filteredGlobalSkills = useMemo(() => {
    const skills = globalInstalledQuery.data ?? [];
    if (globalSkillsAgentFilter === 'all') return skills;
    const alias = UI_PRO_AGENT_ALIASES[globalSkillsAgentFilter];
    return skills.filter((s) =>
      s.agents?.some((a) => a === globalSkillsAgentFilter || a === alias || a === 'all'),
    );
  }, [globalInstalledQuery.data, globalSkillsAgentFilter]);

  const removeGlobalSkillMutation = useMutation({
    mutationFn: async (record: InstalledSkillRecord) => {
      if (record.repositoryId === UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID) {
        // `uipro uninstall` owns the files it wrote and reports what it removed, so it runs in a
        // visible terminal the same way the install did.
        openTerminalSession({
          title: 'Remove UI UX Pro Max',
          initialInput: buildUiProUninstallCommands({
            method: (record.installMethod as UiProInstallMethod) ?? 'npm-global',
            agents: record.agents ?? [],
            global: true,
          }).join('; '),
        });
      }
      await window.runova.skills.remove({ projectId: null, skillId: record.skillId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(null) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillUpdates(null) });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateGlobalSkillMutation = useMutation({
    mutationFn: (update: SkillUpdateInfo) =>
      window.runova.skills.install({
        projectId: null,
        repositoryId: update.repositoryId,
        skillId: update.skillId,
      }),
    onSuccess: (_data, update) => {
      toast.success(`Updated ${update.skillId} to v${update.latestVersion}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(null) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillUpdates(null) });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function handlePickLocalFolder(): Promise<void> {
    // Whatever is typed wins as the starting directory; the main process falls back to the
    // projects folder from Settings when the field is empty or points nowhere.
    const picked = await window.runova.skills.pickLocalRepository(repoSource);
    if (picked) {
      setRepoSource(picked);
      setDebouncedRepoSource(picked);
    }
  }

  function handleCopyInstallCommand(command: string): void {
    void navigator.clipboard.writeText(command);
    toast.success('Install command copied to clipboard.');
  }

  function openInstallPicker(target: InstallTarget): void {
    setInstallTarget(target);
    setInstallPickerProjectIds(new Set());
    setInstallGlobally(false);
    setInstallPickerSearch('');
  }

  // A skills.sh skill is checked straight from the GitHub repo that publishes it, so nothing has
  // to be installed first. The id matches what the audit stores, which is what links a card to
  // its last verdict.
  const handleCheckSkillsShSecurity = useCallback((skill: SkillsShDisplayEntry) => {
    setSecuritySubject({
      skillId: `${skill.repo}/${skill.name}`,
      skillName: skill.name,
      target: { kind: 'github', repo: skill.repo, skillName: skill.name },
    });
  }, []);

  const handleInstallSkillsSh = useCallback((skill: SkillsShDisplayEntry) => {
    setInstallTarget({ kind: 'skillsSh', skill });
    setInstallPickerProjectIds(new Set());
    setInstallGlobally(false);
    setInstallPickerSearch('');
  }, []);

  // The favorite keeps everything the card needs, so the Favorites tab can install, copy and
  // open a skills.sh skill without the directory being loaded.
  const handleToggleShFavorite = useCallback(
    (skill: SkillsShDisplayEntry) => {
      toggleFavorite({
        skillId: `${skill.repo}/${skill.name}`,
        name: skill.name,
        source: 'skills-sh',
        sourceLabel: skill.repo,
        description: skill.description,
        owner: skill.owner,
        repo: skill.repo,
        url: skill.url,
        installCommand: skill.installCommand,
        official: skill.official,
      });
    },
    [toggleFavorite],
  );

  /** Reopens a favorited skill in the install picker it was starred from. */
  function handleInstallFavorite(favorite: FavoriteSkillRecord): void {
    if (favorite.source === 'repository' && favorite.repositoryId) {
      openInstallPicker({
        kind: 'repo',
        repositoryId: favorite.repositoryId,
        skillId: favorite.skillId,
        skillName: favorite.name,
      });
      return;
    }
    if (favorite.owner && favorite.repo && favorite.url && favorite.installCommand) {
      openInstallPicker({
        kind: 'skillsSh',
        skill: {
          id: favorite.skillId,
          name: favorite.name,
          owner: favorite.owner,
          repo: favorite.repo,
          official: favorite.official ?? false,
          url: favorite.url,
          installCommand: favorite.installCommand,
          installsLabel: '',
          description: favorite.description,
        },
      });
      return;
    }
    toast.error('This favorite has no install source saved.');
  }

  function toggleInstallPickerProject(projectId: string): void {
    setInstallPickerProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  const installTargetName = installTarget
    ? installTarget.kind === 'repo'
      ? installTarget.skillName
      : installTarget.skill.name
    : '';

  usePageHeader(
    'Skill Marketplace',
    'Install skills from repositories or skills.sh, star the ones you keep, and see which ones get used.',
  );

  const favoriteCount = favorites.favorites.length;

  const tabItems = useMemo(
    () => [
      { value: 'directory' as const, label: 'Directory', icon: <Search /> },
      { value: 'featured' as const, label: 'Featured', icon: <Sparkles /> },
      {
        value: 'marketplace' as const,
        label: 'Repositories',
        icon: <FolderOpen />,
        count: repoCount,
      },
      { value: 'favorites' as const, label: 'Favorites', icon: <Star />, count: favoriteCount },
      { value: 'usage' as const, label: 'Usage', icon: <ChartSimple /> },
      { value: 'security' as const, label: 'Security', icon: <Shield /> },
    ],
    [repoCount, favoriteCount],
  );

  const globalInstalledCount = globalInstalledQuery.data?.length ?? 0;
  const selectedRepo = reposQuery.data?.find((r) => r.id === selectedRepoId);
  const marketplaceLoading =
    reposQuery.isPending || (visibleRepos.length > 0 && repoIndexes.isPending);
  const auditCount = auditHistoryQuery.data?.length ?? 0;

  return (
    // The Repositories tab is a list and a detail side by side, so it gets the island's height
    // to split. The other tabs are one column that scrolls with the page.
    <div
      className={cn(
        'flex flex-col gap-2 p-2',
        activeTab === 'marketplace' && 'min-h-0 flex-1 overflow-hidden',
      )}
    >
      <div className={cn(GLASS_CARD, 'flex shrink-0 items-center gap-2 px-2 py-1.5')}>
        <PillTabs
          id="skill-views"
          label="Skill views"
          items={tabItems}
          value={activeTab}
          onChange={setActiveTab}
        />
        <Button
          variant="soft"
          className="ml-auto shrink-0"
          onClick={() => setGlobalSkillsModalOpen(true)}
        >
          <Globe />
          Global Skills
          {globalInstalledCount > 0 ? (
            <span className="min-w-4 rounded-full bg-foreground/[0.07] px-1.5 text-center text-[10px] font-semibold tabular-nums text-muted-foreground">
              {globalInstalledCount}
            </span>
          ) : null}
        </Button>
      </div>

      {activeTab === 'featured' && (
        <>
          <p className="px-1.5 text-sm text-muted-foreground">
            Skills that ship their own installer instead of plain files, so Runova walks you through
            their CLI rather than copying a folder.
          </p>
          <UiUxProMaxCard />
        </>
      )}

      {activeTab === 'marketplace' && (
        <CatalogSplit
          sidebar="skillRepositories"
          sidebarLabel="Skill repositories"
          resizeLabel="Resize repositories"
          aside={
            <>
              <div className="flex h-10 shrink-0 items-center gap-0.5 pl-3.5 pr-2">
                <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Repositories</h2>
                <SimpleTooltip label="Add repository">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add repository"
                    onClick={() => setAddRepoOpen(true)}
                  >
                    <Plus />
                  </Button>
                </SimpleTooltip>
              </div>
              <div className="rail-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {reposQuery.isPending ? (
                  <div role="status" aria-label="Loading repositories" className="space-y-1">
                    <Skeleton className="h-8 w-full rounded-lg" />
                    <Skeleton className="h-8 w-4/5 rounded-lg" />
                  </div>
                ) : repoCount === 0 ? (
                  <p className="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                    No repositories yet. Add one to browse its skills.
                  </p>
                ) : (
                  <nav aria-label="Repositories" className="flex flex-col gap-px">
                    <SideNavRow
                      group="skill-repositories"
                      active={showingAllRepos}
                      icon={<LayoutDashboard />}
                      label="All repositories"
                      count={repoCount}
                      onSelect={() => setSelectedRepoId(ALL_REPOSITORIES)}
                    />
                    {(reposQuery.data ?? []).map((repo) => (
                      <SideNavRow
                        key={repo.id}
                        group="skill-repositories"
                        active={repo.id === selectedRepoId}
                        icon={<RepositorySourceIcon sourceType={repo.sourceType} />}
                        label={repo.name}
                        onSelect={() => setSelectedRepoId(repo.id)}
                      />
                    ))}
                  </nav>
                )}
              </div>
            </>
          }
        >
          <div className={cn(GLASS_CARD, 'settings-rows shrink-0')}>
            <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                  {selectedRepo ? (
                    <RepositorySourceIcon
                      sourceType={selectedRepo.sourceType}
                      className="h-4 w-4"
                    />
                  ) : (
                    <FolderOpen className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">
                    {selectedRepo?.name ?? 'All repositories'}
                  </h2>
                  <p className="truncate text-xs text-muted-foreground">
                    {selectedRepo
                      ? selectedRepo.source
                      : 'Every repository’s skills in one grid. Pick one on the left to narrow it.'}
                  </p>
                </div>
              </div>
              {!marketplaceLoading && (
                <span className="text-xs text-muted-foreground">
                  {search.trim()
                    ? `${filteredSkills.length} of ${repoIndexes.entries.length}`
                    : `${repoIndexes.entries.length} skill${repoIndexes.entries.length === 1 ? '' : 's'}`}
                </span>
              )}
              <div className="flex items-center gap-0.5">
                {visibleRepos.length > 0 && (
                  <SimpleTooltip label={showingAllRepos ? 'Refresh all repositories' : 'Refresh'}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        showingAllRepos ? 'Refresh all repositories' : 'Refresh repository'
                      }
                      disabled={refreshRepoMutation.isPending}
                      onClick={() => refreshRepoMutation.mutate(visibleRepos.map((r) => r.id))}
                    >
                      <RefreshCw
                        className={cn(
                          'h-3.5 w-3.5',
                          refreshRepoMutation.isPending && 'animate-spin',
                        )}
                      />
                    </Button>
                  </SimpleTooltip>
                )}
                {!showingAllRepos && (
                  <SimpleTooltip label="Remove repository">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="hover:text-destructive"
                      aria-label="Remove repository"
                      onClick={() => removeRepoMutation.mutate(selectedRepoId)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </SimpleTooltip>
                )}
              </div>
            </div>
            <div className="px-3 py-2">
              <SearchPill
                label="Search skills"
                placeholder="Search skills by name, tag, category…"
                value={search}
                onValueChange={setSearch}
              />
            </div>
            {repoIndexes.failed.length > 0 && (
              <div className="space-y-1 px-3.5 py-2">
                {repoIndexes.failed.map(({ repo, message }) => (
                  <div key={repo.id} className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <p>
                      {repo.name}: {message}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rail-scroll @container/grid -mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 pb-1">
            {marketplaceLoading ? (
              <SkillGridSkeleton label="Loading skills" />
            ) : filteredSkills.length === 0 ? (
              <div className={GLASS_CARD}>
                <EmptyState
                  size="lg"
                  icon={search.trim() ? Search : FolderOpen}
                  title={
                    repoCount === 0
                      ? 'No repositories yet'
                      : search.trim()
                        ? 'Nothing found'
                        : 'This repository is empty'
                  }
                  description={
                    repoCount === 0
                      ? 'No repositories yet. Add one to browse its skills here.'
                      : search.trim()
                        ? 'No skills match your search.'
                        : 'No skills in this repository yet.'
                  }
                  action={
                    repoCount === 0 ? (
                      <Button onClick={() => setAddRepoOpen(true)}>
                        <Plus /> Add a repository
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <div className={CARD_GRID}>
                {visibleMarketplaceSkills.map(({ skill, repo }) => {
                  const audit = auditBySkillId.get(skill.id);
                  return (
                    <SkillCatalogCard
                      key={`${repo.id}:${skill.id}`}
                      title={skill.name}
                      trailing={
                        <SkillFavoriteButton
                          starred={favorites.isFavorite(skill.id)}
                          onToggle={() =>
                            toggleFavorite({
                              skillId: skill.id,
                              name: skill.name,
                              source: 'repository',
                              sourceLabel: repo.name,
                              description: skill.description,
                              repositoryId: repo.id,
                            })
                          }
                          className="-mr-1.5 -mt-1 shrink-0"
                        />
                      }
                      description={skill.description}
                      chips={
                        <>
                          <Chip tone="primary">{skill.category}</Chip>
                          {skill.tags.map((tag) => (
                            <Chip key={tag}>{tag}</Chip>
                          ))}
                          {audit && (
                            <SkillAuditVerdictBadge verdict={audit.verdict} score={audit.score} />
                          )}
                        </>
                      }
                      meta={
                        <>
                          {/* Which repository a skill came from only matters when several are
                              mixed. */}
                          {showingAllRepos && (
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground"
                              onClick={() => setSelectedRepoId(repo.id)}
                            >
                              {repo.name}
                            </button>
                          )}
                          {showingAllRepos && ' · '}
                          {skill.author} · v{skill.version}
                        </>
                      }
                      actions={
                        <>
                          <Button
                            size="sm"
                            onClick={() =>
                              openInstallPicker({
                                kind: 'repo',
                                repositoryId: repo.id,
                                skillId: skill.id,
                                skillName: skill.name,
                              })
                            }
                          >
                            <Download /> Install
                          </Button>
                          {skill.documentationUrl && (
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() =>
                                void window.runova.shell.openExternal(skill.documentationUrl!)
                              }
                            >
                              Docs
                            </Button>
                          )}
                          <SimpleTooltip label="Check this skill for unsafe instructions">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="ml-auto"
                              aria-label={`Check ${skill.name} for unsafe instructions`}
                              onClick={() =>
                                setSecuritySubject({
                                  skillId: skill.id,
                                  skillName: skill.name,
                                  target: {
                                    kind: 'repository',
                                    repositoryId: repo.id,
                                    skillId: skill.id,
                                  },
                                })
                              }
                            >
                              <Shield className="h-3.5 w-3.5" />
                            </Button>
                          </SimpleTooltip>
                        </>
                      }
                    />
                  );
                })}
              </div>
            )}

            {filteredSkills.length > visibleMarketplaceSkills.length && (
              <ShowMoreButton
                remaining={filteredSkills.length - visibleMarketplaceSkills.length}
                onClick={() => setMarketplaceVisibleCount((count) => count + SKILL_GRID_PAGE_SIZE)}
              />
            )}
          </div>
        </CatalogSplit>
      )}

      {activeTab === 'directory' && (
        <div className="@container/grid flex flex-col gap-2">
          <div className={cn(GLASS_CARD, 'settings-rows')}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <SearchPill
                label="Search skills.sh"
                placeholder={
                  shMode === 'live'
                    ? 'Search skills.sh live (2+ characters)…'
                    : 'Search by name, owner, or description…'
                }
                value={shSearch}
                onValueChange={setShSearch}
                className="min-w-56 flex-1"
              />
              <PillTabs
                id="skills-directory-source"
                kind="toggle"
                label="Directory source"
                items={[
                  { value: 'bundled' as const, label: 'Bundled' },
                  { value: 'live' as const, label: 'Live' },
                ]}
                value={shMode}
                onChange={setShMode}
              />
              <FilterChip
                active={shOfficialOnly}
                onClick={() => setShOfficialOnly((v) => !v)}
                icon={<CircleCheck />}
              >
                Official only
              </FilterChip>
            </div>
            {/* A div, not a p: the Official chip below is a span among block siblings. */}
            <div className="px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {bundledSkillsShDirectory.length} popular skills bundled from{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => void window.runova.shell.openExternal('https://www.skills.sh')}
              >
                skills.sh
              </button>{' '}
              as of {SKILLS_SH_SNAPSHOT_DATE} for offline browsing, switch to{' '}
              <span className="font-medium text-foreground">Live</span> to search skills.sh's full
              catalog directly. The{' '}
              <Chip tone="primary" className="align-middle">
                Official
              </Chip>{' '}
              chip mirrors skills.sh's own verified-publisher mark (Anthropic, Vercel, Microsoft,
              Firebase, Supabase, and other verified owners); everything else is
              community-published.
            </div>
            {shMode === 'live' && shDebouncedSearch.trim().length < 2 && (
              <p className="px-3.5 py-2 text-sm text-muted-foreground">
                Type at least 2 characters to search skills.sh live.
              </p>
            )}
            {shMode === 'live' && liveShSearchQuery.isFetching && (
              <p className="px-3.5 py-2 text-sm text-muted-foreground">Searching skills.sh…</p>
            )}
            {shMode === 'live' && liveShSearchQuery.isError && (
              <p className="px-3.5 py-2 text-sm text-destructive">
                Couldn't reach skills.sh. Check your connection and try again.
              </p>
            )}
          </div>

          {visibleShSkills.length > 0 && (
            <div className={CARD_GRID}>
              {visibleShSkills.map((skill) => (
                <SkillsShDirectoryCard
                  key={skill.id}
                  skill={skill}
                  audit={auditBySkillId.get(`${skill.repo}/${skill.name}`)}
                  starred={favorites.isFavorite(`${skill.repo}/${skill.name}`)}
                  onInstall={handleInstallSkillsSh}
                  onView={setShSelected}
                  onCheckSecurity={handleCheckSkillsShSecurity}
                  onToggleFavorite={handleToggleShFavorite}
                />
              ))}
            </div>
          )}

          {filteredShSkills.length > visibleShSkills.length && (
            <ShowMoreButton
              remaining={filteredShSkills.length - visibleShSkills.length}
              onClick={() => setDirectoryVisibleCount((count) => count + SKILL_GRID_PAGE_SIZE)}
            />
          )}

          {filteredShSkills.length === 0 &&
            !(
              shMode === 'live' &&
              (liveShSearchQuery.isFetching || shDebouncedSearch.trim().length < 2)
            ) && (
              <div className={GLASS_CARD}>
                <EmptyState
                  size="sm"
                  icon={Search}
                  title="Nothing found"
                  description="No skills match your search."
                />
              </div>
            )}
        </div>
      )}

      {activeTab === 'favorites' && (
        <SkillFavoritesTab
          favorites={favorites}
          auditBySkillId={auditBySkillId}
          usageBySkillName={usageBySkillName}
          onInstall={handleInstallFavorite}
          onCheckSecurity={setSecuritySubject}
          onCopyInstallCommand={handleCopyInstallCommand}
        />
      )}

      {activeTab === 'usage' && (
        <SkillUsageTab
          report={usageQuery.data}
          isPending={usageQuery.isPending}
          isRescanning={rescanUsageMutation.isPending}
          onRescan={() => rescanUsageMutation.mutate()}
          favorites={favorites}
        />
      )}

      {activeTab === 'security' && (
        <>
          <AdHocSkillScanner auditBySkillId={auditBySkillId} onCheck={setSecuritySubject} />

          <section aria-label="What a check looks for" className={GLASS_CARD}>
            <div className="space-y-1 px-4 pb-2 pt-3.5">
              <h2 className={SECTION_HEADING}>What a check looks for</h2>
              <p className="text-sm text-muted-foreground">
                A skill is instructions an agent reads and acts on, so its text is as powerful as
                code. Anything checked above, or with the shield button on a skill card, is read
                against these patterns. Every check is kept here.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-1.5 px-3 pb-3 pt-1 md:grid-cols-2 xl:grid-cols-3">
              {SKILL_RISK_CATEGORIES.map((category) => (
                <div key={category.id} className="rounded-lg bg-foreground/[0.03] px-3 py-2">
                  <p className="text-sm font-medium text-foreground">{category.label}</p>
                  <p className="text-xs text-muted-foreground">{category.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Check history" className={cn(GLASS_CARD, 'overflow-hidden')}>
            <div className="flex items-center justify-between gap-3 px-4 py-3 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Check history</h2>
                <p className="text-xs text-muted-foreground">
                  {auditCount} check
                  {auditCount === 1 ? '' : 's'} saved on this machine.
                </p>
              </div>
              {auditCount > 0 && (
                <Button
                  variant="soft"
                  onClick={() => {
                    void confirmDialog({
                      title: 'Clear the security check history?',
                      description:
                        'Every saved check is deleted. The skills themselves are not touched.',
                      confirmLabel: 'Clear',
                      variant: 'destructive',
                    }).then((confirmed) => {
                      if (confirmed) clearAuditsMutation.mutate();
                    });
                  }}
                >
                  <Trash2 /> Clear history
                </Button>
              )}
            </div>

            {auditHistoryQuery.isPending ? (
              <div role="status" aria-label="Loading checks" className="settings-rows">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="space-y-2 px-4 py-3">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3 w-72 max-w-full" />
                  </div>
                ))}
              </div>
            ) : auditCount === 0 ? (
              <EmptyState
                size="sm"
                icon={Shield}
                title="Nothing checked yet"
                description="No skills checked yet. Open the Directory or Repositories tab and use the shield button on a skill."
              />
            ) : (
              <div className="settings-rows">
                {(auditHistoryQuery.data ?? []).map((audit) => (
                  <div
                    key={audit.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 transition-colors hover:bg-foreground/[0.03]"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {audit.skillName}
                        </span>
                        <SkillAuditVerdictBadge verdict={audit.verdict} score={audit.score} />
                        <Chip>{AUDIT_SOURCE_LABEL[audit.sourceKind]}</Chip>
                        {audit.deepReview && (
                          <Chip tone="primary">
                            <Sparkles className="h-3 w-3" />
                            {audit.cliName ?? 'CLI'}
                          </Chip>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {audit.findings.length} finding{audit.findings.length === 1 ? '' : 's'} ·{' '}
                        {audit.sourceLabel} · {new Date(audit.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="soft" size="sm" onClick={() => setAuditDetail(audit)}>
                        <Eye /> View
                      </Button>
                      <SimpleTooltip label="Delete this check">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="hover:text-destructive"
                          aria-label={`Delete the check of ${audit.skillName}`}
                          onClick={() => removeAuditMutation.mutate(audit.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <Dialog
        open={addRepoOpen}
        onOpenChange={(open) => {
          setAddRepoOpen(open);
          // Closing clears the form so the next open starts empty rather than on a stale path.
          if (!open) {
            setRepoName('');
            setRepoSource('');
            setDebouncedRepoSource('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add repository</DialogTitle>
            <DialogDescription>
              Point Runova at a folder of skills, a git repository, or a JSON index.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder={folderPreview?.suggestedName || 'Community Repository'}
              />
              {repoSourceType === 'local-folder' &&
                !repoName.trim() &&
                folderPreview?.suggestedName && (
                  <p className="text-xs text-muted-foreground">
                    Leave this empty to use the folder name.
                  </p>
                )}
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Combobox
                value={repoSourceType}
                onChange={(v) => setRepoSourceType(v as SkillRepositorySourceType)}
                options={SOURCE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{repoSourceType === 'local-folder' ? 'Folder' : 'Source'}</Label>
              {repoSourceType === 'local-folder' ? (
                <div className="flex gap-2">
                  <Input
                    value={repoSource}
                    onChange={(e) => setRepoSource(e.target.value)}
                    onPaste={(e) => {
                      // Paths pasted from Explorer often come wrapped in quotes.
                      const pasted = e.clipboardData.getData('text').trim().replace(/^"|"$/g, '');
                      if (!pasted) return;
                      e.preventDefault();
                      setRepoSource(pasted);
                      setDebouncedRepoSource(pasted);
                    }}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder="Type or paste a folder path, or browse…"
                  />
                  <SimpleTooltip label="Browse for a folder">
                    <Button
                      type="button"
                      variant="soft"
                      size="icon"
                      className="h-9 w-9"
                      onClick={() => void handlePickLocalFolder()}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </SimpleTooltip>
                </div>
              ) : (
                <Input
                  value={repoSource}
                  onChange={(e) => setRepoSource(e.target.value)}
                  placeholder={
                    repoSourceType === 'git'
                      ? 'https://github.com/org/skills.git'
                      : 'https://example.com/repository.json'
                  }
                />
              )}
              {repoSourceType === 'local-folder' && (
                <div className="text-xs">
                  {folderPreviewQuery.isFetching ? (
                    <p className="text-muted-foreground">Checking folder…</p>
                  ) : folderPreview?.error ? (
                    <p className="text-destructive">{folderPreview.error}</p>
                  ) : folderPreview ? (
                    <p className="text-muted-foreground">
                      Found {folderPreview.skillNames.length}{' '}
                      {folderPreview.skillNames.length === 1 ? 'skill' : 'skills'}
                      {folderPreview.hasManifest ? ' from repository.json' : ''}:{' '}
                      <span className="text-foreground">
                        {folderPreview.skillNames.slice(0, 5).join(', ')}
                        {folderPreview.skillNames.length > 5
                          ? ` +${folderPreview.skillNames.length - 5} more`
                          : ''}
                      </span>
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      A folder of skills: subfolders with a SKILL.md, or plain .md files. No
                      repository.json needed.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={
                !repoSource.trim() ||
                addRepoMutation.isPending ||
                (repoSourceType === 'local-folder'
                  ? !!folderPreview?.error ||
                    folderPreviewQuery.isFetching ||
                    debouncedRepoSource.trim() !== repoSource.trim()
                  : !repoName.trim())
              }
              onClick={() => addRepoMutation.mutate()}
            >
              {addRepoMutation.isPending ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!shSelected} onOpenChange={(open) => !open && setShSelected(null)}>
        <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5 pr-6">
              {shSelected?.name}
              {shSelected?.official && (
                <SimpleTooltip label="Official: skills.sh has verified this publisher">
                  <CircleCheck className="h-4 w-4 shrink-0 text-blue-500" />
                </SimpleTooltip>
              )}
            </DialogTitle>
            <DialogDescription>
              {shSelected?.repo} · {shModalInstallsLabel} installs
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 -my-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-1">
            <Chip tone={shSelected?.official ? 'primary' : 'neutral'}>
              {shSelected?.official ? 'Official' : 'Community'}
            </Chip>
            {shDetailQuery.isFetching && shModalDescription === null ? (
              <p className="text-sm text-muted-foreground">Loading description from skills.sh…</p>
            ) : shDetailQuery.isError && shModalDescription === null ? (
              <p className="text-sm text-destructive">
                Couldn't load the description from skills.sh.
              </p>
            ) : (
              <p className="whitespace-pre-wrap text-sm text-foreground">{shModalDescription}</p>
            )}
            <div className="space-y-1.5">
              <Label>Install command</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={shSelected?.installCommand ?? ''}
                  className="font-mono text-xs"
                />
                <SimpleTooltip label="Copy">
                  <Button
                    type="button"
                    variant="soft"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() =>
                      shSelected && handleCopyInstallCommand(shSelected.installCommand)
                    }
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </SimpleTooltip>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={!shSelected}
              onClick={() =>
                shSelected && openInstallPicker({ kind: 'skillsSh', skill: shSelected })
              }
            >
              <Download /> Install…
            </Button>
            <Button
              type="button"
              variant="soft"
              onClick={() => shSelected && void window.runova.shell.openExternal(shSelected.url)}
            >
              <ExternalLink /> Open on skills.sh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!installTarget}
        onOpenChange={(open) => {
          if (!open) {
            setInstallTarget(null);
            setInstallPickerProjectIds(new Set());
            setInstallGlobally(false);
            setInstallPickerSearch('');
          }
        }}
      >
        <DialogContent className="flex max-h-[70vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Install {installTargetName}</DialogTitle>
            <DialogDescription>
              Select one or more projects, or install it globally for use in every project.
            </DialogDescription>
          </DialogHeader>
          <SearchPill
            autoFocus
            label="Search projects"
            placeholder="Search projects…"
            value={installPickerSearch}
            onValueChange={setInstallPickerSearch}
            className="h-9"
          />
          <label className={pickerRow(installGlobally)}>
            <Checkbox
              checked={installGlobally}
              onCheckedChange={(checked) => setInstallGlobally(checked === true)}
            />
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                <Globe className="h-3.5 w-3.5" /> Install globally
              </span>
              <span className="truncate text-xs text-muted-foreground">
                Available to every project
              </span>
            </span>
          </label>
          <p className={cn(SECTION_HEADING, 'px-1 pt-1')}>Projects</p>
          <div className="-mx-1 min-h-0 flex-1 space-y-1 overflow-y-auto px-1 py-0.5">
            {filteredProjectsForPicker.map((p) => {
              const checked = installPickerProjectIds.has(p.id);
              return (
                <label key={p.id} className={pickerRow(checked)}>
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleInstallPickerProject(p.id)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{p.folderPath}</span>
                  </span>
                </label>
              );
            })}
            {filteredProjectsForPicker.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {projectsQuery.data?.length === 0
                  ? 'No projects yet. Create one first.'
                  : 'No projects match your search.'}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={
                (installPickerProjectIds.size === 0 && !installGlobally) ||
                installBatchMutation.isPending
              }
              onClick={() =>
                installBatchMutation.mutate({
                  projectIds: [...installPickerProjectIds],
                  global: installGlobally,
                })
              }
            >
              <Download /> Install
              {installPickerProjectIds.size + (installGlobally ? 1 : 0) > 0
                ? ` (${installPickerProjectIds.size + (installGlobally ? 1 : 0)})`
                : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={globalSkillsModalOpen}
        onOpenChange={(open) => {
          setGlobalSkillsModalOpen(open);
          if (!open) setGlobalSkillsAgentFilter('all');
        }}
      >
        <DialogContent className="flex max-h-[70vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4" /> Global Skills
            </DialogTitle>
            <DialogDescription>Available to every project.</DialogDescription>
          </DialogHeader>
          {(globalInstalledQuery.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <FilterChip
                active={globalSkillsAgentFilter === 'all'}
                onClick={() => setGlobalSkillsAgentFilter('all')}
              >
                All
              </FilterChip>
              {SKILLS_CLI_AGENT_OPTIONS.map((agent) => (
                <FilterChip
                  key={agent.value}
                  active={globalSkillsAgentFilter === agent.value}
                  onClick={() => setGlobalSkillsAgentFilter(agent.value)}
                >
                  {agent.label}
                </FilterChip>
              ))}
            </div>
          )}
          <div className="-mx-1 min-h-0 flex-1 space-y-1 overflow-y-auto px-1">
            {(globalInstalledQuery.data?.length ?? 0) === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                No skills installed globally yet.
              </p>
            ) : filteredGlobalSkills.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                No skills installed for this agent.
              </p>
            ) : (
              filteredGlobalSkills.map((skill) => {
                const update = globalSkillUpdateBySkillId.get(skill.skillId);
                return (
                  <div
                    key={skill.skillId}
                    className="flex items-center justify-between gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2 text-sm transition-colors hover:bg-foreground/[0.05]"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      {skill.skillId}{' '}
                      <span className="text-muted-foreground">v{skill.version}</span>
                      {skill.agents?.map((a) => (
                        <Chip key={a}>{agentLabel(a)}</Chip>
                      ))}
                      {update?.hasUpdate && (
                        <Chip tone="primary" dot>
                          v{update.latestVersion} available
                        </Chip>
                      )}
                      {auditBySkillId.has(skill.skillId) && (
                        <SkillAuditVerdictBadge
                          verdict={auditBySkillId.get(skill.skillId)!.verdict}
                          score={auditBySkillId.get(skill.skillId)!.score}
                        />
                      )}
                    </span>
                    <div className="flex items-center gap-1">
                      <SkillFavoriteButton
                        starred={favorites.isFavorite(skill.skillId)}
                        onToggle={() =>
                          toggleFavorite({
                            skillId: skill.skillId,
                            name: skill.skillId.split('/').pop() ?? skill.skillId,
                            source: 'installed',
                            sourceLabel: 'Installed globally',
                          })
                        }
                      />
                      <SimpleTooltip label="Check this skill for unsafe instructions">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Check ${skill.skillId} for unsafe instructions`}
                          onClick={() =>
                            setSecuritySubject({
                              skillId: skill.skillId,
                              skillName: skill.skillId.split('/').pop() ?? skill.skillId,
                              target: {
                                kind: 'installed',
                                projectId: null,
                                skillId: skill.skillId,
                              },
                            })
                          }
                        >
                          <Shield className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                      {update?.hasUpdate && (
                        <Button
                          size="sm"
                          disabled={
                            updateGlobalSkillMutation.isPending &&
                            updateGlobalSkillMutation.variables?.skillId === skill.skillId
                          }
                          onClick={() => updateGlobalSkillMutation.mutate(update)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" /> Update
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hover:text-destructive"
                        aria-label={`Remove ${skill.skillId}`}
                        onClick={() => {
                          void confirmDialog({
                            title: `Remove "${skill.skillId}"?`,
                            description:
                              skill.repositoryId === UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID
                                ? 'This opens a terminal with the uninstall command, which you run yourself, and drops it from this list.'
                                : 'This removes it globally.',
                            confirmLabel: 'Remove',
                            variant: 'destructive',
                          }).then((confirmed) => {
                            if (confirmed) removeGlobalSkillMutation.mutate(skill);
                          });
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      <SkillSecurityDialog
        subject={securitySubject}
        onOpenChange={(open) => {
          if (!open) setSecuritySubject(null);
        }}
      />

      <Dialog open={!!auditDetail} onOpenChange={(open) => !open && setAuditDetail(null)}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <Shield className="h-4 w-4" />
              {auditDetail?.skillName}
            </DialogTitle>
            <DialogDescription>
              Saved security check from{' '}
              {auditDetail ? new Date(auditDetail.createdAt).toLocaleString() : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 -my-1 min-h-0 flex-1 overflow-y-auto px-1 py-1">
            {auditDetail && <SkillAuditReport record={auditDetail} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
