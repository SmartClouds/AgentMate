import type { Project } from '@agentmat/core';
import { AGENT_TYPE_CLI_ID, AGENT_TYPE_LABELS, configuredRunCommands } from '@agentmat/core';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  Blocks,
  ChartColumn,
  CloudUpload,
  Copy,
  Docker,
  EllipsisVertical,
  File,
  FileCog,
  Folder,
  FolderKanban,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Globe,
  HeartPulse,
  History,
  Key,
  MessageSquare,
  Package,
  Pencil,
  Plug,
  Route,
  Run,
  Shield,
  TerminalSquare,
  Trash2,
  Wand2,
  Workspace,
} from '@/components/icons';
import {
  EmptyState,
  GLASS_CARD,
  SectionCard as KitSectionCard,
  SECTION_HEADING,
  SECTION_WELL,
} from '@/components/pageKit';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import { WordPressSectionIcon } from '@/components/projects/wordpress/WordPressSectionIcon';
import { Button } from '@/components/ui/button';
import { CollapsibleText } from '@/components/ui/collapsible-text';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { openCliInTerminal } from '@/lib/openCli';
import { persianTextProps } from '@/lib/rtl';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useRelayBoardStore } from '@/stores/relayBoardStore';

export const PROJECT_SECTION_IDS = [
  'overview',
  'blueprint',
  'prompts',
  'git',
  'usage',
  'review',
  'security',
  'packages',
  'docker',
  // Monitoring of the project's health endpoints (E22).
  'monitoring',
  // The FTP and SFTP sites attached to the project (E23).
  'deploy',
  // Only shown for a project linked to a WordPress site (E21).
  'wordpress',
  // Old links: the schedule now lives under Prompts, and the page redirects there.
  'schedule',
  'terminal',
  'bootstrap',
  'skills',
  'mcp',
  'hooks',
  'environments',
  'config',
] as const;

export type ProjectSectionId = (typeof PROJECT_SECTION_IDS)[number];

export { AGENT_TYPE_LABELS };

const SECTIONS: {
  id: ProjectSectionId;
  label: string;
  icon: typeof File;
  group: 'work' | 'setup';
}[] = [
  { id: 'overview', label: 'Overview', icon: File, group: 'work' },
  { id: 'blueprint', label: 'Blueprint', icon: Route, group: 'work' },
  { id: 'prompts', label: 'Prompts', icon: History, group: 'work' },
  { id: 'git', label: 'Git', icon: GitBranch, group: 'work' },
  { id: 'usage', label: 'Usage', icon: ChartColumn, group: 'work' },
  { id: 'review', label: 'Review', icon: GitPullRequest, group: 'work' },
  { id: 'security', label: 'Security', icon: Shield, group: 'work' },
  { id: 'packages', label: 'Packages', icon: Package, group: 'work' },
  { id: 'docker', label: 'Docker', icon: Docker, group: 'work' },
  { id: 'monitoring', label: 'Monitoring', icon: HeartPulse, group: 'work' },
  { id: 'deploy', label: 'Deploy', icon: CloudUpload, group: 'work' },
  { id: 'wordpress', label: 'WordPress', icon: WordPressSectionIcon, group: 'work' },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare, group: 'work' },
  { id: 'bootstrap', label: 'Bootstrap', icon: Wand2, group: 'setup' },
  { id: 'skills', label: 'Skills', icon: Blocks, group: 'setup' },
  { id: 'mcp', label: 'MCP', icon: Plug, group: 'setup' },
  { id: 'hooks', label: 'Hooks', icon: Bell, group: 'setup' },
  { id: 'environments', label: 'Environments', icon: Key, group: 'setup' },
  { id: 'config', label: 'Config', icon: FileCog, group: 'setup' },
];

export type SectionBadge = { count?: number; attention?: boolean };

export function isProjectSectionId(value: string | null): value is ProjectSectionId {
  return value !== null && (PROJECT_SECTION_IDS as readonly string[]).includes(value);
}

function stripUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** A standalone empty state (Security, Deploy): the kit's glowing state on a glass card. */
export function ProjectEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: typeof File;
  title: string;
  description: string;
  action?: ReactNode;
}): React.JSX.Element {
  return <EmptyState card icon={icon} title={title} description={description} action={action} />;
}

// The project page's names for the shared page kit pieces, kept so its callers need no change.
/** The glass card the project page is built from. */
export const PROJECT_CARD = GLASS_CARD;
export { SECTION_HEADING, SECTION_WELL };

/**
 * The empty state on the project page, the kit's glowing state. On its own it is a glass card;
 * `inset` drops the card for use inside a section that already has one.
 */
export function SectionEmptyState({
  icon,
  title,
  description,
  action,
  inset = false,
}: {
  icon: typeof File;
  title: string;
  description: string;
  action?: ReactNode;
  inset?: boolean;
}): React.JSX.Element {
  return (
    <EmptyState
      size={inset ? 'sm' : 'md'}
      card={!inset}
      icon={icon}
      title={title}
      description={description}
      action={action}
    />
  );
}

/**
 * One section of the project page: the kit's section card, clipped to its corners. It takes the
 * icon as a component and titles the card as an h2, since each card is a section of the page.
 */
export function SectionCard({
  icon: Icon,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  icon: typeof File;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}): React.JSX.Element {
  return (
    <KitSectionCard
      icon={<Icon />}
      title={title}
      description={description}
      actions={actions}
      headingLevel={2}
      className={cn('overflow-hidden', className)}
      bodyClassName={bodyClassName}
    >
      {children}
    </KitSectionCard>
  );
}

export function ProjectDetailSkeleton(): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-1 flex-col gap-2 p-2">
      <div className={cn(PROJECT_CARD, 'p-4')}>
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
            <div className="flex gap-1.5">
              <Skeleton className="h-6 w-28 rounded-full" />
              <Skeleton className="h-6 w-14 rounded-full" />
            </div>
          </div>
          <div className="hidden gap-1.5 sm:flex">
            <Skeleton className="h-8 w-16 rounded-full" />
            <Skeleton className="h-8 w-32 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
        <div className={cn(PROJECT_CARD, 'flex gap-1 p-2 lg:w-52 lg:flex-col')}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-24 shrink-0 rounded-lg lg:w-full" />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-36 w-full rounded-[calc(var(--radius)+2px)]" />
          <Skeleton className="h-28 w-full rounded-[calc(var(--radius)+2px)]" />
        </div>
      </div>
    </div>
  );
}

/** A small rounded label tinted with a theme token. */
function HeaderChip({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2.5 text-[11px] font-medium text-foreground/80',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ProjectDetailHeader({
  project,
  onBack,
  onRun,
  onPrompt,
  onEdit,
  onCreateRunWithAi,
  onDelete,
  onToggleArchive,
  onCopyPath,
  onOpenFolder,
  onOpenTerminal,
  onOpenWorkspace,
}: {
  project: Project;
  onBack: () => void;
  onRun: () => void;
  onPrompt: () => void;
  onEdit: () => void;
  /** Adds "Create run command with AI" to the menu while the project has no run command. */
  onCreateRunWithAi?: () => void;
  onDelete: () => void;
  onToggleArchive: () => void;
  onCopyPath: () => void;
  onOpenFolder: () => void;
  onOpenTerminal: () => void;
  onOpenWorkspace: () => void;
}): React.JSX.Element {
  const agentLabel = AGENT_TYPE_LABELS[project.agentType];
  const agentCliId = AGENT_TYPE_CLI_ID[project.agentType];
  const hasRunCommand = configuredRunCommands(project).length > 0;
  const description = persianTextProps(project.description);

  return (
    <div className={cn(PROJECT_CARD, 'p-4')}>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1.5 mb-2.5 inline-flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-3 w-3" /> Projects
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
          <ProjectIcon
            iconDataUrl={project.iconDataUrl}
            bgColor={project.iconBgColor}
            iconColor={project.iconColor}
            className="h-12 w-12 rounded-xl"
            glyphClassName="h-5 w-5"
          />
          <div className="min-w-0 space-y-2.5">
            <div className="space-y-1">
              <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">
                {project.name}
              </h1>
              {project.description ? (
                <p
                  dir={description.dir}
                  className={cn(
                    'max-w-2xl text-sm leading-relaxed text-muted-foreground',
                    description.className,
                  )}
                >
                  {project.description}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {agentCliId ? (
                <SimpleTooltip label={`Open ${agentLabel} in the terminal`}>
                  <button
                    type="button"
                    className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full bg-foreground/[0.07] px-2.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-primary/12 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() =>
                      openCliInTerminal({
                        cliId: agentCliId,
                        cwd: project.folderPath,
                        projectId: project.id,
                      })
                    }
                  >
                    <CliLogo cliId={agentCliId} className="h-3 w-3" />
                    {agentLabel}
                  </button>
                </SimpleTooltip>
              ) : (
                <HeaderChip>{agentLabel}</HeaderChip>
              )}
              {project.archived ? (
                <HeaderChip className="bg-warning/12 text-warning">
                  <Archive className="h-3 w-3" /> Archived
                </HeaderChip>
              ) : null}
              {project.tags.map((tag) => (
                <HeaderChip key={tag} className="bg-foreground/[0.05] text-muted-foreground">
                  {tag}
                </HeaderChip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <PathChip path={project.folderPath} onCopy={onCopyPath} />
              <IconAction label="Open in File Explorer" onClick={onOpenFolder}>
                <FolderOpen className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction label="Open terminal here" onClick={onOpenTerminal}>
                <TerminalSquare className="h-3.5 w-3.5" />
              </IconAction>
              {project.websiteUrl ? (
                <LinkChip
                  href={project.websiteUrl}
                  label={stripUrl(project.websiteUrl)}
                  icon={Globe}
                />
              ) : null}
              {project.repoUrl ? (
                <LinkChip
                  href={project.repoUrl}
                  label={stripUrl(project.repoUrl)}
                  icon={GitBranch}
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {hasRunCommand ? (
            <Button onClick={onRun}>
              <Run /> Run
            </Button>
          ) : null}
          <SimpleTooltip label="Run agents side by side and review their changes">
            <Button variant="soft" onClick={onOpenWorkspace}>
              <Workspace /> Open workspace
            </Button>
          </SimpleTooltip>
          <Button variant="soft" onClick={onPrompt}>
            <MessageSquare /> Prompt
          </Button>
          <SimpleTooltip label="The project's Relay tasks, as a board you can run from">
            <Button variant="soft" onClick={() => useRelayBoardStore.getState().open(project.id)}>
              <FolderKanban /> Task board
            </Button>
          </SimpleTooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="soft" size="icon" aria-label="More project actions">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-4 w-4" /> Edit project
              </DropdownMenuItem>
              {!hasRunCommand ? (
                <DropdownMenuItem onSelect={onEdit}>
                  <Run className="h-4 w-4" /> Set a run command
                </DropdownMenuItem>
              ) : null}
              {!hasRunCommand && onCreateRunWithAi ? (
                <DropdownMenuItem onSelect={onCreateRunWithAi}>
                  <Wand2 className="h-4 w-4" /> Create run command with AI
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={onOpenFolder}>
                <FolderOpen className="h-4 w-4" /> Open folder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenTerminal}>
                <TerminalSquare className="h-4 w-4" /> Open terminal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onToggleArchive}>
                {project.archived ? (
                  <>
                    <ArchiveRestore className="h-4 w-4" /> Restore project
                  </>
                ) : (
                  <>
                    <Archive className="h-4 w-4" /> Archive project
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem tone="danger" onSelect={onDelete}>
                <Trash2 className="h-4 w-4" /> Remove project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/** The path and link chips under the project name: the search box's faint pill, made small. */
const META_PILL =
  'search-pill inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function PathChip({ path, onCopy }: { path: string; onCopy: () => void }): React.JSX.Element {
  return (
    <SimpleTooltip label={`Copy path: ${path}`}>
      <button
        type="button"
        onClick={onCopy}
        className={cn(META_PILL, 'max-w-[min(100%,28rem)] font-mono text-[11px]')}
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{path}</span>
        <Copy className="h-3 w-3 shrink-0 opacity-70" />
      </button>
    </SimpleTooltip>
  );
}

function LinkChip({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: typeof Globe;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={`Open ${href}`}>
      <button
        type="button"
        onClick={() => void window.agentmat.shell.openExternal(href)}
        className={cn(META_PILL, 'max-w-[min(100%,18rem)]')}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    </SimpleTooltip>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(META_PILL, 'w-7 justify-center px-0')}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}

export function ProjectSectionNav({
  section,
  onSectionChange,
  badges,
  createdAt,
  updatedAt,
  hiddenIds,
}: {
  section: ProjectSectionId;
  onSectionChange: (id: ProjectSectionId) => void;
  badges: Partial<Record<ProjectSectionId, SectionBadge>>;
  createdAt: string;
  updatedAt: string;
  hiddenIds?: readonly ProjectSectionId[];
}): React.JSX.Element {
  const hidden = new Set(hiddenIds ?? []);
  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  return (
    // A card of its own beside the content, like the API Client's collections. Below lg there is
    // no room for a column, so the same entries run across the top as one scrolling strip.
    <nav
      aria-label="Project sections"
      className={cn(
        PROJECT_CARD,
        'flex min-w-0 flex-col p-1.5 lg:sticky lg:top-2 lg:w-52 lg:shrink-0 lg:p-2',
      )}
    >
      <LayoutGroup id="project-sections">
        <div className="flex gap-px overflow-x-auto [scrollbar-width:none] lg:flex-col lg:overflow-visible [&::-webkit-scrollbar]:hidden">
          <SectionGroup
            label="Work"
            section={section}
            onSectionChange={onSectionChange}
            badges={badges}
            transition={pillTransition}
            items={SECTIONS.filter((item) => item.group === 'work' && !hidden.has(item.id))}
          />
          <div className="mx-1 my-1.5 w-px shrink-0 self-stretch bg-foreground/[0.08] lg:hidden" />
          <SectionGroup
            label="Setup"
            section={section}
            onSectionChange={onSectionChange}
            badges={badges}
            transition={pillTransition}
            items={SECTIONS.filter((item) => item.group === 'setup' && !hidden.has(item.id))}
          />
        </div>
      </LayoutGroup>
      <dl className="mt-2 hidden gap-1.5 px-2.5 pb-1 pt-2.5 text-[11px] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)] lg:grid">
        <div className="flex items-center justify-between gap-2">
          <dt>Created</dt>
          <dd className="tabular-nums text-foreground/80">{timeAgo(createdAt)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Updated</dt>
          <dd className="tabular-nums text-foreground/80">{timeAgo(updatedAt)}</dd>
        </div>
      </dl>
    </nav>
  );
}

function SectionGroup({
  label,
  items,
  section,
  onSectionChange,
  badges,
  transition,
}: {
  label: string;
  items: typeof SECTIONS;
  section: ProjectSectionId;
  onSectionChange: (id: ProjectSectionId) => void;
  badges: Partial<Record<ProjectSectionId, SectionBadge>>;
  transition: React.ComponentProps<typeof motion.span>['transition'];
}): React.JSX.Element {
  return (
    <div className="flex gap-px lg:flex-col">
      <p className={cn(SECTION_HEADING, 'hidden px-2.5 pb-1 pt-2 lg:block')}>{label}</p>
      {items.map((item) => {
        const active = section === item.id;
        const badge = badges[item.id];
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onSectionChange(item.id)}
            className={cn(
              // `isolate` keeps the active pill behind the label without lifting every child.
              'relative isolate inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'font-medium text-primary'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                aria-hidden
                layoutId="project-section-active"
                transition={transition}
                className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
              >
                <span className="absolute left-0 top-1/2 hidden h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)] lg:block" />
              </motion.span>
            )}
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{item.label}</span>
            {badge?.count ? (
              <span
                className={cn(
                  'ml-auto min-w-4 rounded-full px-1.5 text-center text-[10px] font-semibold leading-4 tabular-nums',
                  badge.attention
                    ? 'bg-warning/15 text-warning'
                    : active
                      ? 'bg-primary/15 text-primary'
                      : 'bg-foreground/[0.06] text-muted-foreground',
                )}
              >
                {badge.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function ProjectNotesCard({
  notes,
  onSave,
  saving,
}: {
  notes: string;
  onSave: (notes: string) => void;
  saving: boolean;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes);
  const savedValue = useRef<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(notes);
  }, [notes, editing]);

  useEffect(() => {
    if (savedValue.current !== null && notes === savedValue.current) {
      savedValue.current = null;
      setEditing(false);
    }
  }, [notes]);

  function handleSave(): void {
    const next = draft.trim();
    if (next === notes) {
      setEditing(false);
      return;
    }
    savedValue.current = next;
    onSave(next);
  }

  const description = 'A scratchpad for context you do not want in the standing prompt.';

  if (editing) {
    return (
      <SectionCard
        icon={Pencil}
        title="Notes"
        description={description}
        actions={
          <>
            <Button
              variant="soft"
              onClick={() => {
                savedValue.current = null;
                setDraft(notes);
                setEditing(false);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save notes'}
            </Button>
          </>
        }
      >
        <GrammarTextarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
          placeholder="Scratchpad for this project. Anything you want agents or yourself to remember."
          autoFocus
          disabled={saving}
          className="rounded-xl"
        />
      </SectionCard>
    );
  }

  if (!notes) {
    return (
      <SectionCard icon={Pencil} title="Notes" description={description}>
        <SectionEmptyState
          inset
          icon={Pencil}
          title="No notes yet"
          description="Keep a scratchpad on this project for context you do not want in the standing prompt."
          action={
            <Button variant="soft" onClick={() => setEditing(true)}>
              <Pencil /> Add notes
            </Button>
          }
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      icon={Pencil}
      title="Notes"
      description={description}
      actions={
        <Button variant="soft" onClick={() => setEditing(true)}>
          <Pencil /> Edit notes
        </Button>
      }
    >
      <CollapsibleText text={notes} />
    </SectionCard>
  );
}
