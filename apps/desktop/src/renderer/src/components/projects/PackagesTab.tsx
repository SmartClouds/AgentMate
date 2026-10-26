import type { Project } from '@runova/core';
import type { PackageInfo, PackageManagerSection, PackageUpdateRequest } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Folder,
  ListUnordered,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  Spinner,
  TriangleAlert,
  X,
} from '@/components/icons';
import { PackagesUpdateDialog } from '@/components/projects/PackagesUpdateDialog';
import { SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import {
  type BumpKind,
  buildPackageNames,
  buildPackageUpdatePrompt,
  bumpKind,
} from '@/components/projects/packagesCopy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

type PackageFilter = 'all' | 'outdated' | 'dev';
type PackageTick = { status: 'running' | 'done' | 'error'; message?: string };

const FILTERS: { id: PackageFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'outdated', label: 'Outdated' },
  { id: 'dev', label: 'Dev' },
];

function packageKey(pkg: PackageInfo): string {
  return `${pkg.manifestPath}::${pkg.name}`;
}

function ecosystemLabel(section: PackageManagerSection): string {
  if (section.ecosystem === 'dotnet') return 'NuGet (.NET)';
  if (section.ecosystem === 'dart') return 'pub (Dart / Flutter)';
  if (section.manager === 'yarn') return 'Yarn';
  if (section.manager === 'pnpm') return 'pnpm';
  if (section.manager === 'bun') return 'Bun';
  return 'npm';
}

function sectionKey(section: PackageManagerSection): string {
  return `${section.ecosystem}-${section.manager}`;
}

function canUpdatePackage(pkg: PackageInfo): boolean {
  return pkg.isOutdated && Boolean(pkg.latestVersion);
}

function matchesPackageQuery(pkg: PackageInfo, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return pkg.name.toLowerCase().includes(q) || pkg.projectLabel.toLowerCase().includes(q);
}

function isPackageVisible(pkg: PackageInfo, filter: PackageFilter, search: string): boolean {
  if (filter === 'outdated' && !pkg.isOutdated) return false;
  if (filter === 'dev' && !pkg.isDev) return false;
  return matchesPackageQuery(pkg, search);
}

function sortPackages(packages: PackageInfo[]): PackageInfo[] {
  return [...packages].sort((a, b) => {
    if (a.isOutdated !== b.isOutdated) return a.isOutdated ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function groupPackagesByProject(
  packages: PackageInfo[],
): { label: string | null; packages: PackageInfo[] }[] {
  const labels = new Set(packages.map((pkg) => pkg.projectLabel));
  if (labels.size <= 1) return [{ label: null, packages }];

  const groups = new Map<string, PackageInfo[]>();
  for (const pkg of packages) {
    const list = groups.get(pkg.projectLabel) ?? [];
    list.push(pkg);
    groups.set(pkg.projectLabel, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, grouped]) => ({ label, packages: grouped }));
}

function toUpdateRequest(
  section: PackageManagerSection,
  pkg: PackageInfo,
): PackageUpdateRequest | null {
  if (!pkg.latestVersion) return null;
  return {
    ecosystem: section.ecosystem,
    name: pkg.name,
    targetVersion: pkg.latestVersion,
    manifestPath: pkg.manifestPath,
  };
}

const PACKAGE_SKELETON_WIDTHS = ['w-40', 'w-56', 'w-32', 'w-48', 'w-36', 'w-52'];

function PackageRowSkeleton({ nameWidth }: { nameWidth: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-foreground/[0.03] px-3 py-2.5">
      <Skeleton className="h-[18px] w-[18px] shrink-0 rounded-[5px]" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className={`h-3.5 ${nameWidth}`} />
        <Skeleton className="h-2.5 w-28" />
      </div>
      <Skeleton className="h-6 w-16 shrink-0 rounded-md" />
    </div>
  );
}

function PackagesSectionSkeleton({ rows }: { rows: number }): React.JSX.Element {
  return (
    <div className="glass space-y-3 rounded-[calc(var(--radius)+2px)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-2.5 w-16" />
          </div>
        </div>
        <Skeleton className="h-8 w-36 rounded-md" />
      </div>
      <div className="space-y-1.5">
        {Array.from({ length: rows }, (_, i) => (
          <PackageRowSkeleton
            key={i}
            nameWidth={PACKAGE_SKELETON_WIDTHS[i % PACKAGE_SKELETON_WIDTHS.length]}
          />
        ))}
      </div>
    </div>
  );
}

function PackagesTabSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="glass flex flex-wrap items-center justify-between gap-3 rounded-[calc(var(--radius)+2px)] p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-52 rounded-lg" />
        <Skeleton className="h-8 w-44 rounded-lg" />
      </div>
      <PackagesSectionSkeleton rows={5} />
      <PackagesSectionSkeleton rows={3} />
    </div>
  );
}

function BumpBadge({ kind }: { kind: BumpKind }): React.JSX.Element {
  const label = kind === 'major' ? 'Major' : kind === 'minor' ? 'Minor' : 'Patch';
  return (
    <Badge
      variant={kind === 'major' ? 'warning' : 'outline'}
      className="px-1.5 py-0 text-[10px] leading-4"
    >
      {label}
    </Badge>
  );
}

function PackageVersionTrail({ pkg }: { pkg: PackageInfo }): React.JSX.Element {
  if (pkg.isOutdated && pkg.latestVersion) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
        <span className="text-muted-foreground">{pkg.currentVersion}</span>
        <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
        <span className="text-foreground">{pkg.latestVersion}</span>
      </span>
    );
  }
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      {pkg.currentVersion}
    </span>
  );
}

function PackageRow({
  pkg,
  selected,
  tick,
  updating,
  onToggle,
  onUpdate,
}: {
  pkg: PackageInfo;
  selected: boolean;
  tick: PackageTick | undefined;
  updating: boolean;
  onToggle: () => void;
  onUpdate: () => void;
}): React.JSX.Element {
  const bump =
    pkg.isOutdated && pkg.latestVersion ? bumpKind(pkg.currentVersion, pkg.latestVersion) : null;
  const selectable = canUpdatePackage(pkg);
  const identity = (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <SimpleTooltip label={pkg.name}>
          <span className="truncate text-sm font-medium">{pkg.name}</span>
        </SimpleTooltip>
        {pkg.isDev && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
            Dev
          </Badge>
        )}
        {!pkg.isInstalled && (
          <SimpleTooltip label="Declared in the manifest, but not installed locally.">
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
              Not installed
            </Badge>
          </SimpleTooltip>
        )}
        {!pkg.latestVersion && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
            Latest unknown
          </Badge>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <PackageVersionTrail pkg={pkg} />
        {bump && <BumpBadge kind={bump} />}
      </div>
    </div>
  );

  const checkboxId = `pkg-${packageKey(pkg).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;

  return (
    <div
      className={cn(
        'relative flex items-center gap-3 rounded-lg bg-foreground/[0.03] px-3 py-2.5 transition-colors',
        selectable && 'hover:bg-foreground/[0.05]',
        // A ring, not a border: the theme's global border colour would repaint a tinted one.
        selected && 'bg-primary/[0.06] ring-1 ring-inset ring-primary/20 hover:bg-primary/[0.08]',
      )}
    >
      {pkg.isOutdated && (
        // The outdated mark is drawn as its own edge, like the Git list's changed files.
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-warning"
        />
      )}
      {selectable ? (
        <Checkbox
          id={checkboxId}
          checked={selected}
          disabled={updating}
          aria-label={`Select ${pkg.name}`}
          onCheckedChange={onToggle}
        />
      ) : (
        <span className="w-[18px] shrink-0" aria-hidden="true" />
      )}
      {selectable ? (
        <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center">
          {identity}
        </label>
      ) : (
        identity
      )}

      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {tick?.status === 'running' && (
          <Spinner className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
        {tick?.status === 'done' && <Check className="h-3.5 w-3.5 text-success" />}
        {tick?.status === 'error' && (
          <SimpleTooltip label={tick.message ?? 'Update failed'} wrapTrigger>
            <TriangleAlert className="h-3.5 w-3.5 text-destructive" />
          </SimpleTooltip>
        )}
        {!tick && selectable && (
          <Button variant="outline" size="sm" disabled={updating} onClick={onUpdate}>
            Update
          </Button>
        )}
        {!tick && !pkg.isOutdated && pkg.latestVersion && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3 w-3 text-success" /> Current
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Copies either an agent-ready update prompt or just the names. Works on the selected packages
 * when there is a selection, otherwise on every outdated package in the section.
 */
function PackagesCopyMenu({
  section,
  selectedPackages,
}: {
  section: PackageManagerSection;
  selectedPackages: PackageInfo[];
}): React.JSX.Element {
  const targets =
    selectedPackages.length > 0
      ? selectedPackages
      : section.packages.filter((pkg) => pkg.isOutdated);
  const scope =
    selectedPackages.length > 0 ? `${targets.length} selected` : `${targets.length} outdated`;

  async function copy(label: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard.`);
    } catch {
      toast.error(`Could not copy the ${label.toLowerCase()}.`);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={targets.length === 0}>
          <Copy className="h-3.5 w-3.5" />
          Copy
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Copy {scope}</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => void copy('Update prompt', buildPackageUpdatePrompt(section, targets))}
        >
          <Sparkles className="h-4 w-4" />
          <span className="flex flex-col">
            <span>AI update prompt</span>
            <span className="text-xs text-muted-foreground">
              Versions and steps, ready to paste at an agent
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copy('Package names', buildPackageNames(targets))}>
          <ListUnordered className="h-4 w-4" />
          <span className="flex flex-col">
            <span>Package names</span>
            <span className="text-xs text-muted-foreground">Just the names, one per line</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PackagesTab({ project }: { project: Project }): React.JSX.Element {
  const projectId = project.id;
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<PackageFilter>('all');
  const [query, setQuery] = useState('');
  const [progress, setProgress] = useState<Map<string, PackageTick>>(new Map());
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number } | null>(
    null,
  );
  const [updatingSectionKey, setUpdatingSectionKey] = useState<string | null>(null);
  const [aiSectionKey, setAiSectionKey] = useState<string | null>(null);

  const scanQuery = useQuery({
    queryKey: queryKeys.packages(projectId),
    queryFn: () => window.runova.packages.list(projectId),
  });

  useEffect(() => {
    return window.runova.packages.onUpdateProgress((p) => {
      if (p.projectId !== projectId) return;
      setBatchProgress({ completed: p.completed, total: p.total });
      setProgress((prev) => {
        const next = new Map(prev);
        next.set(p.packageName, { status: p.status, message: p.message });
        return next;
      });
    });
  }, [projectId]);

  const updateMutation = useMutation({
    mutationFn: (updates: PackageUpdateRequest[]) =>
      window.runova.packages.update(projectId, updates),
    onSuccess: (result) => {
      const failed = result.results.filter((r) => !r.ok);
      const count = result.results.length;
      if (result.ok) {
        toast.success(`Updated ${count} package${count === 1 ? '' : 's'}.`);
      } else {
        toast.error(
          `${failed.length} of ${count} package${count === 1 ? '' : 's'} failed to update.`,
        );
      }
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: queryKeys.packages(projectId) });
    },
    onSettled: () => {
      setBatchProgress(null);
      setUpdatingSectionKey(null);
    },
    meta: { silentLoading: true },
  });

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleVisibleOutdated(packages: PackageInfo[], checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const pkg of packages) {
        if (!canUpdatePackage(pkg)) continue;
        if (checked) next.add(packageKey(pkg));
        else next.delete(packageKey(pkg));
      }
      return next;
    });
  }

  function runUpdates(section: PackageManagerSection, packages: PackageInfo[]): void {
    const updates = packages
      .map((pkg) => toUpdateRequest(section, pkg))
      .filter((req): req is PackageUpdateRequest => req !== null);
    if (updates.length === 0) return;
    setProgress(new Map());
    setBatchProgress({ completed: 0, total: updates.length });
    setUpdatingSectionKey(sectionKey(section));
    updateMutation.mutate(updates);
  }

  const sections = scanQuery.data?.sections ?? [];
  const isRefreshing = scanQuery.isFetching;
  const search = query.trim();

  const totals = useMemo(() => {
    let packageCount = 0;
    let outdatedCount = 0;
    for (const section of sections) {
      packageCount += section.packages.length;
      outdatedCount += section.packages.filter((pkg) => pkg.isOutdated).length;
    }
    return { packageCount, outdatedCount };
  }, [sections]);

  const ecosystemNames = useMemo(() => [...new Set(sections.map(ecosystemLabel))], [sections]);

  if (scanQuery.isLoading) {
    return <PackagesTabSkeleton />;
  }

  const toolbar = (
    <div className="glass relative overflow-hidden rounded-[calc(var(--radius)+2px)] p-4">
      {isRefreshing && <Skeleton className="absolute inset-x-0 top-0 h-0.5 rounded-none" />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">Dependencies</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {totals.packageCount > 0 ? (
                <Badge variant="outline">
                  {totals.packageCount} package{totals.packageCount === 1 ? '' : 's'}
                </Badge>
              ) : (
                <Badge variant="outline">No packages found</Badge>
              )}
              {totals.outdatedCount > 0 ? (
                <Badge variant="warning">{totals.outdatedCount} outdated</Badge>
              ) : (
                totals.packageCount > 0 && (
                  <Badge variant="success" className="gap-1">
                    <Check className="h-3 w-3" /> All current
                  </Badge>
                )
              )}
              {ecosystemNames.map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={scanQuery.isFetching}
          aria-busy={scanQuery.isFetching}
          onClick={() => void scanQuery.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${scanQuery.isFetching ? 'animate-spin' : ''}`} />
          {scanQuery.isFetching ? 'Scanning…' : 'Refresh'}
        </Button>
      </div>
    </div>
  );

  if (sections.length === 0) {
    return (
      <div className="space-y-4">
        {toolbar}
        <SectionEmptyState
          icon={Package}
          title="No package manifests in this folder"
          description="Runova looks for package.json, yarn.lock, pnpm-lock.yaml, bun.lock, pubspec.yaml, and .NET project files."
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={scanQuery.isFetching}
              onClick={() => void scanQuery.refetch()}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanQuery.isFetching ? 'animate-spin' : ''}`} />
              Scan again
            </Button>
          }
        />
      </div>
    );
  }

  const aiSection = sections.find((section) => sectionKey(section) === aiSectionKey);

  const noVisibleMatches =
    (filter !== 'all' || Boolean(search)) &&
    sections.every(
      (section) =>
        section.status === 'ok' &&
        !section.packages.some((pkg) => isPackageVisible(pkg, filter, search)),
    );

  return (
    <div className="space-y-4">
      {toolbar}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search packages"
            aria-label="Search packages"
            className="h-8 pl-8 pr-8"
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              onClick={() => setQuery('')}
            >
              <X />
            </Button>
          )}
        </div>
        <div
          role="radiogroup"
          aria-label="Filter packages"
          className="flex rounded-lg border border-border p-0.5"
        >
          {FILTERS.map((item) => {
            const active = filter === item.id;
            const count = item.id === 'outdated' ? totals.outdatedCount : undefined;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setFilter(item.id)}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/15 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {item.label}
                {count !== undefined && count > 0 && (
                  <span className="tabular-nums text-warning">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {sections.map((section) => {
        const visiblePackages = sortPackages(
          section.packages.filter((pkg) => isPackageVisible(pkg, filter, search)),
        );
        const visibleOutdated = visiblePackages.filter(canUpdatePackage);
        const sectionSelected = section.packages.filter((pkg) => selected.has(packageKey(pkg)));
        const sectionSelectedCount = sectionSelected.length;
        const allVisibleOutdatedSelected =
          visibleOutdated.length > 0 &&
          visibleOutdated.every((pkg) => selected.has(packageKey(pkg)));
        const someVisibleOutdatedSelected = visibleOutdated.some((pkg) =>
          selected.has(packageKey(pkg)),
        );
        const groups = groupPackagesByProject(visiblePackages);
        const outdatedInSection = section.packages.filter((pkg) => pkg.isOutdated).length;
        const updatingThisSection =
          updateMutation.isPending && updatingSectionKey === sectionKey(section);

        if (
          (filter !== 'all' || search) &&
          visiblePackages.length === 0 &&
          section.status === 'ok'
        ) {
          return null;
        }

        return (
          <div
            key={sectionKey(section)}
            className="glass relative space-y-3 overflow-hidden rounded-[calc(var(--radius)+2px)] p-4"
          >
            {isRefreshing && <Skeleton className="absolute inset-x-0 top-0 h-0.5 rounded-none" />}
            {updateMutation.isPending && batchProgress && updatingThisSection && (
              <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-foreground/10">
                <div
                  className="h-full origin-left bg-primary transition-transform duration-200"
                  style={{
                    transform: `scaleX(${
                      batchProgress.total === 0 ? 0 : batchProgress.completed / batchProgress.total
                    })`,
                  }}
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Package className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                    {ecosystemLabel(section)}
                    {outdatedInSection > 0 && (
                      <Badge variant="warning">{outdatedInSection} outdated</Badge>
                    )}
                    {section.status === 'ok' &&
                      outdatedInSection === 0 &&
                      section.packages.length > 0 && (
                        <Badge variant="success" className="gap-1">
                          <Check className="h-3 w-3" /> Up to date
                        </Badge>
                      )}
                  </p>
                  {section.status === 'ok' && section.packages.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {section.packages.length} package
                      {section.packages.length === 1 ? '' : 's'}
                      {updateMutation.isPending && batchProgress && updatingThisSection
                        ? ` · Updating ${batchProgress.completed} of ${batchProgress.total}`
                        : null}
                    </p>
                  )}
                </div>
              </div>
              {section.status === 'ok' && section.packages.length > 0 && (
                <div className="flex items-center gap-2">
                  <PackagesCopyMenu section={section} selectedPackages={sectionSelected} />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={outdatedInSection === 0}
                    onClick={() => setAiSectionKey(sectionKey(section))}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Update with AI
                  </Button>
                  <Button
                    size="sm"
                    disabled={sectionSelectedCount === 0 || updateMutation.isPending}
                    onClick={() => runUpdates(section, sectionSelected)}
                  >
                    {updateMutation.isPending && updatingThisSection ? (
                      <Spinner className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {sectionSelectedCount > 0
                      ? `Update ${sectionSelectedCount}`
                      : 'Update selected'}
                  </Button>
                </div>
              )}
            </div>

            {section.status === 'cli-missing' && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-muted-foreground">{section.message}</p>
              </div>
            )}

            {section.status === 'error' && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{section.message}</p>
              </div>
            )}

            {section.status === 'ok' && section.message && (
              <p className="text-sm text-muted-foreground">{section.message}</p>
            )}

            {section.status === 'ok' && section.packages.length === 0 && (
              <p className="text-sm text-muted-foreground">No dependencies declared.</p>
            )}

            {section.status === 'ok' &&
              section.packages.length > 0 &&
              visiblePackages.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {filter === 'outdated'
                    ? 'All packages are up to date.'
                    : 'No packages match this filter.'}
                </p>
              )}

            {section.status === 'ok' && visiblePackages.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 px-1">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={
                        allVisibleOutdatedSelected
                          ? true
                          : someVisibleOutdatedSelected
                            ? 'indeterminate'
                            : false
                      }
                      disabled={visibleOutdated.length === 0 || updateMutation.isPending}
                      onCheckedChange={(checked) =>
                        toggleVisibleOutdated(visibleOutdated, checked === true)
                      }
                    />
                    {visibleOutdated.length > 0
                      ? `Select ${visibleOutdated.length} outdated`
                      : 'No outdated packages'}
                  </label>
                  {sectionSelectedCount > 0 && (
                    <button
                      type="button"
                      className="cursor-pointer py-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => toggleVisibleOutdated(section.packages, false)}
                    >
                      Clear {sectionSelectedCount} selected
                    </button>
                  )}
                </div>

                <OverflowScroll className="max-h-[min(36rem,70vh)] space-y-3 pr-1" surface="card">
                  {groups.map((group) => (
                    <div key={group.label ?? 'all'} className="space-y-1.5">
                      {group.label && (
                        <div className="flex items-center gap-1.5 px-1 pt-1 text-xs text-muted-foreground">
                          <Folder className="h-3 w-3" />
                          <span className="truncate font-medium text-foreground/80">
                            {group.label}
                          </span>
                          <span className="tabular-nums">{group.packages.length}</span>
                        </div>
                      )}
                      {group.packages.map((pkg) => {
                        const key = packageKey(pkg);
                        return (
                          <PackageRow
                            key={key}
                            pkg={pkg}
                            selected={selected.has(key)}
                            tick={progress.get(pkg.name)}
                            updating={updateMutation.isPending}
                            onToggle={() => toggle(key)}
                            onUpdate={() => runUpdates(section, [pkg])}
                          />
                        );
                      })}
                    </div>
                  ))}
                </OverflowScroll>
              </div>
            )}
          </div>
        );
      })}

      {aiSection && (
        <PackagesUpdateDialog
          open
          onOpenChange={(open) => {
            if (!open) setAiSectionKey(null);
          }}
          project={project}
          section={aiSection}
          sectionLabel={ecosystemLabel(aiSection)}
          selectedPackages={aiSection.packages.filter((pkg) => selected.has(packageKey(pkg)))}
        />
      )}

      {noVisibleMatches && (
        <p className="text-sm text-muted-foreground">
          {search
            ? `No packages match "${search}".`
            : filter === 'outdated'
              ? 'Everything here is current.'
              : 'No dev dependencies in this project.'}
        </p>
      )}
    </div>
  );
}
