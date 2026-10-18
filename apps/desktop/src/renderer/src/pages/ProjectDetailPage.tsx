import type {
  CliDefinition,
  DetectedClaudeHook,
  NotificationHookKind,
  Project,
  ProjectGithubAction,
  ProjectNotificationHook,
  ProjectNotificationSettings,
} from '@agentmat/core';
import {
  CLI_REGISTRY,
  configuredRunCommands,
  DIFFRAY_TOOL_ID,
  notificationHookChannel,
  runCommandSummary,
} from '@agentmat/core';
import type {
  ApplyVersionResult,
  BootstrapResult,
  GitBranchInfo,
  GitStatus,
  GitTagInfo,
  SkillUpdateInfo,
} from '@shared/apiTypes';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CliLogo, cliOptionIcon } from '@/components/cliLogos';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import { MonitoringView } from '@/components/health/MonitoringView';
import { useProjectHealthBadge } from '@/components/health/useProjectHealthBadge';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Blocks,
  Check,
  CircleCheck,
  CircleQuestion,
  CloudDownload,
  CloudUpload,
  Download,
  EllipsisVertical,
  FileCog,
  FileText,
  Folder,
  FolderTree,
  GitBranch,
  GitCommit,
  GitPullRequest,
  History,
  LinkOff,
  MessageSquare,
  Paw,
  Pencil,
  Plug,
  RefreshCw,
  Run,
  Save,
  Send,
  Shield,
  Sparkles,
  Spinner,
  Tag,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  Undo,
  Wand2,
  X,
} from '@/components/icons';
import { Chip, type ChipTone } from '@/components/pageKit';
import {
  type BootstrapDescription,
  BootstrapDescriptionDialog,
} from '@/components/projects/BootstrapDescriptionDialog';
import { BlueprintTab } from '@/components/projects/blueprint/BlueprintTab';
import { CreateRunWithAiDialog } from '@/components/projects/CreateRunWithAiDialog';
import {
  DiffrayReviewLaunchCard,
  DiffrayReviewWizard,
} from '@/components/projects/DiffrayReviewWizard';
import { DockerTab } from '@/components/projects/DockerTab';
import { EnvironmentsTab } from '@/components/projects/environments/EnvironmentsTab';
import { GitActionsCard } from '@/components/projects/GitActionsCard';
import { GitBranchHistoryDialog } from '@/components/projects/GitBranchHistoryDialog';
import { GitCloneEmptyState } from '@/components/projects/GitCloneEmptyState';
import { GitSetupWizard } from '@/components/projects/GitSetupWizard';
import { PackagesTab } from '@/components/projects/PackagesTab';
import { ProjectDeploySection } from '@/components/projects/ProjectDeploySection';
import {
  AGENT_TYPE_LABELS,
  isProjectSectionId,
  PROJECT_CARD,
  ProjectDetailHeader,
  ProjectDetailSkeleton,
  ProjectNotesCard,
  type ProjectSectionId,
  ProjectSectionNav,
  SECTION_HEADING,
  SECTION_WELL,
  type SectionBadge,
  SectionCard,
  SectionEmptyState,
} from '@/components/projects/ProjectDetailChrome';
import { ProjectFileBrowser } from '@/components/projects/ProjectFileBrowser';
import { ProjectFormDialog, type ProjectFormValues } from '@/components/projects/ProjectFormDialog';
import { ProjectPromptDialog } from '@/components/projects/ProjectPromptDialog';
import { ProjectPrompts } from '@/components/projects/prompts/ProjectPrompts';
import { SecurityTab } from '@/components/projects/security/SecurityTab';
import { ProjectUsageTab } from '@/components/projects/usage/ProjectUsageTab';
import { useProjectDeployBadge } from '@/components/projects/useProjectDeployBadge';
import { useProjectRun } from '@/components/projects/useProjectRun';
import {
  fileDecision,
  VersionChangeReview,
  type VersionReviews,
} from '@/components/projects/VersionChangeReview';
import { LinkWordPressDialog } from '@/components/projects/wordpress/LinkWordPressDialog';
import { useUnlinkWordPressProject } from '@/components/projects/wordpress/useUnlinkWordPressProject';
import { WordPressProjectSection } from '@/components/projects/wordpress/WordPressProjectSection';
import { ProjectWorktreeSetupCard } from '@/components/settings/WorktreeSettings';
import { SkillAuditVerdictBadge } from '@/components/skills/SkillAuditReport';
import {
  DEFAULT_CLI_VALUE,
  deepReviewInput,
  SkillDeepReviewOptions,
} from '@/components/skills/SkillDeepReviewOptions';
import {
  SkillSecurityDialog,
  type SkillSecurityTarget,
} from '@/components/skills/SkillSecurityDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CollapsibleText } from '@/components/ui/collapsible-text';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useGitRepoWatch } from '@/hooks/useGitRepoWatch';
import { sanitizeCommitMessage, splitGitPath } from '@/lib/git';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { EMPTY_TAG_DRAFT, useVersionDialogStore } from '@/stores/versionDialogStore';

export default function ProjectDetailPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const openSession = useTerminalStore((s) => s.openSession);
  const { requestRun, runPicker } = useProjectRun();
  const [editOpen, setEditOpen] = useState(false);
  const [editFocusRun, setEditFocusRun] = useState(false);
  const [createRunAiOpen, setCreateRunAiOpen] = useState(false);
  const [linkWordPressOpen, setLinkWordPressOpen] = useState(false);
  const { unlink: unlinkWordPress } = useUnlinkWordPressProject();
  const [promptOpen, setPromptOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const tabParam = searchParams.get('tab');
  const section: ProjectSectionId = isProjectSectionId(tabParam) ? tabParam : 'overview';

  // Schedule used to be its own section. It now lives under Prompts, so old links land there.
  useEffect(() => {
    if (tabParam !== 'schedule') return;
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('tab', 'prompts');
        params.set('view', 'scheduled');
        return params;
      },
      { replace: true },
    );
  }, [tabParam, setSearchParams]);

  function setSection(next: ProjectSectionId): void {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'overview') params.delete('tab');
        else params.set('tab', next);
        // The Prompts sub-tab only means something inside Prompts.
        if (next !== 'prompts') params.delete('view');
        return params;
      },
      { replace: true },
    );
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching sections should bring the workspace back into view
  useEffect(() => {
    workspaceRef.current?.scrollIntoView({ block: 'nearest' });
  }, [section]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });

  // `?edit=run` (from the Workspace Run button's menu) opens Edit project on the run commands.
  const editParam = searchParams.get('edit');
  useEffect(() => {
    if (editParam !== 'run') return;
    setEditFocusRun(true);
    setEditOpen(true);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('edit');
        return params;
      },
      { replace: true },
    );
  }, [editParam, setSearchParams]);

  // `?createRun=ai` (from Run on a project with no run command) opens the AI helper for one.
  const createRunParam = searchParams.get('createRun');
  useEffect(() => {
    if (createRunParam !== 'ai') return;
    setCreateRunAiOpen(true);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('createRun');
        return params;
      },
      { replace: true },
    );
  }, [createRunParam, setSearchParams]);
  const project = projectsQuery.data?.find((p) => p.id === projectId);

  // The WordPress section only exists for a linked project; an old link to it lands on Overview.
  const strayWordPressTab = section === 'wordpress' && project !== undefined && !project.wordpress;
  useEffect(() => {
    if (!strayWordPressTab) return;
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('tab');
        return params;
      },
      { replace: true },
    );
  }, [strayWordPressTab, setSearchParams]);

  usePageHeader(project?.name ?? '', project ? AGENT_TYPE_LABELS[project.agentType] : undefined);

  const installedSkillsQuery = useQuery({
    queryKey: queryKeys.installedSkills(projectId ?? ''),
    queryFn: () => window.agentmat.skills.listInstalled(projectId!),
    enabled: !!projectId,
  });

  const skillUpdatesQuery = useQuery({
    queryKey: queryKeys.skillUpdates(projectId ?? ''),
    queryFn: () => window.agentmat.skills.checkForUpdates(projectId!),
    enabled: !!projectId && (installedSkillsQuery.data?.length ?? 0) > 0,
  });
  const skillUpdateBySkillId = new Map((skillUpdatesQuery.data ?? []).map((u) => [u.skillId, u]));

  // Skills sitting in this project's agent dirs, including any that arrived with the repository
  // rather than through AgentMate. Those still get read by an agent, so they still get checked.
  const onDiskSkillsQuery = useQuery({
    queryKey: queryKeys.onDiskSkills(projectId ?? ''),
    queryFn: () => window.agentmat.skills.listOnDiskSkills(projectId!),
    enabled: !!projectId,
  });

  const latestAuditsQuery = useQuery({
    queryKey: queryKeys.skillAuditsLatest,
    queryFn: () => window.agentmat.skills.latestAuditPerSkill(),
  });
  const auditBySkillId = useMemo(
    () => new Map((latestAuditsQuery.data ?? []).map((audit) => [audit.skillId, audit])),
    [latestAuditsQuery.data],
  );

  // One row per skill in this project: the installed record when there is one, plus anything
  // else found on disk. Checking works the same either way.
  const projectSkillRows = useMemo(() => {
    const installed = installedSkillsQuery.data ?? [];
    const onDisk = onDiskSkillsQuery.data ?? [];
    const recordedNames = new Set(
      installed.map((skill) => skill.skillId.split('/').pop() ?? skill.skillId),
    );
    return onDisk.filter((skill) => !recordedNames.has(skill.name));
  }, [installedSkillsQuery.data, onDiskSkillsQuery.data]);

  const [securitySubject, setSecuritySubject] = useState<SkillSecurityTarget | null>(null);

  /** Every skill in this project, in the shape the "Check all" run and the dialog both take. */
  const allProjectSkillSubjects = useMemo((): SkillSecurityTarget[] => {
    const fromRecords = (installedSkillsQuery.data ?? []).map((skill) => ({
      skillId: skill.skillId,
      skillName: skill.skillId.split('/').pop() ?? skill.skillId,
      target: {
        kind: 'installed' as const,
        projectId: projectId ?? null,
        skillId: skill.skillId,
      },
    }));
    const fromDisk = projectSkillRows.map((skill) => ({
      skillId: skill.name,
      skillName: skill.name,
      target: skill.target,
    }));
    return [...fromRecords, ...fromDisk];
  }, [installedSkillsQuery.data, projectSkillRows, projectId]);

  const [skillDeepReview, setSkillDeepReview] = useState(false);
  const [skillReviewCliId, setSkillReviewCliId] = useState(DEFAULT_CLI_VALUE);
  const [skillCheckProgress, setSkillCheckProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const checkAllSkillsMutation = useMutation({
    // Progress lives on the button, so the app-wide overlay stays down (see GIT_OP_META).
    meta: { silentLoading: true },
    mutationFn: async (targets: SkillSecurityTarget[]) => {
      // Sequential on purpose: a static scan is cheap, and a burst of parallel GitHub or disk
      // reads would only make the progress harder to reason about.
      const records = [];
      setSkillCheckProgress({ done: 0, total: targets.length });
      for (const subject of targets) {
        const result = await window.agentmat.skills.runAudit({
          target: subject.target,
          ...deepReviewInput(skillDeepReview, skillReviewCliId),
        });
        if (result.ok && result.record) records.push(result.record);
        setSkillCheckProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
      return records;
    },
    onSettled: () => setSkillCheckProgress(null),
    onSuccess: (records) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAudits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAuditsLatest });
      const flagged = records.filter((record) => record.verdict !== 'safe');
      if (records.length === 0) {
        toast.error('No skills could be scanned.');
      } else if (flagged.length === 0) {
        toast.success(`Checked ${records.length} skills, nothing flagged.`);
      } else {
        toast.warning(
          `Checked ${records.length} skills, ${flagged.length} need a look: ${flagged
            .map((record) => record.skillName)
            .join(', ')}.`,
        );
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Share their keys with the Prompts section, so the nav badge and the lists read one fetch.
  const draftsQuery = useQuery({
    queryKey: queryKeys.projectDrafts(projectId ?? ''),
    queryFn: () => window.agentmat.projectDrafts.listByProject(projectId!),
    enabled: !!projectId,
  });
  const scheduledTasksQuery = useQuery({
    queryKey: queryKeys.scheduledTasks(projectId ?? ''),
    queryFn: () => window.agentmat.scheduledTasks.listByProject(projectId!),
    enabled: !!projectId,
  });
  const openDraftCount = (draftsQuery.data ?? []).filter(
    (draft) => draft.status === 'draft',
  ).length;
  const missedTaskCount = (scheduledTasksQuery.data ?? []).filter(
    (task) => task.status === 'missed',
  ).length;

  const installedMcpServersQuery = useQuery({
    queryKey: queryKeys.installedMcpServers(projectId ?? ''),
    queryFn: () => window.agentmat.mcp.listInstalled(projectId!),
    enabled: !!projectId,
  });

  const toolsStatusQuery = useQuery({
    queryKey: queryKeys.toolsStatus,
    queryFn: () => window.agentmat.tools.detectAll(),
  });

  // Only for the nav badge. The Security tab owns this key too, so opening the tab reuses the
  // same cached record rather than reading it twice.
  const latestSecurityScanQuery = useQuery({
    queryKey: queryKeys.securityLatest(projectId!),
    queryFn: () => window.agentmat.security.latest(projectId!),
    enabled: !!projectId,
    meta: { silentLoading: true },
  });
  const diffrayInstalled =
    toolsStatusQuery.data?.find((tool) => tool.id === DIFFRAY_TOOL_ID)?.installed === true;

  // The preload bridge is only attached when the window is created, so a
  // hot-reloaded renderer can outrun it. Feature-detect instead of calling
  // blind, which would throw a bare TypeError.
  const planBridgeReady = typeof window.agentmat?.projects?.bootstrapPlan === 'function';

  // Fetched from the main process rather than computed here, so the preview is
  // literally the plan that gets written. Keyed on the fields the plan derives
  // from, so editing the project's agent refreshes it.
  const bootstrapPlanQuery = useQuery({
    queryKey: [
      'bootstrap-plan',
      projectId,
      project?.agentType,
      project?.name,
      project?.description,
    ],
    queryFn: () => window.agentmat.projects.bootstrapPlan(projectId!),
    enabled: !!projectId && !!project && planBridgeReady,
  });

  const updateMutation = useMutation({
    mutationFn: (values: ProjectFormValues) => window.agentmat.projects.update(projectId!, values),
    onSuccess: () => {
      toast.success('Project updated.');
      setEditOpen(false);
      setEditFocusRun(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });

  const notesMutation = useMutation({
    mutationFn: (notes: string) => window.agentmat.projects.update(projectId!, { notes }),
    onSuccess: () => {
      toast.success('Notes saved.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [describeOpen, setDescribeOpen] = useState(false);
  // Bumped on success so the file browser jumps back to the root and refetches.
  const [fileBrowserRevision, setFileBrowserRevision] = useState(0);

  const bootstrapMutation = useMutation({
    // The description is persisted on the project before scaffolding, because
    // the main process builds the file plan from the stored project, so
    // the preview, the written files, and the saved description can't disagree.
    mutationFn: async ({ description, translatedFrom }: BootstrapDescription) => {
      if (description !== project?.description) {
        await window.agentmat.projects.update(projectId!, { description });
      }
      if (translatedFrom) {
        try {
          await window.agentmat.promptHistory.add({
            rawInput: translatedFrom,
            promptType: 'Project description',
            targetAI: '',
            content: description,
            source: 'translate',
            projectId,
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.promptHistory });
        } catch {
          // Best-effort: losing the history entry shouldn't abort the bootstrap.
        }
      }
      return window.agentmat.projects.bootstrap(projectId!);
    },
    onSuccess: (raw) => {
      setDescribeOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // The main process is bundled separately from this renderer, so a stale
      // Electron build can answer with an older shape. Normalize rather than
      // crash, and say so plainly; the fix is restarting `pnpm dev`.
      const stale = !raw?.agentLabel || !raw?.skippedFiles;
      const result: BootstrapResult = {
        agentLabel: raw?.agentLabel ?? 'the selected agent',
        createdFiles: raw?.createdFiles ?? [],
        skippedFiles: raw?.skippedFiles ?? [],
      };
      setBootstrapResult(result);

      if (stale) {
        toast.warning(
          'Bootstrapped with an outdated main process. Files may have gone to the old locations. Restart the app (pnpm dev) and run it again.',
        );
      } else {
        const skipped = result.skippedFiles.length
          ? ` ${result.skippedFiles.length} already existed.`
          : '';
        toast.success(
          `Created ${result.createdFiles.length} file(s) for ${result.agentLabel}.${skipped}`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['project-dir'] });
      setFileBrowserRevision((n) => n + 1);
    },
    onError: (error: Error) => {
      setBootstrapResult(null);
      toast.error(`Bootstrap failed: ${error.message}`);
    },
  });

  const removeSkillMutation = useMutation({
    mutationFn: (skillId: string) =>
      window.agentmat.skills.remove({ projectId: projectId!, skillId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(projectId ?? '') });
    },
  });

  const updateSkillMutation = useMutation({
    mutationFn: (update: SkillUpdateInfo) =>
      window.agentmat.skills.install({
        projectId: projectId!,
        repositoryId: update.repositoryId,
        skillId: update.skillId,
      }),
    onSuccess: (_data, update) => {
      toast.success(`Updated ${update.skillId} to v${update.latestVersion}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(projectId ?? '') });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillUpdates(projectId ?? '') });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Whether an agent in this project may suggest run commands. The switch writes the project's
  // .mcp.json entry, so the state is read back from the project folder, not from AgentMate's records.
  const runSuggestionsQuery = useQuery({
    queryKey: queryKeys.runProposalsEnabled(projectId ?? ''),
    queryFn: async () => Boolean(await window.agentmat.runProposals.getEnabled(projectId!)),
    enabled: Boolean(projectId),
  });
  const runSuggestionsMutation = useMutation({
    mutationFn: (enabled: boolean) => window.agentmat.runProposals.setEnabled(projectId!, enabled),
    onSuccess: (result, enabled) => {
      if (!result.ok) {
        toast.error(result.error);
      } else {
        toast.success(
          enabled
            ? 'Agents here can suggest run commands now.'
            : 'Agents here can no longer suggest run commands.',
        );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.runProposalsEnabled(projectId ?? ''),
      });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not change that.'),
  });

  const removeMcpServerMutation = useMutation({
    mutationFn: (serverId: string) =>
      window.agentmat.mcp.remove({ projectId: projectId!, serverId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.installedMcpServers(projectId ?? ''),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => window.agentmat.projects.delete(projectId!),
    onSuccess: () => {
      toast.success('Project removed.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      navigate('/projects');
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) => window.agentmat.projects.setArchived(projectId!, archived),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) =>
        prev?.map((p) => (p.id === updated.id ? updated : p)),
      );
      toast.success(
        updated.archived
          ? 'Archived. It now lives behind the Archived toggle on the Projects page.'
          : 'Restored to the Projects page.',
      );
    },
  });

  async function handleCopyPath(): Promise<void> {
    if (!project) return;
    await navigator.clipboard.writeText(project.folderPath);
    toast.success('Path copied to clipboard.');
  }

  async function handleOpenInFileExplorer(): Promise<void> {
    if (!project) return;
    try {
      await window.agentmat.shell.openPath(project.folderPath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open folder.');
    }
  }

  function handleOpenTerminalHere(): void {
    if (!project) return;
    openSession({ title: project.name, cwd: project.folderPath, projectId: project.id });
  }

  function handleRun(): void {
    if (!project) return;
    requestRun(project, { onEmpty: () => setCreateRunAiOpen(true) });
  }

  function handleDelete(): void {
    if (!project) return;
    void confirmDialog({
      title: `Remove "${project.name}"?`,
      description: 'This removes it from AgentMate. Files on disk are kept.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    }).then((confirmed) => {
      if (confirmed) deleteMutation.mutate();
    });
  }

  const skillUpdateCount = (skillUpdatesQuery.data ?? []).filter((u) => u.hasUpdate).length;
  const healthBadge = useProjectHealthBadge(projectId);
  const deployBadge = useProjectDeployBadge(projectId);
  const sectionBadges = useMemo((): Partial<Record<ProjectSectionId, SectionBadge>> => {
    const badges: Partial<Record<ProjectSectionId, SectionBadge>> = {};
    if (healthBadge) badges.monitoring = healthBadge;
    if (deployBadge) badges.deploy = deployBadge;
    const skillCount = installedSkillsQuery.data?.length ?? 0;
    const mcpCount = installedMcpServersQuery.data?.length ?? 0;
    const promptCount = openDraftCount + missedTaskCount;
    if (promptCount > 0) badges.prompts = { count: promptCount, attention: missedTaskCount > 0 };
    if (skillCount > 0) badges.skills = { count: skillCount, attention: skillUpdateCount > 0 };
    if (mcpCount > 0) badges.mcp = { count: mcpCount };
    // Only the two severities worth interrupting someone over. A repo with 400 low-severity
    // style notes should not wear a permanent red badge.
    const counts = latestSecurityScanQuery.data?.counts;
    const serious = (counts?.critical ?? 0) + (counts?.high ?? 0);
    if (serious > 0) badges.security = { count: serious, attention: true };
    return badges;
  }, [
    healthBadge,
    deployBadge,
    installedMcpServersQuery.data,
    installedSkillsQuery.data,
    latestSecurityScanQuery.data,
    missedTaskCount,
    openDraftCount,
    skillUpdateCount,
  ]);

  if (projectsQuery.isLoading) {
    return <ProjectDetailSkeleton />;
  }

  if (!project) {
    return (
      <div className="space-y-2 p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/projects')}
          className="px-2.5 text-muted-foreground hover:bg-foreground/[0.06]"
        >
          <ArrowLeft /> Back to Projects
        </Button>
        <SectionEmptyState
          icon={FileText}
          title="Project not found"
          description="It may have been removed, or this link is out of date."
          action={
            <Button onClick={() => navigate('/projects')}>
              <ArrowLeft /> Back to Projects
            </Button>
          }
        />
      </div>
    );
  }

  return (
    // Like the API Client: the header, the section list and each section are glass cards on the
    // content island with the same small gap between them.
    <div className="flex min-h-full flex-1 flex-col gap-2 p-2">
      <ProjectDetailHeader
        project={project}
        onBack={() => navigate('/projects')}
        onRun={handleRun}
        onPrompt={() => setPromptOpen(true)}
        onEdit={() => setEditOpen(true)}
        onCreateRunWithAi={() => setCreateRunAiOpen(true)}
        onDelete={handleDelete}
        onToggleArchive={() => archiveMutation.mutate(!project.archived)}
        onCopyPath={() => void handleCopyPath()}
        onOpenFolder={() => void handleOpenInFileExplorer()}
        onOpenTerminal={handleOpenTerminalHere}
        onOpenWorkspace={() => navigate(`/workspace/${project.id}`)}
      />

      <div
        ref={workspaceRef}
        className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-start"
      >
        <ProjectSectionNav
          section={section}
          onSectionChange={setSection}
          badges={sectionBadges}
          createdAt={project.createdAt}
          updatedAt={project.updatedAt}
          hiddenIds={[
            ...(diffrayInstalled ? [] : (['review'] as const)),
            ...(project.wordpress ? [] : (['wordpress'] as const)),
          ]}
        />

        <div className="min-w-0 flex-1">
          {section === 'overview' && (
            <div className="space-y-2">
              <SectionCard
                icon={MessageSquare}
                title="Standing prompt"
                description="The context agents start from every time they work on this project."
                actions={
                  project.prompt ? (
                    <Button variant="soft" onClick={() => setPromptOpen(true)}>
                      <MessageSquare /> Edit prompt
                    </Button>
                  ) : null
                }
              >
                {project.prompt ? (
                  <CollapsibleText text={project.prompt} />
                ) : (
                  <SectionEmptyState
                    inset
                    icon={MessageSquare}
                    title="No standing prompt"
                    description="Set the context agents should start from every time they work on this project."
                    action={
                      <Button onClick={() => setPromptOpen(true)}>
                        <MessageSquare /> Define prompt
                      </Button>
                    }
                  />
                )}
              </SectionCard>

              <ProjectNotesCard
                notes={project.notes}
                onSave={(notes) => notesMutation.mutate(notes)}
                saving={notesMutation.isPending}
              />

              <DiffrayReviewLaunchCard
                installed={diffrayInstalled}
                onOpen={() => setSection('review')}
              />
            </div>
          )}

          {section === 'bootstrap' && (
            <div className="space-y-2">
              <SectionCard
                icon={Wand2}
                title="Bootstrap"
                description={
                  bootstrapPlanQuery.data ? (
                    <>
                      Scaffolds this project the way{' '}
                      <span className="font-medium">{bootstrapPlanQuery.data.agentLabel}</span>{' '}
                      expects it, following{' '}
                      <a
                        href={bootstrapPlanQuery.data.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        its own documented layout
                      </a>
                      . Existing files are never overwritten.
                    </>
                  ) : (
                    'Scaffolds this project the way its agent expects it. Existing files are never overwritten.'
                  )
                }
                actions={
                  <Button
                    onClick={() => setDescribeOpen(true)}
                    disabled={
                      bootstrapMutation.isPending || (planBridgeReady && !bootstrapPlanQuery.data)
                    }
                  >
                    <Wand2 />
                    {bootstrapMutation.isPending ? 'Bootstrapping…' : 'Bootstrap Project'}
                  </Button>
                }
                bodyClassName="space-y-2"
              >
                {bootstrapMutation.isError && (
                  <p className="rounded-xl bg-destructive/[0.08] p-3 text-xs text-destructive ring-1 ring-inset ring-destructive/25">
                    Bootstrap failed: {(bootstrapMutation.error as Error).message}
                  </p>
                )}

                <div className={SECTION_WELL}>
                  {bootstrapResult ? (
                    <>
                      <p className={cn(SECTION_HEADING, 'mb-2')}>Result</p>
                      <ul className="space-y-0.5 font-mono text-xs">
                        {[
                          ...bootstrapResult.createdFiles.map((f) => ({ path: f, created: true })),
                          ...bootstrapResult.skippedFiles.map((f) => ({ path: f, created: false })),
                        ].map((file) => (
                          <li
                            key={file.path}
                            className={file.created ? 'text-foreground' : 'text-muted-foreground'}
                          >
                            {file.created ? '+ ' : '· '}
                            {file.path}
                            {file.created ? '' : ' (already existed)'}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : !planBridgeReady ? (
                    <p className="text-xs text-muted-foreground">
                      Preview unavailable. This window is running an older preload script. Fully
                      quit the app and start it again (<code className="font-mono">pnpm dev</code>)
                      to see it. Bootstrapping still works.
                    </p>
                  ) : bootstrapPlanQuery.isError ? (
                    <p className="text-xs text-destructive">
                      Could not load the plan: {(bootstrapPlanQuery.error as Error).message}
                    </p>
                  ) : bootstrapPlanQuery.isPending ? (
                    <div className="space-y-2">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-3 w-56" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  ) : (
                    <>
                      <p className={cn(SECTION_HEADING, 'mb-2')}>Files it will create</p>
                      <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                        {bootstrapPlanQuery.data?.files.map((file) => (
                          <li key={file.relativePath}>{file.relativePath}</li>
                        ))}
                      </ul>
                      <p className={cn(SECTION_HEADING, 'mb-2 mt-3')}>Folders it will create</p>
                      <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                        {bootstrapPlanQuery.data?.folders.map((folder) => (
                          <li key={folder}>{folder}/</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </SectionCard>

              <SectionCard
                icon={FolderTree}
                title="Project files"
                description="Browse and edit project files."
              >
                <ProjectFileBrowser rootPath={project.folderPath} revision={fileBrowserRevision} />
              </SectionCard>
            </div>
          )}

          {section === 'blueprint' && <BlueprintTab project={project} />}

          {section === 'prompts' && <ProjectPrompts project={project} />}

          {section === 'skills' && (
            <div className="space-y-2">
              <SectionCard
                icon={Blocks}
                title="Skills"
                description="Skills installed into this project."
                actions={
                  <>
                    {allProjectSkillSubjects.length > 0 && (
                      <Button
                        variant="soft"
                        disabled={checkAllSkillsMutation.isPending}
                        onClick={() => checkAllSkillsMutation.mutate(allProjectSkillSubjects)}
                      >
                        {checkAllSkillsMutation.isPending ? (
                          <>
                            <Spinner className="h-3.5 w-3.5 animate-spin" />
                            {skillCheckProgress
                              ? `Checking ${skillCheckProgress.done + 1} of ${skillCheckProgress.total}…`
                              : 'Checking…'}
                          </>
                        ) : (
                          <>
                            <Shield /> Check all ({allProjectSkillSubjects.length})
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      variant="soft"
                      onClick={() => navigate(`/skills?projectId=${project.id}`)}
                    >
                      <Blocks /> Browse marketplace
                    </Button>
                  </>
                }
                bodyClassName="space-y-3"
              >
                {allProjectSkillSubjects.length > 0 && (
                  <div className={SECTION_WELL}>
                    <SkillDeepReviewOptions
                      enabled={skillDeepReview}
                      onEnabledChange={setSkillDeepReview}
                      cliId={skillReviewCliId}
                      onCliIdChange={setSkillReviewCliId}
                      disabled={checkAllSkillsMutation.isPending}
                      batchHint={
                        allProjectSkillSubjects.length > 1
                          ? `Check all runs the CLI once per skill, so ${allProjectSkillSubjects.length} skills will take a while.`
                          : undefined
                      }
                    />
                  </div>
                )}
                {installedSkillsQuery.data?.length === 0 ? (
                  <SectionEmptyState
                    inset
                    icon={Blocks}
                    title="No skills installed"
                    description="Pull skills from the marketplace so agents on this project can use them."
                    action={
                      <Button onClick={() => navigate(`/skills?projectId=${project.id}`)}>
                        <Blocks /> Browse marketplace
                      </Button>
                    }
                  />
                ) : installedSkillsQuery.isPending ? (
                  <ListSkeleton />
                ) : (
                  <div className={ROWS}>
                    {installedSkillsQuery.data?.map((skill) => {
                      const update = skillUpdateBySkillId.get(skill.skillId);
                      return (
                        <div key={skill.skillId} className={ROW}>
                          <div className="min-w-0 space-y-1">
                            <p className="truncate font-medium">{skill.skillId}</p>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-xs tabular-nums text-muted-foreground">
                                v{skill.version}
                              </p>
                              {auditBySkillId.has(skill.skillId) && (
                                <SkillAuditVerdictBadge
                                  verdict={auditBySkillId.get(skill.skillId)!.verdict}
                                  score={auditBySkillId.get(skill.skillId)!.score}
                                />
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {update?.hasUpdate && (
                              <>
                                <ToneChip tone="warning">
                                  v{update.latestVersion} available
                                </ToneChip>
                                <Button
                                  variant="soft"
                                  size="sm"
                                  disabled={
                                    updateSkillMutation.isPending &&
                                    updateSkillMutation.variables?.skillId === skill.skillId
                                  }
                                  onClick={() => updateSkillMutation.mutate(update)}
                                >
                                  <RefreshCw className="h-3.5 w-3.5" /> Update
                                </Button>
                              </>
                            )}
                            <SimpleTooltip label={`Check ${skill.skillId} for unsafe instructions`}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Check ${skill.skillId}`}
                                onClick={() =>
                                  setSecuritySubject({
                                    skillId: skill.skillId,
                                    skillName: skill.skillId.split('/').pop() ?? skill.skillId,
                                    target: {
                                      kind: 'installed',
                                      projectId: project.id,
                                      skillId: skill.skillId,
                                    },
                                  })
                                }
                              >
                                <Shield className="h-3.5 w-3.5" />
                              </Button>
                            </SimpleTooltip>
                            <SimpleTooltip label={`Remove ${skill.skillId}`}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="hover:bg-destructive/10 hover:text-destructive"
                                aria-label={`Remove ${skill.skillId}`}
                                onClick={() => {
                                  void confirmDialog({
                                    title: `Remove "${skill.skillId}"?`,
                                    description: 'This removes it from this project.',
                                    confirmLabel: 'Remove',
                                    variant: 'destructive',
                                  }).then((confirmed) => {
                                    if (confirmed) removeSkillMutation.mutate(skill.skillId);
                                  });
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </SimpleTooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>

              {projectSkillRows.length > 0 && (
                <SectionCard
                  icon={FolderTree}
                  title="Also in this project"
                  description="Skills found in this project's agent folders that AgentMate did not install, for example ones that came with the repository. Agents read these too."
                >
                  <div className={ROWS}>
                    {projectSkillRows.map((skill) => {
                      const audit = auditBySkillId.get(skill.name);
                      return (
                        <div key={skill.location} className={ROW}>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate font-medium">{skill.name}</span>
                              {audit && (
                                <SkillAuditVerdictBadge
                                  verdict={audit.verdict}
                                  score={audit.score}
                                />
                              )}
                            </div>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {skill.location}
                            </p>
                          </div>
                          <Button
                            variant="soft"
                            size="sm"
                            className="shrink-0"
                            onClick={() =>
                              setSecuritySubject({
                                skillId: skill.name,
                                skillName: skill.name,
                                target: skill.target,
                              })
                            }
                          >
                            <Shield /> Check
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </SectionCard>
              )}
            </div>
          )}

          {section === 'mcp' && (
            <SectionCard
              icon={Plug}
              title="MCP servers"
              description="MCP servers installed into this project."
              actions={
                <Button variant="soft" onClick={() => navigate(`/mcp?projectId=${project.id}`)}>
                  <Plug /> Browse marketplace
                </Button>
              }
            >
              <div className={cn(ROW, 'mb-2')}>
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="project-run-suggestions" className="font-medium">
                    Let agents suggest run commands
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    An agent here can suggest a run command. You approve each one in AgentMate
                    before it is saved.
                  </p>
                </div>
                <Switch
                  id="project-run-suggestions"
                  checked={runSuggestionsQuery.data ?? false}
                  disabled={
                    !project.folderPath ||
                    runSuggestionsQuery.isPending ||
                    runSuggestionsMutation.isPending
                  }
                  onCheckedChange={(checked) => runSuggestionsMutation.mutate(checked)}
                />
              </div>
              {installedMcpServersQuery.data?.length === 0 ? (
                <SectionEmptyState
                  inset
                  icon={Plug}
                  title="No MCP servers installed"
                  description="Install servers from the marketplace to give this project's agents extra tools."
                  action={
                    <Button onClick={() => navigate(`/mcp?projectId=${project.id}`)}>
                      <Plug /> Browse marketplace
                    </Button>
                  }
                />
              ) : installedMcpServersQuery.isPending ? (
                <ListSkeleton />
              ) : (
                <div className={ROWS}>
                  {installedMcpServersQuery.data?.map((server) => (
                    <div key={server.serverId} className={ROW}>
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-medium">{server.serverId}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          v{server.version}
                        </p>
                      </div>
                      <SimpleTooltip label={`Remove ${server.serverId}`}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Remove ${server.serverId}`}
                          onClick={() => {
                            void confirmDialog({
                              title: `Remove "${server.serverId}"?`,
                              description: 'This removes it from this project.',
                              confirmLabel: 'Remove',
                              variant: 'destructive',
                            }).then((confirmed) => {
                              if (confirmed) removeMcpServerMutation.mutate(server.serverId);
                            });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}

          {section === 'packages' && <PackagesTab project={project} />}

          {section === 'docker' && <DockerTab project={project} />}

          {section === 'monitoring' && <MonitoringView key={project.id} projectId={project.id} />}

          {section === 'deploy' && <ProjectDeploySection key={project.id} project={project} />}

          {section === 'wordpress' && project.wordpress && (
            <WordPressProjectSection project={project} />
          )}

          {section === 'git' && (
            <GitTab
              // The route reuses this page when moving between projects; without a key the tag
              // dialogs would carry one project's fields and running suggestion into the next.
              key={project.id}
              projectId={project.id}
              folderPath={project.folderPath}
              repoUrl={project.repoUrl ?? ''}
              mutedActions={project.githubActionsMuted ?? []}
              diffrayInstalled={diffrayInstalled}
              onReviewWithDiffray={() => setSection('review')}
            />
          )}
          {section === 'git' && <ProjectWorktreeSetupCard project={project} />}

          {/* Keyed like Git: the route reuses this page between projects, and the period and chart
              choice should not carry over. */}
          {section === 'usage' && <ProjectUsageTab key={project.id} projectId={project.id} />}

          {section === 'review' && (
            <DiffrayReviewWizard
              key={project.id}
              projectId={project.id}
              projectName={project.name}
              folderPath={project.folderPath}
              agentType={project.agentType}
              installed={diffrayInstalled}
            />
          )}

          {section === 'security' && <SecurityTab key={project.id} project={project} />}

          {section === 'hooks' && <HooksTab project={project} />}

          {section === 'environments' && <EnvironmentsTab project={project} />}

          {section === 'terminal' && (
            <ProjectTerminalSection
              project={project}
              onOpenHere={() =>
                openSession({
                  title: project.name,
                  cwd: project.folderPath,
                  projectId: project.id,
                })
              }
              onRun={handleRun}
              onSetRun={() => {
                setEditFocusRun(true);
                setEditOpen(true);
              }}
              onCreateWithAi={() => setCreateRunAiOpen(true)}
            />
          )}

          {section === 'config' && <ProjectConfigEditor projectFolderPath={project.folderPath} />}
        </div>
      </div>

      <ProjectPromptDialog project={project} open={promptOpen} onOpenChange={setPromptOpen} />

      <BootstrapDescriptionDialog
        project={project}
        open={describeOpen}
        onOpenChange={setDescribeOpen}
        onConfirm={(result) => bootstrapMutation.mutate(result)}
        pending={bootstrapMutation.isPending}
      />

      <ProjectFormDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditFocusRun(false);
        }}
        focusRunCommands={editFocusRun}
        initial={project}
        onSubmit={(values) => updateMutation.mutate(values)}
        isSubmitting={updateMutation.isPending}
        onCreateWithAi={() => setCreateRunAiOpen(true)}
        onMakeWordPress={() => setLinkWordPressOpen(true)}
        onMakeRegular={() => void unlinkWordPress(project, () => setSection('overview'))}
      />

      <CreateRunWithAiDialog
        open={createRunAiOpen}
        onOpenChange={setCreateRunAiOpen}
        project={project}
        onWriteMyself={() => {
          setEditFocusRun(true);
          setEditOpen(true);
        }}
      />

      <LinkWordPressDialog
        open={linkWordPressOpen}
        onOpenChange={setLinkWordPressOpen}
        project={project}
        onLinked={() => setSection('wordpress')}
      />

      <SkillSecurityDialog
        subject={securitySubject}
        onOpenChange={(open) => {
          if (!open) setSecuritySubject(null);
        }}
      />
      {runPicker}
    </div>
  );
}

/**
 * Rows that run edge to edge under a section's header, split by the hairline Settings uses. The
 * negative margins undo the card body's padding so the rows meet the card's own edges.
 */
const ROWS = 'settings-rows -mx-4 -mb-4 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]';

/** One of those rows: what it is on the left, what you can do with it on the right. */
const ROW =
  'flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-foreground/[0.03]';

/** A status or count as a small tinted chip: the page kit's one chip. */
const ToneChip = Chip;

/** Shimmering rows standing in for a list that is still loading. */
function ListSkeleton({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading" className={ROWS}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-7 w-7 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function ProjectTerminalSection({
  project,
  onOpenHere,
  onRun,
  onSetRun,
  onCreateWithAi,
}: {
  project: Project;
  onOpenHere: () => void;
  onRun: () => void;
  onSetRun: () => void;
  onCreateWithAi: () => void;
}): React.JSX.Element {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const openDrawer = useTerminalStore((s) => s.openDrawer);
  const terminalShortcut = useShortcutLabel('terminal.toggle');
  const runCommands = configuredRunCommands(project);
  const projectSessions = sessions.filter((session) => session.projectId === project.id);

  function showSession(id: string): void {
    setActiveSession(id);
    openDrawer();
  }

  return (
    <SectionCard
      icon={TerminalSquare}
      title="Project terminal"
      description={
        <>
          <p>Opens in this folder. Hide the panel from the top bar and the shell keeps running.</p>
          <p className="mt-1.5 flex items-center gap-1.5 truncate font-mono text-[11px]">
            <Folder className="h-3 w-3 shrink-0" />
            {project.folderPath}
          </p>
        </>
      }
      bodyClassName="space-y-3"
    >
      {projectSessions.length > 0 && (
        <div className="space-y-1.5">
          <p className={cn(SECTION_HEADING, 'px-1')}>Open here</p>
          <div className={cn(SECTION_WELL, 'flex flex-col gap-px p-1')}>
            {projectSessions.map((session) => {
              const active = session.id === activeSessionId;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => showSession(session.id)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/12 font-medium text-primary'
                      : 'hover:bg-foreground/[0.06]',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      active
                        ? 'terminal-live-dot bg-primary shadow-[0_0_6px_hsl(var(--primary))]'
                        : 'bg-foreground/25',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  <span className="text-xs text-muted-foreground">Show</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button onClick={onOpenHere}>
          <TerminalSquare /> Open terminal here
        </Button>
        {runCommands.length > 0 ? (
          <Button variant="soft" onClick={onRun}>
            <Run />{' '}
            {runCommands.length === 1 ? `Run ${runCommandSummary(runCommands[0].command)}` : 'Run'}
          </Button>
        ) : (
          <>
            <Button variant="soft" onClick={onSetRun}>
              Set a run command
            </Button>
            <Button variant="soft" onClick={onCreateWithAi}>
              <Wand2 /> Create with AI
            </Button>
          </>
        )}
        {terminalShortcut ? (
          <span className="ml-1 text-xs text-muted-foreground">
            <kbd className="rounded-full bg-foreground/[0.07] px-2 py-0.5 font-sans text-[10px] font-medium">
              {terminalShortcut}
            </kbd>{' '}
            toggles the panel
          </span>
        ) : null}
      </div>
    </SectionCard>
  );
}

function ProjectConfigEditor({
  projectFolderPath,
}: {
  projectFolderPath: string;
}): React.JSX.Element {
  const configPath = `${projectFolderPath}/.agentmate/config.json`;
  const [content, setContent] = useState('{}');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.agentmat.fs
      .readFile(configPath)
      .catch(() => '{}')
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [configPath]);

  async function handleSave(): Promise<void> {
    try {
      JSON.parse(content);
    } catch {
      toast.error('Config must be valid JSON.');
      return;
    }
    await window.agentmat.fs.writeFile(configPath, content);
    toast.success('Config saved.');
  }

  return (
    <SectionCard
      icon={FileCog}
      title="Config"
      description={<span className="font-mono">.agentmate/config.json</span>}
      actions={
        <Button disabled={!loaded} onClick={() => void handleSave()}>
          <Save /> Save
        </Button>
      }
    >
      {loaded ? (
        <MonacoEditor
          value={content}
          onChange={setContent}
          language="json"
          className="min-h-[320px] rounded-xl border-0 ring-1 ring-foreground/[0.08]"
        />
      ) : (
        <Skeleton className="h-80 w-full rounded-xl" />
      )}
    </SectionCard>
  );
}

/** `${sourceFile}:${event}:${groupIndex}:${hookIndex}` → the settings file this hook lives in. */
function sourceFileLabel(hookId: string): string {
  return hookId.split(':')[0] ?? 'settings.json';
}

/**
 * The hook's agent logo. These hooks all live in Claude Code's settings files, so anything
 * unrecognized is attributed to Claude Code rather than shown as a generic bell.
 */
function HookAgentIcon({
  cliId,
  className,
}: {
  cliId?: string;
  className?: string;
}): React.JSX.Element {
  const known = cliId != null && CLI_REGISTRY.some((c) => c.id === cliId);
  return <CliLogo cliId={known ? cliId : 'claude-code'} className={className} />;
}

/** Best-effort one-line summary of a raw hook body for the list view (command + args, if present). */
function summarizeHook(hook: Record<string, unknown>): string {
  const command = typeof hook.command === 'string' ? hook.command : '';
  const args = Array.isArray(hook.args)
    ? hook.args.filter((a): a is string => typeof a === 'string')
    : [];
  return [command, ...args].filter(Boolean).join(' ') || '(empty command)';
}

function EditClaudeHookDialog({
  projectId,
  hook,
  onOpenChange,
}: {
  projectId: string;
  hook: DetectedClaudeHook | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [hookJson, setHookJson] = useState('');
  const [matcher, setMatcher] = useState('');

  useEffect(() => {
    if (hook) {
      setHookJson(JSON.stringify(hook.hook, null, 2));
      setMatcher(hook.matcher ?? '');
    }
  }, [hook]);

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!hook) return Promise.resolve();
      let parsed: unknown;
      try {
        parsed = JSON.parse(hookJson);
      } catch {
        throw new Error('Hook body must be valid JSON.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Hook body must be a JSON object.');
      }
      return window.agentmat.projects.updateClaudeHook(projectId, hook.id, {
        hook: parsed as Record<string, unknown>,
        matcher: matcher || undefined,
      });
    },
    onSuccess: () => {
      toast.success('Hook updated.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.claudeHooks(projectId) });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update hook.');
    },
  });

  return (
    <Dialog open={!!hook} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit hook</DialogTitle>
          <DialogDescription>
            {hook?.event} hook in .claude/{hook ? sourceFileLabel(hook.id) : 'settings.json'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Matcher</Label>
            <Input
              value={matcher}
              onChange={(e) => setMatcher(e.target.value)}
              placeholder="Optional tool/event matcher"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Hook body (JSON)</Label>
            <Textarea
              value={hookJson}
              onChange={(e) => setHookJson(e.target.value)}
              rows={8}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={updateMutation.isPending || !hookJson.trim()}
            onClick={() => updateMutation.mutate()}
          >
            <Save className="h-4 w-4" /> Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Strips markdown fences/quotes and collapses to a single line, for AI-suggested branch names. */
function sanitizeBranchName(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`/g, '')
    .split('\n')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function gitBranchOptions(
  branches: GitBranchInfo[],
  current: string | null,
  defaultBranch: string | null,
): ComboboxOption[] {
  return [...branches]
    .sort((a, b) => {
      if (a.name === current) return -1;
      if (b.name === current) return 1;
      if (a.name === defaultBranch) return -1;
      if (b.name === defaultBranch) return 1;
      return a.name.localeCompare(b.name);
    })
    .map((branch) => {
      const tags: string[] = [];
      if (branch.name === defaultBranch) tags.push('default');
      if (!branch.local && branch.remote) tags.push('remote');
      return {
        value: branch.name,
        label: tags.length > 0 ? `${branch.name} · ${tags.join(' · ')}` : branch.name,
        keywords: [
          branch.name,
          ...tags,
          branch.local ? 'local' : '',
          branch.remote ? 'remote' : '',
          !branch.local && branch.remote ? 'pull' : '',
        ].filter(Boolean),
        icon:
          !branch.local && branch.remote ? (
            <CloudDownload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ),
      };
    });
}

/** Strips markdown fences/quotes but keeps line breaks, for AI-suggested commit messages. */
type GitFileKind = 'untracked' | 'deleted' | 'added' | 'renamed' | 'modified';

function gitFileKind(x: string, y: string): GitFileKind {
  const code = `${x}${y}`.trim();
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

/** Which theme colour a changed file's kind is tinted with, in its chip and its edge mark. */
function gitFileTone(kind: GitFileKind): ChipTone {
  return kind === 'deleted'
    ? 'destructive'
    : kind === 'added'
      ? 'success'
      : kind === 'modified'
        ? 'warning'
        : kind === 'renamed'
          ? 'primary'
          : 'neutral';
}

function GitStatusBadge({ kind }: { kind: GitFileKind }): React.JSX.Element {
  return (
    <ToneChip tone={gitFileTone(kind)} className="font-mono text-[10px] uppercase tracking-wide">
      {kind}
    </ToneChip>
  );
}

/** CLI transcripts often arrive with color codes that a dialog cannot render. */
function displayCliOutput(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is what an ANSI escape sequence starts with, matching it is the point
      .replace(/\u001B\[[?]?\d*(?:;\d+)*[a-zA-Z]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences are delimited by BEL/ESC
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
      .replace(/\[(?:\d{1,3};)*\d{1,3}m/g, '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Splits a tag into what comes before the version and the version itself, so `v1.2.3`,
 * `web-v1.2.3` and `@acme/web@1.2.3` all give up their `1.2.3`.
 */
function splitTag(tag: string): { prefix: string; version: string } | null {
  const match = tag.trim().match(/^(.*?)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!match) return null;
  return { prefix: match[1], version: match[2] };
}

const TAG_TARGET_STORAGE_PREFIX = 'agentmate:tag-target:';

/** The tag prefix a project was last tagged or bumped with. */
function readStoredTagPrefix(projectId: string): string | null {
  try {
    const raw = localStorage.getItem(`${TAG_TARGET_STORAGE_PREFIX}${projectId}`);
    const parsed = raw ? (JSON.parse(raw) as { prefix?: unknown }) : null;
    return typeof parsed?.prefix === 'string' ? parsed.prefix : null;
  } catch {
    return null;
  }
}

function storeTagPrefix(projectId: string, prefix: string): void {
  try {
    localStorage.setItem(`${TAG_TARGET_STORAGE_PREFIX}${projectId}`, JSON.stringify({ prefix }));
  } catch {
    // Private mode and quota errors only cost the remembered prefix.
  }
}

/**
 * Commit message for a version bump. A plain `v1.2.3` reads as "version 1.2.3", while a
 * named series keeps its whole tag so `web-v1.2.3` says which release it was.
 */
function releaseCommitMessage(tag: string): string {
  const split = splitTag(tag);
  const plain = !split || split.prefix === '' || split.prefix.toLowerCase() === 'v';
  return `chore(release): bump version to ${plain ? (split?.version ?? tag) : tag}`;
}

function parseSemverTag(tag: string): { major: number; minor: number; patch: number } | null {
  const version = splitTag(tag)?.version;
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** What each bump kind is for, so the choice reads without knowing semver by heart. */
const BUMP_HINTS = {
  patch: 'Fixes only',
  minor: 'New features',
  major: 'Breaking changes',
} as const;

/** The next version number for a bump kind, without any prefix: the caller owns that. */
function bumpSemverVersion(latestTag: string | null, kind: 'major' | 'minor' | 'patch'): string {
  const parsed = latestTag ? parseSemverTag(latestTag) : null;
  if (!parsed) {
    if (kind === 'major') return '1.0.0';
    if (kind === 'minor') return '0.1.0';
    return '0.0.1';
  }
  if (kind === 'major') return `${parsed.major + 1}.0.0`;
  if (kind === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function GitIconWell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
      {children}
    </div>
  );
}

/**
 * One button for both halves of an AI call. Idle, it asks. While the request runs it
 * keeps reporting progress (spinner plus what it is doing) and carries a red ✕ that
 * cancels, so the work stays visible and stoppable from the spot it was started.
 */
function AiSuggestButton({
  pending,
  onStart,
  onCancel,
  disabled,
  size,
  label,
  pendingLabel,
  pendingTooltip,
  pill = false,
}: {
  pending: boolean;
  onStart: () => void;
  onCancel: () => void;
  disabled?: boolean;
  size?: 'sm';
  label: string;
  /** What the AI is doing right now, e.g. "Thinking…". */
  pendingLabel: string;
  pendingTooltip: string;
  /** Draws it as the Git tab's pill; the dialogs keep the plain button. */
  pill?: boolean;
}): React.JSX.Element {
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  if (pending) {
    return (
      <SimpleTooltip label={pendingTooltip}>
        <Button
          variant="danger"
          size={pill ? undefined : size}
          onClick={onCancel}
          aria-label={`${pendingLabel} Click to cancel.`}
        >
          <Spinner className={`${iconSize} animate-spin`} />
          {pendingLabel}
          <X className={`${iconSize} text-destructive`} />
        </Button>
      </SimpleTooltip>
    );
  }

  return (
    <Button variant="soft" size={pill ? undefined : size} disabled={disabled} onClick={onStart}>
      <Sparkles className={iconSize} /> {label}
    </Button>
  );
}

/**
 * Git writes report progress in the button the user clicked, so they opt out of the
 * app-wide loading overlay (see `useAppLoadingOverlay`). Blanking the whole page for a
 * push hides the branch, the file list and the status badges the user is reading.
 */
const GIT_OP_META = { silentLoading: true } as const;

/**
 * The Git tab refetches on its own when the repo changes on disk, so those background
 * refreshes must not pull up the app-wide overlay either.
 */
const GIT_REFRESH_META = { silentLoading: true } as const;

/**
 * A git action button that carries its own progress: the icon swaps for a spinner and
 * the label says what is happening, so the page around it stays readable.
 */
function GitOpButton({
  icon: Icon,
  label,
  pendingLabel,
  pending,
  disabled,
  onClick,
  variant,
  size,
  pill = false,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  /** What this button is doing right now, e.g. "Pushing…". */
  pendingLabel: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
  variant?: 'soft' | 'destructive';
  size?: 'sm';
  /** Draws it at the Git tab's pill size; the dialogs keep the smaller one. */
  pill?: boolean;
}): React.JSX.Element {
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <Button
      variant={variant}
      size={pill ? undefined : size}
      disabled={disabled || pending}
      onClick={onClick}
      aria-busy={pending}
    >
      {pending ? (
        <Spinner className={`${iconSize} animate-spin`} />
      ) : (
        Icon && <Icon className={iconSize} />
      )}
      {pending ? pendingLabel : label}
    </Button>
  );
}

function GitTabSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading git status" className="space-y-2">
      <div className={cn(PROJECT_CARD, 'flex flex-wrap items-center justify-between gap-3 p-4')}>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-8 w-16 rounded-full" />
          <Skeleton className="h-8 w-14 rounded-full" />
          <Skeleton className="h-8 w-14 rounded-full" />
          <Skeleton className="h-8 w-16 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Skeleton className="h-40 rounded-[calc(var(--radius)+2px)]" />
        <Skeleton className="h-40 rounded-[calc(var(--radius)+2px)]" />
      </div>
    </div>
  );
}

function GitTab({
  projectId,
  folderPath,
  repoUrl,
  mutedActions,
  diffrayInstalled,
  onReviewWithDiffray,
}: {
  projectId: string;
  folderPath: string;
  repoUrl: string;
  mutedActions: ProjectGithubAction[];
  diffrayInstalled: boolean;
  onReviewWithDiffray: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();

  const [setupOpen, setSetupOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [defaultBranchPick, setDefaultBranchPick] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [suggestingBranch, setSuggestingBranch] = useState(false);
  const [suggestingCommit, setSuggestingCommit] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  // The tag being written into the project's files.
  const [applyVersionTag, setApplyVersionTag] = useState<string | null>(null);
  const [historyBranch, setHistoryBranch] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<GitBranchInfo | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [renameRemote, setRenameRemote] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GitBranchInfo | null>(null);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [deleteForce, setDeleteForce] = useState(false);
  const branchRequestRef = useRef<string | null>(null);
  const commitRequestRef = useRef<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.gitStatus(projectId),
    queryFn: () => window.agentmat.git.status(projectId),
    meta: GIT_REFRESH_META,
  });

  const tagsQuery = useQuery({
    queryKey: queryKeys.gitTags(projectId),
    queryFn: () => window.agentmat.git.tags(projectId),
    enabled: statusQuery.data?.isRepo === true,
    meta: GIT_REFRESH_META,
  });

  // Keeps the tab honest when the repo is driven from somewhere else, e.g. a commit in an editor.
  useGitRepoWatch(projectId, statusQuery.data?.isRepo === true);

  function invalidateStatus(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
  }

  function reportOpResult(result: { ok: boolean; message: string }): void {
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
    invalidateStatus();
  }

  const fetchMutation = useMutation({
    mutationFn: () => window.agentmat.git.fetch(projectId),
    onSuccess: reportOpResult,
    meta: GIT_OP_META,
  });
  const pullMutation = useMutation({
    mutationFn: () => window.agentmat.git.pull(projectId),
    onSuccess: reportOpResult,
    meta: GIT_OP_META,
  });
  const pushMutation = useMutation({
    mutationFn: () => window.agentmat.git.push(projectId),
    onSuccess: (result) => {
      reportOpResult(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pipelineStatus(projectId) });
    },
    meta: GIT_OP_META,
  });
  const syncMutation = useMutation({
    mutationFn: () => window.agentmat.git.sync(projectId),
    onSuccess: (result) => {
      reportOpResult(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pipelineStatus(projectId) });
    },
    meta: GIT_OP_META,
  });
  const createBranchMutation = useMutation({
    mutationFn: (name: string) => window.agentmat.git.createBranch(projectId, name),
    onSuccess: (result) => {
      reportOpResult(result);
      if (result.ok) setBranchName('');
    },
    meta: GIT_OP_META,
  });
  const checkoutBranchMutation = useMutation({
    mutationFn: (name: string) => window.agentmat.git.checkoutBranch(projectId, name),
    onSuccess: reportOpResult,
    meta: GIT_OP_META,
  });
  const setDefaultBranchMutation = useMutation({
    mutationFn: (name: string) => window.agentmat.git.setDefaultBranch(projectId, name),
    onSuccess: (result) => {
      reportOpResult(result);
      if (result.ok) setDefaultBranchPick('');
    },
    meta: GIT_OP_META,
  });
  const renameBranchMutation = useMutation({
    mutationFn: () => {
      if (!renameTarget) return Promise.resolve({ ok: false, message: 'No branch selected.' });
      return window.agentmat.git.renameBranch({
        projectId,
        from: renameTarget.name,
        to: renameTo,
        updateRemote: renameRemote,
      });
    },
    onSuccess: (result) => {
      reportOpResult(result);
      if (result.ok) {
        setRenameTarget(null);
        setRenameTo('');
        setRenameRemote(false);
      }
    },
    meta: GIT_OP_META,
  });
  const deleteBranchMutation = useMutation({
    mutationFn: () => {
      if (!deleteTarget) return Promise.resolve({ ok: false, message: 'No branch selected.' });
      return window.agentmat.git.deleteBranch({
        projectId,
        branchName: deleteTarget.name,
        deleteRemote,
        force: deleteForce,
      });
    },
    onSuccess: (result) => {
      reportOpResult(result);
      if (result.ok) {
        setDeleteTarget(null);
        setDeleteRemote(false);
        setDeleteForce(false);
      }
    },
    meta: GIT_OP_META,
  });
  const commitMutation = useMutation({
    mutationFn: (message: string) => window.agentmat.git.commit(projectId, message),
    onSuccess: (result) => {
      reportOpResult(result);
      if (result.ok) setCommitMessage('');
    },
    meta: GIT_OP_META,
  });

  /** Kills the CLI process behind an in-flight suggestion, rather than just ignoring its answer. */
  function cancelSuggestion(
    ref: React.MutableRefObject<string | null>,
    cancel: (requestId: string) => Promise<boolean>,
  ): void {
    const requestId = ref.current;
    if (!requestId) return;
    ref.current = null;
    void cancel(requestId);
  }

  async function handleSuggestBranchName(): Promise<void> {
    const requestId = crypto.randomUUID();
    branchRequestRef.current = requestId;
    setSuggestingBranch(true);
    try {
      const result = await window.agentmat.git.suggestBranchName(projectId, requestId);
      if (result.cancelled) return;
      if (result.ok && result.text?.trim()) {
        setBranchName(sanitizeBranchName(result.text));
      } else {
        toast.error(result.error || 'The CLI did not return a branch name.');
      }
    } finally {
      branchRequestRef.current = null;
      setSuggestingBranch(false);
    }
  }

  async function handleSuggestCommitMessage(): Promise<void> {
    const requestId = crypto.randomUUID();
    commitRequestRef.current = requestId;
    setSuggestingCommit(true);
    try {
      const result = await window.agentmat.git.suggestCommitMessage(projectId, requestId);
      if (result.cancelled) return;
      if (result.ok && result.text?.trim()) {
        setCommitMessage(sanitizeCommitMessage(result.text));
      } else {
        toast.error(result.error || 'The CLI did not return a commit message.');
      }
    } finally {
      commitRequestRef.current = null;
      setSuggestingCommit(false);
    }
  }

  if (statusQuery.isLoading) {
    return <GitTabSkeleton />;
  }

  if (!statusQuery.data?.isRepo) {
    return (
      <>
        <GitCloneEmptyState
          projectId={projectId}
          repoUrl={repoUrl}
          onInitialize={() => setSetupOpen(true)}
        />

        <GitSetupWizard
          projectId={projectId}
          folderPath={folderPath}
          isRepo={false}
          currentBranch={null}
          open={setupOpen}
          onOpenChange={setSetupOpen}
        />
      </>
    );
  }

  const status = statusQuery.data;
  // Git serialises on the repo's index, so one running command locks the other buttons out.
  // Only the button that was clicked shows the spinner, the rest just grey out.
  const anyOpPending =
    fetchMutation.isPending ||
    pullMutation.isPending ||
    pushMutation.isPending ||
    syncMutation.isPending ||
    createBranchMutation.isPending ||
    checkoutBranchMutation.isPending ||
    setDefaultBranchMutation.isPending ||
    renameBranchMutation.isPending ||
    deleteBranchMutation.isPending ||
    commitMutation.isPending;

  const pullPrimary = status.hasRemote && status.behind > 0 && status.ahead === 0;
  const pushPrimary = status.hasRemote && status.ahead > 0 && status.behind === 0;
  const tagInfo = tagsQuery.data;
  const commitsSince = tagInfo?.commitsSinceLatestTag ?? 0;
  const branchOptions = gitBranchOptions(
    status.branches ?? [],
    status.branch,
    status.defaultBranch,
  );
  const defaultBranchOptions = gitBranchOptions(
    status.hasRemote
      ? (status.branches ?? []).filter((branch) => branch.remote)
      : (status.branches ?? []),
    status.branch,
    status.defaultBranch,
  );
  const defaultBranchValue = defaultBranchPick || status.defaultBranch || '';
  const canSetDefault =
    status.hasRemote && Boolean(defaultBranchValue) && defaultBranchValue !== status.defaultBranch;
  const listedBranches = [...(status.branches ?? [])].sort((a, b) => {
    if (a.name === status.branch) return -1;
    if (b.name === status.branch) return 1;
    if (a.name === status.defaultBranch) return -1;
    if (b.name === status.defaultBranch) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-2">
      <div className={cn(PROJECT_CARD, 'flex flex-wrap items-center justify-between gap-3 p-4')}>
        <div className="flex min-w-0 items-center gap-3">
          <GitIconWell>
            <GitBranch className="h-4 w-4" />
          </GitIconWell>
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <Combobox
                options={branchOptions}
                value={status.branch ?? ''}
                onChange={(name) => {
                  if (!name || name === status.branch) return;
                  checkoutBranchMutation.mutate(name);
                }}
                placeholder={status.branch ?? 'detached HEAD'}
                searchPlaceholder="Search branches…"
                emptyText="Fetch to see remote branches, or create one below."
                disabled={anyOpPending}
                className="h-8 w-[min(20rem,100%)] font-mono text-sm font-semibold"
              />
              {checkoutBranchMutation.isPending ? (
                <Spinner className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              {status.branch ? (
                <SimpleTooltip label="Chart and history">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={anyOpPending}
                    onClick={() => setHistoryBranch(status.branch)}
                    aria-label="Branch chart and history"
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {status.hasRemote && status.ahead === 0 && status.behind === 0 && (
                <ToneChip tone="success">
                  <CircleCheck /> In sync
                </ToneChip>
              )}
              {status.hasRemote && status.ahead > 0 && (
                <ToneChip tone="warning">
                  <ArrowUp /> {status.ahead} ahead
                </ToneChip>
              )}
              {status.hasRemote && status.behind > 0 && (
                <ToneChip tone="warning">
                  <ArrowDown /> {status.behind} behind
                </ToneChip>
              )}
              {!status.hasRemote && (
                <ToneChip>
                  <LinkOff /> No remote
                </ToneChip>
              )}
              {status.files.length > 0 ? (
                <ToneChip>
                  {status.files.length} changed file{status.files.length === 1 ? '' : 's'}
                </ToneChip>
              ) : (
                <ToneChip tone="success">Clean</ToneChip>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {diffrayInstalled && (
            <Button variant="soft" onClick={onReviewWithDiffray} disabled={anyOpPending}>
              <GitPullRequest /> Review with diffray
            </Button>
          )}
          <GitOpButton
            pill
            size="sm"
            variant="soft"
            icon={CloudDownload}
            label="Fetch"
            pendingLabel="Fetching…"
            pending={fetchMutation.isPending}
            disabled={anyOpPending}
            onClick={() => fetchMutation.mutate()}
          />
          <GitOpButton
            pill
            size="sm"
            variant={pullPrimary ? undefined : 'soft'}
            icon={Download}
            label="Pull"
            pendingLabel="Pulling…"
            pending={pullMutation.isPending}
            disabled={anyOpPending || !status.hasRemote}
            onClick={() => pullMutation.mutate()}
          />
          <GitOpButton
            pill
            size="sm"
            variant={pushPrimary ? undefined : 'soft'}
            icon={CloudUpload}
            label="Push"
            pendingLabel="Pushing…"
            pending={pushMutation.isPending}
            disabled={anyOpPending || !status.hasRemote}
            onClick={() => pushMutation.mutate()}
          />
          {status.hasRemote ? (
            <GitOpButton
              pill
              size="sm"
              variant={pullPrimary || pushPrimary ? 'soft' : undefined}
              icon={RefreshCw}
              label="Sync"
              pendingLabel="Syncing…"
              pending={syncMutation.isPending}
              disabled={anyOpPending}
              onClick={() => syncMutation.mutate()}
            />
          ) : (
            <Button onClick={() => setSetupOpen(true)}>
              <CloudUpload className="h-3.5 w-3.5" /> Connect to GitHub
            </Button>
          )}
        </div>
      </div>

      {status.files.length > 0 && (
        <div className={cn(PROJECT_CARD, 'space-y-2.5 p-4')}>
          <div className="flex items-center gap-2">
            <p className={SECTION_HEADING}>Changed files</p>
            <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
              {status.files.length}
            </span>
          </div>
          <OverflowScroll className="max-h-56 space-y-px pr-1" surface="card">
            {status.files.map((file) => {
              const kind = gitFileKind(file.x, file.y);
              const { dir, name } = splitGitPath(file.path);
              const tone = gitFileTone(kind);
              return (
                <SimpleTooltip key={file.path} label={file.path}>
                  <div className="relative flex items-center justify-between gap-2 rounded-lg py-1.5 pl-3 pr-1.5 transition-colors hover:bg-foreground/[0.05]">
                    {/* A coloured edge, drawn as its own mark: a border colour would lose to
                        the theme's global border rule. */}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full',
                        tone === 'destructive' && 'bg-destructive',
                        tone === 'success' && 'bg-success',
                        tone === 'warning' && 'bg-warning',
                        tone === 'primary' && 'bg-primary',
                        tone === 'neutral' && 'bg-muted-foreground/50',
                      )}
                    />
                    <p className="min-w-0 truncate font-mono text-xs">
                      {dir ? <span className="text-muted-foreground">{dir}</span> : null}
                      <span className="text-foreground">{name}</span>
                    </p>
                    <GitStatusBadge kind={kind} />
                  </div>
                </SimpleTooltip>
              );
            })}
          </OverflowScroll>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className={cn(PROJECT_CARD, 'space-y-3 p-4')}>
          <div className="flex items-start gap-3">
            <GitIconWell>
              <GitBranch className="h-4 w-4" />
            </GitIconWell>
            <div className="min-w-0">
              <p className="text-sm font-medium">Branches</p>
              <p className="text-xs text-muted-foreground">
                Create one from the current HEAD, or change the default used for pull requests.
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-branch-name">New branch</Label>
            {/* The name and Create share one pill, like the API Client's URL bar. */}
            <div className="search-pill flex h-10 items-center gap-1 rounded-full p-1 pl-3.5 transition-colors">
              <input
                id="git-branch-name"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && branchName.trim() && !anyOpPending) {
                    e.preventDefault();
                    createBranchMutation.mutate(branchName);
                  }
                }}
                placeholder="feat/my-change"
                spellCheck={false}
                autoComplete="off"
                className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
              />
              <GitOpButton
                pill
                size="sm"
                label="Create"
                pendingLabel="Creating…"
                pending={createBranchMutation.isPending}
                disabled={anyOpPending || !branchName.trim()}
                onClick={() => createBranchMutation.mutate(branchName)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AiSuggestButton
              pill
              size="sm"
              label="Suggest with AI"
              pendingLabel="Thinking…"
              pendingTooltip="Generating a branch name, click to cancel"
              pending={suggestingBranch}
              disabled={status.files.length === 0}
              onStart={() => void handleSuggestBranchName()}
              onCancel={() =>
                cancelSuggestion(branchRequestRef, window.agentmat.git.cancelSuggestBranchName)
              }
            />
          </div>
          <Separator />
          <div className="space-y-1.5">
            <Label>Default branch</Label>
            <p className="text-xs text-muted-foreground">
              {status.hasRemote
                ? 'Must already exist on the remote. GitHub is updated when the GitHub CLI is signed in.'
                : 'Connect a remote before changing the default branch.'}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Combobox
                options={defaultBranchOptions}
                value={defaultBranchValue}
                onChange={setDefaultBranchPick}
                placeholder={status.defaultBranch ?? 'Select a branch'}
                searchPlaceholder="Search branches…"
                emptyText={
                  status.hasRemote
                    ? 'Fetch to see remote branches.'
                    : 'No local branches to choose from.'
                }
                disabled={anyOpPending || !status.hasRemote || defaultBranchOptions.length === 0}
                className="font-mono"
              />
              <SimpleTooltip
                label={
                  !status.hasRemote
                    ? 'Connect a remote before changing the default branch.'
                    : !canSetDefault
                      ? 'This is already the default branch.'
                      : null
                }
                wrapTrigger
              >
                <GitOpButton
                  pill
                  size="sm"
                  label="Set default"
                  pendingLabel="Updating…"
                  pending={setDefaultBranchMutation.isPending}
                  disabled={anyOpPending || !canSetDefault}
                  onClick={() => setDefaultBranchMutation.mutate(defaultBranchValue)}
                />
              </SimpleTooltip>
            </div>
          </div>
          {listedBranches.length > 0 ? (
            <>
              <Separator />
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Label>All branches</Label>
                  <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                    {listedBranches.length}
                  </span>
                </div>
                <OverflowScroll className="max-h-56 space-y-px pr-1" surface="card">
                  {listedBranches.map((branch) => {
                    const isCurrent = branch.name === status.branch;
                    const isDefault = branch.name === status.defaultBranch;
                    const canDelete = !isCurrent && !isDefault;
                    return (
                      <div
                        key={branch.name}
                        className="flex h-8 items-center gap-1 rounded-lg pl-2 pr-0.5 transition-colors hover:bg-foreground/[0.05]"
                      >
                        {/* The tooltip sits on a wrapper so it still shows while the button is
                            disabled, which it is for the branch you are already on. */}
                        <SimpleTooltip
                          label={isCurrent ? 'Current branch' : `Switch to ${branch.name}`}
                        >
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              className={cn(
                                'block w-full truncate text-left font-mono text-xs disabled:cursor-default',
                                isCurrent && 'font-semibold text-primary',
                              )}
                              disabled={anyOpPending || isCurrent}
                              onClick={() => checkoutBranchMutation.mutate(branch.name)}
                            >
                              {branch.name}
                            </button>
                          </div>
                        </SimpleTooltip>
                        <div className="flex shrink-0 items-center gap-1">
                          {isCurrent ? <ToneChip tone="primary">current</ToneChip> : null}
                          {isDefault ? <ToneChip>default</ToneChip> : null}
                          {!branch.local && branch.remote ? <ToneChip>remote</ToneChip> : null}
                          <SimpleTooltip label="Chart and history">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={anyOpPending}
                              onClick={() => setHistoryBranch(branch.name)}
                              aria-label={`History of ${branch.name}`}
                            >
                              <History className="h-3.5 w-3.5" />
                            </Button>
                          </SimpleTooltip>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={anyOpPending}
                                aria-label={`Actions for ${branch.name}`}
                              >
                                <EllipsisVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setHistoryBranch(branch.name)}>
                                <History className="h-4 w-4" /> History
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!branch.local}
                                onSelect={() => {
                                  setRenameTarget(branch);
                                  setRenameTo(branch.name);
                                  setRenameRemote(branch.remote);
                                }}
                              >
                                <Pencil className="h-4 w-4" /> Rename
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={!canDelete}
                                tone="danger"
                                onSelect={() => {
                                  setDeleteTarget(branch);
                                  setDeleteRemote(!branch.local && branch.remote);
                                  setDeleteForce(false);
                                }}
                              >
                                <Trash2 className="h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    );
                  })}
                </OverflowScroll>
              </div>
            </>
          ) : null}
        </div>

        <div
          className={cn(
            PROJECT_CARD,
            'space-y-3 p-4',
            status.files.length > 0 && 'ring-1 ring-primary/25',
          )}
        >
          <div className="flex items-start gap-3">
            <GitIconWell>
              <GitCommit className="h-4 w-4" />
            </GitIconWell>
            <div className="min-w-0">
              <p className="text-sm font-medium">Commit changes</p>
              <p className="text-xs text-muted-foreground">
                {status.files.length > 0
                  ? `${status.files.length} file${status.files.length === 1 ? '' : 's'} will be included.`
                  : 'Working tree is clean. Nothing to commit.'}
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-commit-message">Commit message</Label>
            {/* The message and the commit button are one composed field, like the Prompt
                Builder's request: write at the top, act from the bottom row. */}
            <div className="search-pill flex flex-col rounded-[1.25rem] transition-colors">
              <GrammarTextarea
                id="git-commit-message"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Describe what changed…"
                rows={3}
                disabled={status.files.length === 0}
                className="min-h-[5rem] resize-none rounded-[1.25rem] border-0 bg-transparent px-4 pt-3 shadow-none focus-visible:ring-0"
              />
              <div className="flex flex-wrap items-center gap-1.5 p-1.5 pl-2">
                <AiSuggestButton
                  pill
                  size="sm"
                  label="Suggest with AI"
                  pendingLabel="Thinking…"
                  pendingTooltip="Writing a commit message, click to cancel"
                  pending={suggestingCommit}
                  disabled={status.files.length === 0}
                  onStart={() => void handleSuggestCommitMessage()}
                  onCancel={() =>
                    cancelSuggestion(
                      commitRequestRef,
                      window.agentmat.git.cancelSuggestCommitMessage,
                    )
                  }
                />
                <span className="ml-auto">
                  <GitOpButton
                    pill
                    size="sm"
                    label="Commit all changes"
                    pendingLabel="Committing…"
                    pending={commitMutation.isPending}
                    disabled={anyOpPending || !commitMessage.trim() || status.files.length === 0}
                    onClick={() => commitMutation.mutate(commitMessage)}
                  />
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className={cn(PROJECT_CARD, 'flex flex-col gap-3 p-4')}>
          <div className="flex items-start gap-3">
            <GitIconWell>
              <Tag className="h-4 w-4" />
            </GitIconWell>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Version tag</p>
              {tagInfo?.latestTag ? (
                <p className="text-xs text-muted-foreground">
                  Latest <span className="font-mono text-foreground">{tagInfo.latestTag}</span>
                  {commitsSince > 0
                    ? ` · ${commitsSince} commit${commitsSince === 1 ? '' : 's'} since`
                    : ' · HEAD is on this tag'}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">No tags in this repository yet.</p>
              )}
            </div>
          </div>
          {tagInfo && tagInfo.recentTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tagInfo.recentTags.slice(0, 4).map((existing) => (
                <ToneChip
                  key={existing}
                  tone={existing === tagInfo.latestTag ? 'primary' : 'neutral'}
                  className="font-mono text-[10px]"
                >
                  {existing}
                </ToneChip>
              ))}
            </div>
          )}
          <Button variant="soft" className="mt-auto self-start" onClick={() => setTagOpen(true)}>
            <Tag className="h-3.5 w-3.5" /> Tag a version
          </Button>
        </div>

        <div className={cn(PROJECT_CARD, 'flex flex-col gap-3 p-4')}>
          <div className="flex items-start gap-3">
            <GitIconWell>
              <GitPullRequest className="h-4 w-4" />
            </GitIconWell>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Pull request</p>
              <p className="text-xs text-muted-foreground">
                Pushes this branch and opens a pull request with the GitHub CLI, or the compare page
                in your browser if it isn't installed.
              </p>
            </div>
          </div>
          <SimpleTooltip
            label={!status.hasRemote ? 'Connect a remote before opening a pull request.' : null}
            wrapTrigger
          >
            <Button
              variant="soft"
              className="mt-auto self-start"
              onClick={() => setPrOpen(true)}
              disabled={!status.hasRemote}
            >
              <GitPullRequest className="h-3.5 w-3.5" /> Create pull request
            </Button>
          </SimpleTooltip>
        </div>
      </div>

      {status.hasRemote ? <GitActionsCard projectId={projectId} muted={mutedActions} /> : null}

      <GitSetupWizard
        projectId={projectId}
        folderPath={folderPath}
        isRepo
        currentBranch={status.branch}
        open={setupOpen}
        onOpenChange={setSetupOpen}
      />

      <TagVersionDialog
        projectId={projectId}
        tagInfo={tagsQuery.data ?? null}
        status={status}
        open={tagOpen}
        onOpenChange={setTagOpen}
        onApplyVersion={(nextTag) => {
          // Swap dialogs rather than stacking them; the tag dialog keeps its fields for after.
          setTagOpen(false);
          setApplyVersionTag(nextTag);
        }}
      />

      <ApplyVersionDialog
        projectId={projectId}
        tag={applyVersionTag}
        open={applyVersionTag !== null}
        onOpenChange={(next) => {
          if (!next) setApplyVersionTag(null);
        }}
        onBackToTag={() => {
          setApplyVersionTag(null);
          setTagOpen(true);
        }}
      />

      <CreatePrDialog
        projectId={projectId}
        branch={status.branch}
        defaultBranch={status.defaultBranch}
        branches={status.branches ?? []}
        open={prOpen}
        onOpenChange={setPrOpen}
        suggestedTitle={commitMessage.split('\n')[0]}
      />

      <GitBranchHistoryDialog
        projectId={projectId}
        branch={historyBranch}
        open={historyBranch !== null}
        onOpenChange={(next) => {
          if (!next) setHistoryBranch(null);
        }}
      />

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRenameTarget(null);
            setRenameTo('');
            setRenameRemote(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>
              From <span className="font-mono">{renameTarget?.name}</span> to a new name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="git-rename-branch">New name</Label>
              <Input
                id="git-rename-branch"
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                className="font-mono"
                placeholder="feat/new-name"
              />
            </div>
            {renameTarget?.remote ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={renameRemote}
                  onCheckedChange={(checked) => setRenameRemote(checked === true)}
                />
                Also rename it on the remote
              </label>
            ) : null}
          </div>
          <DialogFooter>
            <GitOpButton
              size="sm"
              icon={Pencil}
              label="Rename"
              pendingLabel="Renaming…"
              pending={renameBranchMutation.isPending}
              disabled={
                anyOpPending ||
                !renameTo.trim() ||
                renameTo.trim().replace(/\s+/g, '-') === renameTarget?.name
              }
              onClick={() => renameBranchMutation.mutate()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
            setDeleteRemote(false);
            setDeleteForce(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete branch</DialogTitle>
            <DialogDescription>
              {deleteTarget && !deleteTarget.local && deleteTarget.remote
                ? `This removes '${deleteTarget.name}' on the remote.`
                : `This removes '${deleteTarget?.name ?? 'this branch'}' from the local repository.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {deleteTarget?.local && deleteTarget.remote ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={deleteRemote}
                  onCheckedChange={(checked) => setDeleteRemote(checked === true)}
                />
                Also delete it on the remote
              </label>
            ) : null}
            {deleteTarget?.local ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={deleteForce}
                  onCheckedChange={(checked) => setDeleteForce(checked === true)}
                />
                Delete even if it is not merged
              </label>
            ) : null}
          </div>
          <DialogFooter>
            <GitOpButton
              size="sm"
              variant="destructive"
              icon={Trash2}
              label="Delete branch"
              pendingLabel="Deleting…"
              pending={deleteBranchMutation.isPending}
              disabled={anyOpPending}
              onClick={() => deleteBranchMutation.mutate()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Runs the version bump in place and reports back here, rather than handing the user off
 * to a terminal. The CLI edits files with its write flags enabled, so the "Files changed"
 * list below comes from git's own before/after view of the working tree, not the CLI's word.
 */
function ApplyVersionDialog({
  projectId,
  tag,
  open,
  onOpenChange,
  onBackToTag,
}: {
  projectId: string;
  tag: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBackToTag: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const startedForRef = useRef<string | null>(null);
  const mutationKey = ['applyVersion', projectId] as const;

  const applyMutation = useMutation({
    mutationKey,
    // Well past the run's own timeout, so a result reached through a "Review" click on a
    // notification (fired minutes after the run settles) still finds it in the cache.
    gcTime: 30 * 60 * 1000,
    mutationFn: ({ tag: versionTag, requestId }: { tag: string; requestId: string }) =>
      window.agentmat.git.applyVersion({ projectId, tag: versionTag, requestId }),
    onSettled: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
      // Fires even if this dialog (or the project it belongs to) has since gone off screen,
      // so a run left to finish in the background still tells the user when it's done.
      if (!result || result.cancelled) return;
      const changeCount = result.changes.length;
      const reviewAction = {
        label: 'Review',
        onClick: () => {
          window.location.hash = `#/workspace/${projectId}`;
          useVersionDialogStore.getState().open(projectId);
        },
      };
      if (result.ok) {
        toast.success('Version files updated', {
          description: `${changeCount} file${changeCount === 1 ? '' : 's'} changed. Review and commit when ready.`,
          action: reviewAction,
        });
      } else {
        toast.error('Updating version files failed', {
          description: displayCliOutput(result.error ?? 'Unknown error.'),
          action: reviewAction,
        });
      }
    },
    meta: GIT_OP_META,
  });

  // The newest run for this project, however it was started, so closing this dialog (or
  // leaving the Workspace entirely) and coming back still finds a run that kept going in
  // the background instead of losing track of it.
  const runs = useMutationState({
    filters: { mutationKey, exact: true },
    select: (m) => ({
      status: m.state.status,
      variables: m.state.variables as { tag: string; requestId: string } | undefined,
      data: m.state.data as ApplyVersionResult | undefined,
      error: m.state.error,
    }),
  });
  const currentRun = [...runs].reverse().find((run) => run.variables?.tag === tag);

  // The tag lands on HEAD, so the version bump this dialog just wrote has to be committed first
  // or the tag points at a commit that still has the old version (TagVersionDialog checks).
  // Only the files the user kept go in, so nothing else lying around the tree gets swept up.
  const commitMutation = useMutation({
    mutationFn: ({ message, paths }: { message: string; paths: string[] }) =>
      window.agentmat.git.commit(projectId, message, paths),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
    },
    meta: GIT_OP_META,
  });

  const { mutate } = applyMutation;

  // The run starts as soon as the dialog opens: the user already asked for it by clicking
  // "Update version in files". The ref guards against a re-run on unrelated re-renders, and
  // a run already in the cache for this exact tag is resumed instead of duplicated. currentRun
  // is read but deliberately left out of the deps below, or this would fire again the instant
  // the run it just started lands in the cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open || !tag) {
      startedForRef.current = null;
      return;
    }
    if (startedForRef.current === tag) return;
    startedForRef.current = tag;
    if (currentRun) return;
    mutate({ tag, requestId: crypto.randomUUID() });
  }, [open, tag, mutate]);

  function handleCancel(): void {
    const requestId = currentRun?.variables?.requestId;
    if (!requestId) return;
    void window.agentmat.git.cancelApplyVersion(requestId);
  }

  function handleRetry(): void {
    if (!tag) return;
    startedForRef.current = tag;
    commitMutation.reset();
    mutate({ tag, requestId: crypto.randomUUID() });
  }

  const result = currentRun?.data;
  const changes = result?.changes ?? [];
  // Decisions belong to one run's file list; a fresh run starts the review over.
  const [reviews, setReviews] = useState<VersionReviews>({});
  // Choices show before they reach disk, and a commit in between would miss them.
  const [savingReview, setSavingReview] = useState(false);
  useEffect(() => {
    if (result) setReviews({});
  }, [result]);
  // A file with only some of its changes kept is committed as it now sits on disk.
  const keptPaths = changes
    .filter((change) => {
      const decision = fileDecision(change, reviews[change.path]);
      return decision === 'keep' || decision === 'partial';
    })
    .map((change) => change.path);
  const undecidedCount = changes.filter(
    (change) => !fileDecision(change, reviews[change.path]),
  ).length;
  const committed = commitMutation.isSuccess && commitMutation.data.ok;
  // A failed commit stays on screen until the next try. As a toast alone it was easy to miss,
  // and then "Back to tag" led straight into tagging a commit without the new version.
  const commitError =
    commitMutation.isSuccess && !commitMutation.data.ok
      ? commitMutation.data.message
      : commitMutation.isError
        ? commitMutation.error.message
        : null;

  const isApplying = currentRun?.status === 'pending';
  const failed = currentRun?.status === 'error' || (result && !result.ok && !result.cancelled);
  const didNothing = !!result?.ok && changes.length === 0 && !result.committedByCli;
  const canRetry = Boolean(failed || result?.cancelled || didNothing || result?.warning);
  const cliOutput = result?.output ? displayCliOutput(result.output) : '';
  const warningText = result?.warning ? displayCliOutput(result.warning) : '';
  const errorText = displayCliOutput(
    result?.error ?? (currentRun?.error as Error | null)?.message ?? 'Unknown error.',
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Update version in files</DialogTitle>
          <DialogDescription>
            Setting the version to <span className="font-mono">{tag}</span> in every file of the
            repository. Keep what belongs to this release and revert the rest, a whole file or one
            change inside it at a time.
          </DialogDescription>
        </DialogHeader>

        <OverflowScroll fill className="-mx-1 space-y-3 px-1">
          {isApplying && (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-3">
              <Spinner className="h-4 w-4 animate-spin text-primary" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Updating version strings</p>
                <p className="text-xs text-muted-foreground">
                  Your CLI is searching the repo and editing manifests. This can take several
                  minutes. Feel free to close this and keep working, you'll get a notification when
                  it's done.
                </p>
              </div>
            </div>
          )}

          {result?.cancelled && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                Cancelled. Any edits already written are listed below.
              </p>
              <Button variant="soft" size="sm" onClick={handleRetry}>
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </Button>
            </div>
          )}

          {failed && (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-destructive">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> The run failed
                </p>
                <Button
                  variant="soft"
                  size="sm"
                  onClick={handleRetry}
                  className="shrink-0 self-start sm:self-auto"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </Button>
              </div>
              {/* CLI failures can dump a whole transcript, so the message gets its
                  own scroll box instead of pushing the rest of the dialog around. */}
              <pre className="max-h-40 overflow-y-auto overscroll-contain text-xs break-words whitespace-pre-wrap text-muted-foreground">
                {errorText}
              </pre>
            </div>
          )}

          {/* The bump landed but the CLI still ended badly, so the file list below may be
              only part of what the version touched. */}
          {warningText && (
            <div className="space-y-1.5 rounded-xl border border-warning/30 bg-warning/10 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" /> The CLI stopped
                  early
                </p>
                <Button
                  variant="soft"
                  size="sm"
                  onClick={handleRetry}
                  className="shrink-0 self-start sm:self-auto"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Run again
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {warningText} The files below were already updated, so check whether anything is
                missing before you commit.
              </p>
            </div>
          )}

          {result && changes.length > 0 && (
            <div className="space-y-2">
              <VersionChangeReview
                projectId={projectId}
                changes={changes}
                reviews={reviews}
                onReviewsChange={setReviews}
                onSavingChange={setSavingReview}
                locked={committed || commitMutation.isPending}
              />
              {commitError && !commitMutation.isPending && (
                <div
                  role="alert"
                  className="space-y-1 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5"
                >
                  <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> The commit failed, so nothing
                    was committed
                  </p>
                  <pre className="max-h-32 overflow-y-auto overscroll-contain text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
                    {commitError}
                  </pre>
                </div>
              )}
              {committed ? (
                <div className="flex items-start gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2.5">
                  <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  <p className="text-xs text-muted-foreground">
                    Committed. Tagging is unlocked. Use "Back to tag" to continue.
                  </p>
                </div>
              ) : undecidedCount === 0 && keptPaths.length === 0 ? (
                <div className="flex items-start gap-2 rounded-xl border border-border bg-card/60 px-3 py-2.5">
                  <Undo className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    Every change was reverted, so there is nothing to commit. Run it again or go
                    back to tag.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center">
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {undecidedCount > 0
                      ? `Keep or revert ${undecidedCount === 1 ? 'the last file' : `the ${undecidedCount} files left`} to commit. Tagging stays locked until then.`
                      : 'Tagging is locked until the kept files are committed.'}
                  </p>
                  <SimpleTooltip
                    label={
                      undecidedCount > 0
                        ? 'Review every file first.'
                        : savingReview
                          ? 'Saving your picks to disk…'
                          : null
                    }
                    wrapTrigger
                  >
                    <GitOpButton
                      size="sm"
                      icon={GitCommit}
                      label={
                        keptPaths.length > 0
                          ? `Commit ${keptPaths.length} kept file${keptPaths.length === 1 ? '' : 's'}`
                          : 'Commit version bump'
                      }
                      pendingLabel="Committing…"
                      pending={commitMutation.isPending}
                      disabled={undecidedCount > 0 || keptPaths.length === 0 || savingReview}
                      onClick={() =>
                        tag &&
                        commitMutation.mutate({
                          message: releaseCommitMessage(tag),
                          paths: keptPaths,
                        })
                      }
                    />
                  </SimpleTooltip>
                </div>
              )}
            </div>
          )}

          {result?.ok && changes.length === 0 && result.committedByCli && (
            <div className="flex items-start gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2.5">
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <p className="text-sm text-muted-foreground">
                Your CLI committed the version bump itself (some version tools do this on their
                own). Tagging is unlocked. Use "Back to tag" to continue.
              </p>
            </div>
          )}

          {didNothing && (
            <div className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                The run finished without changing any files. The version may already be set, or the
                CLI could not find where it lives.
              </p>
              <Button variant="soft" size="sm" onClick={handleRetry}>
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </Button>
            </div>
          )}

          {cliOutput && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {result?.cliName ?? 'CLI'} output
              </p>
              <pre className="max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card/60 p-3 text-xs break-words whitespace-pre-wrap">
                {cliOutput}
              </pre>
            </div>
          )}
        </OverflowScroll>

        <DialogFooter>
          {isApplying ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close, keep it running
              </Button>
              <Button variant="danger" onClick={handleCancel}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </>
          ) : (
            <>
              {canRetry ? (
                <Button variant="soft" onClick={handleRetry}>
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
              ) : null}
              <Button onClick={onBackToTag}>
                <Tag className="h-4 w-4" /> Back to tag
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TagVersionDialog({
  projectId,
  tagInfo,
  status,
  open,
  onOpenChange,
  onApplyVersion,
}: {
  projectId: string;
  tagInfo: GitTagInfo | null;
  status: GitStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hands the entered tag to the apply-version dialog. */
  onApplyVersion: (tag: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  /**
   * The form lives in the store, not in this component, because this component is unmounted
   * far more often than the flow is finished: handing off to "Update version in files" and
   * coming back, switching Workspace projects while a run goes on, or following the run's
   * completion toast from the project page to the Workspace all throw it away. Anything typed
   * here (an AI suggestion most of all) has to still be there when the user gets back.
   *
   * The tag is edited in two halves: the prefix names the tag series ("v", "web-v", ...),
   * the version is the number itself. They only ever meet as `tag`.
   */
  const draft = useVersionDialogStore((s) => s.drafts[projectId] ?? EMPTY_TAG_DRAFT);
  const patchDraft = useVersionDialogStore((s) => s.patchDraft);
  const clearDraft = useVersionDialogStore((s) => s.clearDraft);
  const { version, message, reason, updatedVersionFor } = draft;
  // A prefix of null means nothing has been chosen yet, and the effect below fills it in.
  const prefix = draft.prefix ?? 'v';
  const setVersion = (next: string): void => patchDraft(projectId, { version: next });
  const setMessage = (next: string): void => patchDraft(projectId, { message: next });
  const setReason = (next: string | null): void => patchDraft(projectId, { reason: next });
  const suggestRequestRef = useRef<string | null>(null);
  const confirmingSkipRef = useRef(false);

  const trimmedPrefix = prefix.trim();
  const tag = `${trimmedPrefix}${version.trim()}`;

  // Tag state for the series being released: its own latest tag and recent tags. Keyed on the
  // prefix exactly as typed, so the numbers always describe the tag on screen.
  const prefixTagsQuery = useQuery({
    queryKey: queryKeys.gitTagsForPrefix(projectId, trimmedPrefix),
    queryFn: () => window.agentmat.git.tags(projectId, trimmedPrefix),
    enabled: open,
    meta: GIT_REFRESH_META,
  });
  const prefixInfo = prefixTagsQuery.data ?? null;
  const latestTag = prefixInfo?.latestTag ?? null;
  const commitsSince = prefixInfo?.commitsSinceLatestTag ?? 0;
  const recentTags = prefixInfo?.recentTags ?? [];
  const knownPrefixes = tagInfo?.prefixes ?? [];

  /** The only way the prefix changes. It is remembered right away, not just after a tag. */
  function handlePrefixInput(next: string): void {
    patchDraft(projectId, { prefix: next });
    storeTagPrefix(projectId, next.trim());
  }

  // Until the user chooses, the prefix is the one they last used for this project. Without one
  // it is the plain style ("v", or bare for repos that tag "1.2.3"), never the prefix of
  // whichever series happened to be tagged last: in a repo with `web-v` and `app-v` tags that
  // would hand the user the wrong series.
  const tagInfoLoaded = tagInfo !== null;
  const plainPrefix = !tagInfo
    ? 'v'
    : tagInfo.prefixes.includes('v')
      ? 'v'
      : tagInfo.prefixes.includes('')
        ? ''
        : tagInfo.prefixes.length === 1
          ? tagInfo.prefixes[0]
          : 'v';
  // Nothing to restore once the draft holds a prefix: one the user typed or picked, or the one
  // this effect already put there. That is what keeps the field intact when the dialog comes
  // back from "Update version in files".
  const prefixChosen = draft.prefix !== null;
  useEffect(() => {
    if (!open || prefixChosen || !tagInfoLoaded) return;
    patchDraft(projectId, { prefix: readStoredTagPrefix(projectId) ?? plainPrefix });
  }, [open, prefixChosen, tagInfoLoaded, plainPrefix, projectId, patchDraft]);

  const hasRemote = tagInfo?.hasRemote ?? false;
  // `git tag` and the push after it act on HEAD, not the working tree, so a dirty tree never
  // stops either one. This is only a heads-up: reverting a file that had edits of its own
  // before the version bump ran (see VersionChangeReview) leaves it dirty on purpose, and that
  // used to block tagging entirely even though nothing about the tag itself needed it clean.
  const dirtyFileCount = status?.files.length ?? 0;
  const isDirty = dirtyFileCount > 0;
  const bumpOptions = (['patch', 'minor', 'major'] as const).map((kind) => ({
    kind,
    label: `${kind[0].toUpperCase()}${kind.slice(1)}`,
    hint: BUMP_HINTS[kind],
    next: bumpSemverVersion(latestTag, kind),
  }));

  // The prefix alone is not a tag. Everything that acts on the tag keys off the version
  // field, so an empty version can't create a tag literally named "v".
  const trimmedVersion = version.trim();
  const looksSemver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmedVersion);
  const createTagMutation = useMutation({
    mutationFn: (nextTag: string) =>
      window.agentmat.git.createTag({ projectId, tag: nextTag, message, push: hasRemote }),
    onSuccess: (result, nextTag) => {
      if (result.ok) {
        toast.success(result.message);
        storeTagPrefix(projectId, splitTag(nextTag)?.prefix ?? trimmedPrefix);
        void queryClient.invalidateQueries({ queryKey: queryKeys.gitTags(projectId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
        handleOpenChange(false);
      } else {
        toast.error(result.message);
      }
    },
    meta: GIT_OP_META,
  });

  // A finished create shouldn't vouch for a tag typed the next time the dialog opens.
  const { reset: resetCreateTag } = createTagMutation;
  useEffect(() => {
    if (open) resetCreateTag();
  }, [open, resetCreateTag]);

  // git writes the tag before the push is done, and the repo watcher refreshes the tag list the
  // moment it lands. The tag being created is not a duplicate of itself, so it doesn't count.
  const creatingThisTag =
    createTagMutation.variables === tag &&
    (createTagMutation.isPending || createTagMutation.data?.ok === true);
  // Only the recent tags are in hand, so this catches the common case of re-tagging
  // something that just shipped. Git still rejects any duplicate this misses.
  const tagExists = trimmedVersion.length > 0 && recentTags.includes(tag) && !creatingThisTag;
  const versionApplied = trimmedVersion.length > 0 && updatedVersionFor === tag;

  // The files "Update version in files" changed for this tag that are still uncommitted. The
  // tag goes on HEAD, so while any are left it would point at a commit with the old version.
  // A file that had edits of its own before the run stays dirty after a revert on purpose, so
  // only the ones the run alone touched count.
  const applyRuns = useMutationState({
    filters: { mutationKey: ['applyVersion', projectId], exact: true, status: 'success' },
    select: (m) => ({
      tag: (m.state.variables as { tag: string } | undefined)?.tag,
      data: m.state.data as ApplyVersionResult | undefined,
    }),
  });
  const bumpRun = versionApplied ? [...applyRuns].reverse().find((run) => run.tag === tag) : null;
  const dirtyPaths = new Set(status?.files.map((file) => file.path));
  const uncommittedBump = (bumpRun?.data?.changes ?? [])
    .filter((change) => !change.hadLocalEdits && dirtyPaths.has(change.path))
    .map((change) => change.path);
  const bumpUncommitted = uncommittedBump.length > 0;
  const blockedReason = tagExists ? `${tag} already exists. Pick another version.` : null;
  const canCreate = trimmedVersion.length > 0 && !tagExists;

  const suggestMutation = useMutation({
    mutationFn: () => {
      const requestId = crypto.randomUUID();
      suggestRequestRef.current = requestId;
      return window.agentmat.git.suggestTag(projectId, requestId, trimmedPrefix);
    },
    onSettled: () => {
      suggestRequestRef.current = null;
    },
    onSuccess: (result) => {
      if (result.cancelled) return;
      if (result.ok && result.tag) {
        const split = splitTag(result.tag);
        // The suggestion comes back with the typed prefix already on it, so only the version
        // is taken. The prefix field is the user's and a suggestion never rewrites it.
        patchDraft(projectId, {
          version: split ? split.version : result.tag,
          reason: result.reason ?? null,
          ...(result.message ? { message: result.message } : {}),
        });
        toast.success(`${result.cliName ?? 'Your CLI'} suggested ${result.tag}.`);
      } else {
        toast.error(result.error ?? 'The CLI could not work out a version.');
      }
    },
    meta: GIT_OP_META,
  });

  /** Kills the CLI process behind the running suggestion, rather than just ignoring its answer. */
  function handleCancelSuggest(): void {
    const requestId = suggestRequestRef.current;
    if (!requestId) return;
    suggestRequestRef.current = null;
    void window.agentmat.git.cancelSuggestTag(requestId);
  }

  // This dialog belongs to one project and is replaced when the user switches to another. A
  // suggestion still running then would answer into a form nobody can see, so stop it.
  useEffect(
    () => () => {
      const requestId = suggestRequestRef.current;
      if (!requestId) return;
      suggestRequestRef.current = null;
      void window.agentmat.git.cancelSuggestTag(requestId);
    },
    [],
  );

  // Only a dismissal from inside this dialog (Esc, the close button, a finished tag) lands here,
  // and that is the one thing that throws the form away. Handing off to "Update version in
  // files" closes the dialog from the parent instead, so the draft is still there, prefix
  // included, whenever and wherever the user picks the flow back up.
  function handleOpenChange(next: boolean): void {
    // The shared confirm dialog sits on top of this one. Ignore dismissals
    // that come from clicking it, so the tag form stays put.
    if (!next && confirmingSkipRef.current) return;
    if (!next) clearDraft(projectId);
    onOpenChange(next);
  }

  function handleApplyVersion(): void {
    if (!version.trim()) return;
    const next = tag.trim();
    patchDraft(projectId, { updatedVersionFor: next });
    storeTagPrefix(projectId, trimmedPrefix);
    onApplyVersion(next);
  }

  function handleCreateTag(): void {
    if (!version.trim()) return;
    const next = tag.trim();
    if (updatedVersionFor === next && !bumpUncommitted) {
      createTagMutation.mutate(next);
      return;
    }
    confirmingSkipRef.current = true;
    void confirmDialog(
      bumpUncommitted
        ? {
            title: 'Version bump not committed',
            description: `${uncommittedBump.length} file${uncommittedBump.length === 1 ? '' : 's'} from Update version in files still ${uncommittedBump.length === 1 ? 'has' : 'have'} uncommitted edits. The tag goes on the last commit, which still has the old version. Go back and use "Review and commit" first.`,
            confirmLabel: hasRemote ? 'Create & push anyway' : 'Create anyway',
            cancelLabel: 'Go back',
            variant: 'destructive',
          }
        : {
            title: 'Skip updating version in files?',
            description:
              'You have not run Update version in files for this tag. Package manifests and other version strings may still show the old version.',
            confirmLabel: hasRemote ? 'Create & push anyway' : 'Create anyway',
            cancelLabel: 'Go back',
          },
    ).then((confirmed) => {
      confirmingSkipRef.current = false;
      if (confirmed) createTagMutation.mutate(next);
    });
  }

  function handleBump(nextVersion: string): void {
    setVersion(nextVersion);
    setReason(null);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(36rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 max-h-[88vh]">
        <DialogHeader className="border-b border-border/70 px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Tag className="h-3.5 w-3.5" />
            </span>
            Tag a version
          </DialogTitle>
          <DialogDescription className="text-xs">
            {latestTag ? (
              commitsSince > 0 ? (
                <>
                  <span className="font-medium text-foreground">
                    {commitsSince} commit{commitsSince === 1 ? '' : 's'}
                  </span>{' '}
                  since <span className="font-mono">{latestTag}</span>.
                </>
              ) : (
                <>
                  Nothing new since <span className="font-mono">{latestTag}</span>. A tag here
                  points at the same commit.
                </>
              )
            ) : knownPrefixes.length > 0 ? (
              <>
                No <span className="font-mono">{trimmedPrefix || '(no prefix)'}</span> tags yet.
                Pick a first version below.
              </>
            ) : (
              'This repository has no tags yet. Pick a first version below.'
            )}
          </DialogDescription>
        </DialogHeader>
        <OverflowScroll fill className="space-y-4 px-5 py-4">
          {/* The version bump for this very tag never got committed, most often because the
              commit in "Update version in files" failed. Tagging now would ship the old
              version, so this says so and leads back to the review, where the commit is. */}
          {bumpUncommitted ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 gap-2">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    The version bump for <span className="font-mono">{tag}</span> isn't committed.
                  </span>{' '}
                  {uncommittedBump.length} updated file{uncommittedBump.length === 1 ? '' : 's'}{' '}
                  still {uncommittedBump.length === 1 ? 'has' : 'have'} uncommitted edits, so this
                  tag would point at a commit with the old version.
                </p>
              </div>
              <Button
                variant="soft"
                size="sm"
                className="shrink-0 self-start sm:self-auto"
                disabled={createTagMutation.isPending}
                onClick={handleApplyVersion}
              >
                <GitCommit className="h-3.5 w-3.5" /> Review and commit
              </Button>
            </div>
          ) : (
            isDirty && (
              <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {dirtyFileCount} uncommitted file{dirtyFileCount === 1 ? '' : 's'}.
                  </span>{' '}
                  They won't be part of this tag unless you commit them first.
                </p>
              </div>
            )
          )}

          {/* The one place the finished tag is shown, so the fields below never repeat it
              back. Anything wrong with the tag gets said here too. */}
          <div
            className={cn(
              'overflow-hidden rounded-xl border bg-card/60',
              tagExists ? 'border-destructive/40' : 'border-border',
            )}
          >
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 py-3">
              <div className="min-w-0 text-center">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Latest
                </p>
                <p className="truncate font-mono text-lg font-semibold">{latestTag ?? 'None'}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 text-center">
                <p
                  className={cn(
                    'text-[10px] font-medium uppercase tracking-wider',
                    tagExists ? 'text-destructive' : 'text-primary',
                  )}
                >
                  Next
                </p>
                <p
                  className={cn(
                    'truncate font-mono text-lg font-semibold',
                    tagExists
                      ? 'text-destructive'
                      : trimmedVersion
                        ? 'text-primary'
                        : 'text-muted-foreground',
                  )}
                >
                  {trimmedVersion ? tag : 'None'}
                </p>
              </div>
            </div>
            {tagExists ? (
              <p className="border-t border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                <span className="font-mono">{tag}</span> already exists. Pick another version.
              </p>
            ) : trimmedVersion && !looksSemver ? (
              <p className="border-t border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                Not a <span className="font-mono">major.minor.patch</span> version. It gets created
                exactly as typed.
              </p>
            ) : null}
          </div>

          {/* The AI fills in the version (and a message), so it sits with the version choices. */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">Choose a version</p>
            {suggestMutation.isPending ? (
              <AiSuggestButton
                size="sm"
                label="Suggest with AI"
                pendingLabel="Asking your CLI…"
                pendingTooltip="Reading the commits since the latest tag, click to cancel"
                pending
                onStart={() => suggestMutation.mutate()}
                onCancel={handleCancelSuggest}
              />
            ) : (
              <SimpleTooltip label="Reads the commits since the latest tag with your CLI and proposes the next semantic version">
                <AiSuggestButton
                  size="sm"
                  label="Suggest with AI"
                  pendingLabel="Asking your CLI…"
                  pendingTooltip=""
                  pending={false}
                  disabled={createTagMutation.isPending}
                  onStart={() => suggestMutation.mutate()}
                  onCancel={handleCancelSuggest}
                />
              </SimpleTooltip>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {bumpOptions.map((option) => {
              const selected = trimmedVersion === option.next;
              return (
                <button
                  key={option.kind}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${option.label} bump to ${trimmedPrefix}${option.next}`}
                  onClick={() => handleBump(option.next)}
                  className={cn(
                    'flex cursor-pointer flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border bg-card/40 text-muted-foreground hover:border-foreground/20 hover:bg-accent hover:text-foreground',
                  )}
                >
                  <span className="flex items-center gap-1 text-xs font-medium">
                    {selected && <Check className="h-3 w-3 text-primary" />}
                    {option.label}
                  </span>
                  <span className="font-mono text-[10px]">
                    {trimmedPrefix}
                    {option.next}
                  </span>
                  <span className="text-[10px] opacity-70">{option.hint}</span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-[minmax(6rem,10rem)_1fr] gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="git-tag-prefix">Prefix</Label>
              <Input
                id="git-tag-prefix"
                value={prefix}
                onChange={(e) => {
                  handlePrefixInput(e.target.value);
                  setReason(null);
                }}
                placeholder="v"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="git-tag-version">Version</Label>
              <Input
                id="git-tag-version"
                autoFocus
                value={version}
                onChange={(e) => {
                  // Pasting a whole tag into this field should still work, so a prefix
                  // typed here moves over to the prefix field instead of doubling up.
                  const split = splitTag(e.target.value);
                  if (split?.prefix) {
                    handlePrefixInput(split.prefix);
                    setVersion(split.version);
                  } else {
                    setVersion(e.target.value);
                  }
                  setReason(null);
                }}
                onKeyDown={(e) => {
                  // Enter finishes the form, the way it would in any other short dialog.
                  if (e.key !== 'Enter' || !canCreate || createTagMutation.isPending) return;
                  e.preventDefault();
                  handleCreateTag();
                }}
                placeholder="1.0.1"
                aria-invalid={tagExists}
                className="font-mono"
              />
            </div>
          </div>

          {/* Shortcuts to the prefixes this repo already tags with. Any other prefix can still
              be typed above; nothing here limits what the tag is called. */}
          {(knownPrefixes.length > 1 ||
            (knownPrefixes.length === 1 && knownPrefixes[0] !== trimmedPrefix)) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Prefixes in use</span>
              {knownPrefixes.map((known) => {
                const selected = known === trimmedPrefix;
                return (
                  <button
                    key={known || '(none)'}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      handlePrefixInput(known);
                      setVersion('');
                      setReason(null);
                    }}
                    className={cn(
                      'cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-border bg-card/40 text-muted-foreground hover:border-foreground/20 hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {known || '(no prefix)'}
                  </button>
                );
              })}
            </div>
          )}

          {reason && (
            <div className="flex gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <p className="text-xs text-muted-foreground">{reason}</p>
            </div>
          )}

          {/* Sits beside the version fields, where it answers "what have I used already?". */}
          {recentTags.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {knownPrefixes.length > 1
                  ? `Recent ${trimmedPrefix || 'unprefixed'} tags`
                  : 'Recent tags'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {recentTags.map((existing) => (
                  <Badge
                    key={existing}
                    variant={existing === latestTag ? 'secondary' : 'outline'}
                    className="font-mono text-[10px]"
                  >
                    {existing}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="git-tag-message">Tag message (optional)</Label>
            <GrammarTextarea
              id="git-tag-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="What this release contains…"
            />
          </div>

          {/* Whether this step has run for the tag on screen is the one thing the flow used
              to leave the user guessing about, so it now says so plainly. */}
          <div
            className={cn(
              'space-y-2.5 rounded-xl border p-3',
              versionApplied ? 'border-primary/40 bg-primary/5' : 'border-border bg-card/60',
            )}
          >
            <div className="flex items-start gap-3">
              <GitIconWell>
                {versionApplied ? <Check className="h-4 w-4" /> : <FileCog className="h-4 w-4" />}
              </GitIconWell>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {versionApplied ? (
                    <>
                      Files updated to <span className="font-mono">{tag}</span>
                    </>
                  ) : (
                    'Update version in files'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {versionApplied
                    ? 'Commit those edits, then create the tag.'
                    : 'Runs your CLI over every package.json, other manifest and version string in the repository. You then pick the files to keep, revert the rest, and commit before tagging.'}
                </p>
              </div>
            </div>
            <SimpleTooltip label={trimmedVersion ? null : 'Pick a version first.'} wrapTrigger>
              <Button
                variant="soft"
                size="sm"
                disabled={!trimmedVersion || createTagMutation.isPending}
                onClick={handleApplyVersion}
              >
                <FileCog className="h-3.5 w-3.5" />{' '}
                {versionApplied ? 'Run again' : 'Update version in files'}
              </Button>
            </SimpleTooltip>
          </div>
        </OverflowScroll>
        <DialogFooter className="flex-row items-center gap-3 border-t border-border/70 px-5 py-3 sm:justify-between">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <CloudUpload className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              {hasRemote
                ? 'Pushes the current branch and tag to origin.'
                : 'No remote is configured, so the tag stays local.'}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={createTagMutation.isPending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <SimpleTooltip
              label={trimmedVersion ? blockedReason : 'Pick a version first.'}
              wrapTrigger
            >
              <GitOpButton
                icon={Tag}
                size="sm"
                label={hasRemote ? 'Create & push tag' : 'Create tag'}
                pendingLabel={hasRemote ? 'Creating & pushing…' : 'Creating tag…'}
                pending={createTagMutation.isPending}
                disabled={!canCreate}
                onClick={handleCreateTag}
              />
            </SimpleTooltip>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreatePrDialog({
  projectId,
  branch,
  defaultBranch,
  branches,
  open,
  onOpenChange,
  suggestedTitle,
}: {
  projectId: string;
  branch: string | null;
  defaultBranch: string | null;
  branches: GitBranchInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedTitle: string;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: only seed title/base once, when the dialog opens; don't fight the user's edits
  useEffect(() => {
    if (open) {
      setTitle((current) => current || suggestedTitle);
      setBase((current) => current || defaultBranch || 'main');
    }
  }, [open]);

  const createPrMutation = useMutation({
    mutationFn: () => window.agentmat.git.createPullRequest({ projectId, title, body, base }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(
          result.usedFallback ? 'Opened compare page in your browser.' : 'Pull request created.',
        );
        if (result.url) void window.agentmat.shell.openExternal(result.url);
        onOpenChange(false);
        setTitle('');
        setBody('');
      } else {
        toast.error(result.error ?? 'Failed to create pull request.');
      }
    },
    meta: GIT_OP_META,
  });

  const baseOptions = gitBranchOptions(branches, null, defaultBranch);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create pull request</DialogTitle>
          <DialogDescription>
            From <span className="font-mono">{branch ?? 'current branch'}</span> into base branch
            below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="PR title"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Base branch</Label>
            {baseOptions.length > 0 ? (
              <Combobox
                options={baseOptions}
                value={base}
                onChange={setBase}
                placeholder={defaultBranch || 'main'}
                searchPlaceholder="Search branches…"
                emptyText="No branches found."
                className="font-mono"
              />
            ) : (
              <Input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="main"
                className="font-mono"
              />
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <GrammarTextarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="What changed and why…"
            />
          </div>
        </div>
        <DialogFooter>
          <GitOpButton
            icon={GitPullRequest}
            label="Create Pull Request"
            pendingLabel="Pushing & opening PR…"
            pending={createPrMutation.isPending}
            disabled={!title.trim()}
            onClick={() => createPrMutation.mutate()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HooksTab({ project }: { project: Project }): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editingHook, setEditingHook] = useState<DetectedClaudeHook | null>(null);

  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.agentmat.cli.detectAll(),
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
  });
  const claudeHooksQuery = useQuery({
    queryKey: queryKeys.claudeHooks(project.id),
    queryFn: () => window.agentmat.projects.listClaudeHooks(project.id),
  });
  const otherHooks = (claudeHooksQuery.data ?? []).filter((h) => !h.managedByAgentMate);

  const installedAgents = CLI_REGISTRY.filter(
    (cli) => cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );
  const telegramConfigured = Boolean(
    settingsQuery.data?.telegramBotToken && settingsQuery.data?.telegramChatId,
  );
  const petEnabled = settingsQuery.data?.desktopPetEnabled === true;

  const saveMutation = useMutation({
    mutationFn: (notifications: ProjectNotificationSettings) =>
      window.agentmat.projects.updateNotifications(project.id, notifications),
    onSuccess: () => {
      toast.success('Notification hook saved.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });

  const deleteHookMutation = useMutation({
    mutationFn: (hookId: string) => window.agentmat.projects.deleteClaudeHook(project.id, hookId),
    onSuccess: () => {
      toast.success('Hook removed.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.claudeHooks(project.id) });
    },
  });

  return (
    <div className="space-y-2">
      <p className="px-1 pb-1 text-sm text-muted-foreground">
        Wire an installed agent to a notification for this project. Completion, confirmation, and
        the desktop companion are configured as three independent hooks.
      </p>

      {!telegramConfigured && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[calc(var(--radius)+2px)] bg-warning/[0.08] py-2 pl-3.5 pr-2 text-sm ring-1 ring-inset ring-warning/25">
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
            Set up your Telegram bot in Settings before enabling the Telegram hooks.
          </div>
          <Button variant="soft" onClick={() => navigate('/settings')}>
            Open Settings
          </Button>
        </div>
      )}

      <NotificationHookCard
        kind="completion"
        icon={CircleCheck}
        title="Completion"
        description="Sends a Telegram message when the agent finishes its work."
        project={project}
        installedAgents={installedAgents}
        onSave={(hook) => saveMutation.mutate({ ...project.notifications, completion: hook })}
        saving={saveMutation.isPending}
      />
      <NotificationHookCard
        kind="confirmation"
        icon={CircleQuestion}
        title="Confirmation"
        description="Sends a Telegram message when the agent needs your confirmation to continue. Reply on Telegram and AgentMate forwards your reply to this project's open terminal."
        project={project}
        installedAgents={installedAgents}
        onSave={(hook) => saveMutation.mutate({ ...project.notifications, confirmation: hook })}
        saving={saveMutation.isPending}
      />
      <NotificationHookCard
        kind="pet"
        icon={Paw}
        title="Desktop companion"
        description="Speaks the message through the desktop pet when the agent finishes, so you see it without leaving your desk. It only shows while AgentMate is open with the companion on screen; any other time the hook stays silent instead of failing."
        project={project}
        installedAgents={installedAgents}
        petEnabled={petEnabled}
        onSave={(hook) => saveMutation.mutate({ ...project.notifications, pet: hook })}
        saving={saveMutation.isPending}
      />

      <SectionCard
        icon={Bell}
        title="Other hooks"
        description={
          <>
            Hooks found in this project's{' '}
            <code className="rounded bg-foreground/[0.06] px-1">.claude/settings.json</code> and{' '}
            <code className="rounded bg-foreground/[0.06] px-1">settings.local.json</code> that
            AgentMate didn't create.
          </>
        }
      >
        {otherHooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other hooks found.</p>
        ) : (
          <div className={ROWS}>
            {otherHooks.map((hook) => (
              <div key={hook.id} className={cn(ROW, 'items-start')}>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <HookAgentIcon cliId={hook.cliId} className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-medium text-foreground">{hook.event}</span>
                    {hook.matcher && <span>· {hook.matcher}</span>}
                    <ToneChip className="font-mono text-[10px]">
                      {sourceFileLabel(hook.id)}
                    </ToneChip>
                  </div>
                  {/* The command is often far wider than the row, so the tooltip
                    is where you actually read it, so let it wrap generously. */}
                  <SimpleTooltip
                    label={summarizeHook(hook.hook)}
                    align="start"
                    className="font-mono"
                  >
                    <p className="truncate font-mono text-xs text-muted-foreground/80">
                      {summarizeHook(hook.hook)}
                    </p>
                  </SimpleTooltip>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <SimpleTooltip label="Edit hook">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${hook.event} hook`}
                      onClick={() => setEditingHook(hook)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip label="Delete hook">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Delete ${hook.event} hook`}
                      onClick={() => {
                        void confirmDialog({
                          title: `Remove ${hook.event} hook?`,
                          description: `This removes it from ${sourceFileLabel(hook.id)}.`,
                          confirmLabel: 'Remove',
                          variant: 'destructive',
                        }).then((confirmed) => {
                          if (confirmed) deleteHookMutation.mutate(hook.id);
                        });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <EditClaudeHookDialog
        projectId={project.id}
        hook={editingHook}
        onOpenChange={(open) => {
          if (!open) setEditingHook(null);
        }}
      />
    </div>
  );
}

interface NotificationHookCardProps {
  kind: NotificationHookKind;
  title: string;
  description: string;
  icon: typeof CircleCheck;
  project: Project;
  installedAgents: CliDefinition[];
  /** Pet hook only: whether the companion is switched on in Settings. */
  petEnabled?: boolean;
  onSave: (hook: ProjectNotificationHook) => void;
  saving: boolean;
}

function NotificationHookCard({
  kind,
  title,
  description,
  icon: Icon,
  project,
  installedAgents,
  petEnabled = false,
  onSave,
  saving,
}: NotificationHookCardProps): React.JSX.Element {
  const navigate = useNavigate();
  const saved = project.notifications[kind];
  const [enabled, setEnabled] = useState(saved.enabled);
  const [cliId, setCliId] = useState(saved.cliId ?? '');
  const [message, setMessage] = useState(saved.message);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-syncs from `saved` only; `dirty` is read as a guard, not a re-trigger
  useEffect(() => {
    if (dirty) return;
    setEnabled(saved.enabled);
    setCliId(saved.cliId ?? '');
    setMessage(saved.message);
  }, [saved.enabled, saved.cliId, saved.message]);

  const channel = notificationHookChannel(kind);
  const scriptFileName = `notify-${kind}.cjs`;
  const scriptPath = `${project.folderPath}/.agentmate/hooks/${scriptFileName}`;
  const savedCli = CLI_REGISTRY.find((c) => c.id === saved.cliId);
  const wiredAutomatically = saved.cliId === 'claude-code';

  async function handleCopyScriptPath(): Promise<void> {
    await navigator.clipboard.writeText(scriptPath);
    toast.success('Script path copied.');
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    try {
      const rendered = message.replaceAll('{{project}}', project.name);
      const result =
        channel === 'pet'
          ? await window.agentmat.notifications.sendPetTest({ message: rendered })
          : await window.agentmat.notifications.sendTest({ message: rendered });
      if (result.ok) {
        toast.success(
          channel === 'pet' ? 'Your companion is saying it now.' : 'Sent. Check Telegram.',
        );
      } else {
        toast.error(result.error ?? 'Failed to send test message.');
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionCard
      icon={Icon}
      title={title}
      description={description}
      actions={
        <Switch
          aria-label={`${title} hook`}
          checked={enabled}
          onCheckedChange={(v) => {
            setEnabled(v);
            setDirty(true);
          }}
        />
      }
      className={cn(dirty && 'ring-1 ring-primary/35')}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>Installed agent</Label>
          <Combobox
            className="max-w-xs"
            value={cliId}
            onChange={(v) => {
              setCliId(v);
              setDirty(true);
            }}
            placeholder={installedAgents.length ? 'Select an agent…' : 'No installed CLIs detected'}
            emptyText="No installed CLIs detected."
            disabled={installedAgents.length === 0}
            options={installedAgents.map((cli) => ({
              value: cli.id,
              label: cli.name,
              icon: cliOptionIcon(cli.id),
            }))}
          />
          {installedAgents.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Install a CLI from the{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => navigate('/cli-manager')}
              >
                CLI Manager
              </button>{' '}
              first.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>{channel === 'pet' ? 'Companion message' : 'Telegram message'}</Label>
          <Textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setDirty(true);
            }}
            rows={2}
          />
          <p className="text-xs text-muted-foreground">
            Use <code className="rounded bg-foreground/[0.06] px-1">{'{{project}}'}</code> to insert
            the project name.
          </p>
        </div>

        {channel === 'pet' && !petEnabled && (
          <div
            className={cn(
              SECTION_WELL,
              'flex flex-wrap items-center justify-between gap-2 py-2 pr-2 text-xs text-muted-foreground',
            )}
          >
            <span>
              The desktop companion is off, so this hook stays quiet until you turn it back on.
            </span>
            <Button variant="soft" size="sm" onClick={() => navigate('/settings')}>
              Open Settings
            </Button>
          </div>
        )}

        {saved.enabled && (
          <div
            className={cn(
              SECTION_WELL,
              'flex items-start gap-2 py-2 text-xs text-muted-foreground',
            )}
          >
            <CliLogo cliId={saved.cliId ?? ''} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {wiredAutomatically ? (
              <span>
                Automatically wired into{' '}
                <code className="rounded bg-muted px-1">.claude/settings.json</code> for{' '}
                {savedCli?.name ?? 'Claude Code'}.
              </span>
            ) : (
              <span>
                No automatic wiring available for {savedCli?.name ?? 'this agent'} yet. Run the
                generated script from its hook/automation config:{' '}
                <button
                  type="button"
                  onClick={() => void handleCopyScriptPath()}
                  className="break-all rounded bg-muted px-1 font-mono underline underline-offset-2 hover:text-foreground"
                >
                  {scriptPath}
                </button>
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-1.5 pt-1">
          <Button
            disabled={!dirty || saving}
            onClick={() => {
              onSave({ enabled, cliId: cliId || null, message });
              setDirty(false);
            }}
          >
            <Save className="h-4 w-4" /> Save
          </Button>
          <Button
            variant="soft"
            disabled={testing || !message.trim()}
            onClick={() => void handleTest()}
          >
            {channel === 'pet' ? <Paw className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {testing ? 'Sending…' : channel === 'pet' ? 'Preview on pet' : 'Send test'}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

/**
 * The Tag a version flow on its own, for opening it away from the Git tab (the Workspace
 * header). Same dialogs, same checks: tagging needs a clean tree, and a version can be written
 * into the project's files first.
 */
export function ProjectVersionDialogs({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  // Lives in the store, per project: the Workspace header remounts this for each project,
  // and a run left going for project A has to be found again when the user comes back to it.
  const applyVersionTag = useVersionDialogStore((s) => s.applyTags[projectId] ?? null);
  const setApplyTag = useVersionDialogStore((s) => s.setApplyTag);
  const active = open || applyVersionTag !== null;
  const statusQuery = useQuery({
    queryKey: queryKeys.gitStatus(projectId),
    queryFn: () => window.agentmat.git.status(projectId),
    enabled: active,
    meta: GIT_REFRESH_META,
  });
  const tagsQuery = useQuery({
    queryKey: queryKeys.gitTags(projectId),
    queryFn: () => window.agentmat.git.tags(projectId),
    enabled: active && statusQuery.data?.isRepo === true,
    meta: GIT_REFRESH_META,
  });

  return (
    <>
      <TagVersionDialog
        projectId={projectId}
        tagInfo={tagsQuery.data ?? null}
        status={statusQuery.data ?? null}
        open={open && applyVersionTag === null}
        onOpenChange={onOpenChange}
        onApplyVersion={(nextTag) => setApplyTag(projectId, nextTag)}
      />
      <ApplyVersionDialog
        projectId={projectId}
        tag={applyVersionTag}
        // Closing (Escape, an outside click, the X) just hides this: the run it's watching
        // keeps going regardless, and reopening "Tag a version" for this project finds it
        // again instead of losing track of it. "Back to tag" is the one action that steps
        // away from a finished run on purpose.
        open={open && applyVersionTag !== null}
        onOpenChange={onOpenChange}
        onBackToTag={() => setApplyTag(projectId, null)}
      />
    </>
  );
}
