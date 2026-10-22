using TypedSignalR.Client;

namespace AgentMate.ServerCore.Contracts;

/// <summary>
/// Everything the app can ask the core over the WebSocket. The desktop's typed client is
/// generated from this interface, so a method exists on both sides or on neither.
/// </summary>
[Hub]
public interface ICoreHub
{
    Task<PingResponse> Ping();

    // Account: open to every role, for the signed-in user's own account.

    Task<AccountInfo> GetAccount();

    /// <summary>Ends this session; the connection closes.</summary>
    Task SignOut();

    Task<StepUpResponse> StepUp(StepUpRequest request);

    /// <summary>The caller's devices (an Admin sees everyone's).</summary>
    Task<DeviceInfo[]> ListDevices();

    /// <summary>One's own device, or anyone's for an Admin. Its sessions end with it.</summary>
    Task RevokeDevice(Guid deviceId);

    Task<SessionInfo[]> ListSessions();

    Task RevokeSession(Guid sessionId);

    /// <summary>Ends every session of the caller's but this one. Returns how many ended.</summary>
    Task<int> RevokeOtherSessions();

    /// <summary>Needs a step-up. Two-factor is not on until the first code is confirmed.</summary>
    Task<TotpSetup> BeginTotpSetup();

    Task<RecoveryCodes> ConfirmTotp(string code);

    Task DisableTotp(string code);

    Task<RecoveryCodes> NewRecoveryCodes();

    // Owner.

    /// <summary>A single-use code so another device can enroll. Needs a step-up.</summary>
    Task<EnrollmentCodeInfo> CreateEnrollmentCode(CreateEnrollmentCodeRequest request);

    // Owner: users. Each change needs a step-up, and none may leave the core without an Owner.

    Task<UserInfo[]> ListUsers();

    Task<UserInfo> CreateUser(CreateUserRequest request);

    /// <summary>Takes effect at once: the user's open connections close, so they reconnect with the new role.</summary>
    Task<UserInfo> SetUserRole(Guid userId, string role);

    /// <summary>A disabled user cannot sign in, and every session of theirs ends. Not one's own account.</summary>
    Task<UserInfo> SetUserDisabled(Guid userId, bool disabled);

    /// <summary>Not one's own password. Every session of theirs ends.</summary>
    Task ResetUserPassword(ResetUserPasswordRequest request);

    /// <summary>The user goes, with their devices, sessions and enrollment codes. Not one's own account.</summary>
    Task DeleteUser(Guid userId);

    // Admin.

    Task<AuditPage> QueryAudit(AuditQuery query);

    Task<AuditVerificationInfo> VerifyAudit();

    // The server, read by every role. None of these change anything.

    /// <summary>The Overview's facts. The core gathers them at most every 30 seconds.</summary>
    Task<SystemInfo> GetSystemInfo();

    Task<ServiceInfo[]> ListServices();

    Task<MetricsHistory> GetMetricsHistory(MetricsHistoryRequest request);

    /// <summary>
    /// Live samples, at least the requested interval apart (clamped to 1 to 60 seconds). After a
    /// reconnect, pass the time of the last sample received: the ones buffered since come first.
    /// </summary>
    IAsyncEnumerable<MetricsSample> StreamMetrics(MetricsStreamRequest request, CancellationToken cancellationToken);

    /// <summary>As of the last check. The core checks by itself every hour and after every package job.</summary>
    Task<UpdatesInfo> GetUpdates();

    Task<JobPage> ListJobs(JobQuery query);

    Task<JobInfo> GetJob(Guid jobId);

    /// <summary>
    /// The job's log after line afterSeq (0 for all of it), new lines as they come, then its final
    /// state, and the stream completes. After a reconnect, pass the last Seq received.
    /// </summary>
    IAsyncEnumerable<JobStreamItem> StreamJob(Guid jobId, long afterSeq, CancellationToken cancellationToken);

    Task<AlertInfo[]> ListAlerts(AlertQuery query);

    /// <summary>
    /// Open alerts (or every change after a revision), then changes as they happen. A stream that
    /// ends on its own fell behind: subscribe again with the highest revision received.
    /// </summary>
    IAsyncEnumerable<AlertInfo> StreamAlerts(AlertStreamRequest request, CancellationToken cancellationToken);

    // Operator. The ones that change the server start a job and return it at once; StreamJob follows it.

    /// <summary>Refreshes the package index (apt-get update or dnf makecache), then the list of updates.</summary>
    Task<JobInfo> CheckForUpdates();

    Task<JobInfo> UpgradeSecurityPackages();

    /// <summary>Needs a step-up: it can change what every service runs.</summary>
    Task<JobInfo> UpgradeAllPackages();

    /// <summary>Needs a step-up. The job succeeds, then the server reboots five seconds later.</summary>
    Task<JobInfo> RebootServer();

    /// <summary>Docker or nginx, when installed. nginx restarts only if its configuration passes nginx -t.</summary>
    Task<JobInfo> RestartService(ManagedService service);

    Task CancelJob(Guid jobId);

    Task<AlertInfo> AcknowledgeAlert(long alertId);

    // Admin.

    /// <summary>unattended-upgrades or dnf-automatic, installed when needed. A job.</summary>
    Task<JobInfo> SetAutomaticSecurityUpdates(bool enabled);

    // Firewall (E13). Reads for every role; changes for Admins. Turning the firewall on or off and
    // overriding the SSH lockout guard also need a step-up. A change rolls itself back after
    // ConfirmWithinSeconds unless ConfirmFirewallChanges arrives over a new SSH connection.

    Task<FirewallStatus> GetFirewallStatus();

    /// <summary>Rules for SSH (on the ports sshd really uses), HTTP, HTTPS and common databases.</summary>
    Task<FirewallPreset[]> GetFirewallPresets();

    Task<FirewallChangeSetInfo[]> ListFirewallChangeSets(FirewallChangeSetQuery query);

    /// <summary>Listening sockets and Docker's published ports, public or not, and what the firewall makes of each.</summary>
    Task<ExposureInventory> GetExposure();

    /// <summary>What a change set would do (the exact commands) and the lockout guard's verdict. Changes nothing.</summary>
    Task<FirewallChangePreview> PreviewFirewallChanges(FirewallChangeRequest request);

    /// <summary>
    /// Saves the current rules, arms the rollback timer, then applies, and returns the change set
    /// waiting for confirmation. Needs a step-up to turn the firewall on or off or to override the guard.
    /// </summary>
    Task<FirewallChangeSetInfo> ApplyFirewallChanges(FirewallChangeRequest request);

    /// <summary>Keeps the change. Refused over the SSH connection that applied it: confirm through a new one.</summary>
    Task<FirewallChangeSetInfo> ConfirmFirewallChanges(Guid changeSetId);

    /// <summary>Puts the saved rules back now.</summary>
    Task<FirewallChangeSetInfo> RevertFirewallChanges(Guid changeSetId);

    // Docker. Every role reads; Operators run the containers' lifecycle and pull images; Admins
    // open consoles, remove with volumes, prune and install the engine.

    Task<DockerStatus> GetDockerStatus();

    Task<ContainerList> ListContainers();

    /// <summary>Environment variable names only; RevealContainerEnv has the values.</summary>
    Task<ContainerDetails> InspectContainer(string containerId);

    /// <summary>
    /// Live figures, as `docker stats` computes them, in batches at the requested interval. A
    /// stream that ends on its own lost the engine: open it again.
    /// </summary>
    IAsyncEnumerable<ContainerStatsBatch> StreamContainerStats(ContainerStatsRequest request, CancellationToken cancellationToken);

    /// <summary>Redacted log lines. After a reconnect, pass the last line's Timestamp as AfterTimestamp.</summary>
    IAsyncEnumerable<ContainerLogBatch> StreamContainerLogs(ContainerLogsRequest request, CancellationToken cancellationToken);

    Task<ImageInfo[]> ListImages();

    Task<VolumeInfo[]> ListVolumes();

    Task<NetworkInfo[]> ListNetworks();

    Task<DockerDiskUsage> GetDockerDiskUsage();

    /// <summary>Engine events as they happen. After a reconnect, pass the last event's Cursor.</summary>
    IAsyncEnumerable<DockerEvent> StreamDockerEvents(DockerEventsRequest request, CancellationToken cancellationToken);

    // Docker, Operator.

    Task<ContainerSummary> StartContainer(string containerId);

    /// <summary>The container's own stop timeout unless one is given (0 to 600 seconds).</summary>
    Task<ContainerSummary> StopContainer(string containerId, int? timeoutSeconds);

    Task<ContainerSummary> RestartContainer(string containerId, int? timeoutSeconds);

    Task<ContainerSummary> PauseContainer(string containerId);

    Task<ContainerSummary> UnpauseContainer(string containerId);

    /// <summary>SIGKILL unless another well-known signal is named.</summary>
    Task<ContainerSummary> KillContainer(string containerId, string? signal);

    /// <summary>With RemoveVolumes (its anonymous volumes go too) only for Admins.</summary>
    Task RemoveContainer(ContainerRemoveRequest request);

    /// <summary>A job: StreamJob shows the layers as they arrive.</summary>
    Task<JobInfo> PullImage(ImagePullRequest request);

    Task RemoveImage(ImageRemoveRequest request);

    Task RemoveNetwork(string network);

    // Docker, Admin.

    /// <summary>Needs a step-up: these are the container's secrets.</summary>
    Task<ContainerEnvVariable[]> RevealContainerEnv(string containerId);

    /// <summary>
    /// A terminal in the container (docker exec with a TTY): keystrokes and size changes go in,
    /// the screen comes out. Opening and closing it land in the audit trail; what is typed does not.
    /// </summary>
    IAsyncEnumerable<ConsoleOutput> ContainerConsole(ConsoleRequest request, IAsyncEnumerable<ConsoleInput> input, CancellationToken cancellationToken);

    Task RemoveVolume(string volume, bool force);

    Task<DockerPruneResult> PruneDocker(DockerPruneRequest request);

    /// <summary>
    /// Docker Engine and Compose from download.docker.com, the repository key checked against its
    /// pinned fingerprint. A job. Refused while conflicting packages remain unless the request
    /// says to remove them.
    /// </summary>
    Task<JobInfo> InstallDocker(DockerInstallRequest request);

    // Files in a container or a volume (E27), Admin. Every change and download lands in the audit
    // trail. Downloads and uploads go over REST: /api/v1/files/{SessionId}/content?path=.

    /// <summary>A volume starts its helper container first, pulling the helper image if it is missing.</summary>
    Task<FileSessionInfo> FilesOpen(FileTarget target);

    Task FilesClose(Guid sessionId);

    Task<FileListing> FilesList(FilePathRequest request);

    /// <summary>The entry itself (a link is not followed), or null when nothing is there.</summary>
    Task<FileEntry?> FilesStat(FilePathRequest request);

    /// <summary>The absolute path with links resolved where the session has a shell, normalized otherwise.</summary>
    Task<string> FilesRealpath(FilePathRequest request);

    Task FilesMkdir(FilePathRequest request);

    /// <summary>Refused when something is already at To.</summary>
    Task FilesRename(FileRenameRequest request);

    Task FilesRemove(FileRemoveRequest request);

    Task FilesChmod(FileChmodRequest request);

    // Websites and certificates (E10, E11). Reads are open to every role.

    Task<NginxStatus> GetNginxStatus();

    Task<SiteInfo[]> ListSites();

    Task<StreamProxyInfo[]> ListStreamProxies();

    Task<CertificateInfo[]> ListCertificates();

    /// <summary>A site's access or error log: the last lines, then new ones while Follow is on.</summary>
    IAsyncEnumerable<SiteLogBatch> StreamSiteLog(SiteLogRequest request, CancellationToken cancellationToken);

    // Admin. Saving changes the database only; ApplyNginx puts every saved change live at once.

    /// <summary>Installs nginx from nginx.org (or adopts the one there) and sets it up for AgentMate. A job.</summary>
    Task<JobInfo> InstallNginx();

    /// <summary>Creates or updates a site. Nothing is saved when Problems is not empty.</summary>
    Task<SiteSaveResult> SaveSite(SiteSettings settings);

    Task DeleteSite(string siteId);

    Task<StreamProxySaveResult> SaveStreamProxy(StreamProxySettings settings);

    Task DeleteStreamProxy(string proxyId);

    /// <summary>
    /// Renders every saved site and proxy into a new release, checks it with nginx -t, reloads and
    /// confirms nginx runs it; otherwise nginx keeps what it ran and Problems say why.
    /// </summary>
    Task<NginxApplyResult> ApplyNginx();

    /// <summary>Applies the site if needed, then issues over ACME (HTTP-01) and switches the site to HTTPS. A job.</summary>
    Task<JobInfo> IssueCertificate(CertificateIssueRequest request);

    /// <summary>Renews now instead of waiting for the renewal service. A job.</summary>
    Task<JobInfo> RenewCertificate(string siteId);

    /// <summary>Checks and stores a certificate with its key, then applies.</summary>
    Task<CertificateUploadResult> UploadCertificate(CertificateUploadRequest request);

    /// <summary>Needs a step-up. Takes the certificate off the site (revoking it when asked), then applies.</summary>
    Task<NginxApplyResult> RemoveCertificate(CertificateRemoveRequest request);

    // Compose stacks (E07), the Apps of a server. Every role reads; Operators create, deploy, roll
    // back and run the lifecycle; only Admins delete a stack with its volumes. Files are uploaded
    // over REST first (see StackRevisionUpload). Changes start a job; StreamJob follows it.

    Task<StackInfo[]> ListStacks();

    /// <summary>The stack, its revisions newest first, and its services with their containers.</summary>
    Task<StackDetails> GetStack(Guid stackId);

    /// <summary>The compose file as uploaded and the loopback override. Env values never leave the core.</summary>
    Task<StackRevisionFiles> GetStackRevisionFiles(StackRevisionRef revision);

    Task<StackInfo> CreateStack(CreateStackRequest request);

    /// <summary>Records each acknowledgment in the audit trail, one entry per finding id.</summary>
    Task<StackRevisionInfo> AcknowledgeStackRisks(AcknowledgeStackRisksRequest request);

    /// <summary>Validate, pull, build, up --wait, health. Refused while a finding is unacknowledged.</summary>
    Task<JobInfo> DeployStack(StackRevisionRef revision);

    /// <summary>Copies an earlier revision into a new one and deploys it.</summary>
    Task<JobInfo> RollbackStack(StackRevisionRef revision);

    Task<JobInfo> RunStackAction(StackActionRequest request);

    /// <summary>A new revision copied from another on the server, with other proxied services or a new compose file.</summary>
    Task<StackRevisionInfo> ReviseStack(ReviseStackRequest request);

    /// <summary>A revision's .env with its values. Admin, after a step-up; only the count is audited.</summary>
    Task<StackEnvEntry[]> RevealStackEnv(StackRevisionRef revision);

    /// <summary>docker compose down, then the stack's files and records go. Its volumes stay.</summary>
    Task<JobInfo> DeleteStack(Guid stackId);

    /// <summary>As DeleteStack, with docker compose down --volumes: the app's data goes too. Admin.</summary>
    Task<JobInfo> DeleteStackWithVolumes(Guid stackId);

    // Private registries (E08). The sign-ins a deploy carries live in a tmpfs DOCKER_CONFIG for
    // that job only. Stored credentials are write-only; saving or removing one is for Admins with
    // a recent step-up.

    /// <summary>As DeployStack, signing in to the registries the request names (stored credentials fill the rest).</summary>
    Task<JobInfo> DeployStackWithRegistries(StackDeployRequest request);

    /// <summary>As RollbackStack, with the request's registry sign-ins.</summary>
    Task<JobInfo> RollbackStackWithRegistries(StackDeployRequest request);

    /// <summary>The credentials stored on this server, without their secrets. Operator.</summary>
    Task<RegistryCredentialInfo[]> ListRegistryCredentials();

    /// <summary>Stores or replaces the credential for a registry. Admin and a step-up.</summary>
    Task<RegistryCredentialInfo> SaveRegistryCredential(SaveRegistryCredentialRequest request);

    /// <summary>Admin and a step-up.</summary>
    Task DeleteRegistryCredential(Guid credentialId);
    // Logs center and Deploy AI (E09), Admin. See AssistantContracts.cs for what runs unattended.

    Task<AssistantModeInfo> GetAssistantMode();

    /// <summary>Needs a step-up. Lasts for this session, or until the core restarts.</summary>
    Task<AssistantModeInfo> EnableAutoRunDiagnostics();

    Task<AssistantModeInfo> DisableAutoRunDiagnostics();

    /// <summary>A single-use nonce, good for two minutes, to sign one command's approval with.</summary>
    Task<ExecApprovalNonce> NewExecApproval();

    /// <summary>
    /// Runs a command and streams its redacted output, then its exit code. Refused unless it is on
    /// the read-only allowlist (and, from the assistant, the session auto-runs diagnostics) or it
    /// carries a valid approval. Ending the stream stops the command and everything it started.
    /// </summary>
    IAsyncEnumerable<ExecOutput> StreamExec(ExecRequest request, CancellationToken cancellationToken);

    /// <summary>A systemd unit's journal, redacted: the last lines, then new ones while Follow is on.</summary>
    IAsyncEnumerable<JournalBatch> StreamJournal(JournalRequest request, CancellationToken cancellationToken);

    // Owner.

    /// <summary>A site's custom snippets, checked against the directive allowlist.</summary>
    Task<SiteSaveResult> SetSiteSnippets(SiteSnippets snippets);

    // Cloudflare (E14). Every role reads the origin lock and which zones have a DNS token; Admins
    // change them and handle Origin CA certificates. The account token never reaches the core.

    /// <summary>The origin lock and how the firewall compares with Cloudflare's ranges.</summary>
    Task<OriginLockStatus> GetOriginLock();

    /// <summary>What turning the lock on or off would change, with the firewall's own preview. Changes nothing.</summary>
    Task<OriginLockPreview> PreviewOriginLock(OriginLockRequest request);

    /// <summary>
    /// Turns the lock on or off: the firewall change waits for its confirmation like any other
    /// (ConfirmFirewallChanges), and nginx takes the real visitor address and the client check at once.
    /// </summary>
    Task<OriginLockResult> ApplyOriginLock(OriginLockRequest request);

    /// <summary>Fetches Cloudflare's ranges now (the core also does daily) and brings a lock that is on up to date.</summary>
    Task<OriginLockStatus> RefreshCloudflareRanges();

    /// <summary>Makes a key on this server for a site and returns the signing request for Cloudflare's Origin CA.</summary>
    Task<OriginCertificateRequestInfo> CreateOriginCertificateRequest(string siteId);

    /// <summary>Checks the signed certificate against the key made for it, stores it and applies.</summary>
    Task<CertificateUploadResult> InstallOriginCertificate(OriginCertificateInstall request);

    /// <summary>The zones this server holds a DNS token for. The tokens never come back.</summary>
    Task<DnsCredentialInfo[]> ListDnsCredentials();

    /// <summary>Checks the token with Cloudflare and stores it sealed, replacing the zone's earlier one.</summary>
    Task<DnsCredentialSaveResult> SaveDnsCredential(DnsCredentialRequest request);

    Task RemoveDnsCredential(string zone);

    // Security center (E15). Admins read the checklist; Owners make its SSH changes, which need a
    // step-up and only run over an SSH connection that signed in with a key. A change rolls itself
    // back after ConfirmWithinSeconds unless ConfirmSshHardening arrives over another new
    // connection that signed in with a key too.

    /// <summary>How safe the server is, item by item, with a score. Changes nothing.</summary>
    Task<SecurityChecklist> GetSecurityChecklist(SecurityChecklistRequest request);

    /// <summary>The exact drop-in and commands, and whether this connection is proven to use a key. Changes nothing.</summary>
    Task<SshHardeningPreview> PreviewSshHardening(SshHardeningRequest request);

    /// <summary>Saves the old drop-in, arms the rollback timer, writes and checks the new one, then reloads sshd.</summary>
    Task<SshHardeningChangeInfo> ApplySshHardening(SshHardeningRequest request);

    /// <summary>Keeps the change. Refused over the connection that applied it, or one that did not sign in with a key.</summary>
    Task<SshHardeningChangeInfo> ConfirmSshHardening(Guid changeId);

    /// <summary>Puts the old drop-in back now and reloads sshd.</summary>
    Task<SshHardeningChangeInfo> RevertSshHardening(Guid changeId);

    // Backups (E15), Owners only. Making one needs a step-up: it holds every secret the core keeps.

    /// <summary>
    /// Encrypts the core's state with the passphrase into a file that waits an hour to be downloaded
    /// (GET /api/v1/backups/{id}). The passphrase is not kept.
    /// </summary>
    Task<BackupInfo> CreateBackup(BackupRequest request);

    /// <summary>Deletes a backup from the server, once the app has it. True when there was one.</summary>
    Task<bool> DeleteBackup(Guid backupId);

    // Server backups (E28), Owners only. Setting the secret, saving or removing a destination,
    // backing up now and deleting a stored backup need a step-up.

    Task<BackupSecretStatus> GetBackupSecret();

    /// <summary>Sets the secret key, or changes it with the current one. Neither is kept.</summary>
    Task<BackupSecretStatus> SetBackupSecret(SetBackupSecretRequest request);

    Task<BackupDestinationInfo[]> ListBackupDestinations();

    /// <summary>Adds or changes a destination. Its credentials are sealed and never read back.</summary>
    Task<BackupDestinationInfo> SaveBackupDestination(SaveBackupDestinationRequest request);

    /// <summary>Removes a destination and takes it out of every plan. What it holds stays there.</summary>
    Task<bool> DeleteBackupDestination(Guid destinationId);

    /// <summary>Writes, reads back and deletes a small file, with the request's settings (the stored secret when it has none).</summary>
    Task<BackupDestinationTest> TestBackupDestination(SaveBackupDestinationRequest request);

    Task<BackupPlanInfo[]> ListBackupPlans();

    /// <summary>Adds or changes a plan and puts it on the schedule.</summary>
    Task<BackupPlanInfo> SaveBackupPlan(SaveBackupPlanRequest request);

    Task<bool> DeleteBackupPlan(Guid planId);

    /// <summary>What a plan would do: next runs, how many backups stay, about how much room. Changes nothing.</summary>
    Task<BackupPlanPreview> PreviewBackupPlan(BackupPlanPreviewRequest request);

    /// <summary>Runs a plan now, off its schedule. The run shows in the history.</summary>
    Task<BackupRunInfo> RunBackupPlan(Guid planId);

    /// <summary>Backs up now to the destinations named, and keeps the file an hour for download when asked.</summary>
    Task<BackupRunInfo> RunBackupNow(RunBackupNowRequest request);

    /// <summary>The newest runs first, with each destination's outcome.</summary>
    Task<BackupRunInfo[]> ListBackupRuns(int limit);

    /// <summary>One run as it stands, for following it; null when there is none.</summary>
    Task<BackupRunInfo?> GetBackupRun(Guid runId);

    /// <summary>What a destination holds, newest first, as its manifests say.</summary>
    Task<StoredBackupInfo[]> ListStoredBackups(Guid destinationId);

    /// <summary>Deletes one backup and its parts from a destination.</summary>
    Task<bool> DeleteStoredBackup(Guid destinationId, Guid backupId);

    /// <summary>Starts signing in to a Telegram account; Telegram sends a code.</summary>
    Task<TelegramLoginState> StartTelegramLogin(StartTelegramLoginRequest request);

    /// <summary>Sends the code, then the cloud password when the account has one.</summary>
    Task<TelegramLoginState> ContinueTelegramLogin(ContinueTelegramLoginRequest request);

    /// <summary>Fetches a backup from a destination onto this server for a restore. Owner, with a step-up.</summary>
    Task<BackupFetchInfo> FetchStoredBackup(Guid destinationId, Guid backupId);

    Task<BackupFetchInfo?> GetBackupFetch(Guid fetchId);

    /// <summary>What a restored state still has to bring up on this server, or null when nothing waits.</summary>
    Task<PendingServerRestore?> GetPendingServerRestore();

    /// <summary>Puts back volumes and images, starts what ran, and moves the address when asked. Owner, with a step-up.</summary>
    Task<ServerRestoreStatus> RunServerRestore(RunServerRestoreRequest request);

    Task<ServerRestoreStatus?> GetServerRestoreStatus();
    // E28 end

    // Direct TLS (E16): every role reads it; Owners change it, turning it on needs a step-up.

    /// <summary>The listener's setting and state, and the pin of the certificate it presents.</summary>
    Task<DirectTlsStatus> GetDirectTls();

    /// <summary>Opens (or moves) the port. Owner, with a step-up. The firewall rule is a change set of its own.</summary>
    Task<DirectTlsStatus> EnableDirectTls(DirectTlsRequest request);

    /// <summary>Closes the port. Owner.</summary>
    Task<DirectTlsStatus> DisableDirectTls();

    // Error reporting (E29): the core's warnings and errors, sent to a Sentry project as OpenTelemetry logs.

    /// <summary>Where logs go, how sending is going, and the options. Never the key. Admin.</summary>
    Task<ErrorReportingStatus> GetErrorReporting();

    /// <summary>Sets it up or changes it, effective at once. Owner, with a step-up.</summary>
    Task<ErrorReportingSaveResult> SaveErrorReporting(ErrorReportingRequest request);

    /// <summary>Forgets the DSN and stops sending. Owner, with a step-up.</summary>
    Task<ErrorReportingStatus> RemoveErrorReporting();

    /// <summary>Sends one test event to the project and says whether Sentry took it. Admin.</summary>
    Task<ErrorReportingTestResult> SendErrorReportingTest();

    // Telegram notifications (E30): the core's alerts, sent to a Telegram chat through a bot.

    /// <summary>Which chat alerts go to, which kinds, and how sending is going. Never the token. Admin.</summary>
    Task<TelegramNotificationsStatus> GetTelegramNotifications();

    /// <summary>Sets it up or changes it, effective at once. Owner, with a step-up.</summary>
    Task<TelegramNotificationsSaveResult> SaveTelegramNotifications(TelegramNotificationsRequest request);

    /// <summary>Forgets the token and stops sending. Owner, with a step-up.</summary>
    Task<TelegramNotificationsStatus> RemoveTelegramNotifications();

    /// <summary>Sends one test message to the chat and says whether Telegram took it. Admin.</summary>
    Task<TelegramNotificationsTestResult> SendTelegramNotificationTest();
}

/// <summary>Everything the core can push to the app without being asked.</summary>
[Receiver]
public interface ICoreHubReceiver;
