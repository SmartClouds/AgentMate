import type {
  ActivityEvent,
  AgentHistorySession,
  AndroidActionResult,
  AndroidCapture,
  AndroidEvent,
  AndroidSdkStatus,
  AndroidSnapshot,
  AppNotification,
  AppSettings,
  AvdAdvanced,
  AvdEdit,
  BlueprintPreset,
  BlueprintRevision,
  BlueprintStepId,
  BootstrapPlan,
  CliUpdateCheckResult,
  CodeqlInstallProgress,
  CodeqlLocalStatus,
  CreateAvdSpec,
  CustomDesktopPet,
  DesktopPromptBuildWidgetInstance,
  DesktopWidgetInstance,
  DetectedClaudeHook,
  DevDetection,
  DevJobEvent,
  DevJobState,
  DevSetupEnvironment,
  DevUpdateCheck,
  DuplicatePolicy,
  GenericMapping,
  GitChangeEntry,
  InstalledAgentTool,
  InstalledCli,
  KeepAwakeMode,
  McpRepository,
  McpRepositoryIndex,
  McpRepositorySourceType,
  OpenWidgetOptions,
  PostmanCollection,
  Project,
  ProjectBlueprint,
  ProjectDraft,
  ProjectDraftStatus,
  ProjectGithubAction,
  ProjectNotificationSettings,
  PromptTemplate,
  ProviderUsage,
  ProxySettings,
  ResourceActivitySnapshot,
  ResourceRef,
  ResourceStopOutcome,
  RunPauseReason,
  SaveVaultEntryInput,
  ScannerPreflight,
  ScheduledTask,
  ScheduledTaskStatus,
  SecurityScannerSettings,
  SecurityScanOptions,
  SecurityScanProgress,
  SecurityScanRecord,
  SkillRepository,
  SkillRepositoryIndex,
  SkillRepositorySourceType,
  SystemImage,
  TestDiscovery,
  TestRunEvent,
  TestRunSnapshot,
  TestRunSummary,
  TestTarget,
  ToolUpdateCheckResult,
  UsageProviderConfig,
  UsageResetAlertSettings,
  UsageThresholdAlertSettings,
  VaultEntry,
  VaultEntrySummary,
  VaultExportFormat,
  VaultFieldRef,
  WidgetMode,
  WidgetSize,
  WidgetStyle,
  WorktreeInfo,
} from '@runova/core';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ApiCollectionSummary,
  ApiExecutionResult,
  ExecuteApiRequestInput,
  SaveApiRequestInput,
} from '../shared/apiClientTypes';
import type {
  ActiveScan,
  AddPromptHistoryInput,
  AddUsedSkillInput,
  AddUsedSkillResult,
  AgentRunInfoMap,
  AgentSessionEntry,
  AgentSessionUsage,
  AgentStatusMap,
  ApplyVersionInput,
  ApplyVersionResult,
  AskAiInput,
  AskAiResult,
  AskCliInput,
  AskCliResult,
  AssessRunInput,
  AssessRunResult,
  AuditSourcePreview,
  AuditSourceSkill,
  AutoContinuePendingMap,
  BackupExportOptions,
  BackupExportResult,
  BackupImportResult,
  BackupOpenResult,
  BackupRestoreOptions,
  BlueprintAgentFileResult,
  BlueprintAgentFileTarget,
  BlueprintAttachmentInput,
  BlueprintAttachmentResult,
  BlueprintSectionPatch,
  BootstrapResult,
  BrowserElementShot,
  BrowserGuestShortcut,
  BrowserOpenInNewTab,
  CleanupAfterMergeInput,
  CloneIntoInput,
  CloneIntoResult,
  CloneProjectInput,
  CloneProjectResult,
  CommandPrerequisite,
  ConfirmationForwardedPayload,
  ConnectRemoteInput,
  CreateGithubRepoInput,
  CreateGithubRepoResult,
  CreateProjectDraftInput,
  CreateProjectInput,
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateScheduledTasksInput,
  CreateSshSessionOptions,
  CreateTagInput,
  CreateTerminalOptions,
  CreateWorktreeInput,
  CreateWorktreeResult,
  DeleteBranchInput,
  DetectChatIdResult,
  DirectoryEntry,
  DockerActionResult,
  DockerContainer,
  DockerHubPullInput,
  DockerHubRepository,
  DockerHubStatus,
  DockerHubTag,
  DockerImage,
  DockerImageRemoveResult,
  DockerImageTarget,
  DockerLogLine,
  DockerLogsOptions,
  DockerRemoveOptions,
  EnvCredentialSecrets,
  EnvFolderFile,
  EnvImportPick,
  EnvImportResult,
  EnvWriteResult,
  ExplorerDeleteResult,
  ExplorerFileIndex,
  ExplorerGitignoreResult,
  ExplorerTransferResult,
  FaviconResult,
  FavoriteSkillInput,
  FavoriteSkillRecord,
  GitApplyLinesInput,
  GitBranchHistory,
  GitDiffSide,
  GitDiscardResult,
  GitFileDiff,
  GithubAccount,
  GithubActionsActivity,
  GithubActionsRunErrorInput,
  GithubActionsRunErrorResult,
  GithubActivity,
  GithubJobLogInput,
  GithubJobLogResult,
  GithubNotifications,
  GithubPipelineActionResult,
  GithubRepoLookup,
  GithubRunAnnotationsInput,
  GithubRunAnnotationsResult,
  GithubRunCancelRequest,
  GithubRunDetailsInput,
  GithubRunDetailsResult,
  GithubRunnersInput,
  GithubRunnersResult,
  GithubWorkflowDispatchRequest,
  GithubWorkflowRefsResult,
  GitImageDiff,
  GitInitInput,
  GitOpResult,
  GitStashEntry,
  GitStashPushInput,
  GitStatus,
  GitTagInfo,
  HelpAskInput,
  HelpAskResult,
  HelpEmbeddingModelOption,
  HelpIndexProgress,
  HelpIndexStatus,
  HelpReindexResult,
  ImageFileData,
  InstalledMcpServerRecord,
  InstalledSkillRecord,
  InstallFromSkillsShInput,
  IpGeoInfo,
  KeepAwakeStatus,
  KillProcessResult,
  LastRunInfoByCli,
  LocalSkillFolderPreview,
  MergePullRequestIpcInput,
  MergePullRequestResult,
  NotificationSendResult,
  OllamaConnectionTest,
  OpenSessionSummary,
  PackageScanResult,
  PackageUpdateProgress,
  PackageUpdateRequest,
  PackageUpdateResult,
  PrActionResult,
  PrCommentInput,
  ProjectEnvironment,
  ProjectPipelineStatus,
  ProjectUsageReport,
  PromptHistoryEntry,
  ProxyStatus,
  ProxyTestResult,
  PrThreadReplyInput,
  PrThreadResolveInput,
  PullRequestStatus,
  RdpAgentHistoryRun,
  RdpAgentProgress,
  RdpAgentRequest,
  RdpAgentResponse,
  RdpCertificateCheckResult,
  RdpCertificatePrompt,
  RdpClipboardFiles,
  RdpConnectTicket,
  RdpDownloadTarget,
  RdpLinkStats,
  RdpProxyErrorPayload,
  RdpSavedServer,
  RdpStageResult,
  RdpStageStart,
  RdpWindowState,
  RecordUiProInstallInput,
  RemoteFileManagerEntry,
  RemoteFileProgress,
  RemoteLogEvent,
  RemoteNetworkInterface,
  RemotePairingInfo,
  RemoteSavedServer,
  RemoteScreenSize,
  RemoteState,
  RemoveWorktreeInput,
  RenameBranchInput,
  ResolveConflictWithAiResult,
  RunnerMachineLink,
  RunnerMachineStatsResult,
  RunProposal,
  RunProposalDecision,
  RunProposalDecisionResult,
  RunProposalResult,
  RunProposalsChanged,
  RunSetupSession,
  RunSkillAuditInput,
  RunSkillAuditResult,
  SaveBlueprintPresetInput,
  SaveEnvCredentialInput,
  SaveEnvFileInput,
  SaveEnvironmentInput,
  SaveRdpServerInput,
  SaveSshServerInput,
  SaveTemplateInput,
  ScheduledTaskInput,
  SendTestNotificationInput,
  SkillAuditRecord,
  SkillsShDetail,
  SkillsShSearchResult,
  SkillUpdateInfo,
  SkillUsageReport,
  SpeechModelProgress,
  SpeechModelState,
  SshAgentHistoryRun,
  SshAgentProgress,
  SshAttachResult,
  SshConversationsResult,
  SshDataPayload,
  SshExitPayload,
  SshPasswordPromptPayload,
  SshSavedServer,
  SshVaultStatus,
  StartHostInput,
  StartRdpAgentTaskInput,
  StartSshAgentTaskInput,
  SuggestGitTextResult,
  SuggestPullRequestTextResult,
  SuggestTagResult,
  SwapVersionFileInput,
  SymbolIndexPayload,
  SystemStatsSample,
  TerminalAttachResult,
  TerminalClipboardPaste,
  TerminalPauseChange,
  TerminalPauseResult,
  TerminalRunStatusResult,
  TerminalUsageResult,
  TextSearchBatch,
  TextSearchRequest,
  TextSearchSummary,
  TopResourceAppsResult,
  TopResourceKind,
  TranscribeAudioInput,
  TranscribeAudioResult,
  TranslateTextInput,
  UiProPrerequisites,
  UiProUpdateCheck,
  UpdateProjectDraftInput,
  UpdateScheduledTaskInput,
  UpdateStatus,
  UsedSkillInspection,
  UsedSkillQuery,
  VaultClipboardEvent,
  VaultCopyResult,
  VaultExportResult,
  VaultImportPreview,
  VaultImportResult,
  VaultStateEvent,
  VaultStatus,
  VaultUnlockResult,
  WorkspaceGitState,
  WorktreeDefaults,
  WorktreeMergePreflight,
  WorktreeMergeResult,
  WorktreeRemovePreflight,
  WriteVersionHunksInput,
  WriteVersionHunksResult,
} from '../shared/apiTypes';
import type {
  CloudflareAccessRule,
  CloudflareAccessRuleInput,
  CloudflareCustomRule,
  CloudflareCustomRuleInput,
  CloudflareDnsRecord,
  CloudflarePointDomainInput,
  CloudflarePointDomainPlan,
  CloudflarePointDomainResult,
  CloudflarePurgeRequest,
  CloudflareRecordInput,
  CloudflareSaveTokenInput,
  CloudflareSettingChange,
  CloudflareStatus,
  CloudflareZone,
  CloudflareZoneSettings,
} from '../shared/cloudflareTypes';
import type {
  AccountInfo,
  AlertInfo,
  AuditPage,
  AuditVerificationInfo,
  CertificateInfo,
  CertificateUploadResult,
  DeviceInfo,
  EnrollmentCodeInfo,
  ExposureInventory,
  FirewallChangePreview,
  FirewallChangeSetInfo,
  FirewallPreset,
  FirewallStatus,
  JobInfo,
  JobPage,
  ManagedService,
  MetricsHistory,
  NginxApplyResult,
  NginxStatus,
  RecoveryCodes,
  ServiceInfo,
  SessionInfo,
  SiteInfo,
  SiteSaveResult,
  SiteSettings,
  SiteSnippets,
  StackDetails,
  StackInfo,
  StackRevisionFiles,
  StackRevisionInfo,
  StepUpResponse,
  StreamProxyInfo,
  StreamProxySaveResult,
  StreamProxySettings,
  SystemInfo,
  UpdatesInfo,
  UserInfo,
} from '../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployAppInstallInput,
  DeployAppInstallResult,
  DeployAppRevealInput,
  DeployAppUpdateInput,
  DeployMakePrivateInput,
  DeployRevisionResult,
} from '../shared/deployAppStoreTypes';
import type {
  DeployFirewallApplyInput,
  DeployFirewallChangesInput,
  DeployFirewallDecisionInput,
  DeployFirewallHistoryInput,
  DeployFirewallProgressEvent,
} from '../shared/deployFirewallTypes';
import type {
  DeployAuditExportInput,
  DeployAuditExportResult,
  DeployAuditQueryInput,
  DeployCreateUserInput,
  DeployEnrollmentCodeInput,
  DeployRedeemCodeInput,
  DeployResetPasswordInput,
  DeploySetDisabledInput,
  DeploySetRoleInput,
  DeployUserTarget,
} from '../shared/deploySecurityTypes';
import type {
  DeployCertificateIssueInput,
  DeployCertificateRemoveInput,
  DeployCertificateUploadInput,
  DeploySiteLogEvent,
  DeploySiteLogWatchInput,
} from '../shared/deploySitesTypes';
import type {
  DeployComposeDiscovery,
  DeployStackAcknowledgeInput,
  DeployStackActionInput,
  DeployStackCreateInput,
  DeployStackDeleteInput,
  DeployStackPreview,
  DeployStackPreviewInput,
  DeployStackRef,
  DeployStackRevisionInput,
  DeployStackRevisionRef,
  DeployStackUploadProgress,
  DeployStackUploadResult,
} from '../shared/deployStacksTypes';
import type {
  DeployAccess,
  DeployAlertsEvent,
  DeployAlertsQuery,
  DeployConnection,
  DeployCoreRelease,
  DeployCoreUpdateResult,
  DeployEnrollInput,
  DeployHealth,
  DeployInstallInput,
  DeployInstallResult,
  DeployJobEvent,
  DeployJobsQuery,
  DeployJobWatchInput,
  DeployMetricsEvent,
  DeployMetricsHistoryInput,
  DeployMetricsWatchInput,
  DeployPreflight,
  DeployServer,
  DeploySetupProgressEvent,
  DeploySignInInput,
  DeployStepUpInput,
  DeployTotpSetup,
  DeployUninstallInput,
} from '../shared/deployTypes';
import type { GrammarCheckInput, GrammarCheckResult, GrammarLocalStatus } from '../shared/grammar';
import { IPC } from '../shared/ipcChannels';
import type { PetPipelineMessage, PetSnoozeState, PetWorkArea } from '../shared/pet';
import type { RemoteInputEvent, RemoteRtcMessage } from '../shared/remoteProtocol';
import type { EditCommand, SpellcheckMenuPayload } from '../shared/spellcheck';
import type { SshHostKeyStatus } from '../shared/sshHostKey';
import { createCiAutoFix } from './ciAutoFix';
import { cloudflareServer } from './cloudflareServer';
import { createDeployAssistant, createDeployLogs } from './deployAssistant';
import { createDeployDirectTls } from './deployDirectTls';
import { createDeployDocker } from './deployDocker';
import { createDeployErrorReporting } from './deployErrorReporting';
import { createDeployFiles } from './deployFiles';
import { createDeployHardening } from './deployHardening';
import { createDeployRegistry } from './deployRegistry';
import { createDeployServerBackups } from './deployServerBackups';
import { createDeployTelegram } from './deployTelegram';
import { createDeployWordPress } from './deployWordPress';
import { createErrorTracking } from './errorTracking';
import { createHealth } from './health';
import { createRelay } from './relay';
import { createSftp } from './sftp';
import {
  createStudio,
  createStudioAi,
  createStudioAudio,
  createStudioGen,
  createStudioMedia,
  createStudioRender,
  createStudioScenes,
} from './studio';

interface TerminalDataPayload {
  sessionId: string;
  data: string;
}
interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

const appInfo = {
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.app.getVersion),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.app.checkForUpdates),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.app.downloadUpdate),
  pauseDownload: (): Promise<void> => ipcRenderer.invoke(IPC.app.pauseDownload),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke(IPC.app.quitAndInstall),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      callback(status);
    ipcRenderer.on(IPC.app.onUpdateStatus, listener);
    return () => ipcRenderer.removeListener(IPC.app.onUpdateStatus, listener);
  },
  relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.app.relaunch),
  /** A route that arrived while this window was still loading, or null. */
  pendingNavigate: (): Promise<string | null> => ipcRenderer.invoke(IPC.app.pendingNavigate),
  /** Tells main which page this window is on, so the next launch can open there. */
  setLastRoute: (route: string): void => ipcRenderer.send(IPC.app.setLastRoute, route),
  /** main asking the app window to show a route, e.g. after a click on the pet. */
  onNavigate: (callback: (route: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, route: string): void => callback(route);
    ipcRenderer.on(IPC.app.onNavigate, listener);
    return () => ipcRenderer.removeListener(IPC.app.onNavigate, listener);
  },
  /** main asking whether to close the app while CLIs, SSH or Remote Desktop sessions are open. */
  onConfirmQuit: (callback: (summary: OpenSessionSummary) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, summary: OpenSessionSummary): void =>
      callback(summary);
    ipcRenderer.on(IPC.app.onConfirmQuit, listener);
    return () => ipcRenderer.removeListener(IPC.app.onConfirmQuit, listener);
  },
  answerQuit: (confirmed: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.app.answerQuit, confirmed),
  /** Tells main the first page is on screen, so the splash can hand over to this window. */
  notifyReady: (): void => ipcRenderer.send(IPC.app.rendererReady),
};

const backup = {
  export: (compress: boolean, options: BackupExportOptions = {}): Promise<BackupExportResult> =>
    ipcRenderer.invoke(IPC.backup.export, compress, options),
  /** Picks and checks a backup file. Nothing is restored until `restore` is called. */
  open: (): Promise<BackupOpenResult> => ipcRenderer.invoke(IPC.backup.open),
  restore: (token: string, options: BackupRestoreOptions): Promise<BackupImportResult> =>
    ipcRenderer.invoke(IPC.backup.restore, token, options),
};

const cli = {
  detectAll: (force?: boolean): Promise<InstalledCli[]> =>
    ipcRenderer.invoke(IPC.cli.detectAll, force),
  getInstallCommand: (cliId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.cli.getInstallCommand, cliId),
  checkForUpdate: (cliId: string, currentVersion: string | null): Promise<CliUpdateCheckResult> =>
    ipcRenderer.invoke(IPC.cli.checkForUpdate, cliId, currentVersion),
  getUpdateCommand: (cliId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.cli.getUpdateCommand, cliId),
  /** Puts a fresh copy over one that is found but will not start, through whoever installed it. */
  getReinstallCommand: (cliId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.cli.getReinstallCommand, cliId),
  /** What `command` needs that this machine lacks (Node.js for npm, say), or null. */
  checkCommandPrerequisite: (command: string): Promise<CommandPrerequisite | null> =>
    ipcRenderer.invoke(IPC.cli.checkCommandPrerequisite, command),
};

const terminal = {
  /** Starts a shell, or reconnects to a running one when `sessionId` names it. */
  create: (options: CreateTerminalOptions = {}): Promise<TerminalAttachResult | null> =>
    ipcRenderer.invoke(IPC.terminal.create, options),
  write: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC.terminal.write, sessionId, data),
  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC.terminal.resize, sessionId, cols, rows),
  kill: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.terminal.kill, sessionId),
  /** Every running shell with the CPU and memory its whole process tree is using. */
  usage: (): Promise<TerminalUsageResult> => ipcRenderer.invoke(IPC.terminal.usage),
  /** CPU, memory and listening ports for the given project runs' terminals. */
  runStatus: (sessionIds: string[]): Promise<TerminalRunStatusResult> =>
    ipcRenderer.invoke(IPC.terminal.runStatus, sessionIds),
  /** Freezes a run's shell and everything it started; `reason` says who asked. */
  pause: (sessionId: string, reason: RunPauseReason = 'user'): Promise<TerminalPauseResult> =>
    ipcRenderer.invoke(IPC.terminal.pause, sessionId, reason),
  resume: (sessionId: string): Promise<TerminalPauseResult> =>
    ipcRenderer.invoke(IPC.terminal.resume, sessionId),
  onData: (callback: (payload: TerminalDataPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataPayload): void =>
      callback(payload);
    ipcRenderer.on(IPC.terminal.onData, listener);
    return () => ipcRenderer.removeListener(IPC.terminal.onData, listener);
  },
  onExit: (callback: (payload: TerminalExitPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitPayload): void =>
      callback(payload);
    ipcRenderer.on(IPC.terminal.onExit, listener);
    return () => ipcRenderer.removeListener(IPC.terminal.onExit, listener);
  },
  onPauseChange: (callback: (change: TerminalPauseChange) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: TerminalPauseChange): void =>
      callback(change);
    ipcRenderer.on(IPC.terminal.onPauseChange, listener);
    return () => ipcRenderer.removeListener(IPC.terminal.onPauseChange, listener);
  },
};

const ssh = {
  listServers: (): Promise<SshSavedServer[]> => ipcRenderer.invoke(IPC.ssh.listServers),
  saveServer: (input: SaveSshServerInput): Promise<SshSavedServer> =>
    ipcRenderer.invoke(IPC.ssh.saveServer, input),
  removeServer: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ssh.removeServer, id),
  /** Saves the list in the given id order and returns it. Servers left out go to the end. */
  reorderServers: (orderedIds: string[]): Promise<SshSavedServer[]> =>
    ipcRenderer.invoke(IPC.ssh.reorderServers, orderedIds),
  pickPrivateKeyFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.ssh.pickPrivateKeyFile),
  vaultStatus: (): Promise<SshVaultStatus> => ipcRenderer.invoke(IPC.ssh.vaultStatus),
  unlockVault: (passphrase: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ssh.unlockVault, passphrase),
  setPasskey: (passphrase: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ssh.setPasskey, passphrase),
  /** The stored and presented host key fingerprints, read with a handshake that never logs in. */
  hostKeyStatus: (serverId: string): Promise<SshHostKeyStatus> =>
    ipcRenderer.invoke(IPC.ssh.hostKeyStatus, serverId),
  /** Trusts the key the server presents now, provided it is still `fingerprint`. */
  trustHostKey: (serverId: string, fingerprint: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ssh.trustHostKey, serverId, fingerprint),
  /**
   * Every supported CLI conversation stored on a saved server, read over SFTP. Rejects
   * with an `sshErrorCode` of 'host-key-changed' or 'vault-locked' when those stand in the way.
   */
  conversations: (serverId: string): Promise<SshConversationsResult> =>
    ipcRenderer.invoke(IPC.ssh.conversations, serverId),
  /** Starts a shell for a saved server, or reconnects when `sessionId` names one still running. */
  create: (options: CreateSshSessionOptions): Promise<SshAttachResult> =>
    ipcRenderer.invoke(IPC.ssh.create, options),
  write: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ssh.write, sessionId, data),
  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC.ssh.resize, sessionId, cols, rows),
  kill: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.ssh.kill, sessionId),
  onData: (callback: (payload: SshDataPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SshDataPayload): void =>
      callback(payload);
    ipcRenderer.on(IPC.ssh.onData, listener);
    return () => ipcRenderer.removeListener(IPC.ssh.onData, listener);
  },
  onExit: (callback: (payload: SshExitPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SshExitPayload): void =>
      callback(payload);
    ipcRenderer.on(IPC.ssh.onExit, listener);
    return () => ipcRenderer.removeListener(IPC.ssh.onExit, listener);
  },
  /** Types the saved login password into the shell. False when there is none to type. */
  typePassword: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ssh.typePassword, sessionId),
  onPasswordPrompt: (callback: (payload: SshPasswordPromptPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SshPasswordPromptPayload): void =>
      callback(payload);
    ipcRenderer.on(IPC.ssh.onPasswordPrompt, listener);
    return () => ipcRenderer.removeListener(IPC.ssh.onPasswordPrompt, listener);
  },
};

const sshAgent = {
  /** Starts an AI task in an already-connected SSH session; rejects if one is already running there. */
  start: (input: StartSshAgentTaskInput): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.start, input),
  approveCommand: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.approveCommand, sessionId),
  skipCommand: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.skipCommand, sessionId),
  answerNeedsInput: (sessionId: string, answer: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.answerNeedsInput, sessionId, answer),
  /**
   * Tells a task that is already running something new, without waiting for it to ask. Resolves
   * false when the task is over by now, so the caller can keep the text.
   */
  sendMessage: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.sshAgent.sendMessage, sessionId, text),
  /** True types the server's saved password into the prompt the running command opened. */
  answerPassword: (sessionId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.answerPassword, sessionId, approved),
  stop: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.sshAgent.stop, sessionId),
  /** Picks a run that paused on an error back up where it left off. */
  continueTask: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.continue, sessionId),
  /** The terminal's AI tasks, newest first, with every command, question and answer. */
  history: (sessionId: string): Promise<SshAgentHistoryRun[]> =>
    ipcRenderer.invoke(IPC.sshAgent.history, sessionId),
  /** The AI tasks run in any SSH tab on a saved server, newest first, including closed tabs. */
  serverHistory: (serverId: string): Promise<SshAgentHistoryRun[]> =>
    ipcRenderer.invoke(IPC.sshAgent.serverHistory, serverId),
  /** Forgets the server's finished AI tasks, here and in the saved history. */
  clearServerHistory: (serverId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.clearServerHistory, serverId),
  /** Raises a system notification for a run that is waiting on the user. */
  notifyWaiting: (sessionId: string, tabTitle: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sshAgent.notifyWaiting, sessionId, tabTitle),
  onProgress: (callback: (progress: SshAgentProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SshAgentProgress): void =>
      callback(progress);
    ipcRenderer.on(IPC.sshAgent.onProgress, listener);
    return () => ipcRenderer.removeListener(IPC.sshAgent.onProgress, listener);
  },
};

const rdpAgent = {
  /** Starts an AI task in an open Remote Desktop session; rejects if one is already running there. */
  start: (input: StartRdpAgentTaskInput): Promise<void> =>
    ipcRenderer.invoke(IPC.rdpAgent.start, input),
  approveAction: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdpAgent.approveAction, sessionId),
  skipAction: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdpAgent.skipAction, sessionId),
  answerNeedsInput: (sessionId: string, answer: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdpAgent.answerNeedsInput, sessionId, answer),
  /**
   * Tells a task that is already running something new, without waiting for it to ask. Resolves
   * false when the task is over by now, so the caller can keep the text.
   */
  sendMessage: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.rdpAgent.sendMessage, sessionId, text),
  stop: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.rdpAgent.stop, sessionId),
  /** Picks a run that paused on an error back up where it left off. */
  continueTask: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdpAgent.continue, sessionId),
  /** The session's AI tasks, newest first, with every action, question and answer. */
  history: (sessionId: string): Promise<RdpAgentHistoryRun[]> =>
    ipcRenderer.invoke(IPC.rdpAgent.history, sessionId),
  /** Raises a system notification for a run that is waiting on the user. */
  notifyWaiting: (sessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdpAgent.notifyWaiting, sessionId, title),
  /** Answers a request from onRequest: the screenshot, or that the input was applied. */
  respond: (response: RdpAgentResponse): Promise<boolean> =>
    ipcRenderer.invoke(IPC.rdpAgent.respond, response),
  /** Main asking this window for a screenshot or to apply mouse and keyboard input. */
  onRequest: (callback: (request: RdpAgentRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: RdpAgentRequest): void =>
      callback(request);
    ipcRenderer.on(IPC.rdpAgent.onRequest, listener);
    return () => ipcRenderer.removeListener(IPC.rdpAgent.onRequest, listener);
  },
  onProgress: (callback: (progress: RdpAgentProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: RdpAgentProgress): void =>
      callback(progress);
    ipcRenderer.on(IPC.rdpAgent.onProgress, listener);
    return () => ipcRenderer.removeListener(IPC.rdpAgent.onProgress, listener);
  },
};

const power = {
  keepAwakeStatus: (): Promise<KeepAwakeStatus> => ipcRenderer.invoke(IPC.power.keepAwakeStatus),
  setKeepAwake: (mode: KeepAwakeMode): Promise<KeepAwakeStatus> =>
    ipcRenderer.invoke(IPC.power.setKeepAwake, mode),
  onKeepAwake: (callback: (status: KeepAwakeStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: KeepAwakeStatus): void =>
      callback(status);
    ipcRenderer.on(IPC.power.onKeepAwake, listener);
    return () => ipcRenderer.removeListener(IPC.power.onKeepAwake, listener);
  },
};

const agents = {
  /** Tells main which workspace tabs exist, so it can follow their agents' status. */
  sync: (entries: AgentSessionEntry[]): Promise<void> =>
    ipcRenderer.invoke(IPC.agents.sync, entries),
  /** The tabs on screen right now; finishing while visible and focused raises no notification. */
  setViewing: (visible: string[], focused: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.agents.setViewing, visible, focused),
  acknowledge: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.agents.acknowledge, sessionId),
  list: (): Promise<AgentStatusMap> => ipcRenderer.invoke(IPC.agents.list),
  /**
   * A settings file to pass as `--settings` when launching this CLI, which reports its status
   * back through hooks. Null when the CLI has no such hooks or they cannot run here.
   */
  statusHookSettings: (cliId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.agents.statusHookSettings, cliId),
  /** The model and effort each agent last reported. */
  runInfos: (): Promise<AgentRunInfoMap> => ipcRenderer.invoke(IPC.agents.runInfos),
  /** What each CLI was last actually run on, kept across restarts. */
  lastRunInfoByCli: (): Promise<LastRunInfoByCli> =>
    ipcRenderer.invoke(IPC.agents.lastRunInfoByCli),
  history: (projectId: string): Promise<AgentHistorySession[]> =>
    ipcRenderer.invoke(IPC.agents.history, projectId),
  /** Tokens and estimated cost of a past conversation, as the history list showed it. */
  sessionUsage: (provider: string, id: string): Promise<AgentSessionUsage> =>
    ipcRenderer.invoke(IPC.agents.sessionUsage, provider, id),
  /**
   * What every past conversation in a project (and its worktrees) used over the last `days`, or
   * all of it for null. Parsing the transcripts can take a few seconds on a long history.
   */
  projectUsage: (projectId: string, days: number | null): Promise<ProjectUsageReport> =>
    ipcRenderer.invoke(IPC.agents.projectUsage, projectId, days),
  onRunInfo: (callback: (changes: AgentRunInfoMap) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, changes: AgentRunInfoMap): void =>
      callback(changes);
    ipcRenderer.on(IPC.agents.onRunInfo, listener);
    return () => ipcRenderer.removeListener(IPC.agents.onRunInfo, listener);
  },
  onStatus: (callback: (changes: AgentStatusMap) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, changes: AgentStatusMap): void =>
      callback(changes);
    ipcRenderer.on(IPC.agents.onStatus, listener);
    return () => ipcRenderer.removeListener(IPC.agents.onStatus, listener);
  },
  /** Every "continue" scheduled for a tab after a usage limit or a network error. */
  autoContinuePending: (): Promise<AutoContinuePendingMap> =>
    ipcRenderer.invoke(IPC.agents.autoContinuePending),
  cancelAutoContinue: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.agents.cancelAutoContinue, sessionId),
  onAutoContinue: (callback: (changes: AutoContinuePendingMap) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, changes: AutoContinuePendingMap): void =>
      callback(changes);
    ipcRenderer.on(IPC.agents.onAutoContinue, listener);
    return () => ipcRenderer.removeListener(IPC.agents.onAutoContinue, listener);
  },
};

const projects = {
  list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projects.list),
  create: (input: CreateProjectInput): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.create, input),
  update: (projectId: string, updates: Partial<CreateProjectInput>): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.update, projectId, updates),
  delete: (projectId: string): Promise<void> => ipcRenderer.invoke(IPC.projects.delete, projectId),
  reorder: (orderedIds: string[]): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.projects.reorder, orderedIds),
  setPinned: (projectId: string, pinned: boolean): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.setPinned, projectId, pinned),
  /** Moves a project in or out of the Archived group on the Projects page. */
  setArchived: (projectId: string, archived: boolean): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.setArchived, projectId, archived),
  bootstrap: (projectId: string): Promise<BootstrapResult> =>
    ipcRenderer.invoke(IPC.projects.bootstrap, projectId),
  bootstrapPlan: (projectId: string): Promise<BootstrapPlan> =>
    ipcRenderer.invoke(IPC.projects.bootstrapPlan, projectId),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.projects.pickFolder),
  /** Opens an image picker and returns the file inlined as a data URL, or null if cancelled. */
  pickIcon: (): Promise<string | null> => ipcRenderer.invoke(IPC.projects.pickIcon),
  /** Shrinks a dropped or pasted image to icon size and returns it as a data URL. */
  normalizeIcon: (dataUrl: string): Promise<string> =>
    ipcRenderer.invoke(IPC.projects.normalizeIcon, dataUrl),
  /** Downloads a site's favicon; null when the site is unreachable or has no icon. */
  fetchFavicon: (siteUrl: string): Promise<FaviconResult | null> =>
    ipcRenderer.invoke(IPC.projects.fetchFavicon, siteUrl),
  updateNotifications: (
    projectId: string,
    notifications: ProjectNotificationSettings,
  ): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.updateNotifications, projectId, notifications),
  listClaudeHooks: (projectId: string): Promise<DetectedClaudeHook[]> =>
    ipcRenderer.invoke(IPC.projects.listClaudeHooks, projectId),
  updateClaudeHook: (
    projectId: string,
    hookId: string,
    updates: { matcher?: string; hook: Record<string, unknown> },
  ): Promise<void> => ipcRenderer.invoke(IPC.projects.updateClaudeHook, projectId, hookId, updates),
  deleteClaudeHook: (projectId: string, hookId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.projects.deleteClaudeHook, projectId, hookId),
};

const skills = {
  listRepositories: (): Promise<SkillRepository[]> =>
    ipcRenderer.invoke(IPC.skills.listRepositories),
  addRepository: (input: {
    name: string;
    sourceType: SkillRepositorySourceType;
    source: string;
  }): Promise<SkillRepository> => ipcRenderer.invoke(IPC.skills.addRepository, input),
  removeRepository: (repositoryId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.skills.removeRepository, repositoryId),
  refreshRepository: (repositoryId: string): Promise<SkillRepositoryIndex> =>
    ipcRenderer.invoke(IPC.skills.refreshRepository, repositoryId),
  getRepositoryIndex: (repositoryId: string): Promise<SkillRepositoryIndex> =>
    ipcRenderer.invoke(IPC.skills.getRepositoryIndex, repositoryId),
  /** `currentPath` seeds the dialog; it falls back to the projects folder from Settings. */
  pickLocalRepository: (currentPath?: string | null): Promise<string | null> =>
    ipcRenderer.invoke(IPC.skills.pickLocalRepository, currentPath ?? null),
  previewLocalRepository: (folderPath: string): Promise<LocalSkillFolderPreview> =>
    ipcRenderer.invoke(IPC.skills.previewLocalRepository, folderPath),
  onRepositoryChanged: (cb: (repositoryId: string) => void): (() => void) =>
    subscribe(IPC.skills.onRepositoryChanged, cb),
  install: (params: {
    projectId: string | null;
    repositoryId: string;
    skillId: string;
  }): Promise<void> => ipcRenderer.invoke(IPC.skills.install, params),
  remove: (params: { projectId: string | null; skillId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.skills.remove, params),
  listInstalled: (projectId: string | null): Promise<InstalledSkillRecord[]> =>
    ipcRenderer.invoke(IPC.skills.listInstalled, projectId),
  checkForUpdates: (projectId: string | null): Promise<SkillUpdateInfo[]> =>
    ipcRenderer.invoke(IPC.skills.checkForUpdates, projectId),
  searchSkillsSh: (query: string): Promise<SkillsShSearchResult[]> =>
    ipcRenderer.invoke(IPC.skills.searchSkillsSh, query),
  getSkillsShDetail: (skillPath: string): Promise<SkillsShDetail> =>
    ipcRenderer.invoke(IPC.skills.getSkillsShDetail, skillPath),
  recordSkillsShInstall: (input: InstallFromSkillsShInput): Promise<void> =>
    ipcRenderer.invoke(IPC.skills.recordSkillsShInstall, input),
  checkUiProPrerequisites: (): Promise<UiProPrerequisites> =>
    ipcRenderer.invoke(IPC.skills.checkUiProPrerequisites),
  /** Compares the installed `uipro` CLI against the latest release on npm. */
  checkUiProUpdate: (): Promise<UiProUpdateCheck> =>
    ipcRenderer.invoke(IPC.skills.checkUiProUpdate),
  recordUiProInstall: (input: RecordUiProInstallInput): Promise<void> =>
    ipcRenderer.invoke(IPC.skills.recordUiProInstall, input),
  /** Skills the user has starred, newest first. */
  listFavorites: (): Promise<FavoriteSkillRecord[]> => ipcRenderer.invoke(IPC.skills.listFavorites),
  /** Stars a skill, or refreshes the details of one already starred. */
  addFavorite: (input: FavoriteSkillInput): Promise<FavoriteSkillRecord[]> =>
    ipcRenderer.invoke(IPC.skills.addFavorite, input),
  removeFavorite: (skillId: string): Promise<FavoriteSkillRecord[]> =>
    ipcRenderer.invoke(IPC.skills.removeFavorite, skillId),
  /** Skill invocations counted from the local agent session transcripts. */
  getUsage: (): Promise<SkillUsageReport> => ipcRenderer.invoke(IPC.skills.getUsage),
  /** Re-reads every transcript from scratch instead of only the newly appended bytes. */
  rescanUsage: (): Promise<SkillUsageReport> => ipcRenderer.invoke(IPC.skills.rescanUsage),
  /** Finds a used skill's folder on disk and the projects that already have it. */
  inspectUsedSkill: (query: UsedSkillQuery): Promise<UsedSkillInspection> =>
    ipcRenderer.invoke(IPC.skills.inspectUsedSkill, query),
  /** Copies a used skill into each project's skills dirs, one result per project. */
  addUsedSkillToProjects: (input: AddUsedSkillInput): Promise<AddUsedSkillResult[]> =>
    ipcRenderer.invoke(IPC.skills.addUsedSkillToProjects, input),
  /** Scans a skill for prompt injection, exfiltration, and the other risk categories. */
  runAudit: (input: RunSkillAuditInput): Promise<RunSkillAuditResult> =>
    ipcRenderer.invoke(IPC.skills.runAudit, input),
  /** Stops the CLI review half of an audit started with the same requestId. */
  cancelAudit: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.skills.cancelAudit, requestId),
  /** Lists the skills at a folder path or GitHub address, so either can be checked ad hoc. */
  previewAuditSource: (input: string): Promise<AuditSourcePreview> =>
    ipcRenderer.invoke(IPC.skills.previewAuditSource, input),
  /** Skills present in a project's (or the global) skills dirs, installed by Runova or not. */
  listOnDiskSkills: (projectId: string | null): Promise<AuditSourceSkill[]> =>
    ipcRenderer.invoke(IPC.skills.listOnDiskSkills, projectId),
  listAudits: (options?: {
    skillId?: string | null;
    limit?: number;
  }): Promise<SkillAuditRecord[]> => ipcRenderer.invoke(IPC.skills.listAudits, options ?? {}),
  latestAuditPerSkill: (): Promise<SkillAuditRecord[]> =>
    ipcRenderer.invoke(IPC.skills.latestAuditPerSkill),
  getAudit: (id: string): Promise<SkillAuditRecord | null> =>
    ipcRenderer.invoke(IPC.skills.getAudit, id),
  removeAudit: (id: string): Promise<void> => ipcRenderer.invoke(IPC.skills.removeAudit, id),
  clearAudits: (): Promise<void> => ipcRenderer.invoke(IPC.skills.clearAudits),
};

const mcp = {
  listRepositories: (): Promise<McpRepository[]> => ipcRenderer.invoke(IPC.mcp.listRepositories),
  addRepository: (input: {
    name: string;
    sourceType: McpRepositorySourceType;
    source: string;
  }): Promise<McpRepository> => ipcRenderer.invoke(IPC.mcp.addRepository, input),
  removeRepository: (repositoryId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.removeRepository, repositoryId),
  refreshRepository: (repositoryId: string): Promise<McpRepositoryIndex> =>
    ipcRenderer.invoke(IPC.mcp.refreshRepository, repositoryId),
  getRepositoryIndex: (repositoryId: string): Promise<McpRepositoryIndex> =>
    ipcRenderer.invoke(IPC.mcp.getRepositoryIndex, repositoryId),
  pickLocalRepository: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.mcp.pickLocalRepository),
  install: (params: {
    projectId: string;
    repositoryId: string;
    serverId: string;
    env?: Record<string, string>;
  }): Promise<void> => ipcRenderer.invoke(IPC.mcp.install, params),
  remove: (params: { projectId: string; serverId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.remove, params),
  listInstalled: (projectId: string): Promise<InstalledMcpServerRecord[]> =>
    ipcRenderer.invoke(IPC.mcp.listInstalled, projectId),
};

const security = {
  preflight: (projectId: string): Promise<ScannerPreflight[]> =>
    ipcRenderer.invoke(IPC.security.preflight, projectId),
  runScan: (
    projectId: string,
    options: Partial<SecurityScanOptions>,
    runId: string,
  ): Promise<SecurityScanRecord> =>
    ipcRenderer.invoke(IPC.security.runScan, projectId, options, runId),
  cancelScan: (runId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.security.cancelScan, runId),
  activeScan: (projectId: string): Promise<ActiveScan | null> =>
    ipcRenderer.invoke(IPC.security.activeScan, projectId),
  history: (projectId: string): Promise<SecurityScanRecord[]> =>
    ipcRenderer.invoke(IPC.security.history, projectId),
  getScan: (id: string): Promise<SecurityScanRecord | null> =>
    ipcRenderer.invoke(IPC.security.getScan, id),
  latest: (projectId: string): Promise<SecurityScanRecord | null> =>
    ipcRenderer.invoke(IPC.security.latest, projectId),
  deleteScan: (id: string): Promise<void> => ipcRenderer.invoke(IPC.security.deleteScan, id),
  getConfig: (projectId: string): Promise<SecurityScannerSettings> =>
    ipcRenderer.invoke(IPC.security.getConfig, projectId),
  setConfig: (projectId: string, config: SecurityScannerSettings): Promise<void> =>
    ipcRenderer.invoke(IPC.security.setConfig, projectId, config),
  suggestCodeqlLanguage: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.security.suggestCodeqlLanguage, projectId),
  onScanProgress: (callback: (payload: SecurityScanProgress) => void): (() => void) =>
    subscribe(IPC.security.onScanProgress, callback),
  codeqlStatus: (): Promise<CodeqlLocalStatus> => ipcRenderer.invoke(IPC.security.codeqlStatus),
  installCodeql: (): Promise<CodeqlLocalStatus> => ipcRenderer.invoke(IPC.security.installCodeql),
  cancelCodeqlInstall: (): Promise<void> => ipcRenderer.invoke(IPC.security.cancelCodeqlInstall),
  removeCodeql: (): Promise<CodeqlLocalStatus> => ipcRenderer.invoke(IPC.security.removeCodeql),
  openCodeqlFolder: (): Promise<void> => ipcRenderer.invoke(IPC.security.openCodeqlFolder),
  onCodeqlProgress: (callback: (payload: CodeqlInstallProgress) => void): (() => void) =>
    subscribe(IPC.security.onCodeqlProgress, callback),
};

const tools = {
  detectAll: (): Promise<InstalledAgentTool[]> => ipcRenderer.invoke(IPC.tools.detectAll),
  getInstallCommand: (toolId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.tools.getInstallCommand, toolId),
  checkForUpdate: (toolId: string, currentVersion: string | null): Promise<ToolUpdateCheckResult> =>
    ipcRenderer.invoke(IPC.tools.checkForUpdate, toolId, currentVersion),
  getUpdateCommand: (toolId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.tools.getUpdateCommand, toolId),
  getUninstallCommand: (toolId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.tools.getUninstallCommand, toolId),
  getInteractiveLaunchCommand: (toolId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.tools.getInteractiveLaunchCommand, toolId),
  getDockerCommand: (
    toolId: string,
    action: 'run' | 'start' | 'stop' | 'reset' | 'remove',
  ): Promise<string | null> => ipcRenderer.invoke(IPC.tools.getDockerCommand, toolId, action),
};

const docker = {
  availability: (): Promise<boolean> => ipcRenderer.invoke(IPC.docker.availability),
  list: (): Promise<DockerContainer[]> => ipcRenderer.invoke(IPC.docker.list),
  listForProject: (folderPath: string): Promise<DockerContainer[]> =>
    ipcRenderer.invoke(IPC.docker.listForProject, folderPath),
  runningForProject: (folderPath: string): Promise<DockerContainer[]> =>
    ipcRenderer.invoke(IPC.docker.runningForProject, folderPath),
  start: (id: string): Promise<DockerActionResult> => ipcRenderer.invoke(IPC.docker.start, id),
  stop: (id: string): Promise<DockerActionResult> => ipcRenderer.invoke(IPC.docker.stop, id),
  restart: (id: string): Promise<DockerActionResult> => ipcRenderer.invoke(IPC.docker.restart, id),
  remove: (id: string, options: DockerRemoveOptions): Promise<DockerActionResult> =>
    ipcRenderer.invoke(IPC.docker.remove, id, options),
  listImages: (): Promise<DockerImage[]> => ipcRenderer.invoke(IPC.docker.listImages),
  removeImages: (targets: DockerImageTarget[]): Promise<DockerImageRemoveResult> =>
    ipcRenderer.invoke(IPC.docker.removeImages, targets),
  logs: (id: string, options?: DockerLogsOptions): Promise<DockerLogLine[]> =>
    ipcRenderer.invoke(IPC.docker.logs, id, options),
};

const dockerHub = {
  status: (): Promise<DockerHubStatus> => ipcRenderer.invoke(IPC.dockerHub.status),
  repositories: (): Promise<DockerHubRepository[]> =>
    ipcRenderer.invoke(IPC.dockerHub.repositories),
  tags: (namespace: string, name: string): Promise<DockerHubTag[]> =>
    ipcRenderer.invoke(IPC.dockerHub.tags, namespace, name),
  pull: (input: DockerHubPullInput): Promise<DockerActionResult> =>
    ipcRenderer.invoke(IPC.dockerHub.pull, input),
};

const resourceActivity = {
  snapshot: (options?: { fresh?: boolean }): Promise<ResourceActivitySnapshot> =>
    ipcRenderer.invoke(IPC.resourceActivity.snapshot, options),
  stop: (refs: ResourceRef[], options?: { onlyIfIdle?: boolean }): Promise<ResourceStopOutcome> =>
    ipcRenderer.invoke(IPC.resourceActivity.stop, refs, options),
};

const devSetup = {
  environment: (options?: { force?: boolean }): Promise<DevSetupEnvironment> =>
    ipcRenderer.invoke(IPC.devSetup.environment, options),
  detect: (id: string, options?: { force?: boolean }): Promise<DevDetection> =>
    ipcRenderer.invoke(IPC.devSetup.detect, id, options),
  peek: (ids: string[]): Promise<Record<string, DevDetection | undefined>> =>
    ipcRenderer.invoke(IPC.devSetup.peek, ids),
  /**
   * Which installed tools have a newer version on offer. Answers are remembered in main for half an
   * hour; `force` asks again.
   */
  updates: (
    ids: string[],
    options?: { force?: boolean },
  ): Promise<Record<string, DevUpdateCheck>> =>
    ipcRenderer.invoke(IPC.devSetup.updates, ids, options),
  /** `intent: 'update'` brings tools that are already installed up to date. */
  install: (request: {
    ids: string[];
    consented?: boolean;
    intent?: 'install' | 'update';
  }): Promise<DevJobState> => ipcRenderer.invoke(IPC.devSetup.install, request),
  /** With an id, takes that waiting step out of the queue; without, stops the whole run. */
  cancel: (id?: string): Promise<void> => ipcRenderer.invoke(IPC.devSetup.cancel, id),
  /**
   * Puts the folder of a tool that is installed but off PATH on the user PATH. Only the id is sent;
   * main works out the folder. `where` is for the sentence that says what was written.
   */
  addToPath: (id: string): Promise<{ changed: boolean; where: string }> =>
    ipcRenderer.invoke(IPC.devSetup.addToPath, id),
  jobState: (): Promise<DevJobState> => ipcRenderer.invoke(IPC.devSetup.jobState),
  onEvent: (callback: (event: DevJobEvent) => void): (() => void) =>
    subscribe(IPC.devSetup.onEvent, callback),
};

const android = {
  sdk: (): Promise<AndroidSdkStatus> => ipcRenderer.invoke(IPC.android.sdk),
  setSdkPath: (path: string | null): Promise<AndroidSdkStatus> =>
    ipcRenderer.invoke(IPC.android.setSdkPath, path),
  pickSdkPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.android.pickSdkPath),
  refresh: (): Promise<AndroidSnapshot> => ipcRenderer.invoke(IPC.android.refresh),
  start: (
    avdName: string,
    options?: { coldBoot?: boolean; wipeData?: boolean },
  ): Promise<AndroidActionResult> => ipcRenderer.invoke(IPC.android.start, avdName, options ?? {}),
  stop: (serial: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.stop, serial),
  cancelBoot: (avdName: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.cancelBoot, avdName),
  watchUsage: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.android.watchUsage, enabled),
  rotate: (serial: string): Promise<void> => ipcRenderer.invoke(IPC.android.rotate, serial),
  screenshot: (serial: string, label: string): Promise<AndroidCapture> =>
    ipcRenderer.invoke(IPC.android.screenshot, serial, label),
  startRecording: (serial: string, label: string): Promise<{ id: string }> =>
    ipcRenderer.invoke(IPC.android.startRecording, serial, label),
  stopRecording: (id: string): Promise<AndroidCapture> =>
    ipcRenderer.invoke(IPC.android.stopRecording, id),
  installApk: (serial: string, paths: string[]): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.installApk, serial, paths),
  pickApk: (): Promise<string[]> => ipcRenderer.invoke(IPC.android.pickApk),
  adbPath: (): Promise<string> => ipcRenderer.invoke(IPC.android.adbPath),
  revealCapture: (path: string): Promise<void> =>
    ipcRenderer.invoke(IPC.android.revealCapture, path),
  openCapturesFolder: (): Promise<void> => ipcRenderer.invoke(IPC.android.openCapturesFolder),
  createAvd: (spec: CreateAvdSpec): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.createAvd, spec),
  deleteAvd: (name: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.deleteAvd, name),
  editAvd: (name: string, edit: AvdEdit): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.editAvd, name, edit),
  avdConfig: (name: string): Promise<AvdAdvanced> =>
    ipcRenderer.invoke(IPC.android.avdConfig, name),
  wipeData: (name: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.wipeData, name),
  listSystemImages: (): Promise<SystemImage[]> => ipcRenderer.invoke(IPC.android.listSystemImages),
  availableSystemImages: (
    force?: boolean,
  ): Promise<{ images: SystemImage[]; error: string | null }> =>
    ipcRenderer.invoke(IPC.android.availableSystemImages, force ?? false),
  installSystemImage: (packageId: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.installSystemImage, packageId),
  listDeviceProfiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.android.listDeviceProfiles),
  pair: (hostPort: string, code: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.pair, hostPort, code),
  connect: (hostPort: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.connect, hostPort),
  disconnect: (serial: string): Promise<AndroidActionResult> =>
    ipcRenderer.invoke(IPC.android.disconnect, serial),
  enableWireless: (serial: string): Promise<AndroidActionResult & { hostPort?: string }> =>
    ipcRenderer.invoke(IPC.android.enableWireless, serial),
  onEvent: (callback: (event: AndroidEvent) => void): (() => void) =>
    subscribe(IPC.android.onEvent, callback),
};

const fs = {
  readFile: (path: string): Promise<string> => ipcRenderer.invoke(IPC.fs.readFile, path),
  /** An image file as a data URL, for the workspace viewer. Rejects for anything else. */
  readImage: (path: string): Promise<ImageFileData> => ipcRenderer.invoke(IPC.fs.readImage, path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.fs.writeFile, path, content),
  listDirectory: (path: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke(IPC.fs.listDirectory, path),
  writeScratchFile: (fileName: string, content: string): Promise<string> =>
    ipcRenderer.invoke(IPC.fs.writeScratchFile, fileName, content),
  saveFileAs: (defaultFileName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.fs.saveFileAs, defaultFileName, content),
};

/** File operations from the workspace explorer. Every path must sit inside the project folder. */
const explorer = {
  createFile: (projectId: string, parentDir: string, name: string): Promise<string> =>
    ipcRenderer.invoke(IPC.explorer.createFile, projectId, parentDir, name),
  createFolder: (projectId: string, parentDir: string, name: string): Promise<string> =>
    ipcRenderer.invoke(IPC.explorer.createFolder, projectId, parentDir, name),
  rename: (projectId: string, path: string, newName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.explorer.rename, projectId, path, newName),
  delete: (
    projectId: string,
    paths: string[],
    options: { permanent: boolean },
  ): Promise<ExplorerDeleteResult> =>
    ipcRenderer.invoke(IPC.explorer.delete, projectId, paths, options),
  copy: (
    projectId: string,
    sources: string[],
    targetDir: string,
  ): Promise<ExplorerTransferResult> =>
    ipcRenderer.invoke(IPC.explorer.copy, projectId, sources, targetDir),
  move: (
    projectId: string,
    sources: string[],
    targetDir: string,
    options: { overwrite: boolean },
  ): Promise<ExplorerTransferResult> =>
    ipcRenderer.invoke(IPC.explorer.move, projectId, sources, targetDir, options),
  /** Copies files or folders from outside the project (an OS clipboard paste, or a drag from Explorer/Finder) into it. */
  pasteExternal: (
    projectId: string,
    sources: string[],
    targetDir: string,
  ): Promise<ExplorerTransferResult> =>
    ipcRenderer.invoke(IPC.explorer.pasteExternal, projectId, sources, targetDir),
  /** The OS clipboard's current file list, for pasting real files into the workspace explorer. */
  osClipboardPaths: (): Promise<string[]> => ipcRenderer.invoke(IPC.explorer.osClipboardPaths),
  revealInOs: (projectId: string, path: string): Promise<void> =>
    ipcRenderer.invoke(IPC.explorer.revealInOs, projectId, path),
  addToGitignore: (
    projectId: string,
    path: string,
    pattern: 'path' | 'extension',
  ): Promise<ExplorerGitignoreResult> =>
    ipcRenderer.invoke(IPC.explorer.addToGitignore, projectId, path, pattern),
  untrack: (projectId: string, path: string): Promise<void> =>
    ipcRenderer.invoke(IPC.explorer.untrack, projectId, path),
  ignoredPaths: (projectId: string, paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC.explorer.ignoredPaths, projectId, paths),
  /** Every file in the project, for the explorer's search box. */
  listFiles: (projectId: string): Promise<ExplorerFileIndex> =>
    ipcRenderer.invoke(IPC.explorer.listFiles, projectId),
};

/** The workspace search dialog: text search through ripgrep, and the project's declarations. */
const workspaceSearch = {
  /** Resolves once the search stops. Matches arrive through `onTextResults` while it runs. */
  text: (
    projectId: string,
    requestId: string,
    request: TextSearchRequest,
  ): Promise<TextSearchSummary> =>
    ipcRenderer.invoke(IPC.workspaceSearch.text, projectId, requestId, request),
  cancel: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.workspaceSearch.cancel, requestId),
  /** The whole index, or `unchanged` when `sinceVersion` is still current. */
  symbols: (projectId: string, sinceVersion?: number): Promise<SymbolIndexPayload> =>
    ipcRenderer.invoke(IPC.workspaceSearch.symbols, projectId, sinceVersion),
  onTextResults: (callback: (batch: TextSearchBatch) => void): (() => void) =>
    subscribe(IPC.workspaceSearch.onTextResults, callback),
};

const settings = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settings.get),
  update: (updates: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settings.update, updates),
};

const templates = {
  list: (): Promise<PromptTemplate[]> => ipcRenderer.invoke(IPC.templates.list),
  save: (input: SaveTemplateInput): Promise<PromptTemplate> =>
    ipcRenderer.invoke(IPC.templates.save, input),
  delete: (templateId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.templates.delete, templateId),
};

const activity = {
  list: (): Promise<ActivityEvent[]> => ipcRenderer.invoke(IPC.activity.list),
};

const shellApi = {
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.shell.openExternal, url),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.shell.openPath, path),
  openInEditor: (path: string): Promise<void> => ipcRenderer.invoke(IPC.shell.openInEditor, path),
  /** The file system path of a file dropped into the window. Empty for files not on disk. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
};

const terminalClipboard = {
  /** Saves pasted image bytes to a file and returns its path, for pasting into an agent CLI. */
  saveImage: (bytes: Uint8Array, mime: string): Promise<string> =>
    ipcRenderer.invoke(IPC.terminalClipboard.saveImage, bytes, mime),
  /** What the system clipboard holds for a terminal: text, or paths for copied files and
   * images. Null when it holds nothing a terminal can use. */
  read: (): Promise<TerminalClipboardPaste | null> =>
    ipcRenderer.invoke(IPC.terminalClipboard.read),
  /** A data URL of an image file, scaled down for a hover preview unless `fullSize`. Null when
   * it can't be shown. */
  previewImage: (path: string, fullSize = false): Promise<string | null> =>
    ipcRenderer.invoke(IPC.terminalClipboard.previewImage, path, fullSize),
};

/** The workspace browser tab's pages (webview guests). */
const browser = {
  /** Crops a picked element out of a page and saves it for an agent. Null when it is off
   * screen. `rect` and `viewport` are in the page's CSS pixels. */
  captureElement: (
    webContentsId: number,
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
  ): Promise<BrowserElementShot | null> =>
    ipcRenderer.invoke(IPC.browser.captureElement, webContentsId, rect, viewport),
  /** A browser shortcut pressed while a page had focus. */
  onGuestShortcut: (callback: (payload: BrowserGuestShortcut) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BrowserGuestShortcut): void =>
      callback(payload);
    ipcRenderer.on(IPC.browser.onGuestShortcut, listener);
    return () => ipcRenderer.removeListener(IPC.browser.onGuestShortcut, listener);
  },
  /** A page asked to open a new window. */
  onOpenInNewTab: (callback: (payload: BrowserOpenInNewTab) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BrowserOpenInNewTab): void =>
      callback(payload);
    ipcRenderer.on(IPC.browser.onOpenInNewTab, listener);
    return () => ipcRenderer.removeListener(IPC.browser.onOpenInNewTab, listener);
  },
};

const promptHistory = {
  /** Pass a projectId to get only that project's entries. */
  list: (projectId?: string | null): Promise<PromptHistoryEntry[]> =>
    ipcRenderer.invoke(IPC.promptHistory.list, projectId),
  search: (query: string, projectId?: string | null): Promise<PromptHistoryEntry[]> =>
    ipcRenderer.invoke(IPC.promptHistory.search, query, projectId),
  add: (input: AddPromptHistoryInput): Promise<PromptHistoryEntry> =>
    ipcRenderer.invoke(IPC.promptHistory.add, input),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.promptHistory.remove, id),
  setTags: (id: string, tags: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.promptHistory.setTags, id, tags),
  /** Moves an entry to another project, or detaches it when `projectId` is null. */
  setProject: (id: string, projectId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.promptHistory.setProject, id, projectId),
};

const translate = {
  text: (input: TranslateTextInput): Promise<string> =>
    ipcRenderer.invoke(IPC.translate.text, input),
  /** Stops an in-flight text() that was given the same requestId. */
  cancel: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.translate.cancel, requestId),
};

const ai = {
  ask: (input: AskAiInput): Promise<AskAiResult> => ipcRenderer.invoke(IPC.ai.ask, input),
  /** Aborts an in-flight ask() that was given the same requestId. */
  cancel: (requestId: string): Promise<boolean> => ipcRenderer.invoke(IPC.ai.cancel, requestId),
  /** Lists installed Ollama models. Pass a baseUrl to probe a server that hasn't been saved yet. */
  listOllamaModels: (baseUrl?: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.ai.listOllamaModels, baseUrl),
  /** Pings an Ollama server and reports its version and how many models it has. */
  testOllama: (baseUrl?: string): Promise<OllamaConnectionTest> =>
    ipcRenderer.invoke(IPC.ai.testOllama, baseUrl),
  listGeminiModels: (): Promise<string[]> => ipcRenderer.invoke(IPC.ai.listGeminiModels),
  /** Sizes a generated prompt with the default AI CLI: complexity, model, and effort. */
  assessRun: (input: AssessRunInput): Promise<AssessRunResult> =>
    ipcRenderer.invoke(IPC.ai.assessRun, input),
  /** Stops an assessRun() that was given the same requestId. */
  cancelAssessRun: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ai.cancelAssessRun, requestId),
  /** Answers a one-off prompt with the agent CLI, model and effort the user picked. */
  askCli: (input: AskCliInput): Promise<AskCliResult> => ipcRenderer.invoke(IPC.ai.askCli, input),
  /** Stops an askCli() that was given the same requestId. */
  cancelAskCli: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ai.cancelAskCli, requestId),
};

const help = {
  /** Answers a question about using Runova from the Help articles. */
  ask: (input: HelpAskInput): Promise<HelpAskResult> => ipcRenderer.invoke(IPC.help.ask, input),
  /** Aborts an in-flight ask() that was given the same requestId. */
  cancel: (requestId: string): Promise<boolean> => ipcRenderer.invoke(IPC.help.cancel, requestId),
  /** How much of the Help index the provider's embedder has covered. */
  status: (provider: HelpAskInput['provider']): Promise<HelpIndexStatus> =>
    ipcRenderer.invoke(IPC.help.status, provider),
  /** Embeds the articles with the provider's current model; `fresh` starts over from nothing. */
  reindex: (
    provider: HelpAskInput['provider'],
    options?: { fresh?: boolean },
  ): Promise<HelpReindexResult> => ipcRenderer.invoke(IPC.help.reindex, provider, options),
  /** Stops a reindex() running for the provider. */
  cancelReindex: (provider: HelpAskInput['provider']): Promise<boolean> =>
    ipcRenderer.invoke(IPC.help.cancelReindex, provider),
  /** The embedding models the help search can use with the provider. */
  embeddingModels: (provider: HelpAskInput['provider']): Promise<HelpEmbeddingModelOption[]> =>
    ipcRenderer.invoke(IPC.help.embeddingModels, provider),
  onIndexProgress: (callback: (progress: HelpIndexProgress) => void): (() => void) =>
    subscribe(IPC.help.onIndexProgress, callback),
};

const speech = {
  transcribe: (input: TranscribeAudioInput): Promise<TranscribeAudioResult> =>
    ipcRenderer.invoke(IPC.speech.transcribe, input),
  cancel: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC.speech.cancel, requestId),
  getModelState: (): Promise<SpeechModelState> => ipcRenderer.invoke(IPC.speech.getModelState),
  onModelProgress: (callback: (progress: SpeechModelProgress) => void): (() => void) =>
    subscribe(IPC.speech.onModelProgress, callback),
};

const system = {
  sample: (): Promise<SystemStatsSample> => ipcRenderer.invoke(IPC.system.sample),
  topApps: (resource: TopResourceKind): Promise<TopResourceAppsResult> =>
    ipcRenderer.invoke(IPC.system.topApps, resource),
  killProcess: (pid: number): Promise<KillProcessResult> =>
    ipcRenderer.invoke(IPC.system.killProcess, pid),
};

const ipGeo = {
  lookup: (force?: boolean): Promise<IpGeoInfo> => ipcRenderer.invoke(IPC.ipGeo.lookup, force),
};

const projectDrafts = {
  listByProject: (projectId: string): Promise<ProjectDraft[]> =>
    ipcRenderer.invoke(IPC.projectDrafts.listByProject, projectId),
  create: (input: CreateProjectDraftInput): Promise<ProjectDraft> =>
    ipcRenderer.invoke(IPC.projectDrafts.create, input),
  updateStatus: (draftId: string, status: ProjectDraftStatus): Promise<void> =>
    ipcRenderer.invoke(IPC.projectDrafts.updateStatus, draftId, status),
  update: (draftId: string, patch: UpdateProjectDraftInput): Promise<ProjectDraft | null> =>
    ipcRenderer.invoke(IPC.projectDrafts.update, draftId, patch),
  /** Turns a draft into a scheduled task and removes the draft. */
  promoteToScheduled: (draftId: string, task: ScheduledTaskInput): Promise<ScheduledTask | null> =>
    ipcRenderer.invoke(IPC.projectDrafts.promoteToScheduled, draftId, task),
  remove: (draftId: string): Promise<void> => ipcRenderer.invoke(IPC.projectDrafts.remove, draftId),
};

const blueprints = {
  get: (projectId: string): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(IPC.blueprints.get, projectId),
  updateSection: (
    projectId: string,
    stepId: BlueprintStepId,
    patch: BlueprintSectionPatch,
  ): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(IPC.blueprints.updateSection, projectId, stepId, patch),
  setFinalPrompt: (projectId: string, text: string): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(IPC.blueprints.setFinalPrompt, projectId, text),
  setDocsFolder: (projectId: string, folder: string): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(IPC.blueprints.setDocsFolder, projectId, folder),
  setConfirmBeforeWriting: (projectId: string, value: boolean): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(IPC.blueprints.setConfirmBeforeWriting, projectId, value),
  /** Relay (E26): write the backlog as task files sized to this context budget. */
  setRelay: (
    projectId: string,
    value: { enabled: boolean; budgetTokens: number },
  ): Promise<ProjectBlueprint> => ipcRenderer.invoke(IPC.blueprints.setRelay, projectId, value),
  /** Null when the picker was cancelled, so the caller can tell that from "nothing changed". */
  pickAttachments: (
    projectId: string,
    stepId: BlueprintStepId,
  ): Promise<BlueprintAttachmentResult | null> =>
    ipcRenderer.invoke(IPC.blueprints.pickAttachments, projectId, stepId),
  addAttachment: (
    projectId: string,
    stepId: BlueprintStepId,
    input: BlueprintAttachmentInput,
  ): Promise<BlueprintAttachmentResult> =>
    ipcRenderer.invoke(IPC.blueprints.addAttachment, projectId, stepId, input),
  renameAttachment: (
    projectId: string,
    stepId: BlueprintStepId,
    attachmentId: string,
    displayName: string,
  ): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(
      IPC.blueprints.renameAttachment,
      projectId,
      stepId,
      attachmentId,
      displayName,
    ),
  removeAttachment: (
    projectId: string,
    stepId: BlueprintStepId,
    attachmentId: string,
  ): Promise<ProjectBlueprint> =>
    ipcRenderer.invoke(IPC.blueprints.removeAttachment, projectId, stepId, attachmentId),
  /** Absolute path of one attachment, for handing to the OS through shell.openPath. */
  attachmentPath: (projectId: string, attachmentId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.blueprints.attachmentPath, projectId, attachmentId),
  /** `stepId` of null asks for the final prompt's history rather than a section's. */
  listRevisions: (
    projectId: string,
    stepId: BlueprintStepId | null,
  ): Promise<BlueprintRevision[]> =>
    ipcRenderer.invoke(IPC.blueprints.listRevisions, projectId, stepId),
  agentFileTarget: (projectId: string): Promise<BlueprintAgentFileTarget> =>
    ipcRenderer.invoke(IPC.blueprints.agentFileTarget, projectId),
  syncAgentFile: (projectId: string): Promise<BlueprintAgentFileResult> =>
    ipcRenderer.invoke(IPC.blueprints.syncAgentFile, projectId),
  listPresets: (): Promise<BlueprintPreset[]> => ipcRenderer.invoke(IPC.blueprints.listPresets),
  savePreset: (input: SaveBlueprintPresetInput): Promise<BlueprintPreset[]> =>
    ipcRenderer.invoke(IPC.blueprints.savePreset, input),
  deletePreset: (presetId: string): Promise<BlueprintPreset[]> =>
    ipcRenderer.invoke(IPC.blueprints.deletePreset, presetId),
};

const promptBuildWidget = {
  listWidgets: (): Promise<DesktopPromptBuildWidgetInstance[]> =>
    ipcRenderer.invoke(IPC.promptBuildWidget.listWidgets),
  getWidget: (id: string): Promise<DesktopPromptBuildWidgetInstance | null> =>
    ipcRenderer.invoke(IPC.promptBuildWidget.getWidget, id),
  openWidget: (projectId: string, projectName: string): Promise<DesktopPromptBuildWidgetInstance> =>
    ipcRenderer.invoke(IPC.promptBuildWidget.openWidget, projectId, projectName),
  closeWidget: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.promptBuildWidget.closeWidget, id),
};

const scheduledTasks = {
  list: (): Promise<ScheduledTask[]> => ipcRenderer.invoke(IPC.scheduledTasks.list),
  listByProject: (projectId: string): Promise<ScheduledTask[]> =>
    ipcRenderer.invoke(IPC.scheduledTasks.listByProject, projectId),
  createMany: (input: CreateScheduledTasksInput): Promise<ScheduledTask[]> =>
    ipcRenderer.invoke(IPC.scheduledTasks.createMany, input),
  updateStatus: (taskId: string, status: ScheduledTaskStatus): Promise<void> =>
    ipcRenderer.invoke(IPC.scheduledTasks.updateStatus, taskId, status),
  update: (taskId: string, patch: UpdateScheduledTaskInput): Promise<ScheduledTask | null> =>
    ipcRenderer.invoke(IPC.scheduledTasks.update, taskId, patch),
  /** Records a run started by hand: completed, with the time it ran. */
  markRan: (taskId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.scheduledTasks.markRan, taskId),
  remove: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.scheduledTasks.remove, taskId),
  /** main saying an automatic task is due and should open in a terminal now. */
  onDue: (callback: (task: ScheduledTask) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, task: ScheduledTask): void =>
      callback(task);
    ipcRenderer.on(IPC.scheduledTasks.onDue, listener);
    return () => ipcRenderer.removeListener(IPC.scheduledTasks.onDue, listener);
  },
  /** main saying tasks changed on its side (fired or marked missed), so lists should refetch. */
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on(IPC.scheduledTasks.onChanged, listener);
    return () => ipcRenderer.removeListener(IPC.scheduledTasks.onChanged, listener);
  },
};

const notifications = {
  sendTest: (input: SendTestNotificationInput): Promise<NotificationSendResult> =>
    ipcRenderer.invoke(IPC.notifications.sendTest, input),
  /** Shows the message on the desktop companion, so the pet hook can be previewed. */
  sendPetTest: (input: SendTestNotificationInput): Promise<NotificationSendResult> =>
    ipcRenderer.invoke(IPC.notifications.sendPetTest, input),
  detectChatId: (): Promise<DetectChatIdResult> =>
    ipcRenderer.invoke(IPC.notifications.detectChatId),
  onConfirmationForwarded: (
    callback: (payload: ConfirmationForwardedPayload) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: ConfirmationForwardedPayload,
    ): void => callback(payload);
    ipcRenderer.on(IPC.notifications.onConfirmationForwarded, listener);
    return () => ipcRenderer.removeListener(IPC.notifications.onConfirmationForwarded, listener);
  },
};

const git = {
  status: (projectId: string): Promise<GitStatus> => ipcRenderer.invoke(IPC.git.status, projectId),
  listFiles: (projectId: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.git.listFiles, projectId),
  changeSummary: (projectId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.git.changeSummary, projectId),
  fetch: (projectId: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.git.fetch, projectId),
  pull: (projectId: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.git.pull, projectId),
  push: (projectId: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.git.push, projectId),
  sync: (projectId: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.git.sync, projectId),
  createBranch: (projectId: string, branchName: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.createBranch, projectId, branchName),
  checkoutBranch: (projectId: string, branchName: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.checkoutBranch, projectId, branchName),
  setDefaultBranch: (projectId: string, branchName: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.setDefaultBranch, projectId, branchName),
  renameBranch: (input: RenameBranchInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.renameBranch, input),
  deleteBranch: (input: DeleteBranchInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.deleteBranch, input),
  branchHistory: (projectId: string, branchName: string): Promise<GitBranchHistory> =>
    ipcRenderer.invoke(IPC.git.branchHistory, projectId, branchName),
  /** Commits everything, or only `paths` (repo-relative) when given. */
  commit: (projectId: string, message: string, paths?: string[]): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.commit, projectId, message, paths),
  /** Tag state for the repo, or for one tag series (e.g. "web-v") when a prefix is given. */
  tags: (projectId: string, prefix?: string): Promise<GitTagInfo> =>
    ipcRenderer.invoke(IPC.git.tags, projectId, prefix),
  createTag: (input: CreateTagInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.createTag, input),
  suggestTag: (projectId: string, requestId?: string, prefix?: string): Promise<SuggestTagResult> =>
    ipcRenderer.invoke(IPC.git.suggestTag, projectId, requestId, prefix),
  /** Kills the CLI process behind an in-flight suggestTag(requestId). */
  cancelSuggestTag: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.git.cancelSuggestTag, requestId),
  /** Runs the CLI over the project's files to bump every version string to `tag`. */
  applyVersion: (input: ApplyVersionInput): Promise<ApplyVersionResult> =>
    ipcRenderer.invoke(IPC.git.applyVersion, input),
  cancelApplyVersion: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.git.cancelApplyVersion, requestId),
  /** Reverts one file the version bump changed, or puts the bump's edit back. */
  swapVersionFile: (input: SwapVersionFileInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.swapVersionFile, input),
  /** Rewrites one file the version bump changed with only some of its changes kept. */
  writeVersionHunks: (input: WriteVersionHunksInput): Promise<WriteVersionHunksResult> =>
    ipcRenderer.invoke(IPC.git.writeVersionHunks, input),
  suggestBranchName: (projectId: string, requestId?: string): Promise<SuggestGitTextResult> =>
    ipcRenderer.invoke(IPC.git.suggestBranchName, projectId, requestId),
  /** Kills the CLI process behind an in-flight suggestBranchName(requestId). */
  cancelSuggestBranchName: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.git.cancelSuggestBranchName, requestId),
  /** `scope: 'staged'` describes only what is staged, for a commit of just those changes. */
  suggestCommitMessage: (
    projectId: string,
    requestId?: string,
    scope?: 'staged' | 'all',
  ): Promise<SuggestGitTextResult> =>
    ipcRenderer.invoke(IPC.git.suggestCommitMessage, projectId, requestId, scope),
  /** Kills the CLI process behind an in-flight suggestCommitMessage(requestId). */
  cancelSuggestCommitMessage: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.git.cancelSuggestCommitMessage, requestId),
  createPullRequest: (input: CreatePullRequestInput): Promise<CreatePullRequestResult> =>
    ipcRenderer.invoke(IPC.git.createPullRequest, input),
  /** Creates the repository in the project folder, on the branch the caller picked. */
  init: (input: GitInitInput): Promise<GitOpResult> => ipcRenderer.invoke(IPC.git.init, input),
  /** Who the GitHub CLI is signed in as, plus the organizations that account belongs to. */
  githubAccount: (): Promise<GithubAccount> => ipcRenderer.invoke(IPC.git.githubAccount),
  /** Contribution counts for the signed-in GitHub user, used by the dashboard chart. */
  githubActivity: (): Promise<GithubActivity> => ipcRenderer.invoke(IPC.git.githubActivity),
  /** Unread GitHub notifications for the signed-in account. */
  githubNotifications: (): Promise<GithubNotifications> =>
    ipcRenderer.invoke(IPC.git.githubNotifications),
  /** Marks one GitHub notification thread as read. */
  githubMarkNotificationRead: (threadId: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.githubMarkNotificationRead, threadId),
  /** Marks every unread GitHub notification as read. */
  githubMarkNotificationsRead: (): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.githubMarkNotificationsRead),
  lookupGithubRepo: (owner: string, name: string): Promise<GithubRepoLookup> =>
    ipcRenderer.invoke(IPC.git.lookupGithubRepo, owner, name),
  createGithubRepo: (input: CreateGithubRepoInput): Promise<CreateGithubRepoResult> =>
    ipcRenderer.invoke(IPC.git.createGithubRepo, input),
  /** Points origin at `url`, and optionally pushes the current branch with -u. */
  connectRemote: (input: ConnectRemoteInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.connectRemote, input),
  /** Origin's URL for a folder path, as a browsable link. Null when there isn't one. */
  detectRemote: (folderPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.git.detectRemote, folderPath),
  /** Clones a GitHub repo into the New Project folder. Never throws: check `ok`. */
  cloneInto: (input: CloneIntoInput): Promise<CloneIntoResult> =>
    ipcRenderer.invoke(IPC.git.cloneInto, input),
  /** Clones the project's repo into its folder, or attaches a folder that has files. Never throws. */
  cloneProject: (input: CloneProjectInput): Promise<CloneProjectResult> =>
    ipcRenderer.invoke(IPC.git.cloneProject, input),
  /** Asks main to watch this project's `.git`, so outside commits reach the open Git tab. */
  watchRepo: (projectId: string): Promise<void> => ipcRenderer.invoke(IPC.git.watchRepo, projectId),
  unwatchRepo: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.git.unwatchRepo, projectId),
  onRepoChanged: (callback: (projectId: string) => void): (() => void) =>
    subscribe(IPC.git.onRepoChanged, callback),
  /** Branch, sync counts and every change, grouped the way the workspace panel lists them. */
  workspaceState: (projectId: string): Promise<WorkspaceGitState> =>
    ipcRenderer.invoke(IPC.git.workspaceState, projectId),
  /** Pushes a fresh state through onWorkspaceState whenever files in the project change. */
  watchWorkingTree: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.git.watchWorkingTree, projectId),
  unwatchWorkingTree: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.git.unwatchWorkingTree, projectId),
  onWorkspaceState: (
    callback: (projectId: string, state: WorkspaceGitState) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      projectId: string,
      state: WorkspaceGitState,
    ): void => callback(projectId, state);
    ipcRenderer.on(IPC.git.onWorkspaceState, listener);
    return () => ipcRenderer.removeListener(IPC.git.onWorkspaceState, listener);
  },
  stage: (projectId: string, paths: string[]): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.stage, projectId, paths),
  unstage: (projectId: string, paths: string[]): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.unstage, projectId, paths),
  /** Throws away working tree changes (or trashes untracked files); the result can be undone. */
  discard: (
    projectId: string,
    paths: string[],
    side: 'unstaged' | 'untracked',
  ): Promise<GitDiscardResult> => ipcRenderer.invoke(IPC.git.discard, projectId, paths, side),
  undoDiscard: (projectId: string, token: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.undoDiscard, projectId, token),
  /** Stages, unstages or discards only some lines of a file. A discard can be undone. */
  applyLines: (input: GitApplyLinesInput): Promise<GitDiscardResult> =>
    ipcRenderer.invoke(IPC.git.applyLines, input),
  resolveConflict: (
    projectId: string,
    path: string,
    pick: 'ours' | 'theirs',
  ): Promise<GitOpResult> => ipcRenderer.invoke(IPC.git.resolveConflict, projectId, path, pick),
  /** Has the project's AI CLI edit the conflict markers out of one file. Nothing is staged. */
  resolveConflictWithAi: (
    projectId: string,
    path: string,
    requestId: string,
  ): Promise<ResolveConflictWithAiResult> =>
    ipcRenderer.invoke(IPC.git.resolveConflictWithAi, projectId, path, requestId),
  /** Stops a resolveConflictWithAi(requestId) run and puts the file back as it was. */
  cancelResolveConflictWithAi: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.git.cancelResolveConflictWithAi, requestId),
  abortOperation: (projectId: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.abortOperation, projectId),
  /** Commits only what is staged, optionally pushing the branch right after. */
  commitStaged: (projectId: string, message: string, push: boolean): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.commitStaged, projectId, message, push),
  /** Stashes the working tree. `includeUntracked` is `--include-untracked`, `keepIndex` is `--keep-index`. */
  stashPush: (input: GitStashPushInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.stashPush, input),
  /** Newest stash first. Empty when nothing is stashed. */
  stashList: (projectId: string): Promise<GitStashEntry[]> =>
    ipcRenderer.invoke(IPC.git.stashList, projectId),
  /** Restores the given stash (or the newest) and drops it. */
  stashPop: (projectId: string, ref?: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.stashPop, projectId, ref),
  /** Restores the given stash (or the newest) and keeps it. */
  stashApply: (projectId: string, ref?: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.stashApply, projectId, ref),
  /** Forgets the given stash without restoring it. */
  stashDrop: (projectId: string, ref: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.git.stashDrop, projectId, ref),
  fileDiff: (
    projectId: string,
    path: string,
    side: GitDiffSide,
    origPath?: string,
  ): Promise<GitFileDiff> => ipcRenderer.invoke(IPC.git.fileDiff, projectId, path, side, origPath),
  /** Both sides of a changed image, for the viewer that stands in for a binary diff. */
  fileImage: (
    projectId: string,
    path: string,
    side: GitDiffSide,
    origPath?: string,
  ): Promise<GitImageDiff> =>
    ipcRenderer.invoke(IPC.git.fileImage, projectId, path, side, origPath),
  /** Saves an edit to a working tree file from the diff view. `path` is repo-relative. */
  writeWorkingFile: (projectId: string, path: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.git.writeWorkingFile, projectId, path, content),
  /** The files a commit changed, with line counts. */
  commitFiles: (projectId: string, hash: string): Promise<GitChangeEntry[]> =>
    ipcRenderer.invoke(IPC.git.commitFiles, projectId, hash),
  /** One file as a commit changed it. */
  commitFileDiff: (
    projectId: string,
    hash: string,
    path: string,
    origPath?: string,
  ): Promise<GitFileDiff> =>
    ipcRenderer.invoke(IPC.git.commitFileDiff, projectId, hash, path, origPath),
  /** An image as a commit changed it. */
  commitFileImage: (
    projectId: string,
    hash: string,
    path: string,
    origPath?: string,
  ): Promise<GitImageDiff> =>
    ipcRenderer.invoke(IPC.git.commitFileImage, projectId, hash, path, origPath),
};

const pipelines = {
  status: (projectId: string): Promise<ProjectPipelineStatus> =>
    ipcRenderer.invoke(IPC.pipelines.status, projectId),
  setMuted: (projectId: string, actions: ProjectGithubAction[]): Promise<ProjectPipelineStatus> =>
    ipcRenderer.invoke(IPC.pipelines.setMuted, projectId, actions),
  dashboardActivity: (): Promise<GithubActionsActivity> =>
    ipcRenderer.invoke(IPC.pipelines.dashboardActivity),
  runError: (input: GithubActionsRunErrorInput): Promise<GithubActionsRunErrorResult> =>
    ipcRenderer.invoke(IPC.pipelines.runError, input),
  /** Warnings, notices and failures the run's jobs left behind. */
  runAnnotations: (input: GithubRunAnnotationsInput): Promise<GithubRunAnnotationsResult> =>
    ipcRenderer.invoke(IPC.pipelines.runAnnotations, input),
  /** The jobs of one run with each step's status and timing. */
  runDetails: (input: GithubRunDetailsInput): Promise<GithubRunDetailsResult> =>
    ipcRenderer.invoke(IPC.pipelines.runDetails, input),
  /** One finished job's log, split by step, with each line's kind. */
  jobLog: (input: GithubJobLogInput): Promise<GithubJobLogResult> =>
    ipcRenderer.invoke(IPC.pipelines.jobLog, input),
  /** Branches and tags a manual run can be started from. */
  refs: (repo: string): Promise<GithubWorkflowRefsResult> =>
    ipcRenderer.invoke(IPC.pipelines.refs, repo),
  /** Starts a workflow by hand, the way GitHub's "Run workflow" button does. */
  dispatch: (input: GithubWorkflowDispatchRequest): Promise<GithubPipelineActionResult> =>
    ipcRenderer.invoke(IPC.pipelines.dispatch, input),
  /** Stops a queued or in-progress run. */
  cancelRun: (input: GithubRunCancelRequest): Promise<GithubPipelineActionResult> =>
    ipcRenderer.invoke(IPC.pipelines.cancelRun, input),
  /** Self-hosted runners behind the projects' repos, and jobs stuck waiting for one. */
  runners: (input: GithubRunnersInput): Promise<GithubRunnersResult> =>
    ipcRenderer.invoke(IPC.pipelines.runners, input),
  /** CPU, memory and disk of the machine a runner was linked to. */
  runnerMachineStats: (link: RunnerMachineLink): Promise<RunnerMachineStatsResult> =>
    ipcRenderer.invoke(IPC.pipelines.runnerMachineStats, link),
};

/** The Deploy section: saved servers with their server core, installing it, and its health. */
const deploy = {
  listServers: (): Promise<DeployServer[]> => ipcRenderer.invoke(IPC.deploy.listServers),
  /** A read-only look at the server: OS, processor, sudo, disk, and what is installed. */
  preflight: (serverId: string): Promise<DeployPreflight> =>
    ipcRenderer.invoke(IPC.deploy.preflight, serverId),
  install: (input: DeployInstallInput): Promise<DeployInstallResult> =>
    ipcRenderer.invoke(IPC.deploy.install, input),
  uninstall: (input: DeployUninstallInput): Promise<void> =>
    ipcRenderer.invoke(IPC.deploy.uninstall, input),
  /**
   * Updates the core without SSH: the server downloads the release itself, or the app uploads it
   * over the core's connection. Needs an Owner with a step-up (`[core:stepUpRequired]`); pass the
   * password or a code. Ends in `needs-ssh` when the core cannot replace itself.
   */
  updateCore: (input: DeployStepUpInput): Promise<DeployCoreUpdateResult> =>
    ipcRenderer.invoke(IPC.deploy.updateCore, input),
  /** The core release this build installs, or null when it has none. */
  coreRelease: (): Promise<DeployCoreRelease | null> => ipcRenderer.invoke(IPC.deploy.coreRelease),
  health: (serverId: string): Promise<DeployHealth> =>
    ipcRenderer.invoke(IPC.deploy.health, serverId),
  /** Whether this computer can act on the core now: signed in, or what it needs first. */
  access: (serverId: string): Promise<DeployAccess> =>
    ipcRenderer.invoke(IPC.deploy.access, serverId),
  /** Enrolls this computer over SSH, as a user the core has (again, after a revocation). */
  enroll: (input: DeployEnrollInput): Promise<DeployAccess> =>
    ipcRenderer.invoke(IPC.deploy.enroll, input),
  signIn: (input: DeploySignInInput): Promise<DeployAccess> =>
    ipcRenderer.invoke(IPC.deploy.signIn, input),
  signOut: (serverId: string): Promise<void> => ipcRenderer.invoke(IPC.deploy.signOut, serverId),
  account: (serverId: string): Promise<AccountInfo> =>
    ipcRenderer.invoke(IPC.deploy.account, serverId),
  /** Confirms the password (or a code) again, for ten minutes of sensitive changes. */
  stepUp: (input: DeployStepUpInput): Promise<StepUpResponse> =>
    ipcRenderer.invoke(IPC.deploy.stepUp, input),
  /** Confirms with the password this computer remembers; null when there is none to use. */
  stepUpSaved: (serverId: string): Promise<StepUpResponse | null> =>
    ipcRenderer.invoke(IPC.deploy.stepUpSaved, serverId),
  /** Remembers the password (sealed on this computer) once the core has confirmed it is right. */
  rememberPassword: (input: DeployStepUpInput): Promise<void> =>
    ipcRenderer.invoke(IPC.deploy.rememberPassword, input),
  forgetPassword: (serverId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deploy.forgetPassword, serverId),
  beginTotp: (serverId: string): Promise<DeployTotpSetup> =>
    ipcRenderer.invoke(IPC.deploy.beginTotp, serverId),
  confirmTotp: (serverId: string, code: string): Promise<RecoveryCodes> =>
    ipcRenderer.invoke(IPC.deploy.confirmTotp, serverId, code),
  disableTotp: (serverId: string, code: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deploy.disableTotp, serverId, code),
  /** Each step of a running install or removal, as it starts, finishes or fails. */
  onSetupProgress: (cb: (event: DeploySetupProgressEvent) => void): (() => void) =>
    subscribe(IPC.deploy.onSetupProgress, cb),
  /** The server's lasting connection to its core right now. */
  connection: (serverId: string): Promise<DeployConnection> =>
    ipcRenderer.invoke(IPC.deploy.connection, serverId),
  /** Tries the connection again now, whatever it waited for (after unlocking the vault, say). */
  reconnect: (serverId: string): Promise<DeployConnection> =>
    ipcRenderer.invoke(IPC.deploy.reconnect, serverId),
  /** Every change of a server's connection: online, reconnecting, needs a sign-in, and so on. */
  onConnection: (cb: (connection: DeployConnection) => void): (() => void) =>
    subscribe(IPC.deploy.onConnection, cb),
};

/**
 * A server's Overview: its facts, live and stored metrics, updates, reboot and restarts. Calls
 * refused for a missing step-up carry `[core:stepUpRequired]`; for a role, `[core:forbidden]`.
 */
const deploySystem = {
  info: (serverId: string): Promise<SystemInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.info, serverId),
  services: (serverId: string): Promise<ServiceInfo[]> =>
    ipcRenderer.invoke(IPC.deploySystem.services, serverId),
  metricsHistory: (input: DeployMetricsHistoryInput): Promise<MetricsHistory> =>
    ipcRenderer.invoke(IPC.deploySystem.metricsHistory, input),
  updates: (serverId: string): Promise<UpdatesInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.updates, serverId),
  checkUpdates: (serverId: string): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.checkUpdates, serverId),
  upgradeSecurity: (serverId: string): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.upgradeSecurity, serverId),
  /** Needs a step-up: pass the password (or a code) unless one was made in the last 10 minutes. */
  upgradeAll: (input: DeployStepUpInput): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.upgradeAll, input),
  setAutomaticUpdates: (serverId: string, enabled: boolean): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.setAutomaticUpdates, serverId, enabled),
  /** Needs a step-up, as upgradeAll. The connection drops a few seconds after the job succeeds. */
  reboot: (input: DeployStepUpInput): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.reboot, input),
  restartService: (serverId: string, service: ManagedService): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySystem.restartService, serverId, service),
  /** Starts live samples for this window; they arrive on onMetrics under the returned id. */
  watchMetrics: (input: DeployMetricsWatchInput): Promise<string> =>
    ipcRenderer.invoke(IPC.deploySystem.watchMetrics, input),
  unwatchMetrics: (subscriptionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.deploySystem.unwatchMetrics, subscriptionId),
  onMetrics: (cb: (event: DeployMetricsEvent) => void): (() => void) =>
    subscribe(IPC.deploySystem.onMetrics, cb),
};

/** The jobs a server core runs, and their live logs (already redacted by the core). */
const deployJobs = {
  list: (query: DeployJobsQuery): Promise<JobPage> =>
    ipcRenderer.invoke(IPC.deployJobs.list, query),
  get: (serverId: string, jobId: string): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployJobs.get, serverId, jobId),
  cancel: (serverId: string, jobId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deployJobs.cancel, serverId, jobId),
  /** Starts a job's log for this window; it arrives on onLog until an event carries `ended`. */
  watch: (input: DeployJobWatchInput): Promise<string> =>
    ipcRenderer.invoke(IPC.deployJobs.watch, input),
  unwatch: (subscriptionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.deployJobs.unwatch, subscriptionId),
  onLog: (cb: (event: DeployJobEvent) => void): (() => void) => subscribe(IPC.deployJobs.onLog, cb),
};

/** Docker on a server: containers, their stats, logs and console, and Docker's resources. */
const deployDocker = createDeployDocker(subscribe);
const deployDirectTls = createDeployDirectTls();
const deployErrorReporting = createDeployErrorReporting();
const deployTelegram = createDeployTelegram();

/** The Security center (E15): the checklist, its SSH fixes, backups and restores. */
const deployHardening = createDeployHardening(subscribe);

/** A server's Backups section (E28): destinations, plans, runs and the restore wizard. */
const deployServerBackups = createDeployServerBackups(subscribe);

/** WordPress sites through the Runova Connector plugin, and WordPress projects (E19 to E21). */
const deployWordPress = createDeployWordPress(subscribe);

/** FTP and SFTP sites: a local deploy folder sent to a folder on a server (E23). */
const deployFiles = createDeployFiles(subscribe);

/** The Deploy AI and the logs center's journal (E09). */
const deployAssistant = createDeployAssistant(subscribe);
const deployLogs = createDeployLogs(subscribe);

/**
 * A server's Apps (E07). Env values never come here: the main process reads the environment,
 * renders the .env and uploads it. Changes return the job that does them (follow it with
 * deployJobs.watch); refusals carry `[core:forbidden]` like deploySystem's.
 */
const deployStacks = {
  discover: (projectId: string): Promise<DeployComposeDiscovery> =>
    ipcRenderer.invoke(IPC.deployStacks.discover, projectId),
  preview: (input: DeployStackPreviewInput): Promise<DeployStackPreview> =>
    ipcRenderer.invoke(IPC.deployStacks.preview, input),
  list: (serverId: string): Promise<StackInfo[]> =>
    ipcRenderer.invoke(IPC.deployStacks.list, serverId),
  get: (input: DeployStackRef): Promise<StackDetails> =>
    ipcRenderer.invoke(IPC.deployStacks.get, input),
  files: (input: DeployStackRevisionRef): Promise<StackRevisionFiles> =>
    ipcRenderer.invoke(IPC.deployStacks.files, input),
  create: (input: DeployStackCreateInput): Promise<DeployStackUploadResult> =>
    ipcRenderer.invoke(IPC.deployStacks.create, input),
  upload: (input: DeployStackRevisionInput): Promise<DeployStackUploadResult> =>
    ipcRenderer.invoke(IPC.deployStacks.upload, input),
  acknowledge: (input: DeployStackAcknowledgeInput): Promise<StackRevisionInfo> =>
    ipcRenderer.invoke(IPC.deployStacks.acknowledge, input),
  deploy: (input: DeployStackRevisionRef): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployStacks.deploy, input),
  rollback: (input: DeployStackRevisionRef): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployStacks.rollback, input),
  action: (input: DeployStackActionInput): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployStacks.action, input),
  delete: (input: DeployStackDeleteInput): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployStacks.delete, input),
  /** Redeploys the app as a new revision with these services on 127.0.0.1 (E13). */
  makePrivate: (input: DeployMakePrivateInput): Promise<DeployRevisionResult> =>
    ipcRenderer.invoke(IPC.deployStacks.makePrivate, input),
  onUploadProgress: (cb: (event: DeployStackUploadProgress) => void): (() => void) =>
    subscribe(IPC.deployStacks.onUploadProgress, cb),
};

/**
 * A server's App Store (E12). The catalog is read from @runova/core in the renderer; these
 * send what was picked, and the main process renders the files itself.
 */
const deployAppStore = {
  install: (input: DeployAppInstallInput): Promise<DeployAppInstallResult> =>
    ipcRenderer.invoke(IPC.deployAppStore.install, input),
  /** A copy of the live revision on newer images, deployed; the .env stays on the server. */
  update: (input: DeployAppUpdateInput): Promise<DeployRevisionResult> =>
    ipcRenderer.invoke(IPC.deployAppStore.update, input),
  /** Admins, after a step-up: the app's .env as a map of key to value. */
  revealSecrets: (input: DeployAppRevealInput): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IPC.deployAppStore.revealSecrets, input),
};

/** Private registries (E08): sign-ins on this computer and credentials stored on a server. */
const deployRegistry = createDeployRegistry();
const health = createHealth();
const studio = createStudio();
const studioAi = createStudioAi();
const studioScenes = createStudioScenes();
const studioRender = createStudioRender();
const studioMedia = createStudioMedia();
const studioAudio = createStudioAudio();
const studioGen = createStudioGen();
const relay = createRelay();
const ciAutoFix = createCiAutoFix();
const errorTracking = createErrorTracking();

/** A server core's alerts: disk pressure, failed jobs, a reboot waiting. */
const deployAlerts = {
  list: (query: DeployAlertsQuery): Promise<AlertInfo[]> =>
    ipcRenderer.invoke(IPC.deployAlerts.list, query),
  acknowledge: (serverId: string, alertId: number): Promise<AlertInfo> =>
    ipcRenderer.invoke(IPC.deployAlerts.acknowledge, serverId, alertId),
  /** Starts alerts for this window: every open one first, then each change, on onChanged. */
  watch: (serverId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.deployAlerts.watch, serverId),
  unwatch: (subscriptionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.deployAlerts.unwatch, subscriptionId),
  onChanged: (cb: (event: DeployAlertsEvent) => void): (() => void) =>
    subscribe(IPC.deployAlerts.onChanged, cb),
};

/**
 * A server's host firewall (E13). Every role reads; Admins preview and apply. An applied change
 * waits for `confirm`, which the main process sends over a brand-new SSH connection, and rolls
 * back on the server by itself at its deadline otherwise. Steps arrive on onProgress.
 */
const deployFirewall = {
  status: (serverId: string): Promise<FirewallStatus> =>
    ipcRenderer.invoke(IPC.deployFirewall.status, serverId),
  presets: (serverId: string): Promise<FirewallPreset[]> =>
    ipcRenderer.invoke(IPC.deployFirewall.presets, serverId),
  history: (input: DeployFirewallHistoryInput): Promise<FirewallChangeSetInfo[]> =>
    ipcRenderer.invoke(IPC.deployFirewall.history, input),
  exposure: (serverId: string): Promise<ExposureInventory> =>
    ipcRenderer.invoke(IPC.deployFirewall.exposure, serverId),
  /** The exact commands and the SSH guard's verdict. Changes nothing. */
  preview: (input: DeployFirewallChangesInput): Promise<FirewallChangePreview> =>
    ipcRenderer.invoke(IPC.deployFirewall.preview, input),
  /**
   * May need a step-up (`[core:stepUpRequired]`): pass the password, as upgradeAll does. Not
   * called `apply`, which every function already has (Function.prototype.apply).
   */
  applyChanges: (input: DeployFirewallApplyInput): Promise<FirewallChangeSetInfo> =>
    ipcRenderer.invoke(IPC.deployFirewall.apply, input),
  confirm: (input: DeployFirewallDecisionInput): Promise<FirewallChangeSetInfo> =>
    ipcRenderer.invoke(IPC.deployFirewall.confirm, input),
  revert: (input: DeployFirewallDecisionInput): Promise<FirewallChangeSetInfo> =>
    ipcRenderer.invoke(IPC.deployFirewall.revert, input),
  onProgress: (cb: (event: DeployFirewallProgressEvent) => void): (() => void) =>
    subscribe(IPC.deployFirewall.onProgress, cb),
};

/**
 * A server's websites. Saving only stores a site; `apply` puts every saved change live (it can
 * take some 20 seconds) or keeps nginx as it was and says why. Snippets are the Owner's alone.
 */
const deploySites = {
  status: (serverId: string): Promise<NginxStatus> =>
    ipcRenderer.invoke(IPC.deploySites.status, serverId),
  list: (serverId: string): Promise<SiteInfo[]> =>
    ipcRenderer.invoke(IPC.deploySites.list, serverId),
  listStreams: (serverId: string): Promise<StreamProxyInfo[]> =>
    ipcRenderer.invoke(IPC.deploySites.listStreams, serverId),
  /** Installs nginx from nginx.org, or adopts the one there. A job. */
  install: (serverId: string): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deploySites.install, serverId),
  save: (serverId: string, settings: SiteSettings): Promise<SiteSaveResult> =>
    ipcRenderer.invoke(IPC.deploySites.save, serverId, settings),
  remove: (serverId: string, siteId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deploySites.remove, serverId, siteId),
  saveStream: (serverId: string, settings: StreamProxySettings): Promise<StreamProxySaveResult> =>
    ipcRenderer.invoke(IPC.deploySites.saveStream, serverId, settings),
  removeStream: (serverId: string, proxyId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deploySites.removeStream, serverId, proxyId),
  applyChanges: (serverId: string): Promise<NginxApplyResult> =>
    ipcRenderer.invoke(IPC.deploySites.apply, serverId),
  setSnippets: (serverId: string, snippets: SiteSnippets): Promise<SiteSaveResult> =>
    ipcRenderer.invoke(IPC.deploySites.setSnippets, serverId, snippets),
  /** Starts a site's access or error log for this window; lines arrive on onLog. */
  watchLog: (input: DeploySiteLogWatchInput): Promise<string> =>
    ipcRenderer.invoke(IPC.deploySites.watchLog, input),
  unwatchLog: (subscriptionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.deploySites.unwatchLog, subscriptionId),
  onLog: (cb: (event: DeploySiteLogEvent) => void): (() => void) =>
    subscribe(IPC.deploySites.onLog, cb),
};

/** A server's certificates. Removing one needs a step-up, as reboot does. */
const deployCerts = {
  list: (serverId: string): Promise<CertificateInfo[]> =>
    ipcRenderer.invoke(IPC.deployCerts.list, serverId),
  /** Orders a certificate over ACME for every domain of the site. A job. */
  issue: (input: DeployCertificateIssueInput): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployCerts.issue, input),
  renew: (serverId: string, siteId: string): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.deployCerts.renew, serverId, siteId),
  upload: (input: DeployCertificateUploadInput): Promise<CertificateUploadResult> =>
    ipcRenderer.invoke(IPC.deployCerts.upload, input),
  remove: (input: DeployCertificateRemoveInput): Promise<NginxApplyResult> =>
    ipcRenderer.invoke(IPC.deployCerts.remove, input),
};

/**
 * A server core's Security area. The core decides who may do what; changes to users need a
 * step-up first (deploy.stepUp). Passwords pass straight through to the core.
 */
const deploySecurity = {
  listUsers: (serverId: string): Promise<UserInfo[]> =>
    ipcRenderer.invoke(IPC.deploySecurity.listUsers, serverId),
  createUser: (input: DeployCreateUserInput): Promise<UserInfo> =>
    ipcRenderer.invoke(IPC.deploySecurity.createUser, input),
  setUserRole: (input: DeploySetRoleInput): Promise<UserInfo> =>
    ipcRenderer.invoke(IPC.deploySecurity.setUserRole, input),
  setUserDisabled: (input: DeploySetDisabledInput): Promise<UserInfo> =>
    ipcRenderer.invoke(IPC.deploySecurity.setUserDisabled, input),
  resetUserPassword: (input: DeployResetPasswordInput): Promise<void> =>
    ipcRenderer.invoke(IPC.deploySecurity.resetUserPassword, input),
  deleteUser: (input: DeployUserTarget): Promise<void> =>
    ipcRenderer.invoke(IPC.deploySecurity.deleteUser, input),
  /** Shown once: the core keeps only its hash. */
  createEnrollmentCode: (input: DeployEnrollmentCodeInput): Promise<EnrollmentCodeInfo> =>
    ipcRenderer.invoke(IPC.deploySecurity.createEnrollmentCode, input),
  /** Enrolls this computer with an Owner's code, then signs in. No SSH root needed. */
  redeemEnrollmentCode: (input: DeployRedeemCodeInput): Promise<DeployAccess> =>
    ipcRenderer.invoke(IPC.deploySecurity.redeemEnrollmentCode, input),
  listDevices: (serverId: string): Promise<DeviceInfo[]> =>
    ipcRenderer.invoke(IPC.deploySecurity.listDevices, serverId),
  revokeDevice: (serverId: string, deviceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deploySecurity.revokeDevice, serverId, deviceId),
  listSessions: (serverId: string): Promise<SessionInfo[]> =>
    ipcRenderer.invoke(IPC.deploySecurity.listSessions, serverId),
  revokeSession: (serverId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deploySecurity.revokeSession, serverId, sessionId),
  /** Ends every session of the signed-in user's but this computer's; returns how many. */
  revokeOtherSessions: (serverId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.deploySecurity.revokeOtherSessions, serverId),
  queryAudit: (input: DeployAuditQueryInput): Promise<AuditPage> =>
    ipcRenderer.invoke(IPC.deploySecurity.queryAudit, input),
  verifyAudit: (serverId: string): Promise<AuditVerificationInfo> =>
    ipcRenderer.invoke(IPC.deploySecurity.verifyAudit, serverId),
  /** Asks where to save, then writes every matching event as JSON or CSV. */
  exportAudit: (input: DeployAuditExportInput): Promise<DeployAuditExportResult> =>
    ipcRenderer.invoke(IPC.deploySecurity.exportAudit, input),
};

/**
 * The Deploy section's Cloudflare dialog. The API token goes in through saveToken and never comes
 * back: everything else answers with zones, records, settings and rules.
 */
const cloudflare = {
  /** The connected accounts (locked behind the Servers passkey or not), and each last check. */
  status: (): Promise<CloudflareStatus> => ipcRenderer.invoke(IPC.cloudflare.status),
  /** Checks a pasted token against Cloudflare, then seals and saves it as a new account. */
  saveToken: (input: CloudflareSaveTokenInput): Promise<CloudflareStatus> =>
    ipcRenderer.invoke(IPC.cloudflare.saveToken, input),
  /** Checks an account's saved token again, as after its permissions were edited on Cloudflare. */
  checkToken: (accountId: string): Promise<CloudflareStatus> =>
    ipcRenderer.invoke(IPC.cloudflare.checkToken, accountId),
  removeToken: (accountId: string): Promise<CloudflareStatus> =>
    ipcRenderer.invoke(IPC.cloudflare.removeToken, accountId),
  /** The domains one account's token can see. */
  listZones: (accountId: string): Promise<CloudflareZone[]> =>
    ipcRenderer.invoke(IPC.cloudflare.listZones, accountId),
  listRecords: (zoneId: string): Promise<CloudflareDnsRecord[]> =>
    ipcRenderer.invoke(IPC.cloudflare.listRecords, zoneId),
  createRecord: (zoneId: string, record: CloudflareRecordInput): Promise<CloudflareDnsRecord> =>
    ipcRenderer.invoke(IPC.cloudflare.createRecord, zoneId, record),
  updateRecord: (
    zoneId: string,
    recordId: string,
    record: CloudflareRecordInput,
  ): Promise<CloudflareDnsRecord> =>
    ipcRenderer.invoke(IPC.cloudflare.updateRecord, zoneId, recordId, record),
  deleteRecord: (zoneId: string, recordId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflare.deleteRecord, zoneId, recordId),
  zoneSettings: (zoneId: string): Promise<CloudflareZoneSettings> =>
    ipcRenderer.invoke(IPC.cloudflare.zoneSettings, zoneId),
  changeSetting: (
    zoneId: string,
    change: CloudflareSettingChange,
  ): Promise<CloudflareZoneSettings> =>
    ipcRenderer.invoke(IPC.cloudflare.changeSetting, zoneId, change),
  purgeCache: (zoneId: string, request: CloudflarePurgeRequest): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflare.purgeCache, zoneId, request),
  listCustomRules: (zoneId: string): Promise<CloudflareCustomRule[]> =>
    ipcRenderer.invoke(IPC.cloudflare.listCustomRules, zoneId),
  createCustomRule: (
    zoneId: string,
    input: CloudflareCustomRuleInput,
  ): Promise<CloudflareCustomRule[]> =>
    ipcRenderer.invoke(IPC.cloudflare.createCustomRule, zoneId, input),
  setCustomRuleEnabled: (
    zoneId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<CloudflareCustomRule[]> =>
    ipcRenderer.invoke(IPC.cloudflare.setCustomRuleEnabled, zoneId, ruleId, enabled),
  deleteCustomRule: (zoneId: string, ruleId: string): Promise<CloudflareCustomRule[]> =>
    ipcRenderer.invoke(IPC.cloudflare.deleteCustomRule, zoneId, ruleId),
  listAccessRules: (zoneId: string): Promise<CloudflareAccessRule[]> =>
    ipcRenderer.invoke(IPC.cloudflare.listAccessRules, zoneId),
  createAccessRule: (
    zoneId: string,
    input: CloudflareAccessRuleInput,
  ): Promise<CloudflareAccessRule> =>
    ipcRenderer.invoke(IPC.cloudflare.createAccessRule, zoneId, input),
  deleteAccessRule: (zoneId: string, ruleId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflare.deleteAccessRule, zoneId, ruleId),
  /** What pointing a name at a saved server would change, without changing anything. */
  planPointDomain: (input: CloudflarePointDomainInput): Promise<CloudflarePointDomainPlan> =>
    ipcRenderer.invoke(IPC.cloudflare.planPointDomain, input),
  pointDomain: (input: CloudflarePointDomainInput): Promise<CloudflarePointDomainResult> =>
    ipcRenderer.invoke(IPC.cloudflare.pointDomain, input),
};

const pullRequests = {
  /** The current branch, its PR (with checks and review threads) and what the tab needs to decide. */
  status: (projectId: string): Promise<PullRequestStatus> =>
    ipcRenderer.invoke(IPC.pullRequests.status, projectId),
  /** Asks the project's CLI for a PR title and description from the branch's commits. */
  suggestText: (
    projectId: string,
    requestId: string,
    base: string,
  ): Promise<SuggestPullRequestTextResult> =>
    ipcRenderer.invoke(IPC.pullRequests.suggestText, projectId, requestId, base),
  comment: (input: PrCommentInput): Promise<PrActionResult> =>
    ipcRenderer.invoke(IPC.pullRequests.comment, input),
  replyThread: (input: PrThreadReplyInput): Promise<PrActionResult> =>
    ipcRenderer.invoke(IPC.pullRequests.replyThread, input),
  resolveThread: (input: PrThreadResolveInput): Promise<PrActionResult> =>
    ipcRenderer.invoke(IPC.pullRequests.resolveThread, input),
  markReady: (projectId: string, number: number): Promise<PrActionResult> =>
    ipcRenderer.invoke(IPC.pullRequests.markReady, projectId, number),
  /** Merges on GitHub, then optionally switches to the base, pulls and deletes the branch. */
  merge: (input: MergePullRequestIpcInput): Promise<MergePullRequestResult> =>
    ipcRenderer.invoke(IPC.pullRequests.merge, input),
  /** The post-merge cleanup on its own, to retry a failed step or clean up later. */
  cleanup: (input: CleanupAfterMergeInput): Promise<MergePullRequestResult> =>
    ipcRenderer.invoke(IPC.pullRequests.cleanup, input),
  /** A read-only AI review of the PR diff, returned for the user to edit before posting. */
  localReview: (projectId: string, requestId: string): Promise<SuggestGitTextResult> =>
    ipcRenderer.invoke(IPC.pullRequests.localReview, projectId, requestId),
  cancelAi: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.pullRequests.cancelAi, requestId),
};

const tests = {
  /** Reads the project's files for test frameworks and the tests they declare. */
  discover: (projectId: string): Promise<TestDiscovery> =>
    ipcRenderer.invoke(IPC.tests.discover, projectId),
  /** Starts a background run. No targets runs every test project. */
  run: (projectId: string, targets: TestTarget[]): Promise<TestRunSummary> =>
    ipcRenderer.invoke(IPC.tests.run, projectId, targets),
  cancel: (projectId: string): Promise<boolean> => ipcRenderer.invoke(IPC.tests.cancel, projectId),
  lastRun: (projectId: string): Promise<TestRunSnapshot | null> =>
    ipcRenderer.invoke(IPC.tests.lastRun, projectId),
  /** The command a target would run with, as a person would type it. */
  command: (projectId: string, target: TestTarget): Promise<string | null> =>
    ipcRenderer.invoke(IPC.tests.command, projectId, target),
  onRunEvent: (callback: (event: TestRunEvent) => void): (() => void) =>
    subscribe(IPC.tests.onRunEvent, callback),
};

const apiClient = {
  listCollections: (): Promise<ApiCollectionSummary[]> =>
    ipcRenderer.invoke(IPC.apiClient.listCollections),
  getCollection: (id: string): Promise<PostmanCollection> =>
    ipcRenderer.invoke(IPC.apiClient.getCollection, id),
  createCollection: (name: string): Promise<ApiCollectionSummary> =>
    ipcRenderer.invoke(IPC.apiClient.createCollection, name),
  renameCollection: (id: string, name: string): Promise<ApiCollectionSummary> =>
    ipcRenderer.invoke(IPC.apiClient.renameCollection, id, name),
  removeCollection: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.apiClient.removeCollection, id),
  /** Adds the request to the collection, or updates it where it already is. */
  saveRequest: (input: SaveApiRequestInput): Promise<ApiCollectionSummary> =>
    ipcRenderer.invoke(IPC.apiClient.saveRequest, input),
  createFolder: (
    collectionId: string,
    parentId: string | null,
    name: string,
  ): Promise<{ summary: ApiCollectionSummary; folderId: string }> =>
    ipcRenderer.invoke(IPC.apiClient.createFolder, collectionId, parentId, name),
  removeItem: (collectionId: string, itemId: string): Promise<ApiCollectionSummary> =>
    ipcRenderer.invoke(IPC.apiClient.removeItem, collectionId, itemId),
  /** Sends one request and resolves when it finished, failed or was cancelled. */
  execute: (input: ExecuteApiRequestInput): Promise<ApiExecutionResult> =>
    ipcRenderer.invoke(IPC.apiClient.execute, input),
  cancel: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.apiClient.cancel, requestId),
};

const appNotifications = {
  list: (): Promise<AppNotification[]> => ipcRenderer.invoke(IPC.appNotifications.list),
  unreadCount: (): Promise<number> => ipcRenderer.invoke(IPC.appNotifications.unreadCount),
  markRead: (notificationId: string): Promise<AppNotification[]> =>
    ipcRenderer.invoke(IPC.appNotifications.markRead, notificationId),
  markAllRead: (): Promise<AppNotification[]> =>
    ipcRenderer.invoke(IPC.appNotifications.markAllRead),
  remove: (notificationId: string): Promise<AppNotification[]> =>
    ipcRenderer.invoke(IPC.appNotifications.remove, notificationId),
  onChanged: (callback: () => void): (() => void) =>
    subscribe(IPC.appNotifications.onChanged, callback),
};

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const worktrees = {
  list: (projectId: string): Promise<WorktreeInfo[]> =>
    ipcRenderer.invoke(IPC.worktrees.list, projectId),
  defaults: (projectId: string): Promise<WorktreeDefaults> =>
    ipcRenderer.invoke(IPC.worktrees.defaults, projectId),
  suggestPath: (projectId: string, branch: string): Promise<string> =>
    ipcRenderer.invoke(IPC.worktrees.suggestPath, projectId, branch),
  create: (input: CreateWorktreeInput): Promise<CreateWorktreeResult> =>
    ipcRenderer.invoke(IPC.worktrees.create, input),
  previewCopy: (projectId: string, globs: string[] | null): Promise<string[]> =>
    ipcRenderer.invoke(IPC.worktrees.previewCopy, projectId, globs),
  copyFiles: (projectId: string, worktreeId: string, files: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC.worktrees.copyFiles, projectId, worktreeId, files),
  removePreflight: (projectId: string, worktreeId: string): Promise<WorktreeRemovePreflight> =>
    ipcRenderer.invoke(IPC.worktrees.removePreflight, projectId, worktreeId),
  remove: (input: RemoveWorktreeInput): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.worktrees.remove, input),
  mergePreflight: (projectId: string, worktreeId: string): Promise<WorktreeMergePreflight> =>
    ipcRenderer.invoke(IPC.worktrees.mergePreflight, projectId, worktreeId),
  merge: (projectId: string, worktreeId: string): Promise<WorktreeMergeResult> =>
    ipcRenderer.invoke(IPC.worktrees.merge, projectId, worktreeId),
  mergeBaseIn: (projectId: string, worktreeId: string): Promise<WorktreeMergeResult> =>
    ipcRenderer.invoke(IPC.worktrees.mergeBaseIn, projectId, worktreeId),
  prune: (projectId: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.worktrees.prune, projectId),
  suggestBranch: (
    projectId: string,
    task: string,
    requestId?: string,
  ): Promise<SuggestGitTextResult> =>
    ipcRenderer.invoke(IPC.worktrees.suggestBranch, projectId, task, requestId),
  cancelSuggestBranch: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.worktrees.cancelSuggestBranch, requestId),
  pickLocation: (defaultPath: string | null): Promise<string | null> =>
    ipcRenderer.invoke(IPC.worktrees.pickLocation, defaultPath),
  /** Fires with the project id whenever that project's worktrees change. */
  onChanged: (cb: (projectId: string) => void): (() => void) =>
    subscribe(IPC.worktrees.onChanged, cb),
};

const packages = {
  list: (projectId: string): Promise<PackageScanResult> =>
    ipcRenderer.invoke(IPC.packages.list, projectId),
  update: (projectId: string, updates: PackageUpdateRequest[]): Promise<PackageUpdateResult> =>
    ipcRenderer.invoke(IPC.packages.update, projectId, updates),
  onUpdateProgress: (cb: (progress: PackageUpdateProgress) => void): (() => void) =>
    subscribe(IPC.packages.onUpdateProgress, cb),
};

const remote = {
  getState: (): Promise<RemoteState> => ipcRenderer.invoke(IPC.remote.getState),
  listInterfaces: (): Promise<RemoteNetworkInterface[]> =>
    ipcRenderer.invoke(IPC.remote.listInterfaces),
  startHost: (input: StartHostInput): Promise<RemoteState> =>
    ipcRenderer.invoke(IPC.remote.startHost, input),
  stopHost: (): Promise<void> => ipcRenderer.invoke(IPC.remote.stopHost),
  generatePairingCode: (): Promise<RemotePairingInfo> =>
    ipcRenderer.invoke(IPC.remote.generatePairingCode),
  connect: (code: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.remote.connect, code),
  connectFiles: (code: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.remote.connectFiles, code),
  disconnect: (): Promise<void> => ipcRenderer.invoke(IPC.remote.disconnect),
  listSavedServers: (): Promise<RemoteSavedServer[]> =>
    ipcRenderer.invoke(IPC.remote.listSavedServers),
  connectSaved: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.remote.connectSaved, id),
  connectSavedFiles: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.remote.connectSavedFiles, id),
  renameSavedServer: (id: string, nickname: string): Promise<void> =>
    ipcRenderer.invoke(IPC.remote.renameSavedServer, id, nickname),
  removeSavedServer: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.remote.removeSavedServer, id),
  openSessionWindow: (): Promise<void> => ipcRenderer.invoke(IPC.remote.openSessionWindow),
  sendClipboard: (): Promise<void> => ipcRenderer.invoke(IPC.remote.sendClipboard),
  sendFile: (): Promise<void> => ipcRenderer.invoke(IPC.remote.sendFile),
  getFileProgress: (): Promise<RemoteFileProgress[]> =>
    ipcRenderer.invoke(IPC.remote.getFileProgress),

  // Remote file manager: browse/mkdir/delete/rename/upload/download on the peer's filesystem.
  fmRoots: (): Promise<RemoteFileManagerEntry[]> => ipcRenderer.invoke(IPC.remote.fmRoots),
  fmList: (path: string | null): Promise<{ path: string; entries: RemoteFileManagerEntry[] }> =>
    ipcRenderer.invoke(IPC.remote.fmList, path),
  fmMkdir: (parentPath: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.remote.fmMkdir, parentPath, name),
  fmDelete: (path: string): Promise<void> => ipcRenderer.invoke(IPC.remote.fmDelete, path),
  fmRename: (path: string, newName: string): Promise<void> =>
    ipcRenderer.invoke(IPC.remote.fmRename, path, newName),
  fmUploadTo: (destDir: string): Promise<void> =>
    ipcRenderer.invoke(IPC.remote.fmUploadTo, destDir),
  fmDownload: (path: string): Promise<void> => ipcRenderer.invoke(IPC.remote.fmDownload, path),

  // Fire-and-forget, high-frequency channels.
  sendInput: (event: RemoteInputEvent): void => ipcRenderer.send(IPC.remote.sendInput, event),
  setScreenInfo: (size: RemoteScreenSize): void => ipcRenderer.send(IPC.remote.setScreenInfo, size),
  setDisplaySize: (size: RemoteScreenSize): void =>
    ipcRenderer.send(IPC.remote.setDisplaySize, size),
  hostTile: (tile: ArrayBuffer): void => ipcRenderer.send(IPC.remote.hostTile, tile),
  rtcSignal: (peerId: string, message: RemoteRtcMessage): void =>
    ipcRenderer.send(IPC.remote.rtcSignal, { peerId, message }),
  rtcPeerState: (peerId: string, connected: boolean): void =>
    ipcRenderer.send(IPC.remote.rtcPeerState, { peerId, connected }),
  clientRtcSignal: (message: RemoteRtcMessage): void =>
    ipcRenderer.send(IPC.remote.clientRtcSignal, message),
  rtcInput: (peerId: string, event: RemoteInputEvent): void =>
    ipcRenderer.send(IPC.remote.rtcInput, { peerId, event }),
  setCursorTracking: (enabled: boolean): void =>
    ipcRenderer.send(IPC.remote.setCursorTracking, enabled),
  benchSample: (): Promise<{ cpu: number; memory: number; at: number }> =>
    ipcRenderer.invoke(IPC.remote.benchSample),

  onState: (cb: (state: RemoteState) => void): (() => void) => subscribe(IPC.remote.onState, cb),
  onRtcSignal: (
    cb: (payload: { peerId: string; message: RemoteRtcMessage }) => void,
  ): (() => void) => subscribe(IPC.remote.onRtcSignal, cb),
  onRtcPeerGone: (cb: (peerId: string) => void): (() => void) =>
    subscribe(IPC.remote.onRtcPeerGone, cb),
  onClientRtcSignal: (cb: (message: RemoteRtcMessage) => void): (() => void) =>
    subscribe(IPC.remote.onClientRtcSignal, cb),
  onHostCursor: (cb: (point: { x: number; y: number; visible: boolean }) => void): (() => void) =>
    subscribe(IPC.remote.onHostCursor, cb),
  onCaptureRefresh: (cb: () => void): (() => void) => subscribe(IPC.remote.onCaptureRefresh, cb),
  onTileDemand: (cb: (demand: boolean) => void): (() => void) =>
    subscribe(IPC.remote.onTileDemand, cb),
  onCaptureStart: (cb: () => void): (() => void) => subscribe(IPC.remote.onCaptureStart, cb),
  onCaptureStop: (cb: () => void): (() => void) => subscribe(IPC.remote.onCaptureStop, cb),
  onFrameTile: (cb: (tile: Uint8Array) => void): (() => void) =>
    subscribe(IPC.remote.onFrameTile, cb),
  onScreenInfo: (cb: (size: RemoteScreenSize) => void): (() => void) =>
    subscribe(IPC.remote.onScreenInfo, cb),
  onPeerDisplaySize: (
    cb: (payload: { peerId: string; width: number; height: number }) => void,
  ): (() => void) => subscribe(IPC.remote.onPeerDisplaySize, cb),
  onFileProgress: (cb: (progress: RemoteFileProgress) => void): (() => void) =>
    subscribe(IPC.remote.onFileProgress, cb),
  onLog: (cb: (event: RemoteLogEvent) => void): (() => void) => subscribe(IPC.remote.onLog, cb),
};

const usage = {
  list: (): Promise<ProviderUsage[]> => ipcRenderer.invoke(IPC.usage.list),
  get: (providerId: string): Promise<ProviderUsage> =>
    ipcRenderer.invoke(IPC.usage.get, providerId),
  refresh: (): Promise<ProviderUsage[]> => ipcRenderer.invoke(IPC.usage.refresh),
  refreshProvider: (providerId: string): Promise<ProviderUsage> =>
    ipcRenderer.invoke(IPC.usage.refreshProvider, providerId),
  setProviderConfig: (providerId: string, config: UsageProviderConfig): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.setProviderConfig, { providerId, config }),
  setResetAlerts: (alerts: UsageResetAlertSettings): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.setResetAlerts, alerts),
  testResetAlert: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.usage.testResetAlert),
  setThresholdAlerts: (alerts: UsageThresholdAlertSettings): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.setThresholdAlerts, alerts),
  testThresholdAlert: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.usage.testThresholdAlert),
  onThresholdAlert: (
    callback: (payload: { title: string; body: string; providerId: string }) => void,
  ): (() => void) => subscribe(IPC.usage.onThresholdAlert, callback),
  listWidgets: (): Promise<DesktopWidgetInstance[]> => ipcRenderer.invoke(IPC.usage.listWidgets),
  getWidget: (id: string): Promise<DesktopWidgetInstance | null> =>
    ipcRenderer.invoke(IPC.usage.getWidget, id),
  openWidget: (providerId: string, options?: OpenWidgetOptions): Promise<DesktopWidgetInstance> =>
    ipcRenderer.invoke(IPC.usage.openWidget, providerId, options),
  closeWidget: (id: string): Promise<void> => ipcRenderer.invoke(IPC.usage.closeWidget, id),
  setWidgetStyle: (id: string, style: WidgetStyle): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.setWidgetStyle, id, style),
  setWidgetSize: (id: string, size: WidgetSize): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.setWidgetSize, id, size),
  setWidgetMode: (id: string, mode: WidgetMode): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.setWidgetMode, id, mode),
  configureWidget: (id: string, patch: OpenWidgetOptions): Promise<void> =>
    ipcRenderer.invoke(IPC.usage.configureWidget, id, patch),
  onWidgetUpdated: (callback: (payload: { id: string }) => void): (() => void) =>
    subscribe(IPC.usage.onWidgetUpdated, callback),
};

const pet = {
  setClickThrough: (ignore: boolean): void => ipcRenderer.send(IPC.pet.setClickThrough, ignore),
  setDragGuard: (active: boolean): void => ipcRenderer.send(IPC.pet.setDragGuard, active),
  getWorkArea: (): Promise<PetWorkArea> => ipcRenderer.invoke(IPC.pet.getWorkArea),
  onDisplayChanged: (callback: (area: PetWorkArea) => void): (() => void) =>
    subscribe(IPC.pet.onDisplayChanged, callback),
  onSettingsChanged: (callback: () => void): (() => void) =>
    subscribe(IPC.pet.onSettingsChanged, callback),
  onPipelineMessage: (callback: (payload: PetPipelineMessage) => void): (() => void) =>
    subscribe(IPC.pet.onPipelineMessage, callback),
  importCustom: (): Promise<CustomDesktopPet | null> => ipcRenderer.invoke(IPC.pet.importCustom),
  removeCustom: (id: string): Promise<void> => ipcRenderer.invoke(IPC.pet.removeCustom, id),
  customDataUrls: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.pet.customDataUrls),
  snooze: (minutes: number): Promise<PetSnoozeState> => ipcRenderer.invoke(IPC.pet.snooze, minutes),
  cancelSnooze: (): Promise<PetSnoozeState> => ipcRenderer.invoke(IPC.pet.cancelSnooze),
  getSnooze: (): Promise<PetSnoozeState> => ipcRenderer.invoke(IPC.pet.getSnooze),
  onSnoozeChanged: (callback: (state: PetSnoozeState) => void): (() => void) =>
    subscribe(IPC.pet.onSnoozeChanged, callback),
  showMainWindow: (route?: string): void => ipcRenderer.send(IPC.pet.showMainWindow, route),
};

const spellcheck = {
  onShowMenu: (callback: (payload: SpellcheckMenuPayload) => void): (() => void) =>
    subscribe(IPC.spellcheck.onShowMenu, callback),
  /** Resolves false when the platform has no custom dictionary (macOS). */
  addToDictionary: (word: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.spellcheck.addToDictionary, word),
  /** Runs it in the field that has focus. Resolves false for a command main does not know. */
  runEditCommand: (command: EditCommand): Promise<boolean> =>
    ipcRenderer.invoke(IPC.spellcheck.runEditCommand, command),
};

const grammar = {
  /** Resolves with no issues when grammar checking is off, so callers don't have to check first. */
  check: (input: GrammarCheckInput): Promise<GrammarCheckResult> =>
    ipcRenderer.invoke(IPC.grammar.check, input),
  localStatus: (): Promise<GrammarLocalStatus> => ipcRenderer.invoke(IPC.grammar.localStatus),
  /** Starts the server if it isn't up; resolves with the status either way, error included. */
  startLocal: (): Promise<GrammarLocalStatus> => ipcRenderer.invoke(IPC.grammar.startLocal),
  stopLocal: (): Promise<GrammarLocalStatus> => ipcRenderer.invoke(IPC.grammar.stopLocal),
  /** Resolves with the folder that was opened. */
  openToolsFolder: (): Promise<string> => ipcRenderer.invoke(IPC.grammar.openToolsFolder),
  onLocalStatus: (callback: (status: GrammarLocalStatus) => void): (() => void) =>
    subscribe(IPC.grammar.onLocalStatus, callback),
};

const proxy = {
  /** Where the app's requests are going right now, plus what this machine is set to. */
  status: (): Promise<ProxyStatus> => ipcRenderer.invoke(IPC.proxy.status),
  /** Probes a candidate server without saving it, so a bad one never takes the app offline. */
  test: (candidate: ProxySettings): Promise<ProxyTestResult> =>
    ipcRenderer.invoke(IPC.proxy.test, candidate),
};

const windowControls = {
  minimize: (): Promise<void> => ipcRenderer.invoke(IPC.window.minimize),
  maximizeToggle: (): Promise<void> => ipcRenderer.invoke(IPC.window.maximizeToggle),
  close: (): Promise<void> => ipcRenderer.invoke(IPC.window.close),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.isMaximized),
  onMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean): void =>
      callback(isMaximized);
    ipcRenderer.on(IPC.window.onMaximizedChange, listener);
    return () => ipcRenderer.removeListener(IPC.window.onMaximizedChange, listener);
  },
  isFocused: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.isFocused),
  onFocusChange: (callback: (isFocused: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isFocused: boolean): void =>
      callback(isFocused);
    ipcRenderer.on(IPC.window.onFocusChange, listener);
    return () => ipcRenderer.removeListener(IPC.window.onFocusChange, listener);
  },
};

const remoteSessionWindowControls = {
  minimize: (): Promise<void> => ipcRenderer.invoke(IPC.remoteSessionWindow.minimize),
  maximizeToggle: (): Promise<void> => ipcRenderer.invoke(IPC.remoteSessionWindow.maximizeToggle),
  close: (): Promise<void> => ipcRenderer.invoke(IPC.remoteSessionWindow.close),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.remoteSessionWindow.isMaximized),
  onMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean): void =>
      callback(isMaximized);
    ipcRenderer.on(IPC.remoteSessionWindow.onMaximizedChange, listener);
    return () => ipcRenderer.removeListener(IPC.remoteSessionWindow.onMaximizedChange, listener);
  },
};

/** Per-project environments (production, staging, ...) with their env files and credentials. */
const environments = {
  list: (projectId: string): Promise<ProjectEnvironment[]> =>
    ipcRenderer.invoke(IPC.environments.list, projectId),
  save: (input: SaveEnvironmentInput): Promise<ProjectEnvironment> =>
    ipcRenderer.invoke(IPC.environments.save, input),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.environments.remove, id),
  reorder: (projectId: string, orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.environments.reorder, projectId, orderedIds),
  saveFile: (input: SaveEnvFileInput): Promise<ProjectEnvironment> =>
    ipcRenderer.invoke(IPC.environments.saveFile, input),
  removeFile: (environmentId: string, fileId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.environments.removeFile, environmentId, fileId),
  readFile: (environmentId: string, fileId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.environments.readFile, environmentId, fileId),
  copyFile: (environmentId: string, fileId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.environments.copyFile, environmentId, fileId),
  saveCredential: (input: SaveEnvCredentialInput): Promise<ProjectEnvironment> =>
    ipcRenderer.invoke(IPC.environments.saveCredential, input),
  removeCredential: (environmentId: string, credentialId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.environments.removeCredential, environmentId, credentialId),
  revealCredential: (environmentId: string, credentialId: string): Promise<EnvCredentialSecrets> =>
    ipcRenderer.invoke(IPC.environments.revealCredential, environmentId, credentialId),
  copyCredentialSecret: (environmentId: string, credentialId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.environments.copyCredentialSecret, environmentId, credentialId),
  scanFolder: (projectId: string): Promise<EnvFolderFile[]> =>
    ipcRenderer.invoke(IPC.environments.scanFolder, projectId),
  importFromFolder: (projectId: string, picks: EnvImportPick[]): Promise<EnvImportResult> =>
    ipcRenderer.invoke(IPC.environments.importFromFolder, projectId, picks),
  writeToFolder: (
    environmentId: string,
    fileId: string,
    overwrite: boolean,
  ): Promise<EnvWriteResult> =>
    ipcRenderer.invoke(IPC.environments.writeToFolder, environmentId, fileId, overwrite),
};

const rdp = {
  listServers: (): Promise<RdpSavedServer[]> => ipcRenderer.invoke(IPC.rdp.listServers),
  saveServer: (input: SaveRdpServerInput): Promise<RdpSavedServer> =>
    ipcRenderer.invoke(IPC.rdp.saveServer, input),
  removeServer: (id: string): Promise<void> => ipcRenderer.invoke(IPC.rdp.removeServer, id),
  /** Saves the list in the given id order and returns it. Servers left out go to the end. */
  reorderServers: (orderedIds: string[]): Promise<RdpSavedServer[]> =>
    ipcRenderer.invoke(IPC.rdp.reorderServers, orderedIds),
  /** Opens a session window for a saved server and returns its session id. */
  openSession: (serverId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.rdp.openSession, serverId),
  getTicket: (sessionId: string): Promise<RdpConnectTicket> =>
    ipcRenderer.invoke(IPC.rdp.getTicket, sessionId),
  respondCertificate: (sessionId: string, trust: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.rdp.respondCertificate, sessionId, trust),
  /** Fetches the certificate a saved server presents now and compares it with the saved one. */
  checkCertificate: (serverId: string): Promise<RdpCertificateCheckResult> =>
    ipcRenderer.invoke(IPC.rdp.checkCertificate, serverId),
  /** Saves the certificate the last check of this server saw, if it still has this fingerprint. */
  trustCertificate: (serverId: string, fingerprint: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdp.trustCertificate, serverId, fingerprint),
  /** Forgets the saved certificate, so the next connection saves whatever the server presents. */
  forgetCertificate: (serverId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdp.forgetCertificate, serverId),
  readClipboardFiles: (
    sessionId: string,
    previousSignature: string | null,
  ): Promise<RdpClipboardFiles | 'unchanged' | null> =>
    ipcRenderer.invoke(IPC.rdp.readClipboardFiles, sessionId, previousSignature),
  readClipboardFile: (sessionId: string, signature: string, index: number): Promise<Uint8Array> =>
    ipcRenderer.invoke(IPC.rdp.readClipboardFile, sessionId, signature, index),
  beginDownload: (sessionId: string): Promise<RdpDownloadTarget | null> =>
    ipcRenderer.invoke(IPC.rdp.beginDownload, sessionId),
  prepareDownloadEntry: (
    downloadId: string,
    index: number,
    entry: { name: string; path?: string; isDirectory: boolean },
  ): Promise<string> => ipcRenderer.invoke(IPC.rdp.prepareDownloadEntry, downloadId, index, entry),
  writeDownloadChunk: (downloadId: string, index: number, bytes: Uint8Array): Promise<void> =>
    ipcRenderer.invoke(IPC.rdp.writeDownloadChunk, downloadId, index, bytes),
  finishDownloadFile: (downloadId: string, index: number, ok: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.rdp.finishDownloadFile, downloadId, index, ok),
  openDownloadFolder: (downloadId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rdp.openDownloadFolder, downloadId),
  /**
   * Starts a download into a private folder instead of one the person picks, for files copied on
   * the server that are then put on this computer's clipboard. Fill it with the same
   * prepareDownloadEntry / writeDownloadChunk / finishDownloadFile calls, then `finishStaging`.
   */
  beginStaging: (sessionId: string, totalBytes: number): Promise<RdpStageStart> =>
    ipcRenderer.invoke(IPC.rdp.beginStaging, sessionId, totalBytes),
  finishStaging: (sessionId: string, downloadId: string): Promise<RdpStageResult> =>
    ipcRenderer.invoke(IPC.rdp.finishStaging, sessionId, downloadId),
  /** Speed and answer time of the session's connection, or null when it has none open. */
  getLinkStats: (sessionId: string): Promise<RdpLinkStats | null> =>
    ipcRenderer.invoke(IPC.rdp.getLinkStats, sessionId),
  onCertificatePrompt: (callback: (prompt: RdpCertificatePrompt) => void): (() => void) =>
    subscribe(IPC.rdp.onCertificatePrompt, callback),
  onProxyError: (callback: (payload: RdpProxyErrorPayload) => void): (() => void) =>
    subscribe(IPC.rdp.onProxyError, callback),
};

const rdpWindowControls = {
  minimize: (): Promise<void> => ipcRenderer.invoke(IPC.rdpWindow.minimize),
  maximizeToggle: (): Promise<void> => ipcRenderer.invoke(IPC.rdpWindow.maximizeToggle),
  fullscreenToggle: (): Promise<void> => ipcRenderer.invoke(IPC.rdpWindow.fullscreenToggle),
  close: (): Promise<void> => ipcRenderer.invoke(IPC.rdpWindow.close),
  getState: (): Promise<RdpWindowState> => ipcRenderer.invoke(IPC.rdpWindow.getState),
  onStateChange: (callback: (state: RdpWindowState) => void): (() => void) =>
    subscribe(IPC.rdpWindow.onStateChange, callback),
};

/**
 * The Windows build (e.g. 26200), which xterm needs to match how ConPTY redraws. Null elsewhere.
 * Exported so the tests can run it on both platforms; the renderer reads `windowsBuild` instead.
 */
export function windowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;
  const build = Number(process.getSystemVersion().split('.')[2]);
  return Number.isFinite(build) && build > 0 ? build : null;
}

const vault = {
  status: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vault.status),
  create: (password: string): Promise<void> => ipcRenderer.invoke(IPC.vault.create, password),
  unlock: (password: string): Promise<VaultUnlockResult> =>
    ipcRenderer.invoke(IPC.vault.unlock, password),
  lock: (): Promise<void> => ipcRenderer.invoke(IPC.vault.lock),
  changePassword: (current: string, next: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.vault.changePassword, current, next),
  reset: (): Promise<void> => ipcRenderer.invoke(IPC.vault.reset),
  list: (): Promise<VaultEntrySummary[]> => ipcRenderer.invoke(IPC.vault.list),
  getForEdit: (id: string): Promise<VaultEntry> => ipcRenderer.invoke(IPC.vault.getForEdit, id),
  reveal: (id: string, field: VaultFieldRef): Promise<string> =>
    ipcRenderer.invoke(IPC.vault.reveal, id, field),
  copy: (id: string, field: VaultFieldRef): Promise<VaultCopyResult> =>
    ipcRenderer.invoke(IPC.vault.copy, id, field),
  save: (input: SaveVaultEntryInput): Promise<VaultEntrySummary> =>
    ipcRenderer.invoke(IPC.vault.save, input),
  remove: (ids: string[]): Promise<number> => ipcRenderer.invoke(IPC.vault.remove, ids),
  patch: (
    id: string,
    change: { favorite?: boolean; tags?: string[] },
  ): Promise<VaultEntrySummary> => ipcRenderer.invoke(IPC.vault.patch, id, change),
  duplicate: (id: string): Promise<VaultEntrySummary> =>
    ipcRenderer.invoke(IPC.vault.duplicate, id),
  touch: (): Promise<void> => ipcRenderer.invoke(IPC.vault.touch),
  /** A site's favicon as a small data URL for an entry; null when it has none. */
  fetchIcon: (siteUrl: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.vault.fetchIcon, siteUrl),
  importOpen: (): Promise<VaultImportPreview | null> => ipcRenderer.invoke(IPC.vault.importOpen),
  importPreview: (token: string, mapping: GenericMapping | null): Promise<VaultImportPreview> =>
    ipcRenderer.invoke(IPC.vault.importPreview, token, mapping),
  importCommit: (
    token: string,
    mapping: GenericMapping | null,
    policy: DuplicatePolicy,
  ): Promise<VaultImportResult> =>
    ipcRenderer.invoke(IPC.vault.importCommit, token, mapping, policy),
  importCancel: (token: string): Promise<void> => ipcRenderer.invoke(IPC.vault.importCancel, token),
  exportCsv: (password: string, format: VaultExportFormat): Promise<VaultExportResult> =>
    ipcRenderer.invoke(IPC.vault.exportCsv, password, format),
  onStateChanged: (cb: (event: VaultStateEvent) => void): (() => void) =>
    subscribe(IPC.vault.onStateChanged, cb),
  onEntriesChanged: (cb: () => void): (() => void) => subscribe(IPC.vault.onEntriesChanged, cb),
  onClipboardSettled: (cb: (event: VaultClipboardEvent) => void): (() => void) =>
    subscribe(IPC.vault.onClipboardSettled, cb),
};

/** Only the startup splash window listens to these. */
const splash = {
  onStatus: (cb: (status: string) => void): (() => void) => subscribe(IPC.splash.onStatus, cb),
  onClose: (cb: () => void): (() => void) => subscribe(IPC.splash.onClose, cb),
};

/** Run commands an AI agent suggests for a project. Each suggestion waits for the user's decision. */
const runProposals = {
  list: (): Promise<RunProposal[]> => ipcRenderer.invoke(IPC.runProposals.list),
  decide: (id: string, decision: RunProposalDecision): Promise<RunProposalDecisionResult> =>
    ipcRenderer.invoke(IPC.runProposals.decide, { id, decision }),
  getEnabled: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.runProposals.getEnabled, projectId),
  setEnabled: (projectId: string, enabled: boolean): Promise<RunProposalResult> =>
    ipcRenderer.invoke(IPC.runProposals.setEnabled, { projectId, enabled }),
  startGuided: (projectId: string): Promise<RunSetupSession> =>
    ipcRenderer.invoke(IPC.runProposals.startGuided, projectId),
  onChanged: (callback: (changed: RunProposalsChanged) => void): (() => void) =>
    subscribe(IPC.runProposals.onChanged, callback),
};

const runovaApi = {
  platform: process.platform,
  windowsBuild: windowsBuildNumber(),
  app: appInfo,
  runProposals,
  cli,
  terminal,
  ssh,
  environments,
  vault,
  rdp,
  sshAgent,
  rdpAgent,
  agents,
  power,
  projects,
  skills,
  mcp,
  security,
  tools,
  devSetup,
  android,
  docker,
  dockerHub,
  resourceActivity,
  fs,
  explorer,
  workspaceSearch,
  settings,
  templates,
  activity,
  shell: shellApi,
  terminalClipboard,
  browser,
  spellcheck,
  grammar,
  proxy,
  window: windowControls,
  remoteSessionWindow: remoteSessionWindowControls,
  rdpWindow: rdpWindowControls,
  promptHistory,
  translate,
  ai,
  help,
  speech,
  system,
  ipGeo,
  projectDrafts,
  blueprints,
  promptBuildWidget,
  scheduledTasks,
  notifications,
  git,
  worktrees,
  pipelines,
  ciAutoFix,
  deploy,
  deploySecurity,
  deployHardening,
  deployServerBackups,
  deployWordPress,
  deployFiles,
  sftp: createSftp(subscribe),
  deployFirewall,
  deploySystem,
  deployJobs,
  deployAlerts,
  deployDocker,
  deployDirectTls,
  deployErrorReporting,
  deployTelegram,
  deployAssistant,
  deployLogs,
  deploySites,
  deployCerts,
  deployStacks,
  deployAppStore,
  deployRegistry,
  health,
  studio,
  studioAi,
  studioScenes,
  studioRender,
  studioMedia,
  studioAudio,
  studioGen,
  relay,
  errorTracking,
  cloudflare,
  cloudflareServer,
  pullRequests,
  tests,
  appNotifications,
  apiClient,
  packages,
  remote,
  usage,
  pet,
  backup,
  splash,
};

export type RunovaApi = typeof runovaApi;

contextBridge.exposeInMainWorld('runova', runovaApi);
