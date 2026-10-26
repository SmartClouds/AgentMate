import {
  AGENT_TOOL_REGISTRY,
  type AgentToolDefinition,
  buildChecklist,
  CODEQL_TOOL_ID,
  type DevOs,
  itemsForStacks,
  LANGUAGETOOL_DOWNLOAD_URL,
  LANGUAGETOOL_TOOL_ID,
  normalizeDevSetupStacks,
  SECURITY_TOOL_CATEGORY,
  type SupportedOS,
  type ToolSettingsAction,
  type ToolSettingsValues,
} from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Bolt,
  CircleCheck,
  CloudDownload,
  Code,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Globe,
  Package,
  Play,
  RefreshCw,
  Server,
  Shield,
  SpellCheck,
  StopCircle,
  TerminalSquare,
  Trash2,
  Wand2,
  Workspace,
  Wrench,
} from '@/components/icons';
import {
  Chip,
  type ChipTone,
  GLASS_CARD,
  NoMatches,
  SECTION_HEADING,
  SearchPill,
  TOOLBAR,
  UpdateSummary,
} from '@/components/pageKit';
import { CodeqlInstallCard } from '@/components/tools/CodeqlInstallCard';
import { DEV_SETUP_TAB, DevSetupPanel } from '@/components/tools/devSetup';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { openCommandTerminal } from '@/lib/openCommandTerminal';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { useTerminalStore } from '@/stores/terminalStore';

type DockerAction = 'run' | 'start' | 'stop' | 'reset' | 'remove';

interface PendingToolUpdate {
  tool: AgentToolDefinition;
  currentVersion: string | null;
  latestVersion: string;
  command: string;
}

/**
 * Names the install button after whatever actually runs, rather than assuming npm. Every tool
 * with a Docker option used to be npm-installed, so the button was hardcoded to "Install (npm)",
 * which became a lie the moment a pip or winget tool gained a Docker option.
 */
function installLabel(command: string | undefined): string {
  if (!command) return 'Install';
  const known: Record<string, string> = {
    npm: 'npm',
    pnpm: 'pnpm',
    pip: 'pip',
    pip3: 'pip',
    pipx: 'pipx',
    brew: 'brew',
    winget: 'winget',
    choco: 'choco',
    scoop: 'scoop',
    go: 'go',
    cargo: 'cargo',
    curl: 'script',
    wget: 'script',
    irm: 'script',
    iwr: 'script',
    powershell: 'script',
    sudo: 'apt',
  };
  // Semgrep's Windows line sets an environment variable before `pipx install`, so the first
  // statement that names a known installer decides the label.
  const manager = command
    .split(/;|&&/)
    .map((statement) => known[statement.trim().split(/\s+/)[0].toLowerCase()])
    .find(Boolean);
  return manager ? `Install (${manager})` : 'Install';
}

/**
 * Category names read well on a card chip but are too long for the nav, so the nav shows the
 * distinctive half. "Security & Code Scanning" becomes "Security", "Token & Cost Optimization"
 * becomes "Token & Cost".
 */
function shortCategoryLabel(category: string): string {
  const first = category.split(' & ')[0];
  return first === 'Token' ? 'Token & Cost' : first;
}

/** One icon per category for the side nav. A category added later falls back to a box. */
const CATEGORY_ICONS: Record<string, typeof Wrench> = {
  [SECURITY_TOOL_CATEGORY]: Shield,
  'Token & Cost Optimization': Bolt,
  'Agent Behavior & Prompting': Wand2,
  'Code Intelligence': Code,
  'Agent Runtimes & Gateways': Server,
  'Writing & Docs': SpellCheck,
};

/**
 * The small count at the end of the Dev Setup nav entry. A number says how many required tools
 * are still missing, a tick says none are, and nothing is shown while that is not yet known, so
 * the nav never claims a count it has not checked.
 */
function DevSetupBadge({
  missing,
  active,
}: {
  missing: number | null;
  active: boolean;
}): React.JSX.Element | null {
  if (missing === null) return null;
  if (missing === 0) {
    return (
      <span className="relative flex h-4 w-4 items-center justify-center text-success">
        <CircleCheck aria-hidden className="h-3.5 w-3.5" />
        <span className="sr-only">All set</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        'relative rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums',
        active ? 'bg-warning/20 text-warning' : 'bg-warning/15 text-warning',
      )}
    >
      {missing}
      <span className="sr-only"> to install</span>
    </span>
  );
}

/** One entry in the side nav: its icon, label and a trailing count or badge. */
function CategoryNavButton({
  active,
  onSelect,
  icon: Icon,
  label,
  trailing,
  pillTransition,
}: {
  active: boolean;
  onSelect: () => void;
  icon: typeof Wrench;
  label: string;
  trailing?: React.ReactNode;
  pillTransition: Parameters<typeof motion.span>[0]['transition'];
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'relative flex h-8 w-full cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
        active
          ? 'font-semibold text-primary'
          : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="tool-category-active"
          transition={pillTransition}
          className="absolute inset-0 rounded-lg bg-primary/12"
        >
          <span className="absolute left-0 top-1/2 hidden h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)] @3xl/tools:block" />
        </motion.span>
      )}
      <Icon className="relative h-3.5 w-3.5 shrink-0" />
      <span className="relative flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}

/** Does a tool match the filter box, by its name, what it does, who makes it or a tag? */
function matchesFilter(tool: AgentToolDefinition, needle: string): boolean {
  return [tool.name, tool.description, tool.author, ...tool.tags].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

const DOCKER_TONES: Record<string, ChipTone> = {
  running: 'success',
  stopped: 'warning',
};

export default function ToolsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openSession = useTerminalStore((s) => s.openSession);

  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [settingsTool, setSettingsTool] = useState<AgentToolDefinition | null>(null);
  const [settingsValues, setSettingsValues] = useState<ToolSettingsValues>({});
  const [checkingToolId, setCheckingToolId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<PendingToolUpdate | null>(null);
  const [, setUpdateQueue] = useState<PendingToolUpdate[]>([]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const statusQuery = useQuery({
    queryKey: queryKeys.toolsStatus,
    queryFn: () => window.runova.tools.detectAll(),
  });
  // CodeQL can live in Runova's tools folder rather than on PATH, which the shared
  // detectAll probe cannot see, so its card asks separately.
  const codeqlQuery = useQuery({
    queryKey: queryKeys.codeqlStatus,
    queryFn: () => window.runova.security.codeqlStatus(),
    meta: { silentLoading: true },
  });
  // LanguageTool isn't on PATH: it lives in the app's tools folder, so its card
  // reads the grammar status instead of the PATH probe every other tool uses.
  const languageToolQuery = useQuery({
    queryKey: queryKeys.grammarLocalStatus,
    queryFn: () => window.runova.grammar.localStatus(),
  });

  // The Dev Setup nav entry shows how many required tools are missing. It reads what main already
  // remembers and only probes the items nobody has checked yet, so reopening this page is instant.
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
  const devSetupStacks = normalizeDevSetupStacks(settingsQuery.data?.devSetupStacks);
  const devSetupOs: DevOs =
    window.runova.platform === 'win32' || window.runova.platform === 'darwin'
      ? window.runova.platform
      : 'linux';
  const devSetupIds = itemsForStacks(devSetupStacks, devSetupOs).map((item) => item.id);
  const devSetupPeekQuery = useQuery({
    queryKey: [...queryKeys.devSetupPeek, devSetupIds.join(',')],
    queryFn: async () => {
      const remembered = (await window.runova.devSetup.peek(devSetupIds)) ?? {};
      const unchecked = devSetupIds.filter((id) => !remembered[id]);
      if (unchecked.length === 0) return remembered;
      await Promise.all(unchecked.map((id) => window.runova.devSetup.detect(id)));
      return (await window.runova.devSetup.peek(devSetupIds)) ?? {};
    },
    meta: { silentLoading: true },
    staleTime: 5_000,
  });
  let devSetupMissing: number | null = null;
  if (devSetupPeekQuery.data) {
    const { summary } = buildChecklist({
      stacks: devSetupStacks,
      // Only the counts are read, so which package managers exist does not matter here.
      environment: { os: devSetupOs, arch: 'x64', packageManagers: [] },
      detections: devSetupPeekQuery.data,
    });
    // A partial answer would show a number that is too low, so wait for the whole list.
    devSetupMissing = summary.checking > 0 ? null : summary.missing;
  }

  const selectedProject = projectsQuery.data?.find((p) => p.id === selectedProjectId);

  function statusFor(toolId: string) {
    return statusQuery.data?.find((s) => s.id === toolId);
  }

  async function openToolsFolder(): Promise<void> {
    const dir = await window.runova.grammar.openToolsFolder();
    toast.info(`Extract LanguageTool-stable.zip into ${dir}`);
  }

  async function toggleLanguageToolServer(action: 'start' | 'stop'): Promise<void> {
    if (action === 'start') toast.info('Starting LanguageTool. The first start loads its rules.');
    const next =
      action === 'start'
        ? await window.runova.grammar.startLocal()
        : await window.runova.grammar.stopLocal();
    queryClient.setQueryData(queryKeys.grammarLocalStatus, next);
    if (action === 'start') {
      if (next.serverState === 'running') toast.success('LanguageTool is running.');
      else toast.error(next.error ?? 'LanguageTool did not start.');
    }
  }

  async function runAction(
    action: ToolSettingsAction,
    tool: AgentToolDefinition,
    title: string,
  ): Promise<void> {
    if (action.kind === 'command') {
      if (action.cwd === 'project' && !selectedProject) {
        toast.error('Choose a target project first.');
        return;
      }
      openSession({
        title,
        initialInput: action.command,
        cwd: action.cwd === 'project' ? selectedProject!.folderPath : undefined,
      });
      toast.info(`Press Enter in the terminal to run this for ${tool.name}.`);
      return;
    }
    if (action.kind === 'write-project-file') {
      if (!selectedProject) {
        toast.error('Choose a target project first.');
        return;
      }
      await window.runova.fs.writeFile(
        `${selectedProject.folderPath}/${action.relativePath}`,
        action.content,
      );
      toast.success(`${action.relativePath} written to ${selectedProject.name}.`);
      return;
    }
    await navigator.clipboard.writeText(action.content);
    toast.success('Copied to clipboard. ' + action.instructions);
  }

  async function handleInstall(tool: AgentToolDefinition): Promise<void> {
    const command = await window.runova.tools.getInstallCommand(tool.id);
    if (!command) {
      toast.error(`No install command available for ${tool.name} on this OS.`);
      return;
    }
    await openCommandTerminal({ command, name: tool.name, verb: 'install' });
  }

  async function buildPendingUpdate(
    tool: AgentToolDefinition,
    currentVersion: string | null,
  ): Promise<PendingToolUpdate | 'uncheckable' | 'up-to-date' | null> {
    const result = await window.runova.tools.checkForUpdate(tool.id, currentVersion);
    if (!result.supported || !result.latestVersion) return 'uncheckable';
    if (!result.updateAvailable) return 'up-to-date';
    const command = await window.runova.tools.getUpdateCommand(tool.id);
    if (!command) return null;
    return { tool, currentVersion, latestVersion: result.latestVersion, command };
  }

  async function handleCheckForUpdate(
    tool: AgentToolDefinition,
    currentVersion: string | null,
  ): Promise<void> {
    setCheckingToolId(tool.id);
    try {
      const pending = await buildPendingUpdate(tool, currentVersion);
      if (pending === 'uncheckable') {
        toast.info(`Can't check updates for ${tool.name} automatically.`);
        return;
      }
      if (pending === 'up-to-date') {
        toast.success(`${tool.name} is up to date.`);
        return;
      }
      if (!pending) {
        toast.error(`No update command available for ${tool.name} on this OS.`);
        return;
      }
      setPendingUpdate(pending);
    } finally {
      setCheckingToolId(null);
    }
  }

  function dismissPendingUpdate(): void {
    setUpdateQueue((queue) => {
      const [next, ...rest] = queue;
      setPendingUpdate(next ?? null);
      return rest;
    });
  }

  async function handleConfirmUpdate(): Promise<void> {
    if (!pendingUpdate) return;
    const { tool, command } = pendingUpdate;
    dismissPendingUpdate();
    await openCommandTerminal({ command, name: tool.name, verb: 'update' });
  }

  async function handleCheckAllForUpdates(): Promise<void> {
    const installedTools = AGENT_TOOL_REGISTRY.filter(
      (tool) => tool.updateCheck && statusFor(tool.id)?.installed,
    );
    if (installedTools.length === 0) {
      toast.info('No installed tools to check.');
      return;
    }

    setCheckingAll(true);
    try {
      const updates: PendingToolUpdate[] = [];
      let uncheckable = 0;
      for (const tool of installedTools) {
        const pending = await buildPendingUpdate(tool, statusFor(tool.id)?.version ?? null);
        if (pending === 'uncheckable' || pending === null) {
          uncheckable += 1;
          continue;
        }
        if (pending !== 'up-to-date') updates.push(pending);
      }

      if (updates.length === 0) {
        toast.success(
          uncheckable > 0
            ? `All checkable tools are up to date (${uncheckable} could not be checked).`
            : 'All tools are up to date.',
        );
        return;
      }

      toast.info(`${updates.length} tool update${updates.length > 1 ? 's' : ''} available.`);
      const [first, ...rest] = updates;
      setPendingUpdate(first);
      setUpdateQueue(rest);
    } finally {
      setCheckingAll(false);
    }
  }

  async function handleUninstall(tool: AgentToolDefinition): Promise<void> {
    const command = await window.runova.tools.getUninstallCommand(tool.id);
    if (!command) {
      toast.error(`No uninstall command available for ${tool.name} on this OS.`);
      return;
    }
    await openCommandTerminal({ command, name: tool.name, verb: 'uninstall' });
  }

  function handleCopyManualInstructions(tool: AgentToolDefinition): void {
    void navigator.clipboard.writeText(tool.manualInstallInstructions ?? '');
    toast.success(`Setup commands copied. Run them inside ${tool.name}'s target agent.`);
  }

  async function handleInteractiveInstall(tool: AgentToolDefinition): Promise<void> {
    if (!tool.interactiveInstall) return;
    const launchCommand = await window.runova.tools.getInteractiveLaunchCommand(tool.id);
    if (!launchCommand) {
      toast.error(`No launch command available for ${tool.name} on this OS.`);
      return;
    }
    // Open the terminal first; if the clipboard write below fails (e.g. no OS focus yet),
    // the user still gets a working terminal instead of the click silently doing nothing.
    openSession({ title: `Install ${tool.name}`, initialInput: launchCommand });
    // xterm.js reserves plain Ctrl+V for the shell's own control-character convention (^V) and
    // doesn't paste with it. Its actual paste shortcut is Ctrl+Shift+V (Cmd+V on macOS, which
    // isn't used for anything else there so it works as a normal paste).
    const pasteShortcut = window.runova.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V';
    try {
      await navigator.clipboard.writeText(tool.interactiveInstall.pasteCommands);
      toast.info(
        `Press Enter to launch ${launchCommand}, then paste (${pasteShortcut}, not Ctrl+V) and press Enter again to install ${tool.name}.`,
      );
    } catch {
      toast.info(
        `Press Enter to launch ${launchCommand}, then type: ${tool.interactiveInstall.pasteCommands.replace('\n', ', then ')}`,
      );
    }
  }

  function handleCopyManualUninstall(tool: AgentToolDefinition): void {
    void navigator.clipboard.writeText(tool.manualUninstallInstructions ?? '');
    toast.success(`Uninstall commands copied. Run them inside ${tool.name}'s target agent.`);
  }

  async function handleDockerAction(
    tool: AgentToolDefinition,
    action: DockerAction,
  ): Promise<void> {
    const command = await window.runova.tools.getDockerCommand(tool.id, action);
    if (!command) {
      toast.error('Docker command unavailable for this tool.');
      return;
    }
    const verb = action === 'run' ? 'install' : action === 'remove' ? 'delete' : action;
    openSession({ title: `${action} ${tool.name} container`, initialInput: command });
    toast.info(`Press Enter in the terminal to ${verb} the container.`);
  }

  function openSettings(tool: AgentToolDefinition): void {
    const defaults: ToolSettingsValues = {};
    for (const field of tool.settingsFields ?? []) defaults[field.key] = field.defaultValue;
    setSettingsValues(defaults);
    setSettingsTool(tool);
  }

  const preview = useMemo(() => {
    if (!settingsTool?.buildSettingsAction) return null;
    return settingsTool.buildSettingsAction(settingsValues);
  }, [settingsTool, settingsValues]);

  const requiresProject =
    preview?.kind === 'write-project-file' ||
    (preview?.kind === 'command' && preview.cwd === 'project');

  async function handleApplySettings(): Promise<void> {
    if (!settingsTool || !preview) return;
    await runAction(preview, settingsTool, `Configure ${settingsTool.name}`);
    setSettingsTool(null);
  }

  // Derived from the registry rather than hardcoded, so adding a tool with a new category adds
  // its tab automatically. Security leads because it is the one people come here looking for.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of AGENT_TOOL_REGISTRY) {
      counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
    }
    const rest = [...counts.keys()]
      .filter((c) => c !== SECURITY_TOOL_CATEGORY)
      .sort((a, b) => a.localeCompare(b));
    const ordered = counts.has(SECURITY_TOOL_CATEGORY) ? [SECURITY_TOOL_CATEGORY, ...rest] : rest;
    return ordered.map((category) => ({ category, count: counts.get(category) ?? 0 }));
  }, []);

  const tabParam = searchParams.get('tab');
  const activeCategory =
    tabParam === DEV_SETUP_TAB
      ? DEV_SETUP_TAB
      : tabParam === 'security'
        ? SECURITY_TOOL_CATEGORY
        : categories.some((c) => c.category === tabParam)
          ? (tabParam as string)
          : 'all';
  const onDevSetup = activeCategory === DEV_SETUP_TAB;

  function setActiveCategory(next: string): void {
    setSearchParams(
      (params) => {
        const updated = new URLSearchParams(params);
        if (next === 'all') updated.delete('tab');
        else updated.set('tab', next === SECURITY_TOOL_CATEGORY ? 'security' : next);
        return updated;
      },
      { replace: true },
    );
  }

  const navEntries = useMemo(
    () => [
      { value: 'all', label: 'All', icon: Wrench, count: AGENT_TOOL_REGISTRY.length },
      ...categories.map(({ category, count }) => ({
        value: category,
        label: shortCategoryLabel(category),
        icon: CATEGORY_ICONS[category] ?? Package,
        count,
      })),
    ],
    [categories],
  );

  // The filter works inside the open category, and the nav keeps counting the whole registry so
  // its numbers don't jump around while typing.
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visibleTools = useMemo(() => {
    const inCategory =
      activeCategory === 'all'
        ? AGENT_TOOL_REGISTRY
        : AGENT_TOOL_REGISTRY.filter((tool) => tool.category === activeCategory);
    return needle ? inCategory.filter((tool) => matchesFilter(tool, needle)) : inCategory;
  }, [activeCategory, needle]);

  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  usePageHeader(
    'Agent Tools',
    onDevSetup
      ? 'See what this computer has for development, and install what is missing.'
      : 'Curated third-party tools that cut agent token spend or improve code quality. Install, configure, and run them from here.',
  );

  return (
    // A container, so the category nav moves from the side to the top when the island is narrow.
    <div className="@container/tools">
      <div className="flex flex-col gap-2 p-2 @3xl/tools:flex-row @3xl/tools:items-start">
        <aside
          aria-label="Tool filters"
          className={cn(
            GLASS_CARD,
            'flex shrink-0 flex-col gap-2 p-2 @3xl/tools:sticky @3xl/tools:top-2 @3xl/tools:w-56',
          )}
        >
          {/* The filter and the target project only act on tool cards, which Dev Setup has none of. */}
          {!onDevSetup && (
            <SearchPill
              type="search"
              value={query}
              onValueChange={setQuery}
              clearLabel="Clear filter"
              label="Filter tools"
              placeholder="Filter tools"
            />
          )}

          <nav aria-label="Tool categories" className="flex flex-col gap-1">
            <LayoutGroup id="tool-categories">
              {/* Setup is a different kind of thing from the tool categories, so it has a group. */}
              <h2 className={cn(SECTION_HEADING, 'hidden px-2.5 pt-1.5 @3xl/tools:block')}>
                Setup
              </h2>
              <ul className="flex flex-wrap gap-0.5 @3xl/tools:flex-col @3xl/tools:flex-nowrap @3xl/tools:gap-px">
                <li className="shrink-0">
                  <CategoryNavButton
                    active={onDevSetup}
                    onSelect={() => setActiveCategory(DEV_SETUP_TAB)}
                    icon={Workspace}
                    label="Dev Setup"
                    pillTransition={pillTransition}
                    trailing={<DevSetupBadge missing={devSetupMissing} active={onDevSetup} />}
                  />
                </li>
              </ul>

              <h2 className={cn(SECTION_HEADING, 'hidden px-2.5 pt-2.5 @3xl/tools:block')}>
                Categories
              </h2>
              <ul className="flex flex-wrap gap-0.5 @3xl/tools:flex-col @3xl/tools:flex-nowrap @3xl/tools:gap-px">
                {navEntries.map((entry) => {
                  const active = entry.value === activeCategory;
                  return (
                    <li key={entry.value} className="shrink-0">
                      <CategoryNavButton
                        active={active}
                        onSelect={() => setActiveCategory(entry.value)}
                        icon={entry.icon}
                        label={entry.label}
                        pillTransition={pillTransition}
                        trailing={
                          <span
                            className={cn(
                              'relative rounded-full px-1.5 text-[10px] font-medium leading-4 tabular-nums',
                              active
                                ? 'bg-primary/15 text-primary'
                                : 'bg-foreground/[0.06] text-muted-foreground',
                            )}
                          >
                            {entry.count}
                          </span>
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </LayoutGroup>
          </nav>

          {/* The project the "in a project" actions write to, under a hairline of its own. */}
          {!onDevSetup && (
            <div className="space-y-1.5 px-0.5 pb-0.5 pt-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
              <h2 className={cn(SECTION_HEADING, 'px-2')}>Target project</h2>
              <Combobox
                ariaLabel="Target project"
                className="w-full"
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                placeholder="Choose a project"
                searchPlaceholder="Search projects…"
                options={projectsQuery.data?.map((p) => ({ value: p.id, label: p.name })) ?? []}
                clearable
              />
              <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
                Initializing a tool in a project or writing its config needs one. Docker and global
                setup actions don't.
              </p>
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {onDevSetup ? (
            <DevSetupPanel />
          ) : (
            <>
              <div className={TOOLBAR}>
                <div className="flex min-w-0 items-center gap-2 pl-2">
                  <h2 className="truncate text-sm font-semibold">
                    {activeCategory === 'all' ? 'All tools' : activeCategory}
                  </h2>
                  <Chip>{visibleTools.length}</Chip>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="soft"
                    disabled={checkingAll}
                    onClick={() => void handleCheckAllForUpdates()}
                  >
                    <CloudDownload className={checkingAll ? 'animate-pulse' : undefined} />
                    {checkingAll ? 'Checking updates…' : 'Check all for updates'}
                  </Button>
                  <Button
                    variant="soft"
                    onClick={() => {
                      void queryClient.invalidateQueries({ queryKey: queryKeys.toolsStatus });
                      toast.info('Re-checking installed tools…');
                    }}
                  >
                    <RefreshCw /> Refresh
                  </Button>
                </div>
              </div>

              {visibleTools.length === 0 ? (
                <div className={GLASS_CARD}>
                  <NoMatches query={query} />
                </div>
              ) : (
                // Columns follow the width this area actually has, not the window's, since the
                // category nav takes a share of it on a wide island.
                <div className="@container/toolgrid">
                  <div className="grid grid-cols-1 gap-2 @2xl/toolgrid:grid-cols-2 @5xl/toolgrid:grid-cols-3">
                    {visibleTools.map((tool) => {
                      const isLanguageTool = tool.id === LANGUAGETOOL_TOOL_ID;
                      const isCodeql = tool.id === CODEQL_TOOL_ID;
                      // A shell tool with no command for this OS must not offer an Install button
                      // that can only fail; it falls back to its written instructions instead.
                      const osInstallCommand =
                        tool.installCommand?.[window.runova.platform as SupportedOS];
                      const canShellInstall =
                        tool.installKind === 'shell' && Boolean(osInstallCommand);
                      const languageTool = isLanguageTool ? languageToolQuery.data : undefined;
                      const codeql = isCodeql ? codeqlQuery.data : undefined;
                      const status = isLanguageTool
                        ? {
                            id: tool.id,
                            installed: Boolean(languageTool?.installPath),
                            version: languageTool?.version ? `v${languageTool.version}` : null,
                            dockerStatus: 'unavailable' as const,
                            lastCheckedAt: '',
                          }
                        : isCodeql
                          ? {
                              id: tool.id,
                              installed: Boolean(codeql?.installed),
                              version: codeql?.version ?? null,
                              dockerStatus: 'unavailable' as const,
                              lastCheckedAt: '',
                            }
                          : statusFor(tool.id);
                      return (
                        <div key={tool.id} className={cn(GLASS_CARD, 'flex flex-col')}>
                          <div className="space-y-2 p-4 pb-3">
                            <div className="flex items-start gap-2">
                              <h3 className="min-w-0 flex-1 text-sm font-semibold leading-5">
                                {tool.name}
                              </h3>
                              {/* Inside one category every card would repeat it. */}
                              {activeCategory === 'all' && (
                                <Chip className="mt-px">{shortCategoryLabel(tool.category)}</Chip>
                              )}
                            </div>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {tool.description}
                            </p>
                            <div className="flex flex-wrap gap-1">
                              {/* "Not detected" is a result, not a starting state, so shimmer
                              the chip until the scan actually says so. */}
                              {(
                                isLanguageTool
                                  ? languageToolQuery.isPending
                                  : isCodeql
                                    ? codeqlQuery.isPending
                                    : statusQuery.isPending
                              ) ? (
                                <Skeleton className="h-5 w-24 rounded-full" />
                              ) : (
                                <Chip tone={status?.installed ? 'success' : 'neutral'}>
                                  {status?.installed
                                    ? (status.version ?? 'Installed')
                                    : isLanguageTool
                                      ? 'Not in tools folder'
                                      : isCodeql
                                        ? 'Not downloaded'
                                        : 'Not detected'}
                                </Chip>
                              )}
                              {isLanguageTool && languageTool?.serverState === 'running' ? (
                                <Chip tone="success">Server running</Chip>
                              ) : null}
                              {tool.docker && statusQuery.isPending && (
                                <Skeleton className="h-5 w-28 rounded-full" />
                              )}
                              {tool.docker && !statusQuery.isPending && (
                                <Chip tone={DOCKER_TONES[status?.dockerStatus ?? ''] ?? 'neutral'}>
                                  Docker: {status?.dockerStatus ?? 'unknown'}
                                </Chip>
                              )}
                              {tool.tags.map((tag) => (
                                <Chip
                                  key={tag}
                                  className="bg-transparent ring-1 ring-inset ring-foreground/10"
                                >
                                  {tag}
                                </Chip>
                              ))}
                            </div>
                          </div>

                          <div className="mt-auto flex flex-wrap items-center gap-1.5 px-4 pb-3">
                            {isCodeql ? (
                              <CodeqlInstallCard />
                            ) : isLanguageTool ? (
                              <>
                                <Button
                                  size="sm"
                                  variant={status?.installed ? 'soft' : 'default'}
                                  onClick={() =>
                                    void window.runova.shell.openExternal(LANGUAGETOOL_DOWNLOAD_URL)
                                  }
                                >
                                  <Download /> Download zip
                                </Button>
                                <SimpleTooltip label="Extract the zip here, then start the server">
                                  <Button
                                    variant="soft"
                                    size="sm"
                                    onClick={() => void openToolsFolder()}
                                  >
                                    <FolderOpen /> Open tools folder
                                  </Button>
                                </SimpleTooltip>
                                {languageTool?.serverState === 'running' ? (
                                  <Button
                                    variant="soft"
                                    size="sm"
                                    onClick={() => void toggleLanguageToolServer('stop')}
                                  >
                                    <StopCircle /> Stop server
                                  </Button>
                                ) : (
                                  <Button
                                    variant="soft"
                                    size="sm"
                                    disabled={!status?.installed}
                                    onClick={() => void toggleLanguageToolServer('start')}
                                  >
                                    <Play /> Start server
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-muted-foreground hover:text-foreground"
                                  onClick={() => navigate('/settings?tab=ai')}
                                >
                                  <Wrench /> Writing settings
                                </Button>
                              </>
                            ) : canShellInstall ? (
                              status?.installed ? (
                                <Button
                                  variant="soft"
                                  size="sm"
                                  onClick={() => void handleUninstall(tool)}
                                >
                                  <Trash2 /> Uninstall
                                </Button>
                              ) : (
                                <Button size="sm" onClick={() => void handleInstall(tool)}>
                                  <TerminalSquare /> {installLabel(osInstallCommand)}
                                </Button>
                              )
                            ) : tool.installKind === 'interactive' ? (
                              <SimpleTooltip
                                label={`Opens a terminal running ${tool.name}'s target agent and copies the setup commands to paste in`}
                              >
                                <Button
                                  size="sm"
                                  onClick={() => void handleInteractiveInstall(tool)}
                                >
                                  <TerminalSquare /> Install
                                </Button>
                              </SimpleTooltip>
                            ) : (
                              <SimpleTooltip
                                label={
                                  tool.installKind === 'shell'
                                    ? `${tool.name} has no install command for this operating system. Copies its setup notes instead.`
                                    : ''
                                }
                              >
                                <Button
                                  variant="soft"
                                  size="sm"
                                  onClick={() => handleCopyManualInstructions(tool)}
                                >
                                  <TerminalSquare />
                                  {tool.installKind === 'shell'
                                    ? 'Setup instructions'
                                    : 'Copy setup commands'}
                                </Button>
                              </SimpleTooltip>
                            )}

                            {tool.quickActions?.map((qa) => (
                              <Button
                                variant="soft"
                                size="sm"
                                key={qa.id}
                                onClick={() => void runAction(qa.action, tool, qa.label)}
                              >
                                {qa.label}
                              </Button>
                            ))}

                            {tool.docker &&
                              (status?.dockerStatus === 'unavailable' ? (
                                <SimpleTooltip label="Docker isn't installed on this machine">
                                  <Button variant="soft" size="sm" disabled>
                                    Install with Docker
                                  </Button>
                                </SimpleTooltip>
                              ) : status?.dockerStatus === 'not-created' ? (
                                <Button
                                  variant="soft"
                                  size="sm"
                                  onClick={() => void handleDockerAction(tool, 'run')}
                                >
                                  <Play /> Install with Docker
                                </Button>
                              ) : (
                                // The container's own controls share one pill, so they read as a
                                // group apart from the tool's install actions.
                                <div className="search-pill inline-flex h-7 items-center gap-px rounded-full px-0.5">
                                  <SimpleTooltip label="Start container">
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      disabled={status?.dockerStatus === 'running'}
                                      onClick={() => void handleDockerAction(tool, 'start')}
                                    >
                                      <Play />
                                    </Button>
                                  </SimpleTooltip>
                                  <SimpleTooltip label="Stop container">
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      disabled={status?.dockerStatus === 'stopped'}
                                      onClick={() => void handleDockerAction(tool, 'stop')}
                                    >
                                      <StopCircle />
                                    </Button>
                                  </SimpleTooltip>
                                  <SimpleTooltip label="Reset container (recreate from image)">
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => void handleDockerAction(tool, 'reset')}
                                    >
                                      <RefreshCw />
                                    </Button>
                                  </SimpleTooltip>
                                  <SimpleTooltip label="Delete container">
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => void handleDockerAction(tool, 'remove')}
                                    >
                                      <Trash2 />
                                    </Button>
                                  </SimpleTooltip>
                                  {tool.docker.dashboardUrl &&
                                    status?.dockerStatus === 'running' && (
                                      <SimpleTooltip label="Open dashboard">
                                        <Button
                                          variant="ghost"
                                          size="icon-xs"
                                          onClick={() =>
                                            void window.runova.shell.openExternal(
                                              tool.docker!.dashboardUrl!,
                                            )
                                          }
                                        >
                                          <Globe />
                                        </Button>
                                      </SimpleTooltip>
                                    )}
                                </div>
                              ))}
                          </div>

                          {/* Who makes it, and the small actions every card has, under a hairline. */}
                          <div className="flex min-h-10 items-center gap-0.5 py-1.5 pl-4 pr-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
                            <span className="mr-auto min-w-0 truncate text-[11px] text-muted-foreground">
                              {tool.author}
                            </span>
                            {tool.updateCheck && status?.installed && (
                              <SimpleTooltip
                                label="Check for updates"
                                wrapTrigger={checkingToolId === tool.id}
                              >
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={checkingToolId === tool.id}
                                  onClick={() => void handleCheckForUpdate(tool, status.version)}
                                >
                                  <CloudDownload
                                    className={
                                      checkingToolId === tool.id ? 'animate-pulse' : undefined
                                    }
                                  />
                                </Button>
                              </SimpleTooltip>
                            )}
                            {tool.manualUninstallInstructions && (
                              <SimpleTooltip label="Copy uninstall commands">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => handleCopyManualUninstall(tool)}
                                >
                                  <Trash2 />
                                </Button>
                              </SimpleTooltip>
                            )}
                            {tool.settingsFields && tool.settingsFields.length > 0 && (
                              <SimpleTooltip label="Configure">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => openSettings(tool)}
                                >
                                  <Wrench />
                                </Button>
                              </SimpleTooltip>
                            )}
                            {tool.websiteUrl && (
                              <SimpleTooltip label="Website">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() =>
                                    void window.runova.shell.openExternal(tool.websiteUrl!)
                                  }
                                >
                                  <ExternalLink />
                                </Button>
                              </SimpleTooltip>
                            )}
                            <SimpleTooltip label="GitHub">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() =>
                                  void window.runova.shell.openExternal(tool.repositoryUrl)
                                }
                              >
                                <GitBranch />
                              </Button>
                            </SimpleTooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Dialog
        open={pendingUpdate !== null}
        onOpenChange={(open) => !open && dismissPendingUpdate()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update {pendingUpdate?.tool.name}?</DialogTitle>
            <DialogDescription>
              This opens a terminal session and runs the update command below.
            </DialogDescription>
          </DialogHeader>
          <UpdateSummary
            currentVersion={pendingUpdate?.currentVersion ?? null}
            latestVersion={pendingUpdate?.latestVersion ?? ''}
            command={pendingUpdate?.command ?? ''}
          />
          <DialogFooter>
            <Button variant="soft" onClick={dismissPendingUpdate}>
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmUpdate()}>Update</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!settingsTool} onOpenChange={(open) => !open && setSettingsTool(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure {settingsTool?.name}</DialogTitle>
            <DialogDescription>
              {settingsTool?.settingsScope === 'global'
                ? 'This applies machine-wide, not to a specific project.'
                : 'This applies to the chosen target project.'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-y-auto">
            {settingsTool?.settingsFields?.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label>{field.label}</Label>
                {field.type === 'select' && (
                  <Combobox
                    value={String(settingsValues[field.key] ?? '')}
                    onChange={(v) => setSettingsValues((prev) => ({ ...prev, [field.key]: v }))}
                    options={field.options ?? []}
                  />
                )}
                {field.type === 'text' && (
                  <Input
                    value={String(settingsValues[field.key] ?? '')}
                    onChange={(e) =>
                      setSettingsValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                  />
                )}
                {field.type === 'boolean' && (
                  <Switch
                    checked={!!settingsValues[field.key]}
                    onCheckedChange={(checked) =>
                      setSettingsValues((prev) => ({ ...prev, [field.key]: checked }))
                    }
                  />
                )}
                {field.description && (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                )}
              </div>
            ))}

            {preview && (
              <div className="space-y-1.5">
                <Label>
                  {preview.kind === 'command' && 'Command to run'}
                  {preview.kind === 'write-project-file' && `File: ${preview.relativePath}`}
                  {preview.kind === 'copy-text' && preview.instructions}
                </Label>
                <code className="block overflow-x-auto whitespace-pre rounded-lg bg-foreground/[0.05] px-3 py-2 font-mono text-xs">
                  {preview.kind === 'command' ? preview.command : preview.content}
                </code>
                {requiresProject && !selectedProject && (
                  <p className="text-xs text-warning">Choose a target project before applying.</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={!preview || (requiresProject && !selectedProject)}
              onClick={() => void handleApplySettings()}
            >
              {preview?.kind === 'command' && 'Run in terminal'}
              {preview?.kind === 'write-project-file' && 'Write to project'}
              {preview?.kind === 'copy-text' && 'Copy to clipboard'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
