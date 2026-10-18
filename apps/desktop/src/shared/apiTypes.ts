import type {
  AgentHistoryProvider,
  AgentHistorySession,
  AgentStatus,
  AgentType,
  AiProvider,
  AutoContinueOptions,
  AutoContinuePending,
  BlueprintAttachment,
  BlueprintRevisionTarget,
  BlueprintStepId,
  EffortLevel,
  EnvironmentKind,
  GenericMapping,
  GitChangeEntry,
  ImportSkip,
  KeepAwakeMode,
  MergeMethod,
  ProjectBlueprint,
  ProjectDraft,
  ProjectNotificationSettings,
  ProjectRunCommand,
  ProjectWordPressLink,
  ProjectWorktreeSetup,
  ProxyMode,
  PullRequestInfo,
  RunAssessment,
  RunPauseReason,
  ScanPhase,
  ScheduledTask,
  ScheduledTaskRunMode,
  SecurityScannerId,
  SkillAuditFinding,
  SkillAuditVerdict,
  UsageProviderConfig,
  UsageTokens,
  VaultEntryType,
  VaultImportFormat,
  WorktreeInfo,
} from '@agentmat/core';
import type { GuestShortcut } from './browserGuest';

export type { AiProvider };

/** Payload for enabling/configuring a Usage provider (settings key + API key). */
export interface SetUsageProviderConfigInput {
  providerId: string;
  config: UsageProviderConfig;
}

/** Where the app's requests are going right now, for the proxy card in Settings. */
export interface ProxyStatus {
  mode: ProxyMode;
  /** The server in use, or null when requests go straight out. */
  effectiveServer: string | null;
  /** What this machine is configured with, whether or not the app is following it. */
  systemServer: string | null;
}

/** Outcome of one probe request sent through a candidate proxy. */
export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number | null;
  /** Address the probe saw the request arrive from, when it could tell us. */
  ip: string | null;
  country: string | null;
  error: string | null;
}

/** main -> widget window: which widget instance changed. */
export interface WidgetUpdatedPayload {
  id: string;
}

export interface UpdateInfo {
  version: string;
  releaseDate: string | null;
  releaseNotes: string | null;
  /** Installer size from the release metadata, when the feed includes it. */
  sizeBytes: number | null;
}

export interface UpdateDownloadProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  /** Null when speed is too low to estimate. */
  etaSeconds: number | null;
  /** True when this session continued from bytes already on disk. */
  resumed: boolean;
}

/** What is still open when the user closes the app, sent with IPC.app.onConfirmQuit. */
export interface OpenSessionSummary {
  /** Terminal tabs running an agent CLI. Plain shells are not counted. */
  clis: number;
  ssh: number;
  rdp: number;
  /** True when the CLIs carry on in the background terminal host after the app closes. */
  clisKeepRunning: boolean;
}

/** Pushed to the renderer over IPC.app.onUpdateStatus as the main-process auto-updater progresses. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | {
      state: 'available';
      info: UpdateInfo;
      /** Bytes already on disk from an earlier interrupted download of this version. */
      partialBytes: number;
    }
  | { state: 'not-available' }
  | {
      state: 'downloading';
      info: UpdateInfo;
      progress: UpdateDownloadProgress;
      /** True while waiting out a stall or dropped connection before Range-resuming. */
      reconnecting: boolean;
    }
  | { state: 'paused'; info: UpdateInfo; progress: UpdateDownloadProgress; message: string }
  | { state: 'downloaded'; info: UpdateInfo }
  | {
      state: 'error';
      message: string;
      info?: UpdateInfo;
      /** True when the partial file is still on disk and Resume will continue it. */
      resumable?: boolean;
      progress?: UpdateDownloadProgress;
    };

/**
 * A tool an install or update command needs before it can run (Node.js for `npm install -g`,
 * say), with the page that explains how to get it.
 */
export interface CommandPrerequisite {
  name: string;
  url: string;
}

export interface CreateTerminalOptions {
  /**
   * Stable id for the session. Passing the id of a session that is still running reconnects
   * to it (and its shell) instead of starting a new one. Omit it to get a fresh id.
   */
  sessionId?: string;
  /** Only reconnect to a running session; resolve null rather than start a new shell. */
  attachOnly?: boolean;
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  /** Text to pre-fill into the shell's input line, not yet submitted (e.g. an install command). */
  initialInput?: string;
  /** Associates this session with a project so confirmation-hook replies can be forwarded to it. */
  projectId?: string;
  /** CLI_REGISTRY id of the agent this session was launched to run, if any. */
  cliId?: string;
  /** Which part of the app shows this session. */
  surface?: TerminalSurface;
}

export type TerminalSurface = 'drawer' | 'workspace';

/** One process inside a terminal's process tree. */
export interface TerminalProcessUsage {
  pid: number;
  name: string;
  /** Share of all cores, 0-100. */
  cpuPercent: number;
  memBytes: number;
}

/** A running shell and what it and everything it started are using right now. */
export interface TerminalSessionUsage {
  sessionId: string;
  /** The shell's pid. Agent CLIs run as its children. */
  pid: number;
  projectId?: string;
  cliId?: string;
  surface?: TerminalSurface;
  /** When the shell started, in ms. Survives app restarts, unlike the tab's own time. */
  createdAt: number;
  /** Share of all cores, 0-100, summed over the whole tree. */
  cpuPercent: number;
  memBytes: number;
  processCount: number;
  /** The busiest processes in the tree, shell included. */
  processes: TerminalProcessUsage[];
}

export interface TerminalUsageResult {
  /** False when this system's process list could not be read; sessions are still listed. */
  available: boolean;
  /** False on the first reading, before there is a CPU time delta to compare. */
  cpuReady: boolean;
  sampledAt: number;
  sessions: TerminalSessionUsage[];
}

/** A project run's terminal: what its process tree uses and which ports it listens on. */
export interface TerminalRunStatus {
  sessionId: string;
  /** False when the shell is no longer running. */
  alive: boolean;
  /** Share of all cores, 0-100, summed over the whole tree. */
  cpuPercent: number;
  memBytes: number;
  processCount: number;
  /** TCP ports any process in the tree is listening on, lowest first. */
  ports: number[];
  /** True while the run's processes are frozen by Pause. */
  paused: boolean;
  pauseReason: RunPauseReason | null;
  pausedAt: number | null;
}

/** What pausing or resuming a run did. */
export interface TerminalPauseResult {
  /** False when nothing could be paused (or resumed); `error` says why. */
  ok: boolean;
  /** Whether the run is paused now, whatever was asked. */
  paused: boolean;
  reason: RunPauseReason | null;
  pausedAt: number | null;
  /** How many processes were frozen or thawed. */
  processCount: number;
  /** How many processes in the tree could not be (an elevated one, say). */
  failedCount: number;
  /**
   * True when the only work frozen was a Docker client (`docker compose up`): its containers
   * run inside Docker and keep using CPU.
   */
  containersOnly: boolean;
  error?: string;
}

/** Sent to every window when a run is paused or resumed, from anywhere. */
export interface TerminalPauseChange {
  sessionId: string;
  paused: boolean;
  reason: RunPauseReason | null;
  pausedAt: number | null;
}

export interface TerminalRunStatusResult {
  /** False when this system's process list could not be read. */
  available: boolean;
  /** False on the first reading, before there is a CPU time delta to compare. */
  cpuReady: boolean;
  sessions: TerminalRunStatus[];
}

/** A workspace terminal tab, as the agent status tracker needs to know it. */
export interface AgentSessionEntry {
  sessionId: string;
  projectId: string;
  cliId?: string;
  /** The tab's name, used in notifications. */
  title: string;
  /** Whether to type "continue" for this tab after a usage limit or a network error. */
  autoContinue?: AutoContinueOptions;
}

/** Session id to the continue scheduled for it; null when one was just sent or dropped. */
export type AutoContinuePendingMap = Record<string, AutoContinuePending | null>;

/** Session id to what its agent is doing right now. */
export type AgentStatusMap = Record<string, AgentStatus>;

/** The model and reasoning effort an agent reports it is running on right now. */
export interface AgentRunInfo {
  /** Raw model id, e.g. `claude-opus-5`. */
  model?: string;
  effort?: string;
  /** The CLI's own id for the conversation, which the history section matches against. */
  conversationId?: string;
}

export type AgentRunInfoMap = Record<string, AgentRunInfo>;

/** The model and effort last reported for a CLI, kept across restarts. */
export interface LastRunInfo {
  model?: string;
  effort?: string;
}

/** CLI id to what it was last actually running on. */
export type LastRunInfoByCli = Record<string, LastRunInfo>;

/** What one model in a conversation used. */
export interface AgentSessionModelUsage {
  /** Raw model id, e.g. `claude-opus-5-5`. */
  model: string;
  tokens: UsageTokens;
  /** Null when the model has no known price. */
  costUsd: number | null;
}

/**
 * What one past conversation used, read from the agent's own log. `unsupported` is an agent that
 * does not record tokens; `unavailable` is a conversation whose log is not on this machine or
 * could not be read.
 */
export type AgentSessionUsage =
  | {
      status: 'ok';
      tokens: UsageTokens;
      /** Estimated from the catalog prices, or null when no model in the run has one. */
      costUsd: number | null;
      /** Some of the tokens ran on a model with no price, so `costUsd` is a lower bound. */
      costPartial: boolean;
      /** Per model, most tokens first. Empty when the log does not name a model. */
      models: AgentSessionModelUsage[];
    }
  | { status: 'unsupported' }
  | { status: 'unavailable' };

/** What a project spent on one local calendar day. */
export interface ProjectUsageDay {
  /** `YYYY-MM-DD` in this machine's time zone. */
  day: string;
  /** All token kinds added up. */
  tokens: number;
  /** Null when no model that day has a known price. */
  costUsd: number | null;
}

/** What one agent (Claude Code, Codex, ...) used in a project. */
export interface ProjectUsageAgent {
  provider: AgentHistoryProvider;
  /** Conversations of this agent that used tokens in the period. */
  conversations: number;
  tokens: UsageTokens;
  costUsd: number | null;
  costPartial: boolean;
}

/** What one model used in a project, across agents. */
export interface ProjectUsageModel {
  /** Raw model id, e.g. `claude-opus-5-5`. */
  model: string;
  tokens: UsageTokens;
  /** Null when the model has no known price. */
  costUsd: number | null;
}

/** One conversation's share of a project's spend. */
export interface ProjectUsageConversation {
  provider: AgentHistoryProvider;
  id: string;
  title: string | null;
  /** Epoch ms of its last activity. */
  updatedAt: number;
  /** All token kinds added up, inside the period. */
  tokens: number;
  costUsd: number | null;
  costPartial: boolean;
}

/** Conversations of an agent that keeps no token log, so they could not be counted. */
export interface ProjectUsageUncounted {
  provider: AgentHistoryProvider;
  conversations: number;
}

/**
 * What a project's past conversations used, for the project page's Usage tab. Costs are list
 * price estimates from the catalog (OpenCode's own recorded cost wins where it has one).
 */
export type ProjectUsageReport =
  | {
      status: 'ok';
      /** The period in days, or null for everything. */
      days: number | null;
      tokens: UsageTokens;
      /** Null when no model in the period has a known price. */
      costUsd: number | null;
      /** Some tokens ran on a model with no price, so `costUsd` is a lower bound. */
      costPartial: boolean;
      /** Conversations that used tokens in the period. */
      conversations: number;
      /** Local days that had spend, oldest first. */
      byDay: ProjectUsageDay[];
      /** Most expensive first (most tokens first when nothing is priced). */
      byAgent: ProjectUsageAgent[];
      /** Most tokens first. */
      byModel: ProjectUsageModel[];
      /** The costliest conversations, most expensive first. */
      top: ProjectUsageConversation[];
      /** Agents whose conversations could not be counted. */
      uncounted: ProjectUsageUncounted[];
      /** Conversations whose log was listed but could not be read. */
      unreadable: number;
      /** The project has more conversations than were read; the oldest were left out. */
      truncated: boolean;
      /** Folders read: the project's own, plus one per git worktree. */
      folders: number;
    }
  | { status: 'unavailable' };

/** What a terminal found on the clipboard: text, or paths (copied files, a screenshot saved to
 * disk). Read in the main process, which sees formats the renderer cannot and needs no focus. */
export type TerminalClipboardPaste =
  | { kind: 'text'; text: string }
  | { kind: 'files'; paths: string[] };

/** A crop of a page element picked in the workspace browser, saved for an agent to read. */
export interface BrowserElementShot {
  path: string;
  /** A small PNG data URL for the comment card and the tray. */
  thumbDataUrl: string;
}

export interface BrowserGuestShortcut {
  webContentsId: number;
  shortcut: GuestShortcut;
}

export interface BrowserOpenInNewTab {
  webContentsId: number;
  url: string;
}

export interface TerminalSnapshot {
  /** Serialized screen and scrollback, written into a fresh xterm to repaint it. */
  data: string;
  cols: number;
  rows: number;
}

export interface TerminalAttachResult {
  sessionId: string;
  /** False when this reconnected to a shell that was already running. */
  isNew: boolean;
  /** What the terminal showed before this reconnect; null for a brand-new shell. */
  snapshot: TerminalSnapshot | null;
}

export interface CreateProjectInput {
  name: string;
  folderPath: string;
  description: string;
  tags: string[];
  agentType: AgentType;
  notes: string;
  /** Launch commands the Run button can start. Empty when none are set. */
  runCommands: ProjectRunCommand[];
  /** CLI_REGISTRY id for this project's AI actions; null means the app default in Settings. */
  cliId?: string | null;
  /** Icon image inlined as a data URL; null (or omitted) leaves the project on the folder glyph. */
  iconDataUrl?: string | null;
  /** `#rrggbb` tile colour behind the icon; null (or omitted) keeps the theme default. */
  iconBgColor?: string | null;
  /** `#rrggbb` colour for the folder glyph shown when there is no icon image. */
  iconColor?: string | null;
  /** Site this project lives at; the favicon fetch reads it. */
  websiteUrl?: string;
  /** Git repository the code lives in, stored as a link only. */
  repoUrl?: string;
  /** Optional: the create/edit form doesn't collect it; the Prompt dialog defines it later. */
  prompt?: string;
  /** What new worktrees of this project get: a setup command and files to copy. */
  worktreeSetup?: ProjectWorktreeSetup;
  /**
   * The WordPress site and items the project mirrors (E21). Only the WordPress project flow sets
   * it, through `deployWordPress.createProject`; `projects.create` ignores it.
   */
  wordpress?: ProjectWordPressLink;
}

export interface FaviconResult {
  /** The icon itself, ready to store on the project. */
  dataUrl: string;
  /** Where it came from, so the UI can say which site answered after redirects. */
  sourceUrl: string;
  /** The normalized site URL, which is what gets saved as the project's websiteUrl. */
  siteUrl: string;
}

export interface BootstrapResult {
  /** Agent the scaffold was written for, e.g. "Claude Code". */
  agentLabel: string;
  createdFiles: string[];
  /** Files left untouched because they already existed. */
  skippedFiles: string[];
}

export interface SaveTemplateInput {
  name: string;
  promptType: string;
  targetAI: string;
  content: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Every file in a project, for the explorer's search box. */
export interface ExplorerFileIndex {
  /** The project folder the paths are relative to, as the main process resolved it. */
  root: string;
  /** Paths relative to `root`, with forward slashes. */
  files: string[];
  /** The project has more files than the index holds, so a search can miss one. */
  truncated: boolean;
}

/** How the workspace search reads a text query. */
export interface TextSearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  /** The query is a regular expression rather than literal text. */
  regex: boolean;
}

export interface TextSearchRequest extends TextSearchOptions {
  query: string;
  /** Stop after this many matching lines. The main process caps it too. */
  maxMatches?: number;
}

/** One matching line, trimmed around the match when the line is long. */
export interface TextSearchLine {
  /** 1-based. */
  line: number;
  /** 1-based, in characters, of the first match on the line. */
  column: number;
  /** The part of the line worth showing. */
  text: string;
  /** Where `text` starts in the full line, in characters. */
  textOffset: number;
  /** Part of the line before `text` was cut off (not just its indent), so the row shows "…". */
  clipped?: boolean;
  /** [start, end) of each match inside `text`. */
  ranges: [number, number][];
}

export interface TextSearchFileMatches {
  /** Relative to the project folder, with forward slashes. */
  path: string;
  matches: TextSearchLine[];
}

/** Results streamed to the window while a text search runs. */
export interface TextSearchBatch {
  requestId: string;
  files: TextSearchFileMatches[];
}

export interface TextSearchSummary {
  requestId: string;
  matches: number;
  files: number;
  /** A cap was reached, so there are more matches than were sent. */
  truncated: boolean;
  /** A newer search, or a cancel, stopped this one. */
  cancelled: boolean;
  /** Why the search could not run, such as a bad regular expression. */
  error?: string;
  /** Text search needs the bundled ripgrep, and it is missing. */
  unavailable?: boolean;
  elapsedMs: number;
}

/**
 * Every declaration the search found in a project, column by column so a big project crosses
 * IPC as a few arrays rather than one object per symbol. Entry `i` is `names[i]`, declared in
 * `files[fileOf[i]]` at `lines[i]`, `columns[i]`.
 */
export interface SymbolIndex {
  version: number;
  /** The project folder the paths are relative to. */
  root: string;
  files: string[];
  names: string[];
  /** The type a member sits in, or '' at the top level. */
  containers: string[];
  /** Positions in `SYMBOL_KINDS`. */
  kinds: Uint8Array;
  fileOf: Uint32Array;
  /** 1-based. */
  lines: Uint32Array;
  /** 1-based, in characters. */
  columns: Uint32Array;
  /** The project has more declarations than the index holds. */
  truncated: boolean;
  /** Symbol search needs the bundled ripgrep, and it is missing. */
  unavailable: boolean;
}

/** The answer when the window already holds the latest version. */
export interface SymbolIndexUnchanged {
  unchanged: true;
  version: number;
}

export type SymbolIndexPayload = SymbolIndex | SymbolIndexUnchanged;

/** What a delete from the workspace explorer left behind. */
export interface ExplorerDeleteResult {
  /** Paths the system trash would not take. They are still on disk. */
  failed: string[];
}

export interface ExplorerMove {
  from: string;
  to: string;
}

/** The outcome of pasting or dropping entries into a folder. */
export interface ExplorerTransferResult {
  moves: ExplorerMove[];
  /** Names already taken in the target folder. Nothing was moved when this is not empty. */
  conflicts: string[];
}

export interface ExplorerGitignoreResult {
  /** The line that is now in the repository's root .gitignore. */
  line: string;
  /** False when the line was already there. */
  added: boolean;
  /** Git still tracks the path, so ignoring it changes nothing until it is untracked. */
  tracked: boolean;
}

export interface InstalledSkillRecord {
  skillId: string;
  repositoryId: string;
  version: string;
  installedAt: string;
  /** CLI agent ids (e.g. 'claude-code', 'cursor') this skill was installed for. Unset for repo-based skills, which aren't agent-specific. */
  agents?: string[];
  /** How the skill's own CLI was run ('npm-global' or 'npx'), so removal uses the same route. */
  installMethod?: string;
}

/** Compares an installed repo-based skill's stored version against its repository's current version. */
export interface SkillUpdateInfo {
  skillId: string;
  repositoryId: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

export interface InstalledMcpServerRecord {
  serverId: string;
  repositoryId: string;
  version: string;
  installedAt: string;
}

/**
 * A run command an AI agent in a project asked to add. It stays pending until the user approves
 * it in AgentMate, and nothing is saved or run before that.
 */
export interface RunProposal {
  id: string;
  projectId: string;
  projectName: string;
  /** Empty when the agent did not name the command. The command is shown instead. */
  label: string;
  command: string;
  proposedAt: string;
}

export type RunProposalDecision = 'add' | 'discard';

export interface RunProposalsChanged {
  pending: RunProposal[];
}

export type RunProposalResult = { ok: true } | { ok: false; error: string };

/** What deciding on a suggestion returns. Adding hands back the saved command, so it can be run. */
export type RunProposalDecisionResult =
  | {
      ok: true;
      projectId: string;
      runCommand?: { id: string; label: string; command: string };
    }
  | { ok: false; error: string };

/**
 * What an agent needs to be started from AgentMate with the run suggestion tools: an MCP config
 * file to pass to its CLI, and the tool names that are safe to allow without asking, because every
 * suggestion is approved in AgentMate anyway.
 */
export type RunSetupSession =
  | { ok: true; mcpConfigPath: string; allowedTools: string[] }
  | { ok: false; error: string };

/** A single hit from a live skills.sh search, before its description has been fetched. */
export interface SkillsShSearchResult {
  id: string;
  name: string;
  owner: string;
  repo: string;
  installs: number;
  official: boolean;
  url: string;
  installCommand: string;
}

/** What a folder looks like as a skill repository, shown while the user types or picks a path. */
export interface LocalSkillFolderPreview {
  path: string;
  /** Folder name, offered as the repository name when the user left that field empty. */
  suggestedName: string;
  skillNames: string[];
  /** True when the folder carries its own repository.json instead of being scanned. */
  hasManifest: boolean;
  /** Why the folder can't be used, or null when it can. */
  error: string | null;
}

/** Detail fetched on demand for a single skills.sh skill (description isn't in search results). */
export interface SkillsShDetail {
  description: string | null;
  installsLabel: string | null;
}

export interface InstallFromSkillsShInput {
  /** null installs globally to ~/.claude/skills instead of a project. */
  projectId: string | null;
  owner: string;
  repo: string;
  skillName: string;
  /** CLI agent ids (e.g. 'claude-code', 'cursor') the skill was installed for. */
  agents: string[];
}

/** Where the files a security audit read came from. */
export type SkillAuditSourceKind = 'repository' | 'installed' | 'github' | 'folder';

/**
 * What to audit. A repository skill is read from its index and an installed one straight off
 * disk; the last three need nothing added to AgentMate at all, so any folder or GitHub address
 * can be checked before it is trusted.
 */
export type SkillAuditTarget =
  | { kind: 'repository'; repositoryId: string; skillId: string }
  | { kind: 'installed'; projectId: string | null; skillId: string }
  | { kind: 'github'; repo: string; skillName: string }
  /** A folder (or a single .md file) anywhere on disk. */
  | { kind: 'folder'; path: string }
  /** An exact directory inside a GitHub repository, at a given branch, tag, or commit. */
  | { kind: 'githubPath'; repo: string; ref: string; path: string; skillName: string };

/** One skill found at a pasted location, ready to be checked. */
export interface AuditSourceSkill {
  name: string;
  /** Where it sits inside the source, so two skills with the same name can be told apart. */
  location: string;
  target: SkillAuditTarget;
}

/** What a typed or pasted path/URL turned out to contain, shown before anything is scanned. */
export interface AuditSourcePreview {
  kind: SkillAuditSourceKind | null;
  /** Folder path or `owner/repo@ref`, so the user can see what was understood. */
  label: string;
  skills: AuditSourceSkill[];
  /** Why nothing can be scanned there, or null. */
  error: string | null;
}

export interface RunSkillAuditInput {
  target: SkillAuditTarget;
  /** Also send the skill to an agent CLI for a second opinion. Slower, needs an installed CLI. */
  deepReview: boolean;
  /** CLI to use for the deep review; null falls back to the default CLI from Settings. */
  cliId?: string | null;
  /** Lets cancelSkillAudit(requestId) stop the CLI review. */
  requestId?: string;
}

/** One completed audit, as stored in the history database. */
export interface SkillAuditRecord {
  id: string;
  skillId: string;
  skillName: string;
  sourceKind: SkillAuditSourceKind;
  /** Repository name, project path, or `owner/repo`, whichever the audit read from. */
  sourceLabel: string;
  /** Set for an installed-skill audit scoped to a project; null for a global or remote one. */
  projectId: string | null;
  verdict: SkillAuditVerdict;
  score: number;
  findings: SkillAuditFinding[];
  filesScanned: number;
  bytesScanned: number;
  deepReview: boolean;
  /** CLI that answered the deep review, when one ran. */
  cliName: string | null;
  aiSummary: string | null;
  /** Why the deep review produced nothing, when it was asked for and failed. */
  aiError: string | null;
  createdAt: string;
}

/** Where a starred skill came from, so the Favorites tab can offer the right actions. */
export type FavoriteSkillSource = 'skills-sh' | 'repository' | 'installed' | 'local';

/**
 * A starred skill. `skillId` is the same id the audit history uses (`owner/repo/name` for a
 * skills.sh skill, the repository's skill id for a repository one), so a favorite, its last
 * security verdict and its usage count all line up on one card.
 */
export interface FavoriteSkillRecord {
  skillId: string;
  name: string;
  source: FavoriteSkillSource;
  /** `owner/repo`, the repository name, or the scope a skill is installed in. */
  sourceLabel: string;
  description?: string;
  /** Set for a repository skill, so Favorites can install it without going back to the tab. */
  repositoryId?: string;
  /** skills.sh fields, kept so the card can install, open and re-check the skill on its own. */
  owner?: string;
  repo?: string;
  url?: string;
  installCommand?: string;
  official?: boolean;
  addedAt: string;
}

/** A favorite as the renderer sends it; `addedAt` is stamped by the main process. */
export type FavoriteSkillInput = Omit<FavoriteSkillRecord, 'addedAt'>;

/** One project (a transcript's working directory) a skill was invoked from. */
export interface SkillUsageProject {
  /** Absolute folder path the session ran in. */
  path: string;
  /** Folder name, or the matching AgentMate project's name when there is one. */
  label: string;
  count: number;
}

/** How often one skill has been invoked, aggregated across every session transcript. */
export interface SkillUsageStat {
  /** The name the agent invoked, e.g. `artifact-design` or `plugin:skill`. */
  skill: string;
  count: number;
  /** Invocations in the last 7 and 30 days, for the "recently used" sort. */
  count7d: number;
  count30d: number;
  firstUsedAt: string;
  lastUsedAt: string;
  projects: SkillUsageProject[];
  /** One count per day of `SkillUsageReport.days`, so a row can draw its own trend. */
  daily: number[];
}

/** The Usage tab's whole payload: per-skill counts plus what the scan actually read. */
export interface SkillUsageReport {
  stats: SkillUsageStat[];
  totalInvocations: number;
  /** The last 30 local dates as `YYYY-MM-DD`, oldest first. */
  days: string[];
  /** Invocations per day of `days`, across every skill. */
  dailyTotals: number[];
  /** Transcript files read across every Claude Code config dir found. */
  filesScanned: number;
  /** The transcript folders that were read, empty when Claude Code has never run here. */
  sourceRoots: string[];
  scannedAt: string;
}

/** Which part of the machine a used skill's files were found in. */
export type UsedSkillOrigin = 'project' | 'global' | 'plugin';

/** Names a used skill and the folders the usage scan saw it invoked in. */
export interface UsedSkillQuery {
  /** The invoked name, e.g. `artifact-design` or `plugin:skill`. */
  skill: string;
  /** Folders the skill was invoked in, busiest first. They are searched before the global dirs. */
  projectPaths: string[];
}

/** Where a used skill lives on disk, so it can be copied somewhere else. */
export interface UsedSkillInspection {
  skill: string;
  /** The skill's folder name, which is what a copy is called in the target project. */
  folderName: string;
  /** Null when no folder with a SKILL.md was found, for example a skill built into the agent. */
  source: {
    path: string;
    origin: UsedSkillOrigin;
    /** The project folder, `~/.claude`, or the plugin's name. */
    label: string;
  } | null;
  /** AgentMate projects that already have a folder of this name in one of their skills dirs. */
  presentInProjectIds: string[];
}

export interface AddUsedSkillInput extends UsedSkillQuery {
  projectIds: string[];
}

export interface AddUsedSkillResult {
  projectId: string;
  /** `exists` means the project already had the skill, so nothing was written. */
  status: 'added' | 'exists' | 'failed';
  error?: string;
}

export interface RunSkillAuditResult {
  ok: boolean;
  record: SkillAuditRecord | null;
  /** Why the audit could not run at all (no files found, repository gone, rate limited). */
  error?: string;
  cancelled?: boolean;
}

/** One probed command behind the UI UX Pro Max wizard's prerequisite step. */
export interface UiProToolProbe {
  found: boolean;
  version: string | null;
}

/**
 * What the `uipro` CLI needs to be able to run: Node and npm to install it, and Python 3 for the
 * skill's own search/design-system scripts. `uipro` itself is reported so the wizard can skip the
 * global npm install when it is already there.
 */
export interface UiProPrerequisites {
  node: UiProToolProbe;
  npm: UiProToolProbe;
  /** True when either `python3` or `python` resolves to a Python 3.x. */
  python: UiProToolProbe;
  /** The command that found Python, so the wizard can show the one that works here. */
  pythonCommand: string | null;
  uipro: UiProToolProbe;
}

/**
 * The installed `uipro` CLI measured against the latest release on npm. The skill files are
 * generated by the CLI, so the CLI's version is what says whether an update is waiting.
 */
export interface UiProUpdateCheck {
  /** False when `uipro` is not on PATH, which means there is nothing installed to update. */
  cliFound: boolean;
  /** null when the CLI is missing, or when its --version output carried no version number. */
  installedVersion: string | null;
  /** null when npm could not be reached. */
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string;
}

export interface RecordUiProInstallInput {
  /** null records a global install (~/.claude/skills and friends) instead of a project one. */
  projectId: string | null;
  /** `--ai` values the skill was installed for, or ['all']. */
  agents: string[];
  /** Which route was used, kept so the removal command matches the install. */
  method: string;
}

export type PromptHistorySource = 'generate' | 'translate';

export interface PromptHistoryEntry {
  id: string;
  rawInput: string;
  promptType: string;
  targetAI: string;
  content: string;
  source: PromptHistorySource;
  tags: string[];
  /** Set when the entry came from a project-scoped flow (e.g. a bootstrap description). */
  projectId: string | null;
  createdAt: string;
}

export interface AddPromptHistoryInput {
  rawInput: string;
  promptType: string;
  targetAI: string;
  content: string;
  source: PromptHistorySource;
  /** Links this entry to a project, so it shows up in that project's history. */
  projectId?: string | null;
}

export interface BackupExportResult {
  ok: boolean;
  /** Absolute path the backup was written to; unset when the save dialog was canceled. */
  path?: string;
  /** Set when the write itself failed; unset on a plain cancel. */
  error?: string;
}

export interface BackupExportOptions {
  /**
   * When set, project environments and credentials go into the backup, encrypted with this
   * password. Left out, they stay on this computer only.
   */
  environmentsPassword?: string;
  /**
   * The Vault goes in by default when there is one. It stays encrypted with its own master
   * password, so it needs no backup password. False leaves it out.
   */
  includeVault?: boolean;
}

/** First step of a restore: the file was picked and checked, nothing has been written yet. */
export interface BackupOpenResult {
  ok: boolean;
  error?: string;
  /** Hands the checked backup to `backup:restore`. Only valid for this app session. */
  token?: string;
  /** Present when the backup carries password-protected project environments. */
  environments?: { count: number };
  /** Present when the backup carries a Vault. */
  vault?: { present: true };
}

export interface BackupRestoreOptions {
  /** The backup password for its environments, or null to restore everything else. */
  environmentsPassword: string | null;
  /** Replaces this computer's Vault with the one in the backup. The old one is kept aside. */
  restoreVault?: boolean;
}

export interface BackupImportResult {
  ok: boolean;
  error?: string;
  /** The environments password did not open the backup. Nothing was written, so ask again. */
  wrongPassword?: boolean;
  /**
   * Things the user should look at after a successful restore: rows that could not
   * be read, and settings the backup carried that affect what gets executed.
   */
  warnings?: string[];
}

export interface TranslateTextInput {
  text: string;
  targetLang: string;
  /** Lets translate.cancel() stop this request. */
  requestId?: string;
}

export interface TranscribeAudioInput {
  /**
   * Mono 32-bit float PCM samples at 16 kHz, the only shape Whisper accepts.
   * The renderer resamples the microphone capture before sending, so the main
   * process never needs ffmpeg or any other audio tool.
   */
  samples: Float32Array;
  /** BCP-47-ish Whisper language code, or 'auto' to let the model detect it. */
  language: string;
}

export interface TranscribeAudioResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * First-run model download progress. Whisper weights are fetched once and
 * cached under userData, so this only reports during the initial download.
 */
export interface SpeechModelProgress {
  /** 0–100, or null while the total size is still unknown. */
  percent: number | null;
  file: string;
}

export interface SpeechModelState {
  /** True once the weights are on disk, so transcription can run offline. */
  ready: boolean;
  modelId: string;
}

export interface OllamaConnectionTest {
  ok: boolean;
  /** Version reported by the server, when it answered /api/version. */
  version?: string;
  /** How many models are installed, so the UI can warn about an empty server. */
  modelCount?: number;
  error?: string;
}

export interface AskAiHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskAiInput {
  provider: AiProvider;
  /** Model id: an OpenAI/Gemini model name, or an Ollama model tag from listOllamaModels(). */
  model: string;
  prompt: string;
  /** Prior turns in the conversation, oldest first. Omitted for one-off (non-chat) prompts. */
  history?: AskAiHistoryMessage[];
  /** Caller-generated id that ai.cancel(requestId) can abort this request with. */
  requestId?: string;
}

export interface AskAiResult {
  ok: boolean;
  text: string;
  error?: string;
  /** True when the caller aborted the request, so the UI can stay quiet about it. */
  cancelled?: boolean;
}

/** A question for the Help page's guide, answered from the Help articles. */
export interface HelpAskInput {
  provider: AiProvider;
  model: string;
  question: string;
  /** Earlier turns of the help conversation, oldest first. */
  history?: AskAiHistoryMessage[];
  /** Caller-generated id that help.cancel(requestId) can abort this request with. */
  requestId?: string;
}

/** A help passage an answer was drawn from. `n` is the number the answer cites it by, as in [2]. */
export interface HelpSource {
  n: number;
  slug: string;
  anchor: string;
  articleTitle: string;
  heading: string;
}

export interface HelpAskResult {
  ok: boolean;
  text: string;
  sources: HelpSource[];
  /** 'hybrid' when vector and keyword search both ran, 'keyword' when only keywords did. */
  retrieval?: 'hybrid' | 'keyword';
  /** Why the answer fell back to keyword search, when there is something the user can fix. */
  notice?: string;
  error?: string;
  cancelled?: boolean;
}

export interface HelpIndexStatus {
  /** Passages in the index. */
  chunks: number;
  /** Passages that have a vector from the provider's embedder. */
  embedded: number;
  backend: 'sqlite-vec' | 'js';
  /** `<provider>:<model>`, or null when the provider is not set up. */
  embedder: string | null;
}

export interface HelpReindexResult {
  ok: boolean;
  /** Passages that now have a vector from the provider's current model. */
  embedded: number;
  total: number;
  /** Earlier models of the provider whose vectors were dropped, as `<provider>:<model>`. */
  removedModels: string[];
  error?: string;
  cancelled?: boolean;
}

/** An embedding model the help search can use, for the picker in Settings. */
export interface HelpEmbeddingModelOption {
  value: string;
  label: string;
  /** Set for Ollama models already on the server. */
  installed?: boolean;
}

export interface HelpIndexProgress {
  done: number;
  total: number;
  embedder: string;
}

export interface AskCliInput {
  prompt: string;
  /** The agent CLI to answer with. No other CLI is tried when it isn't installed. */
  cliId: string;
  /** Model id from that CLI's run profile, or null for whatever the CLI is set up with. */
  modelId?: string | null;
  /** Ignored when the model has no effort setting. */
  effort?: EffortLevel | null;
  /** Caller-generated id that ai.cancelAskCli(requestId) can stop this run with. */
  requestId?: string;
}

export interface AskCliResult {
  ok: boolean;
  text: string;
  /** Display name of the CLI that answered (or that we tried to use). */
  cliName: string | null;
  error?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface AssessRunInput {
  /** The generated prompt (or translation) to size. */
  prompt: string;
  /** Target AI label; its model list is what the CLI picks from. */
  targetAI: string;
  /** Omitted for translations, which aren't shaped by a prompt type. */
  promptType?: string;
  /** Caller-generated id that ai.cancelAssessRun(requestId) can stop this run with. */
  requestId?: string;
}

export interface AssessRunResult {
  ok: boolean;
  assessment?: RunAssessment;
  /** Display name of the CLI that answered (or that we tried to use). */
  cliName: string | null;
  error?: string;
  cancelled?: boolean;
}

export interface CreateProjectDraftInput {
  projectId: string;
  rawInput: string;
  promptType: string;
  targetAI: string;
  content: string;
}

export type UpdateProjectDraftInput = Partial<
  Pick<ProjectDraft, 'rawInput' | 'content' | 'promptType' | 'targetAI'>
>;

/**
 * Partial update for one Blueprint step. A `text` that is present is what marks
 * the change as an edit worth keeping a revision of; the English cache fields
 * are written by a generate run and deliberately don't count as one.
 */
export interface BlueprintSectionPatch {
  text?: string;
  includeInAgentFile?: boolean;
  textEn?: string | null;
  textEnHash?: string | null;
}

/** A pasted or dropped file on its way to the blueprint's file store. */
export interface BlueprintAttachmentInput {
  displayName: string;
  dataUrl: string;
}

/**
 * The updated record plus the files this call added. The editor needs the
 * second part to place each one at the caret; the record on its own would not
 * say which of the step's files are the new ones.
 */
export interface BlueprintAttachmentResult {
  blueprint: ProjectBlueprint;
  added: BlueprintAttachment[];
}

/** Which markdown file the "include in the project's instructions" checkbox writes to. */
export interface BlueprintAgentFileTarget {
  /** Absolute path, so the handler doesn't have to resolve it twice. */
  path: string;
  /** Project-relative, which is what the checkbox label shows. */
  relativePath: string;
  exists: boolean;
}

export interface BlueprintAgentFileResult {
  path: string;
  relativePath: string;
  /** False when nothing was ticked and there was no block to remove either. */
  written: boolean;
}

export interface AddBlueprintRevisionInput {
  blueprintId: string;
  projectId: string;
  target: BlueprintRevisionTarget;
  stepId?: BlueprintStepId | null;
  text: string;
  attachmentNames?: string[];
}

export interface SaveBlueprintPresetInput {
  /** Absent for a new preset; present when an existing one is being edited. */
  id?: string;
  stepId: BlueprintStepId;
  label: string;
  text: string;
}

/** One attachment file carried inside a backup envelope. */
export interface BackupAttachmentBlob {
  fileName: string;
  mime: string;
  size: number;
  /** Null when the file was over the export cap or could not be read. */
  dataBase64: string | null;
  omitted?: 'too-large' | 'unreadable';
}

export interface ScheduledTaskInput {
  rawInput: string;
  promptType: string;
  targetAI: string;
  content: string;
  runAt: string;
  runMode?: ScheduledTaskRunMode;
  cliId?: string;
  model?: string;
  effort?: EffortLevel;
}

/**
 * Fields of a scheduled task that can be changed after it's created. `null` clears a CLI, model
 * or effort choice, so the task goes back to the defaults.
 */
export interface UpdateScheduledTaskInput
  extends Partial<Pick<ScheduledTask, 'rawInput' | 'content' | 'runAt' | 'runMode' | 'status'>> {
  cliId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface CreateScheduledTasksInput {
  projectId: string;
  tasks: ScheduledTaskInput[];
}

export interface PingResult {
  host: string;
  alive: boolean;
  latencyMs: number | null;
}

export interface IpGeoInfo {
  ip: string;
  country: string;
  countryCode: string;
}

export interface UpdateProjectNotificationsInput {
  projectId: string;
  notifications: ProjectNotificationSettings;
}

export interface SendTestNotificationInput {
  message: string;
}

export interface NotificationSendResult {
  ok: boolean;
  error?: string;
}

export interface DetectChatIdResult {
  chatId: string | null;
  error?: string;
}

export interface ConfirmationForwardedPayload {
  projectId: string;
  sessionId: string;
  text: string;
}

export interface GitFileChange {
  path: string;
  /** Index (staged) status character from `git status --porcelain`. */
  x: string;
  /** Worktree (unstaged) status character from `git status --porcelain`. */
  y: string;
}

export interface GitBranchInfo {
  name: string;
  /** Present as a local `refs/heads` branch. */
  local: boolean;
  /** Present on the primary remote (usually origin). */
  remote: boolean;
  /**
   * The folder of the other worktree that has this branch checked out. Git will not check a
   * branch out twice, so the UI offers to open that worktree instead. Unset when none has it.
   */
  worktreePath?: string;
}

/** Why a worktree's branch cannot be merged back into its base right now. */
export type WorktreeMergeBlocker =
  | { kind: 'worktree-dirty'; changes: number }
  | { kind: 'main-dirty'; changes: number }
  | { kind: 'main-not-on-base'; current: string | null }
  | { kind: 'nothing-to-merge' };

export type WorktreeMergePreflight = { ok: true } | { ok: false; blocker: WorktreeMergeBlocker };

export type WorktreeMergeResult =
  | { ok: true; message: string }
  /** The merge was backed out; these files conflicted. */
  | { ok: false; conflicts: string[] };

/** What the New worktree dialog starts from. */
export interface WorktreeDefaults {
  /** False when the project folder is not a git repository yet. */
  isRepo: boolean;
  /** The branch new worktrees start from unless the user picks another. */
  defaultBranch: string | null;
  /** The branch the main checkout is on. */
  currentBranch: string | null;
  branches: GitBranchInfo[];
  /** The project's own patterns when it has them, else the app-wide ones. */
  copyGlobs: string[];
  setupCommand: string;
}

export interface CreateWorktreeInput {
  /** The project, never a worktree scope: worktrees always hang off the main checkout. */
  projectId: string;
  branch: string;
  mode: 'new' | 'existing';
  /** What a new branch starts from; null uses the default branch. */
  base: string | null;
  /** Null puts it where Settings says (next to the repository by default). */
  path: string | null;
}

export type CreateWorktreeResult =
  | { ok: true; worktree: WorktreeInfo }
  | { ok: false; error: string };

/** What removing a worktree would throw away, for the Remove dialog. */
export interface WorktreeRemovePreflight {
  branch: string | null;
  baseBranch: string | null;
  /** The folder is already gone, so there is nothing left in it to lose. */
  missing: boolean;
  changes: number;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  /** Null when the branch has no upstream. */
  unpushed: number | null;
  merged: boolean;
}

export interface RemoveWorktreeInput {
  projectId: string;
  worktreeId: string;
  /** Throw away uncommitted changes too. */
  force: boolean;
  deleteBranch: boolean;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO-8601 committer date. */
  date: string;
  subject: string;
  parents: string[];
  /** Local tag names pointing at this commit. Empty when none. */
  tags: string[];
}

export interface GitDayCount {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  count: number;
}

export interface GitBranchHistory {
  branch: string;
  commits: GitCommitInfo[];
  /** Daily commit counts covering the last 12 weeks, including empty days. */
  activity: GitDayCount[];
}

export interface RenameBranchInput {
  projectId: string;
  from: string;
  to: string;
  /** Push the new name and delete the old one on the primary remote. */
  updateRemote?: boolean;
}

export interface DeleteBranchInput {
  projectId: string;
  branchName: string;
  /** Also `git push --delete` on the primary remote. */
  deleteRemote?: boolean;
  /** Use `git branch -D` when the branch is not fully merged. */
  force?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  /** Best-effort guess at the repo's primary branch, e.g. "main" vs "master". */
  defaultBranch: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  files: GitFileChange[];
  branches: GitBranchInfo[];
}

export interface GitOpResult {
  ok: boolean;
  message: string;
}

/** A merge, rebase or similar that stopped part way and is waiting on the user. */
export type GitPendingOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** Everything the workspace's changes panel shows, read in one pass. */
export interface WorkspaceGitState {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  /** Short id of HEAD, or null before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  operation: GitPendingOperation | null;
  conflicts: GitChangeEntry[];
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  untracked: GitChangeEntry[];
  /** More untracked files exist than were listed. */
  untrackedTruncated: boolean;
  /**
   * Where the project folder sits inside the repository, with forward slashes. Empty when the
   * project is the repository root. Status paths are relative to the root, not the project.
   */
  projectPrefix: string;
}

export type GitDiffSide = 'staged' | 'unstaged' | 'untracked' | 'conflict';

/** An image read for the workspace viewer: its bytes as a data URL, plus the size on disk. */
export interface ImageFileData {
  dataUrl: string;
  bytes: number;
}

/**
 * Both sides of a changed image, for the viewer the changes panel shows in place of a text
 * diff. A side the change does not have (a new or a deleted file) is null.
 */
export interface GitImageDiff {
  path: string;
  original: ImageFileData | null;
  modified: ImageFileData | null;
  /** A side is past the size the viewer loads; it says so instead of showing the picture. */
  tooLarge: boolean;
}

export interface GitFileDiff {
  path: string;
  original: string;
  modified: string;
  binary: boolean;
  /** One side is too big to diff comfortably; the viewer shows a notice instead. */
  tooLarge: boolean;
  /**
   * Blob ids of both sides as git stores them (empty blob for a side that doesn't exist). A line
   * action hands them back, so it never lands on a file that moved since the diff was read.
   */
  originalId?: string;
  modifiedId?: string;
}

/** What a line action does: stage or discard working tree lines, or unstage staged ones. */
export type GitLineAction = 'stage' | 'unstage' | 'discard';

/** 1-based, inclusive line ranges picked in the diff, on the old side and on the new side. */
export interface GitLineRanges {
  original: [number, number][];
  modified: [number, number][];
}

export interface GitApplyLinesInput {
  projectId: string;
  /** Repo-relative. */
  path: string;
  side: 'staged' | 'unstaged' | 'untracked';
  action: GitLineAction;
  ranges: GitLineRanges;
  /** The ids from the GitFileDiff the lines were picked in. */
  originalId: string;
  modifiedId: string;
  origPath?: string;
}

export interface GitDiscardResult extends GitOpResult {
  /** Hands the discarded content back for a short while. */
  undoToken?: string;
}

/** An AI CLI's go at a conflicted file. `undoToken` puts the markers back. */
export interface ResolveConflictWithAiResult extends GitDiscardResult {
  /** The CLI's own short account of what it kept. */
  summary?: string;
  /** Set when the user stopped the run; the file is back as it was. */
  cancelled?: boolean;
}

/** One entry of `git stash list`, newest first. */
export interface GitStashEntry {
  /** `stash@{0}`, `stash@{1}`, … — what pop/apply/drop take. */
  ref: string;
  /** 0 for the newest stash. */
  index: number;
  /** The message git stored, e.g. "WIP on main: abc1234 Subject". */
  message: string;
}

/** How a stash push from the workspace panel behaves. */
export interface GitStashPushInput {
  projectId: string;
  /** Also stash untracked files (`--include-untracked`). */
  includeUntracked: boolean;
  /** Leave staged changes in place, stashing only the rest (`--keep-index`). */
  keepIndex: boolean;
  /** Optional message; git generates a "WIP on …" one when empty. */
  message?: string;
}

export interface GitTagInfo {
  /** Most recent tag reachable from HEAD, or null when the repo has none yet. */
  latestTag: string | null;
  /** Newest tags first, capped to a handful for display. */
  recentTags: string[];
  /** Commits made after `latestTag` (all commits when there is no tag yet). */
  commitsSinceLatestTag: number;
  hasRemote: boolean;
  /**
   * Every prefix the repo's tags put in front of a version ("v", "web-v", "" for bare
   * versions), most recently used first. Only offered as quick picks, never enforced.
   */
  prefixes: string[];
}

export interface CreateTagInput {
  projectId: string;
  tag: string;
  /** Annotation message; falls back to the tag name when empty. */
  message?: string;
  /** Push the current branch and the new tag to origin after creating it. */
  push: boolean;
}

export interface ApplyVersionInput {
  projectId: string;
  /** Tag being prepared, e.g. "v1.7.0"; the manifests get the version part on its own. */
  tag: string;
  /** Lets git.cancelAiPrompt(requestId) stop the run. */
  requestId?: string;
}

/**
 * One file the version bump run changed, compared by content before and after the run. The
 * two object ids are what let the user revert that one file, or put the edit back again.
 */
export interface VersionFileChange {
  /** Repo-relative path with forward slashes. */
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  /** Git blob id of the file before the run, or null when it did not exist. */
  beforeId: string | null;
  /** Git blob id of the file after the run, or null when the run deleted it. */
  afterId: string | null;
  /**
   * The exact bytes on disk on each side, line endings untouched, so a swap puts back the very
   * same file. Null when that side matched HEAD (a checkout recreates it) or did not exist.
   */
  beforeRawId: string | null;
  afterRawId: string | null;
  additions: number;
  deletions: number;
  /** Hunks of the run's own edit, without the diff header. Empty for binary files. */
  diff: string;
  /** The diff was cut short because the file changed a lot. */
  diffTruncated?: boolean;
  binary?: boolean;
  /**
   * The file already had uncommitted edits before the run. The diff shows only what the run
   * changed, but committing the file also commits those earlier edits.
   */
  hadLocalEdits?: boolean;
  /**
   * The edit split into hunks of changed lines, each with a little context, so the user can
   * keep some lines and revert others. Only set for a text file with more than one changed line.
   */
  hunks?: VersionHunk[];
}

export interface VersionHunk {
  /** Git's `@@ -a,b +c,d @@` line for the change. */
  header: string;
  /** 1-based line numbers of the first `lead` line in the old and the new file. */
  oldLine: number;
  newLine: number;
  /** Unchanged lines just before the change, line endings removed. */
  lead: string[];
  /**
   * The changed lines in order. Edits are numbered across the whole file, hunk by hunk, and
   * that number is what WriteVersionHunksInput.revertEdits refers to.
   */
  edits: VersionLineEdit[];
  /** Unchanged lines just after the change. */
  trail: string[];
}

/** One changed line: the line the run replaced, the line it wrote, or both. */
export interface VersionLineEdit {
  removed?: string;
  added?: string;
}

export interface ApplyVersionResult {
  ok: boolean;
  /** What the CLI reported it did. */
  output: string;
  /** Files whose content differs from before the run. */
  changes: VersionFileChange[];
  /** True if HEAD moved during the run, e.g. the CLI ran `npm version` and committed on its own. */
  committedByCli?: boolean;
  cliName?: string | null;
  /** Set when files were edited but the CLI still ended badly (timed out, exited non-zero). */
  warning?: string;
  error?: string;
  cancelled?: boolean;
}

/** Swaps one file between two recorded versions: reverting a run's edit, or restoring it. */
export interface SwapVersionFileInput {
  projectId: string;
  path: string;
  /** Blob id the file must still have, or null if it must not exist. Guards against lost work. */
  fromId: string | null;
  /** Blob id to write into the file, or null to delete it. */
  toId: string | null;
  /** Exact bytes to write instead of checking `toId` out, when that side has a raw copy. */
  toRawId?: string | null;
}

/** Rewrites one file with only some of the run's changes to it applied. */
export interface WriteVersionHunksInput {
  projectId: string;
  path: string;
  /** Blob id the file must still have. Guards against lost work. */
  fromId: string;
  beforeId: string;
  afterId: string;
  beforeRawId: string | null;
  afterRawId: string | null;
  /** Line edits to leave out, numbered across the file's hunks; every other edit is applied. */
  revertEdits: number[];
}

export interface WriteVersionHunksResult extends GitOpResult {
  /** Blob id the file holds after the write, when it succeeded. */
  id?: string;
}

export interface SuggestTagResult {
  ok: boolean;
  /** Suggested tag name, e.g. "v1.6.2". */
  tag?: string;
  /** One-line rationale from the CLI, when it gave one. */
  reason?: string;
  /** Release notes for the tag annotation. */
  message?: string;
  /** Display name of the CLI that answered. */
  cliName?: string | null;
  error?: string;
  /** True when the caller cancelled the run, so the UI can stay quiet about it. */
  cancelled?: boolean;
}

export interface SuggestGitTextResult {
  ok: boolean;
  /** Suggested branch name or commit message, when ok is true. */
  text?: string;
  /** Display name of the CLI that answered. */
  cliName?: string | null;
  error?: string;
  /** True when the caller cancelled the run, so the UI can stay quiet about it. */
  cancelled?: boolean;
}

export interface CreatePullRequestInput {
  projectId: string;
  title: string;
  body: string;
  base?: string;
  /** Open it as a draft, so it can't be merged until it is marked ready. */
  draft?: boolean;
}

export interface CreatePullRequestResult {
  ok: boolean;
  url?: string;
  error?: string;
  /** True when the GitHub CLI wasn't available and we opened a compare page in the browser instead. */
  usedFallback?: boolean;
}

/** Everything the workspace Pull request tab needs for the current branch, in one read. */
export interface PullRequestStatus {
  cliAvailable: boolean;
  authenticated: boolean;
  /** The GitHub repository behind the primary remote, or null when it isn't on GitHub. */
  github: { owner: string; repo: string } | null;
  /** Null when HEAD is detached. */
  branch: string | null;
  defaultBranch: string | null;
  onDefaultBranch: boolean;
  /** Commits a push would send, or all of them when the branch has no upstream yet. */
  ahead: number;
  hasUpstream: boolean;
  /** Uncommitted changes in the working tree. */
  dirty: boolean;
  pr: PullRequestInfo | null;
  error?: string;
}

export interface PrActionResult {
  ok: boolean;
  error?: string;
}

export interface PrCommentInput {
  projectId: string;
  number: number;
  body: string;
}

export interface PrThreadReplyInput {
  projectId: string;
  threadId: string;
  body: string;
}

export interface PrThreadResolveInput {
  projectId: string;
  threadId: string;
  resolved: boolean;
}

export type MergeStep = 'merge' | 'checkout' | 'pull' | 'delete';

export interface MergeStepResult {
  step: MergeStep;
  ok: boolean;
  message: string;
}

export interface MergePullRequestIpcInput {
  projectId: string;
  number: number;
  base: string;
  head: string;
  method: MergeMethod;
  cleanup: boolean;
}

export interface MergePullRequestResult {
  ok: boolean;
  /** True once GitHub merged it, even if a cleanup step afterwards failed. */
  merged: boolean;
  steps: MergeStepResult[];
}

export interface CleanupAfterMergeInput {
  projectId: string;
  base: string;
  head: string;
}

export interface SuggestPullRequestTextResult {
  ok: boolean;
  title?: string;
  body?: string;
  cliName?: string | null;
  error?: string;
  cancelled?: boolean;
}

export interface GitInitInput {
  projectId: string;
  /** Branch the fresh repository starts on, e.g. "master". */
  branch: string;
  /** Stage everything and record a first commit right after the init. */
  initialCommit: boolean;
  commitMessage?: string;
}

export type GithubOwnerType = 'user' | 'organization';

export interface GithubOwner {
  login: string;
  type: GithubOwnerType;
}

export interface GithubAccount {
  /** False when the GitHub CLI isn't installed at all. */
  cliAvailable: boolean;
  /** False when gh is there but nobody has logged in with it. */
  authenticated: boolean;
  login: string | null;
  /** The signed-in account first, then every organization it belongs to. */
  owners: GithubOwner[];
  error?: string;
}

/** Daily GitHub contribution counts for the dashboard activity chart. */
export interface GithubActivity {
  ok: boolean;
  cliAvailable: boolean;
  authenticated: boolean;
  login: string | null;
  /** Contributions in GitHub's current contribution year. */
  yearCount: number;
  /** Last 12 weeks of local calendar days, including days with no activity. */
  days: GitDayCount[];
  error?: string;
}

export interface GithubNotificationItem {
  id: string;
  unread: boolean;
  reason: string;
  title: string;
  type: string;
  repo: string;
  updatedAt: string;
  /** Browser URL when GitHub gave us enough to build one; otherwise the repo page. */
  url: string | null;
}

export interface GithubNotifications {
  ok: boolean;
  cliAvailable: boolean;
  authenticated: boolean;
  notifications: GithubNotificationItem[];
  error?: string;
}

export interface GithubRepoInfo {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface GithubRepoLookup {
  /** False only when the lookup itself failed, which is different from "no such repo". */
  ok: boolean;
  exists: boolean;
  repo?: GithubRepoInfo;
  error?: string;
}

export interface CreateGithubRepoInput {
  /** A user login or an organization login the account can create repos in. */
  owner: string;
  name: string;
  isPrivate: boolean;
  description?: string;
}

export interface CreateGithubRepoResult {
  ok: boolean;
  repo?: GithubRepoInfo;
  error?: string;
}

export interface ConnectRemoteInput {
  projectId: string;
  /** Remote URL, https or ssh. */
  url: string;
  /** Push the current branch with -u once the remote is wired up. */
  push: boolean;
}

/** Clones a GitHub repo into the folder picked in the New Project dialog. */
export interface CloneIntoInput {
  folderPath: string;
  /** Whatever the user pasted; validated and normalized in main. */
  repoUrl: string;
}

/** Outcome of the Add Project auto-clone. Project creation still proceeds on failure. */
export interface CloneIntoResult extends GitOpResult {
  /** True when the folder already held a repo and no clone was needed. */
  skipped?: boolean;
}

export type PackageManagerEcosystem = 'node' | 'dotnet' | 'dart';
export type PackageManagerKind = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'nuget' | 'pub';

export interface PackageInfo {
  name: string;
  currentVersion: string;
  /** Null when the latest-version lookup failed, distinct from "up to date". */
  latestVersion: string | null;
  isOutdated: boolean;
  isDev: boolean;
  /** False when only a declared range was found (e.g. node_modules missing). */
  isInstalled: boolean;
  /** Absolute path to the manifest this package was read from (package.json, a specific .csproj, or pubspec.yaml). */
  manifestPath: string;
  /** Human-readable name of the sub-project this package belongs to (e.g. its package.json "name", or a relative folder path). */
  projectLabel: string;
}

export interface PackageManagerSection {
  ecosystem: PackageManagerEcosystem;
  manager: PackageManagerKind;
  status: 'ok' | 'cli-missing' | 'error';
  message: string | null;
  packages: PackageInfo[];
}

export interface PackageScanResult {
  projectId: string;
  sections: PackageManagerSection[];
}

export interface PackageUpdateRequest {
  ecosystem: PackageManagerEcosystem;
  name: string;
  targetVersion: string;
  manifestPath: string;
}

export interface PackageUpdateProgress {
  projectId: string;
  ecosystem: PackageManagerEcosystem;
  packageName: string;
  status: 'running' | 'done' | 'error';
  message?: string;
  completed: number;
  total: number;
}

export interface PackageUpdateItemResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface PackageUpdateResult {
  ok: boolean;
  results: PackageUpdateItemResult[];
}

export interface DiskUsage {
  /** Drive letter (Windows) or device name (macOS/Linux), stable across samples. */
  id: string;
  label: string;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

export interface GpuUsage {
  /** GPU index reported by `nvidia-smi`, stable across samples. */
  id: string;
  label: string;
  percent: number;
  memUsedBytes: number;
  memTotalBytes: number;
}

/** One app (possibly several processes) in a top-CPU, GPU, memory, or disk listing. */
export interface TopResourceApp {
  name: string;
  /** Heaviest process in the group, useful when processCount is 1. */
  pid: number;
  /** Share of the resource, 0-100, already scaled to match the dashboard graphs. */
  percent: number;
  processCount: number;
  /** Working set (CPU/memory) or dedicated GPU memory (GPU), when the OS reports it. */
  memBytes?: number;
  /** Disk read+write throughput, when listing top disk apps. */
  rateBytesPerSec?: number;
  /** Small PNG data URL of the app's file icon, when the OS can resolve it. */
  iconDataUrl?: string;
}

export type TopResourceKind = 'cpu' | 'gpu' | 'memory' | 'disk';

export interface TopResourceAppsResult {
  apps: TopResourceApp[];
  /**
   * False when this machine has no way to attribute the resource to processes
   * (typical for GPU on macOS without nvidia-smi, or disk I/O on macOS).
   */
  available: boolean;
}

export interface KillProcessResult {
  ok: boolean;
  error?: string;
}

export interface SystemStatsSample {
  timestamp: number;
  /** e.g. "Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz". */
  cpuModel: string;
  cpuCoreCount: number;
  /**
   * Aggregate CPU usage, 0-100. On Windows this is % Processor Time, the
   * same formula Windows 11 Task Manager uses (busy time / elapsed / cores).
   * On other platforms it is the average of cpuCorePercents.
   */
  cpuPercent: number;
  /** Per-logical-core usage, same order as reported by the OS. */
  cpuCorePercents: number[];
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** Empty when no fixed disk could be queried. */
  disks: DiskUsage[];
  /**
   * Empty when no GPU could be queried. NVIDIA GPUs (via `nvidia-smi`) get
   * precise usage; on Windows, one additional non-NVIDIA GPU (e.g. an
   * integrated Intel/AMD chip) is included with best-effort usage (see
   * sampleOtherGpu in system/gpuStats.ts for the accuracy caveat); on macOS
   * every GPU, Apple Silicon included, is read from the IORegistry.
   */
  gpus: GpuUsage[];
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  pings: PingResult[];
}

/** What the keep-awake policy is doing right now. */
export interface KeepAwakeStatus {
  mode: KeepAwakeMode;
  /** True while the machine is actually being held awake. */
  blocking: boolean;
  /** What counts as busy at the moment, e.g. `['agents']`. */
  busy: string[];
}

// --- Remote control ------------------------------------------------------------

export interface RemoteNetworkInterface {
  /** Adapter name, e.g. "Wi-Fi" or "eth0". */
  name: string;
  address: string;
}

export interface RemoteScreenSize {
  width: number;
  height: number;
}

/** A controller currently connected to this machine while it is hosting. */
export interface RemotePeerInfo {
  id: string;
  deviceName: string;
  address: string;
  connectedAt: number;
}

export type RemoteConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** What an outbound connection is for: a full control session, or file transfer/browsing only (no screen capture/WebRTC). */
export type RemoteConnectIntent = 'control' | 'files';

/** This machine's outbound connection to a remote host (controller side). */
export interface RemoteConnectionInfo {
  status: RemoteConnectionStatus;
  remoteDeviceName: string | null;
  remoteScreen: RemoteScreenSize | null;
  intent: RemoteConnectIntent | null;
  error?: string;
}

/** A live one-time pairing code plus its QR rendering. */
export interface RemotePairingInfo {
  code: string;
  qrDataUrl: string;
  expiresAt: number;
}

export interface RemoteState {
  deviceName: string;
  hosting: boolean;
  hostIp: string | null;
  hostPort: number;
  /** Whether OS-level input injection is available on this platform. */
  inputSupported: boolean;
  pairing: RemotePairingInfo | null;
  peers: RemotePeerInfo[];
  connection: RemoteConnectionInfo;
  interfaces: RemoteNetworkInterface[];
}

/**
 * A remembered host, keyed by the durable per-device token the host issues on
 * first pairing (see `auth-ok`'s `deviceToken`). Lets the controller reconnect
 * with one click, no pairing code required, until the host revokes the token.
 */
export interface RemoteSavedServer {
  id: string;
  nickname: string;
  ip: string;
  port: number;
  deviceName: string;
  deviceToken: string;
  createdAt: number;
  lastConnectedAt: number;
}

export type SshAuthMethod = 'password' | 'privateKey';

/** A saved SSH server. Never carries the plaintext password/passphrase; see `SaveSshServerInput`. */
export interface SshSavedServer {
  id: string;
  nickname: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  /** Plaintext filesystem path, only set for authMethod 'privateKey'; not itself a secret. */
  privateKeyPath?: string;
  /** Whether a password or key passphrase is stored. The secret itself is never sent to the renderer. */
  hasSecret: boolean;
  /** SHA256 host key fingerprint recorded on first successful connect (trust-on-first-use). */
  hostKeyFingerprint?: string;
  createdAt: number;
  lastConnectedAt: number | null;
}

/**
 * Input to `ssh:saveServer`. `secret` is the plaintext password/passphrase the user just typed;
 * omit it on an edit to leave the stored secret unchanged, since the real one is never round-tripped
 * back to the renderer for display.
 */
export interface SaveSshServerInput {
  /** Present on an edit of an existing server. */
  id?: string;
  nickname: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  secret?: string;
}

export interface CreateSshSessionOptions {
  sessionId?: string;
  savedServerId: string;
  cols?: number;
  rows?: number;
  /** Typed into the shell once it opens, e.g. a command that resumes an agent conversation. */
  initialInput?: string;
}

export interface SshAttachResult {
  sessionId: string;
}

/** Every supported CLI conversation stored on a saved server, newest first. */
export interface SshConversationsResult {
  sessions: AgentHistorySession[];
  /** The login user's home folder on the server, or null when it could not be found. */
  home: string | null;
  /** Which agent CLIs the server has, so resuming can be offered only where it can work. */
  clis: {
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    cursor: boolean;
    continue: boolean;
    grok: boolean;
    cline: boolean;
    opencode: boolean;
    qwen: boolean;
    freebuff: boolean;
  };
}

export interface SshVaultStatus {
  hasPasskey: boolean;
  unlocked: boolean;
}

/** On-disk record for the optional Servers passkey. Never holds the passkey itself. */
export interface SshVaultRecord {
  salt: string;
  verifier: string;
}

/** A secret encrypted with the OS keychain (Electron `safeStorage`); the default when no passkey is set. */
export interface SafeStorageSecretEnvelope {
  mode: 'safeStorage';
  ciphertext: string;
}

/** A secret encrypted with a key derived from the user's Servers passkey (AES-256-GCM). */
export interface PassphraseSecretEnvelope {
  mode: 'passphrase';
  iv: string;
  authTag: string;
  ciphertext: string;
}

export type SecretEnvelope = SafeStorageSecretEnvelope | PassphraseSecretEnvelope;

/**
 * Main-process-only, on-disk shape of a saved SSH server: `SshSavedServer` plus the actual
 * encrypted secret. Never sent to the renderer as-is; `ssh:listServers` maps this down to
 * `SshSavedServer` (dropping `secretEnvelope` in favor of the `hasSecret` boolean).
 */
export interface StoredSshServer extends Omit<SshSavedServer, 'hasSecret'> {
  secretEnvelope?: SecretEnvelope;
}

/** Desktop size an RDP session asks for: follow the window, or a fixed resolution. */
export type RdpResolution = 'fitWindow' | { width: number; height: number };

export interface RdpServerOptions {
  resolution: RdpResolution;
  fullscreenOnConnect: boolean;
  /** Keep text and images in sync between this computer and the server. */
  clipboard: boolean;
  /** Allow copying files both ways through the clipboard channel. */
  fileTransfer: boolean;
  /** Network Level Authentication (CredSSP). Windows Server requires it by default. */
  nla: boolean;
}

/** A saved Remote Desktop server. The password never leaves the main process for listing. */
export interface RdpSavedServer {
  id: string;
  nickname: string;
  host: string;
  port: number;
  username: string;
  domain?: string;
  hasSecret: boolean;
  /** SHA-256 of the server's TLS certificate, recorded on the first successful connect. */
  certFingerprint?: string;
  /** Who the saved certificate was issued to and until when, for showing next to the pin. */
  certDetails?: RdpCertificateDetails;
  options: RdpServerOptions;
  createdAt: number;
  lastConnectedAt: number | null;
}

/** What a person needs to recognise a certificate. The fingerprint is what gets compared. */
export interface RdpCertificateDetails {
  subject: string;
  issuer: string;
  validTo: string;
}

/** A server's TLS certificate as it presented itself. */
export interface RdpCertificateInfo extends RdpCertificateDetails {
  fingerprint: string;
}

/** Input to `rdp:saveServer`. Leave `secret` out on an edit to keep the stored password. */
export interface SaveRdpServerInput {
  id?: string;
  nickname: string;
  host: string;
  port: number;
  username: string;
  domain?: string;
  secret?: string;
  options: RdpServerOptions;
}

/** Main-process-only, on-disk shape of a saved RDP server. */
export interface StoredRdpServer extends Omit<RdpSavedServer, 'hasSecret'> {
  secretEnvelope?: SecretEnvelope;
}

/** An env file saved for one environment. The contents stay in the main process until asked for. */
export interface EnvFileSummary {
  id: string;
  /** A bare `.env*` name such as `.env.production`, written as is into the project folder. */
  fileName: string;
  keyCount: number;
  updatedAt: number;
}

/** A saved login or key that isn't a file: a database, dashboard, server and so on. */
export interface EnvCredentialSummary {
  id: string;
  label: string;
  username: string;
  url: string;
  hasSecret: boolean;
  hasNotes: boolean;
  updatedAt: number;
}

/** One stage of a project (production, staging, ...) and the secrets saved for it. */
export interface ProjectEnvironment {
  id: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
  order: number;
  files: EnvFileSummary[];
  credentials: EnvCredentialSummary[];
  createdAt: number;
  updatedAt: number;
}

export interface SaveEnvironmentInput {
  id?: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
}

export interface SaveEnvFileInput {
  environmentId: string;
  id?: string;
  fileName: string;
  content: string;
}

/** Leave `secret` or `notes` undefined on an edit to keep what is stored; an empty string clears it. */
export interface SaveEnvCredentialInput {
  environmentId: string;
  id?: string;
  label: string;
  username: string;
  url: string;
  secret?: string;
  notes?: string;
}

export interface EnvCredentialSecrets {
  secret: string;
  notes: string;
}

/** A `.env*` file found in the root of a project folder. */
export interface EnvFolderFile {
  fileName: string;
  size: number;
  guessedKind: EnvironmentKind;
  isTemplate: boolean;
  tooLarge: boolean;
  /** Id of the environment that already has a file with this name, if any. */
  savedInEnvironmentId?: string;
}

/** Where one imported file goes: an existing environment, or a new one made on the way. */
export interface EnvImportPick {
  fileName: string;
  environmentId?: string;
  newEnvironment?: { name: string; kind: EnvironmentKind };
}

export interface EnvImportResult {
  imported: number;
  errors: string[];
}

export interface EnvWriteResult {
  status: 'written' | 'exists';
  path: string;
  /** The project is a git repo and the file is not ignored, so it could get committed. */
  notIgnored?: boolean;
}

export interface StoredEnvFile extends EnvFileSummary {
  contentEnvelope: SecretEnvelope;
}

export interface StoredEnvCredential extends Omit<EnvCredentialSummary, 'hasSecret' | 'hasNotes'> {
  secretEnvelope?: SecretEnvelope;
  notesEnvelope?: SecretEnvelope;
}

/** Main-process-only, on-disk shape of a project environment. */
export interface StoredProjectEnvironment
  extends Omit<ProjectEnvironment, 'files' | 'credentials'> {
  files: StoredEnvFile[];
  credentials: StoredEnvCredential[];
}

/**
 * Everything a session window needs for one connection attempt. `proxyUrl` carries a token
 * that works once, for this server only.
 */
export interface RdpConnectTicket {
  sessionId: string;
  serverId: string;
  nickname: string;
  proxyUrl: string;
  destination: string;
  username: string;
  domain?: string;
  password: string;
  options: RdpServerOptions;
}

/** Sent to a session window when the server's certificate is not the one saved last time. */
export interface RdpCertificatePrompt {
  sessionId: string;
  host: string;
  expectedFingerprint: string;
  actualFingerprint: string;
  subject: string;
  issuer: string;
  validTo: string;
}

/**
 * What went wrong on the way to a server, so the window can pick fitting advice without reading
 * sentences. `tls-key-usage` is a certificate Windows made for Remote Desktop that the secure
 * connection library only accepts for the older RSA key exchange, which the server then refused.
 */
export type RdpProxyErrorCode =
  | 'host-not-found'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'closed'
  | 'not-rdp'
  | 'tls-failed'
  | 'tls-key-usage'
  | 'certificate-changed'
  /** The proxy from the Network settings could not be reached or would not connect. */
  | 'proxy-failed'
  | 'other';

/** A reason the proxy gave up. `message` is one plain sentence; `detail` is for support. */
export interface RdpFailureInfo {
  code: RdpProxyErrorCode;
  /** Never carries text from the socket or TLS library. */
  message: string;
  /** The library's own reason with its source locations removed, for the technical details. */
  detail?: string;
}

/** A reason the proxy gave up, sent to the session window before the socket closes. */
export interface RdpProxyErrorPayload extends RdpFailureInfo {
  sessionId: string;
}

/** How a server's current certificate compares to the one saved for it. */
export type RdpCertificateStatus = 'new' | 'same' | 'changed';

export interface RdpCertificateCheck {
  certificate: RdpCertificateInfo;
  status: RdpCertificateStatus;
  /** The saved certificate, when there is one. Its details are missing on older saves. */
  saved?: { fingerprint: string; details?: RdpCertificateDetails };
}

/** The answer to `rdp:checkCertificate`; a failure comes back as data so its text stays clean. */
export type RdpCertificateCheckResult =
  | { ok: true; check: RdpCertificateCheck }
  | { ok: false; failure: RdpFailureInfo };

/**
 * One file or folder copied on this computer, flattened the way the RDP clipboard channel
 * describes a copied collection: `path` is the folder it sits in, relative to the copy root,
 * with `\` separators.
 */
export interface RdpFileEntry {
  name: string;
  path?: string;
  size: number;
  lastModified: number;
  isDirectory: boolean;
}

/** Files currently copied on this computer, as seen by `rdp:readClipboardFiles`. */
export interface RdpClipboardFiles {
  /** Changes whenever a different set of files is copied. */
  signature: string;
  entries: RdpFileEntry[];
  totalBytes: number;
  /** Set when the copy is too large to hand over through the clipboard. */
  tooLarge: boolean;
}

export interface RdpDownloadTarget {
  downloadId: string;
  folder: string;
}

export interface RdpWindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
}

export interface SshDataPayload {
  sessionId: string;
  data: string;
}

export interface SshExitPayload {
  sessionId: string;
  /** A short, user-facing reason (auth failed, host unreachable, host key changed), if any. */
  error?: string;
}

/**
 * How much control the user keeps over an AI-driven terminal task (SSH or local) before a
 * command actually runs.
 * `approve-risky` still runs ordinary commands immediately, pausing only when a command matches
 * a destructive-looking pattern (rm -rf, drop table, shutdown, ...).
 */
export type SshAgentMode = 'approve-all' | 'approve-risky' | 'autonomous';

export interface StartSshAgentTaskInput {
  sessionId: string;
  /**
   * Which kind of terminal `sessionId` is. Defaults to `ssh`; `local` drives a shell on this
   * machine (PowerShell, cmd, bash, zsh, or fish) the same way.
   */
  target?: 'ssh' | 'local';
  /** The task (or series of tasks) in plain language, e.g. "check disk usage, then clear old logs". */
  prompt: string;
  mode: SshAgentMode;
  /**
   * Agent CLI that decides each step (e.g. `claude-code`). Null or absent uses the AI provider
   * from Settings (OpenAI, Gemini, or Ollama) instead.
   */
  cliId?: string | null;
  /** Model id from that CLI's run profile (`opus`, `terra`, ...). Absent keeps the CLI's own default. */
  modelId?: string | null;
  /** Reasoning effort, when the chosen model has one. */
  effort?: EffortLevel | null;
}

export type SshAgentPhase =
  | 'thinking'
  | 'proposed'
  | 'running'
  | 'needs-input'
  | 'needs-password'
  | 'finished'
  | 'error'
  | 'stopped';

export interface SshAgentProgress {
  sessionId: string;
  phase: SshAgentPhase;
  /** How many commands the AI has proposed so far this run, 1-based. */
  step: number;
  /** The command that was proposed, is running, or just finished, when relevant to `phase`. */
  command?: string;
  /** A question (needs-input), a summary (finished), or an error/stop reason. */
  message?: string;
  /**
   * Only on `needs-password`: whether this server has a saved login password AgentMate can type
   * into the prompt. The password itself never leaves the main process.
   */
  hasSavedPassword?: boolean;
  /**
   * Only on `error`: the run is paused rather than over, and continueSshAgentTask() picks it up
   * again with everything it has done so far.
   */
  canContinue?: boolean;
  /**
   * How many messages the user sent mid-run that the AI has not read yet. Absent when none are
   * waiting, so a run nobody talked to reports exactly what it did before.
   */
  queuedMessages?: number;
}

/** One thing that happened during an AI terminal task, as shown in its history. */
export type SshAgentHistoryEntry =
  | {
      kind: 'command';
      at: number;
      command: string;
      output: string;
      exitCode: number | null;
      timedOut: boolean;
    }
  | { kind: 'skipped'; at: number; command: string }
  | { kind: 'question'; at: number; text: string }
  | { kind: 'answer'; at: number; text: string }
  /** Something the user told the AI on their own, while it was working. */
  | { kind: 'message'; at: number; text: string }
  | { kind: 'error'; at: number; text: string }
  | { kind: 'continued'; at: number }
  | { kind: 'finished'; at: number; text: string }
  | { kind: 'stopped'; at: number; text: string };

export type SshAgentRunStatus = 'running' | 'paused' | 'finished' | 'error' | 'stopped';

/** A whole AI terminal task: what was asked and everything that happened, oldest first. */
export interface SshAgentHistoryRun {
  id: string;
  sessionId: string;
  /**
   * The saved server the run's SSH tab was connected to when it started, so the server's AI
   * history can list it after the tab is gone. Absent for a local terminal.
   */
  serverId?: string;
  prompt: string;
  /** Who decided each step, e.g. "Claude Code" or "OpenAI". */
  aiLabel: string;
  startedAt: number;
  endedAt: number | null;
  status: SshAgentRunStatus;
  entries: SshAgentHistoryEntry[];
}

/** Starts an AI task that operates a Remote Desktop session by looking at it and using mouse and keyboard. */
export interface StartRdpAgentTaskInput {
  /** The Remote Desktop session (its window) the AI should operate. */
  sessionId: string;
  /** The task in plain language, e.g. "open Notepad and write a shopping list". */
  prompt: string;
  mode: SshAgentMode;
  /**
   * Agent CLI that decides each step. It has to be one that can look at a screenshot. Null or
   * absent uses the AI provider from Settings instead, which then needs a vision model.
   */
  cliId?: string | null;
  /** Model id from that CLI's run profile. Absent keeps the CLI's own default. */
  modelId?: string | null;
  /** Reasoning effort, when the chosen model has one. */
  effort?: EffortLevel | null;
}

export type RdpAgentPhase =
  | 'thinking'
  | 'proposed'
  | 'acting'
  | 'needs-input'
  | 'finished'
  | 'error'
  | 'stopped';

export interface RdpAgentProgress {
  sessionId: string;
  phase: RdpAgentPhase;
  /** How many actions the AI has proposed so far this run, 1-based. */
  step: number;
  /** The action as the AI wrote it, e.g. `CLICK 512 300`, when relevant to `phase`. */
  action?: string;
  /** Where a pointer action lands, as fractions (0 to 1) of the desktop, for the on-screen marker. */
  target?: { x: number; y: number };
  /** A question (needs-input), a summary (finished), a warning (proposed), or an error/stop reason. */
  message?: string;
  /** Only on `error`: the run is paused rather than over, and continuing picks it up again. */
  canContinue?: boolean;
  /** Messages the user sent mid-run that the AI has not read yet. Absent when there are none. */
  queuedMessages?: number;
}

/** One thing that happened during an AI Remote Desktop task, as shown in its history. */
export type RdpAgentHistoryEntry =
  | { kind: 'action'; at: number; action: string; outcome: string; ok: boolean }
  | { kind: 'skipped'; at: number; action: string }
  | { kind: 'question'; at: number; text: string }
  | { kind: 'answer'; at: number; text: string }
  /** Something the user told the AI on their own, while it was working. */
  | { kind: 'message'; at: number; text: string }
  | { kind: 'error'; at: number; text: string }
  | { kind: 'continued'; at: number }
  | { kind: 'finished'; at: number; text: string }
  | { kind: 'stopped'; at: number; text: string };

/** A whole AI Remote Desktop task: what was asked and everything that happened, oldest first. */
export interface RdpAgentHistoryRun {
  id: string;
  sessionId: string;
  prompt: string;
  /** Who decided each step, e.g. "Claude Code" or "OpenAI". */
  aiLabel: string;
  startedAt: number;
  endedAt: number | null;
  status: SshAgentRunStatus;
  entries: RdpAgentHistoryEntry[];
}

/**
 * Low-level input in remote desktop pixels. The main process builds these from the AI's action;
 * the Remote Desktop window only executes them.
 */
export type RdpInputOp =
  | { kind: 'move'; x: number; y: number }
  /** DOM numbering: 0 left, 1 middle, 2 right. */
  | { kind: 'button'; button: 0 | 1 | 2; down: boolean }
  /** PS/2 set 1 scancode. Extended keys carry 0xE0 in the high byte (the Windows key is 0xE05B). */
  | { kind: 'key'; scancode: number; down: boolean }
  | { kind: 'unicode'; char: string; down: boolean }
  /** Positive scrolls up. unit: 0 pixel, 1 line, 2 page. */
  | { kind: 'wheel'; vertical: boolean; amount: number; unit: 0 | 1 | 2 }
  | { kind: 'pause'; ms: number }
  | { kind: 'releaseAll' };

/** One screenshot of a Remote Desktop session, scaled down for the AI. */
export interface RdpAgentFrame {
  /** PNG, base64, without the `data:` prefix. */
  png: string;
  /** Size of the PNG. */
  width: number;
  height: number;
  /** Size of the remote desktop the PNG was scaled from. */
  desktopWidth: number;
  desktopHeight: number;
}

/** main -> Remote Desktop window. */
export type RdpAgentRequest =
  | { requestId: string; sessionId: string; kind: 'frame'; maxWidth: number }
  | { requestId: string; sessionId: string; kind: 'input'; ops: RdpInputOp[] };

/** Remote Desktop window -> main, answering one RdpAgentRequest. */
export type RdpAgentResponse =
  | { requestId: string; ok: true; frame?: RdpAgentFrame }
  | { requestId: string; ok: false; error: string };

/** Live transport quality for the controller's inbound video, sampled ~1/sec. */
export interface RemoteQualitySample {
  kbps: number;
  fps: number;
  rttMs: number | null;
  /** Packets lost since the previous sample (a delta, not the cumulative WebRTC stat). */
  packetsLost: number;
  jitter: number;
  width: number;
  height: number;
  codec: string | null;
}

export type RemoteFileDirection = 'incoming' | 'outgoing';

export interface RemoteFileProgress {
  transferId: string;
  name: string;
  direction: RemoteFileDirection;
  transferred: number;
  total: number;
  done: boolean;
  error?: string;
  /** Absolute path where an incoming file was saved (set when done). */
  savedPath?: string;
  /** Total resumable parts (10MB each) this transfer is split into. */
  partsTotal?: number;
  /** Parts that have been hashed and acked so far. */
  partsCompleted?: number;
  /** Whole-file SHA-256 matched between sender and receiver (set when done). */
  verified?: boolean;
  /** True while auto-reconnecting after a dropped connection mid-transfer. */
  resuming?: boolean;
  /** Retry count for the part currently in flight (part-hash mismatch or timeout). */
  currentPartRetry?: number;
}

/** One entry in a remote-file-manager directory listing (mirrors `RemoteFileEntry` from the wire protocol). */
export interface RemoteFileManagerEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export type RemoteLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface RemoteLogEvent {
  level: RemoteLogLevel;
  message: string;
  at: number;
}

export interface StartHostInput {
  ip: string;
  port: number;
}

export type PipelineRunStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'waiting'
  | 'requested'
  | 'pending'
  | 'unknown';

export type PipelineConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'stale'
  | null;

export interface GithubWorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
  htmlUrl: string;
  badgeUrl: string;
  /**
   * Whether the workflow declares a `workflow_dispatch` trigger. Optimistically true when the
   * workflow file could not be read, so the Run button still shows and GitHub reports the real
   * reason if it turns out not to be dispatchable.
   */
  dispatchable: boolean;
  /** Inputs declared under `workflow_dispatch.inputs`, to prompt for before starting a run. */
  dispatchInputs: GithubWorkflowDispatchInput[];
}

export interface GithubWorkflowDispatchInput {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'boolean' | 'choice' | 'number' | 'environment';
  default: string;
  options: string[];
}

export interface GithubWorkflowRefs {
  defaultBranch: string;
  branches: string[];
  tags: string[];
}

export type GithubWorkflowRefsResult =
  | ({ ok: true } & GithubWorkflowRefs)
  | { ok: false; error: string };

export interface GithubWorkflowDispatchRequest {
  repo: string;
  workflowId: number;
  ref: string;
  inputs: Record<string, string>;
}

export interface GithubRunCancelRequest {
  repo: string;
  runId: number;
}

export type GithubPipelineActionResult = { ok: true } | { ok: false; error: string };

export interface GithubWorkflowRunInfo {
  id: number;
  workflowId: number;
  name: string;
  displayTitle: string;
  runNumber: number;
  headBranch: string;
  status: PipelineRunStatus;
  conclusion: PipelineConclusion;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPipelineStatus {
  projectId: string;
  cliAvailable: boolean;
  authenticated: boolean;
  github: { owner: string; repo: string } | null;
  error?: string;
  workflows: GithubWorkflowInfo[];
  /** Latest run for each workflow id, or null when that workflow has never run. */
  runsByWorkflowId: Record<number, GithubWorkflowRunInfo | null>;
}

export interface GithubActionsDayCount {
  date: string;
  passed: number;
  failed: number;
}

export interface GithubActionsHistoryItem {
  id: number;
  projectId: string | null;
  projectName: string;
  repo: string;
  workflowName: string;
  displayTitle: string;
  runNumber: number;
  headBranch: string;
  status: PipelineRunStatus;
  conclusion: PipelineConclusion;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  /** Lets the annotations lookup list the run's check runs in one call. */
  checkSuiteId?: number;
}

export type GithubRunAnnotationLevel = 'failure' | 'warning' | 'notice';

/** One annotation a job left on a run, like a deprecation warning or a failed step's message. */
export interface GithubRunAnnotation {
  level: GithubRunAnnotationLevel;
  jobName: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  title: string;
  message: string;
}

export interface GithubRunAnnotationsInput {
  repo: string;
  runId: number;
  checkSuiteId?: number;
}

export type GithubRunAnnotationsResult =
  | {
      ok: true;
      /** Failures first, then warnings, then notices. */
      annotations: GithubRunAnnotation[];
      counts: Record<GithubRunAnnotationLevel, number>;
    }
  | { ok: false; error: string };

export interface GithubActionsActivity {
  ok: boolean;
  cliAvailable: boolean;
  authenticated: boolean;
  /** Last 14 local calendar days, including days with no runs. */
  days: GithubActionsDayCount[];
  /** Newest first. */
  runs: GithubActionsHistoryItem[];
  weekPassed: number;
  weekFailed: number;
  runningCount: number;
  repoCount: number;
  error?: string;
}

/**
 * How a self-hosted runner looks right now. `seen` means GitHub would not tell us its live
 * state (an org runner without org admin access), so all we know is that it ran a job lately.
 */
export type GithubRunnerState = 'idle' | 'busy' | 'offline' | 'seen';

/** The job a busy runner is working on. */
export interface GithubRunnerJob {
  repo: string;
  runId: number;
  jobName: string;
  workflowName: string;
  htmlUrl: string;
}

export interface GithubRunner {
  /** Runner names are unique within their scope, so `scope` plus `name` identifies one. */
  name: string;
  /** Only known for runners read from the runners API. */
  id?: number;
  /** Where the runner is registered: one repo (`owner/name`) or a whole org. */
  scope: { kind: 'repo' | 'org'; name: string };
  /** `Linux`, `Windows` or `macOS`, empty when only seen through jobs and the labels say nothing. */
  os: string;
  /** `X64`, `ARM64` and so on, when a label gives it away. */
  arch?: string;
  state: GithubRunnerState;
  /** Every label, as GitHub reports it. */
  labels: string[];
  /** Labels someone added by hand, without `self-hosted`, the OS and the arch. */
  customLabels: string[];
  /** Set while the runner is busy and the job belongs to a run we know about. */
  currentJob?: GithubRunnerJob;
  /** When the runner last finished a job, for `seen` runners. ISO timestamp. */
  lastSeenAt?: string;
}

/** A queued job asking for a self-hosted runner that no online runner can take. */
export interface GithubRunnerWaitingJob {
  repo: string;
  runId: number;
  jobName: string;
  workflowName: string;
  htmlUrl: string;
  /** The `runs-on` labels the job is waiting for. */
  labels: string[];
  /** ISO timestamp of when the job was queued. */
  queuedAt: string;
  /**
   * True when we could read the live runner list for the job's repo or org and none online
   * matches. False when the org hides its runners, so the job is only reported once it has
   * waited a while and the copy has to say "may be offline" rather than "is offline".
   */
  liveStatusKnown: boolean;
}

/** A run from the activity list, so the runner lookup can read its jobs. */
export interface GithubRunnersRunRef {
  repo: string;
  runId: number;
  workflowName: string;
  /** Whether the run has finished. Finished runs only feed `seen` runners. */
  completed: boolean;
}

export interface GithubRunnersInput {
  /** Runs from the activity list, newest first. The main process caps how many it reads. */
  runs: GithubRunnersRunRef[];
  /**
   * Ask GitHub again for runner lists it refused recently. Set when the user refreshes or has
   * just granted org access, so a new scope shows up at once instead of minutes later.
   */
  fresh?: boolean;
}

export type GithubRunnersResult =
  | {
      ok: true;
      runners: GithubRunner[];
      waiting: GithubRunnerWaitingJob[];
      /** Orgs whose runner list needs org admin access (the `admin:org` scope). */
      hiddenOrgs: string[];
    }
  | { ok: false; error: string };

export interface GithubActionsRunErrorInput {
  repo: string;
  runId: number;
  workflowName?: string;
  displayTitle?: string;
  runNumber?: number;
  headBranch?: string;
}

export type GithubActionsRunErrorResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * A security scan in flight, as the main process sees it.
 *
 * A scan is owned by the main process, not by whichever view started it: leaving the Security tab
 * or navigating elsewhere does not stop it. This is what a reopened tab reads to rejoin a run
 * that is still going, instead of showing an empty tab while scanning continues in the
 * background.
 */
export interface ActiveScannerState {
  scannerId: SecurityScannerId;
  phase: ScanPhase;
  message: string;
  startedAt: number;
  /** Tail of this scanner's own output, so the log drawer is populated on rejoin too. */
  lines: string[];
}

export interface ActiveScan {
  runId: string;
  projectId: string;
  startedAt: number;
  scannerIds: SecurityScannerId[];
  scanners: ActiveScannerState[];
  completedScanners: number;
  totalScanners: number;
}

export type DockerContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'restarting'
  | 'created'
  | 'dead';

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: DockerContainerState;
  /** Docker's own human string, e.g. "Up 2 hours" or "Exited (0) 3 days ago". */
  status: string;
  /** The `docker compose` project this container belongs to, when it was started by compose. */
  composeProject: string | null;
  /** Null while the container isn't running, or when `docker stats` couldn't be read. */
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
}

export interface DockerActionResult {
  ok: boolean;
  error?: string;
}

export interface DockerRemoveOptions {
  removeVolumes: boolean;
  removeImage: boolean;
}

/* Vault ----------------------------------------------------------------------------------- */

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

export type VaultLockReason = 'manual' | 'idle' | 'system' | 'quit' | 'reset' | 'restore';

export interface VaultStatus {
  state: VaultState;
  /** Milliseconds until another unlock attempt is accepted. */
  retryAfterMs: number;
  autoLockMinutes: number;
  clipboardClearSeconds: number;
}

export type VaultUnlockResult =
  | { ok: true }
  | { ok: false; reason: 'wrong-password' | 'throttled' | 'busy'; retryAfterMs: number };

export interface VaultStateEvent {
  state: VaultState;
  reason?: VaultLockReason;
}

export interface VaultCopyResult {
  /** When the clipboard will be cleared (epoch ms), or null when clearing is off. */
  clearsAt: number | null;
}

export interface VaultClipboardEvent {
  cleared: boolean;
}

export interface VaultImportSampleRow {
  type: VaultEntryType;
  title: string;
  username: string;
  host: string;
}

/** What the import dialog shows. Never includes passwords or notes from the file. */
export interface VaultImportPreview {
  token: string;
  fileName: string;
  format: VaultImportFormat | null;
  headers: string[];
  mapping: GenericMapping;
  rowCount: number;
  importable: number;
  duplicates: { identical: number; conflict: number };
  skipped: ImportSkip[];
  sample: VaultImportSampleRow[];
}

export interface VaultImportResult {
  added: number;
  replaced: number;
  skipped: number;
  invalid: ImportSkip[];
}

export type VaultExportResult =
  | { ok: true }
  | { ok: false; reason: 'wrong-password' | 'cancelled' };
