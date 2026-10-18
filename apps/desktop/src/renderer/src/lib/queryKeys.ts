export const queryKeys = {
  /** A project file open in an editor tab. */
  workspaceFile: (path: string) => ['workspace-file', path] as const,
  /** An image file open in a viewer tab. Nested under its file key, so a rename clears both. */
  workspaceImage: (path: string) => ['workspace-file', path, 'image'] as const,
  /** Prefix of every explorer listing for a project, so one invalidate refreshes the whole tree. */
  workspaceExplorer: (projectId: string) => ['workspace-explorer', projectId] as const,
  workspaceExplorerDir: (projectId: string, dir: string) =>
    ['workspace-explorer', projectId, dir] as const,
  workspaceExplorerIgnored: (projectId: string, dir: string) =>
    ['workspace-explorer', projectId, dir, 'ignored'] as const,
  /** Every file in the project, for the explorer's search box. */
  workspaceExplorerFiles: (projectId: string) =>
    ['workspace-explorer', projectId, 'files'] as const,
  /**
   * The project's declarations, for the search dialog's type and member filters. Under the
   * explorer prefix, so a change on disk that refreshes the tree checks these too.
   */
  workspaceSymbols: (projectId: string) => ['workspace-explorer', projectId, 'symbols'] as const,
  cliStatus: ['cli-status'] as const,
  projects: ['projects'] as const,
  /** Every API Client collection's outline, for the sidebar. */
  apiCollections: ['api-collections'] as const,
  /** One collection in full, nested under the list so one invalidate refreshes both. */
  apiCollection: (id: string) => ['api-collections', id] as const,
  project: (id: string) => ['projects', id] as const,
  activity: ['activity'] as const,
  repositories: ['skill-repositories'] as const,
  /** Prefix of every repositoryIndex key, for invalidating them all at once. */
  repositoryIndexes: ['skill-repository-index'] as const,
  repositoryIndex: (id: string) => ['skill-repository-index', id] as const,
  localSkillFolderPreviews: ['local-skill-folder-preview'] as const,
  localSkillFolderPreview: (path: string) => ['local-skill-folder-preview', path] as const,
  installedSkills: (projectId: string | null) => ['installed-skills', projectId] as const,
  /** Prefix of every skill-audit key, so one invalidate refreshes the history and the per-skill lists. */
  skillAudits: ['skill-audits'] as const,
  skillAuditsFor: (skillId: string) => ['skill-audits', skillId] as const,
  skillAuditsLatest: ['skill-audits-latest'] as const,
  skillFavorites: ['skill-favorites'] as const,
  skillUsage: ['skill-usage'] as const,
  usedSkillInspection: (skill: string) => ['used-skill-inspection', skill] as const,
  auditSourcePreview: (input: string) => ['audit-source-preview', input] as const,
  onDiskSkills: (projectId: string) => ['on-disk-skills', projectId] as const,
  skillUpdates: (projectId: string | null) => ['skill-updates', projectId] as const,
  mcpRepositories: ['mcp-repositories'] as const,
  mcpRepositoryIndex: (id: string) => ['mcp-repository-index', id] as const,
  installedMcpServers: (projectId: string) => ['installed-mcp-servers', projectId] as const,
  runProposalsEnabled: (projectId: string) => ['run-proposals-enabled', projectId] as const,
  codeqlStatus: ['codeql-status'] as const,
  securityActive: (projectId: string) => ['security', projectId, 'active'] as const,
  securityPreflight: (projectId: string) => ['security', projectId, 'preflight'] as const,
  securityLatest: (projectId: string) => ['security', projectId, 'latest'] as const,
  securityHistory: (projectId: string) => ['security', projectId, 'history'] as const,
  securityConfig: (projectId: string) => ['security', projectId, 'config'] as const,
  toolsStatus: ['tools-status'] as const,
  /** Agent Tools > Dev Setup: the machine (OS, package managers), then one probe per item. */
  devSetupEnvironment: ['dev-setup', 'environment'] as const,
  /** Prefix of every devSetupItem key, so one invalidate re-checks the whole checklist. */
  devSetupItems: ['dev-setup', 'item'] as const,
  devSetupItem: (id: string) => ['dev-setup', 'item', id] as const,
  /** What the nav badge reads: remembered results only, never a probe. */
  devSetupPeek: ['dev-setup', 'peek'] as const,
  templates: ['prompt-templates'] as const,
  settings: ['settings'] as const,
  petCustomImages: ['pet-custom-images'] as const,
  petSnooze: ['pet-snooze'] as const,
  usageList: ['usage-list'] as const,
  appVersion: ['app-version'] as const,
  promptHistory: ['prompt-history'] as const,
  promptHistorySearch: (query: string) => ['prompt-history', query] as const,
  // Nested under the same root so invalidating `promptHistory` refreshes it too.
  projectPromptHistory: (projectId: string) => ['prompt-history', 'project', projectId] as const,
  ipGeo: ['ip-geo'] as const,
  topResourceApps: (resource: string) => ['top-resource-apps', resource] as const,
  cliUpdateCheck: (cliId: string, version: string | null) =>
    ['cli-update-check', cliId, version] as const,
  toolUpdateCheck: (toolId: string, version: string | null) =>
    ['tool-update-check', toolId, version] as const,
  projectDrafts: (projectId: string) => ['project-drafts', projectId] as const,
  blueprint: (projectId: string) => ['blueprint', projectId] as const,
  // Nested under the blueprint root so one invalidation after a save refreshes
  // the record and its history together.
  blueprintRevisions: (projectId: string, stepId: string | null) =>
    ['blueprint', projectId, 'revisions', stepId ?? 'final-prompt'] as const,
  blueprintAgentFile: (projectId: string) => ['blueprint', projectId, 'agent-file'] as const,
  blueprintPresets: ['blueprint-presets'] as const,
  scheduledTasks: (projectId: string) => ['scheduled-tasks', projectId] as const,
  /** Prefix of every project's task list, for changes made by the scheduler in main. */
  scheduledTasksAll: ['scheduled-tasks'] as const,
  claudeHooks: (projectId: string) => ['claude-hooks', projectId] as const,
  gitStatus: (projectId: string) => ['git-status', projectId] as const,
  /** A project's git worktrees, with each one's live status. */
  worktrees: (projectId: string) => ['worktrees', projectId] as const,
  /** What the New worktree dialog starts from: branches, copy patterns, setup command. */
  worktreeDefaults: (projectId: string) => ['worktrees', projectId, 'defaults'] as const,
  /** The workspace changes panel's state, pushed live by the working tree watcher. */
  gitWorkspaceState: (projectId: string) => ['git-workspace-state', projectId] as const,
  agentHistory: (projectId: string) => ['agent-history', projectId] as const,
  agentSessionUsage: (provider: string, id: string) =>
    ['agent-session-usage', provider, id] as const,
  /** What a project's conversations used over the last `days`, or all of it for null. */
  projectUsage: (projectId: string, days: number | null) =>
    ['project-usage', projectId, days] as const,
  /** The workspace Pull request tab: the current branch and its PR, checks and review. */
  pullRequest: (projectId: string) => ['pull-request', projectId] as const,
  gitFileDiff: (projectId: string, side: string, path: string) =>
    ['git-file-diff', projectId, side, path] as const,
  /** Both sides of a changed image. Under the diff prefix, so the watcher refreshes it too. */
  gitFileImage: (projectId: string, side: string, path: string) =>
    ['git-file-diff', projectId, side, path, 'image'] as const,
  /** Prefix of every diff of a project, to refresh open diffs after the tree changed. */
  gitFileDiffs: (projectId: string) => ['git-file-diff', projectId] as const,
  gitFiles: (projectId: string) => ['git-files', projectId] as const,
  gitTags: (projectId: string) => ['git-tags', projectId] as const,
  /** Tag state for one tag series. Nested so invalidating gitTags refreshes it too. */
  gitTagsForPrefix: (projectId: string, prefix: string) =>
    ['git-tags', projectId, 'prefix', prefix] as const,
  gitBranchHistory: (projectId: string, branch: string) =>
    ['git-branch-history', projectId, branch] as const,
  /** Prefix of a project's branch histories, for invalidating every branch at once. */
  gitBranchHistories: (projectId: string) => ['git-branch-history', projectId] as const,
  /** A project's `git stash list`, newest first. */
  gitStashList: (projectId: string) => ['git-stash-list', projectId] as const,
  githubAccount: ['github-account'] as const,
  githubActivity: ['github-activity'] as const,
  githubNotifications: ['github-notifications'] as const,
  githubActionsActivity: ['github-actions-activity'] as const,
  /** Self-hosted runners behind the projects' repos, for the Pipelines page. */
  githubRunners: ['github-runners'] as const,
  /** Annotations one finished Actions run left behind. */
  runAnnotations: (repo: string, runId: number) => ['run-annotations', repo, runId] as const,
  pipelineStatus: (projectId: string) => ['pipeline-status', projectId] as const,
  /** Test frameworks and tests found in a project, for the workspace Tests panel. */
  testsDiscovery: (projectId: string) => ['tests-discovery', projectId] as const,
  /** Branches and tags of a repo, for picking what a manual workflow run should build. */
  pipelineRefs: (repo: string) => ['pipeline-refs', repo] as const,
  appNotifications: ['app-notifications'] as const,
  appNotificationUnread: ['app-notifications-unread'] as const,
  packages: (projectId: string) => ['packages', projectId] as const,
  skillsShSearch: (query: string) => ['skills-sh-search', query] as const,
  skillsShDetail: (id: string) => ['skills-sh-detail', id] as const,
  uiProPrerequisites: ['ui-ux-pro-max-prerequisites'] as const,
  uiProUpdate: ['ui-ux-pro-max-update'] as const,
  remoteSavedServers: ['remote-saved-servers'] as const,
  sshServers: ['ssh-servers'] as const,
  /** A terminal's AI task history, refetched as the running task reports progress. */
  sshAgentHistory: (sessionId: string) => ['ssh-agent-history', sessionId] as const,
  sshServerAgentHistory: (serverId: string) => ['ssh-server-agent-history', serverId] as const,
  /** A Remote Desktop session's AI task history, refetched as the running task reports progress. */
  rdpAgentHistory: (sessionId: string) => ['rdp-agent-history', sessionId] as const,
  /** The agent CLI conversations stored on a saved server. */
  sshConversations: (serverId: string) => ['ssh-conversations', serverId] as const,
  sshVaultStatus: ['ssh-vault-status'] as const,
  rdpServers: ['rdp-servers'] as const,
  projectEnvironments: (projectId: string) => ['project-environments', projectId] as const,
  /** Local LanguageTool install and server state, for Settings and the Tools card. */
  grammarLocalStatus: ['grammar-local-status'] as const,
  /** Which proxy the app is going through, and what this machine itself is set to. */
  proxyStatus: ['proxy-status'] as const,
  androidSdk: ['android-sdk'] as const,
  androidSnapshot: ['android-snapshot'] as const,
  androidSystemImages: ['android-system-images'] as const,
  androidAvailableImages: ['android-available-images'] as const,
  androidDeviceProfiles: ['android-device-profiles'] as const,
  androidAvdConfig: (name: string) => ['android-avd-config', name] as const,
  dockerAvailability: ['docker-availability'] as const,
  dockerList: ['docker-list'] as const,
  dockerListForProject: (projectId: string) => ['docker-list', 'project', projectId] as const,
  /** The Dashboard's Docker and emulator usage chart and idle list, read from the main process. */
  resourceActivity: ['resource-activity'] as const,
  /** Saved servers with the server core each one runs, for the Deploy rail. */
  deployServers: ['deploy', 'servers'] as const,
  /** A core's live health, shared by its rail entry and its health card. */
  deployHealth: (serverId: string) => ['deploy', 'health', serverId] as const,
  /** The install wizard's read-only look at a server. */
  deployPreflight: (serverId: string) => ['deploy', 'preflight', serverId] as const,
  /** Whether this computer is signed in to a server's core, or what it needs first. */
  deployAccess: (serverId: string) => ['deploy', 'access', serverId] as const,
  /** Prefix of a core's Security area: users, devices, sessions, the audit trail and the step-up. */
  deploySecurity: (serverId: string) => ['deploy', 'security', serverId] as const,
  deployUsers: (serverId: string) => ['deploy', 'security', serverId, 'users'] as const,
  deployDevices: (serverId: string) => ['deploy', 'security', serverId, 'devices'] as const,
  deploySessions: (serverId: string) => ['deploy', 'security', serverId, 'sessions'] as const,
  deployAudit: (serverId: string, filter: object) =>
    ['deploy', 'security', serverId, 'audit', filter] as const,
  /** Until when the core takes sensitive changes without asking for the password again. */
  deployStepUp: (serverId: string) => ['deploy', 'security', serverId, 'step-up'] as const,
  /** The Security center's checklist (E15). */
  deployChecklist: (serverId: string) => ['deploy', 'security', serverId, 'checklist'] as const,
  /** A server's lasting connection to its core, kept current by its change events. */
  deployConnection: (serverId: string) => ['deploy', 'connection', serverId] as const,
  /** Prefix of a server's Overview reads, fetched again when its connection comes back. */
  deployOverview: (serverId: string) => ['deploy', 'overview', serverId] as const,
  deploySystemInfo: (serverId: string) => ['deploy', 'overview', serverId, 'info'] as const,
  deployServices: (serverId: string) => ['deploy', 'overview', serverId, 'services'] as const,
  deployUpdates: (serverId: string) => ['deploy', 'overview', serverId, 'updates'] as const,
  deployActiveJobs: (serverId: string) => ['deploy', 'overview', serverId, 'jobs'] as const,
  deployMetricsHistory: (serverId: string, range: string) =>
    ['deploy', 'overview', serverId, 'metrics', range] as const,
  /** Prefix of a server's Docker reads (E06), fetched again on engine events and reconnects. */
  deployDocker: (serverId: string) => ['deploy', 'docker', serverId] as const,
  deployDockerStatus: (serverId: string) => ['deploy', 'docker', serverId, 'status'] as const,
  deployContainers: (serverId: string) => ['deploy', 'docker', serverId, 'containers'] as const,
  deployContainer: (serverId: string, containerId: string) =>
    ['deploy', 'docker', serverId, 'container', containerId] as const,
  deployImages: (serverId: string) => ['deploy', 'docker', serverId, 'images'] as const,
  deployVolumes: (serverId: string) => ['deploy', 'docker', serverId, 'volumes'] as const,
  deployNetworks: (serverId: string) => ['deploy', 'docker', serverId, 'networks'] as const,
  deployDiskUsage: (serverId: string) => ['deploy', 'docker', serverId, 'disk'] as const,
  /** Prefix of a server's Websites section: nginx, sites, stream proxies and certificates. */
  deployWeb: (serverId: string) => ['deploy', 'web', serverId] as const,
  deployNginx: (serverId: string) => ['deploy', 'web', serverId, 'nginx'] as const,
  deploySites: (serverId: string) => ['deploy', 'web', serverId, 'sites'] as const,
  deployStreams: (serverId: string) => ['deploy', 'web', serverId, 'streams'] as const,
  /** Everything the Firewall section reads (E13), dropped at once after a change. */
  deployFirewall: (serverId: string) => ['deploy', 'firewall', serverId] as const,
  deployDirectTls: (serverId: string) => ['deploy', 'directTls', serverId] as const,
  deployFirewallStatus: (serverId: string) => ['deploy', 'firewall', serverId, 'status'] as const,
  deployFirewallPresets: (serverId: string) => ['deploy', 'firewall', serverId, 'presets'] as const,
  deployFirewallHistory: (serverId: string) => ['deploy', 'firewall', serverId, 'history'] as const,
  deployFirewallExposure: (serverId: string) =>
    ['deploy', 'firewall', serverId, 'exposure'] as const,
  /** Prefix of a server's Apps (compose stacks). */
  // Logs center, problems feed and Deploy AI (E09).
  deployAssistantMode: (serverId: string) => ['deploy', 'assistant', serverId, 'mode'] as const,
  deployCertificates: (serverId: string) => ['deploy', 'web', serverId, 'certificates'] as const,
  deployAlertsList: (serverId: string) => ['deploy', 'overview', serverId, 'alerts-list'] as const,
  deployApps: (serverId: string) => ['deploy', 'apps', serverId] as const,
  deployAppsList: (serverId: string) => ['deploy', 'apps', serverId, 'list'] as const,
  deployApp: (serverId: string, stackId: string) =>
    ['deploy', 'apps', serverId, 'app', stackId] as const,
  deployAppFiles: (serverId: string, stackId: string, revision: number) =>
    ['deploy', 'apps', serverId, 'app', stackId, 'files', revision] as const,
  /** The compose files the New App wizard found in a project. */
  deployComposeFiles: (projectId: string) => ['deploy', 'compose-files', projectId] as const,
  /** The wizard's look at a compose file with an environment and its exposure choices. */
  deployAppPreview: (input: object) => ['deploy', 'app-preview', input] as const,
  /** Private registries (E08): everything below is dropped at once after a change. */
  deployRegistries: ['deploy', 'registries'] as const,
  /** The registry sign-ins kept on this computer (never their secrets). */
  deployRegistryLocal: ['deploy', 'registries', 'local'] as const,
  /** The credentials a server stores, write-only. */
  deployRegistryServer: (serverId: string) => ['deploy', 'registries', 'server', serverId] as const,
  /** Which sign-in goes with an app's deploys, per registry it pulls from. */
  deployRegistryPlan: (input: object) => ['deploy', 'registries', 'plan', input] as const,
  /**
   * WordPress sites connected through the AgentMate Connector (E19 to E21). Under `deploy`, so
   * unlocking the Servers vault refreshes them with everything else.
   */
  deployWordPressSites: ['deploy', 'wordpress', 'sites'] as const,
  /** Prefix of everything read from one site. */
  deployWordPressSite: (siteId: string) => ['deploy', 'wordpress', 'site', siteId] as const,
  deployWordPressSiteInfo: (siteId: string) =>
    ['deploy', 'wordpress', 'site', siteId, 'info'] as const,
  deployWordPressItems: (siteId: string) =>
    ['deploy', 'wordpress', 'site', siteId, 'items'] as const,
  deployWordPressHistory: (siteId: string) =>
    ['deploy', 'wordpress', 'site', siteId, 'history'] as const,
  deployWordPressAudit: (siteId: string, filter: object) =>
    ['deploy', 'wordpress', 'site', siteId, 'audit', filter] as const,
  /**
   * FTP and SFTP sites (E23). Under `deploy`, so unlocking the Servers vault refreshes them with
   * everything else.
   */
  deployFilesSites: ['deploy', 'files', 'sites'] as const,
  /** Prefix of everything read for one site. */
  deployFilesSite: (siteId: string) => ['deploy', 'files', 'site', siteId] as const,
  /** The live list of pending changes, kept fresh by `deployFiles.onChanges`. */
  deployFilesChanges: (siteId: string) => ['deploy', 'files', 'site', siteId, 'changes'] as const,
  deployFilesHistory: (siteId: string) => ['deploy', 'files', 'site', siteId, 'history'] as const,
  /** One folder of a server, while picking the remote folder. */
  deployFilesBrowse: (target: string, path: string | null) =>
    ['deploy', 'files', 'browse', target, path] as const,
  /** How far a WordPress project's folder has moved from its last sync. */
  projectWordPressChanges: (projectId: string) =>
    ['deploy', 'wordpress', 'project', projectId, 'changes'] as const,
  /** A site file for the diff view in a WordPress project. */
  projectWordPressRemoteFile: (projectId: string, itemKey: string, path: string) =>
    ['deploy', 'wordpress', 'project', projectId, 'remote-file', itemKey, path] as const,
  /** Whether a Cloudflare token is saved, and what its last check found. */
  cloudflareStatus: ['cloudflare', 'status'] as const,
  /** Prefix of everything read with the Cloudflare token, dropped when the token changes. */
  cloudflareData: ['cloudflare', 'data'] as const,
  cloudflareZones: ['cloudflare', 'data', 'zones'] as const,
  cloudflareAccountZones: (accountId: string) =>
    ['cloudflare', 'data', 'zones', accountId] as const,
  cloudflareRecords: (zoneId: string) => ['cloudflare', 'data', 'records', zoneId] as const,
  cloudflareSettings: (zoneId: string) => ['cloudflare', 'data', 'settings', zoneId] as const,
  cloudflareCustomRules: (zoneId: string) => ['cloudflare', 'data', 'customRules', zoneId] as const,
  cloudflareAccessRules: (zoneId: string) => ['cloudflare', 'data', 'accessRules', zoneId] as const,
  /** A server's Cloudflare origin lock, as its core reports it (E14). */
  cloudflareOriginLock: (serverId: string) =>
    ['deploy', 'cloudflare', serverId, 'origin-lock'] as const,
  /** The zones a server holds a DNS token for (never the tokens). */
  cloudflareDnsTokens: (serverId: string) =>
    ['deploy', 'cloudflare', serverId, 'dns-tokens'] as const,
  /** Every running shell with its process tree's CPU and memory, for the Running CLIs modal. */
  terminalUsage: ['terminal-usage'] as const,
  /** Usage and listening ports of the project runs' terminals, for the status bar. */
  terminalRunStatus: (sessionIds: readonly string[]) =>
    ['terminal-run-status', ...sessionIds] as const,
  vaultStatus: ['vault', 'status'] as const,
  /** Prefix of everything decrypted from the vault, removed as a whole when it locks. */
  vaultData: ['vault', 'data'] as const,
  vaultEntries: ['vault', 'data', 'entries'] as const,
  vaultEntry: (id: string) => ['vault', 'data', 'entry', id] as const,
  /** Prefix of everything the Health page reads (E22). */
  health: ['health'] as const,
  /** Every target with no project, one project's otherwise. The bare key is the prefix of both. */
  healthList: (projectId?: string) =>
    projectId ? (['health', 'list', projectId] as const) : (['health', 'list'] as const),
  /** One target's detail panel: last report, incidents and samples. */
  healthTarget: (id: string) => ['health', 'target', id] as const,
  /** Prefix of everything the Errors tab reads (E24). */
  errorTracking: ['error-tracking'] as const,
  errorConnections: ['error-tracking', 'connections'] as const,
  /** Every link with no project, one project's otherwise. */
  errorLinks: (projectId?: string) =>
    projectId
      ? (['error-tracking', 'links', projectId] as const)
      : (['error-tracking', 'links'] as const),
  errorRemoteProjects: (connectionId: string) =>
    ['error-tracking', 'remote-projects', connectionId] as const,
  errorEnvironments: (projectId?: string) =>
    ['error-tracking', 'environments', projectId ?? 'all'] as const,
  /** The issue list; the query object is part of the key. */
  errorIssues: (query: unknown) => ['error-tracking', 'issues', query] as const,
  errorIssue: (connectionId: string, issueId: string) =>
    ['error-tracking', 'issue', connectionId, issueId] as const,
};
