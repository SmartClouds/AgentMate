namespace Runova.ServerCore.Compatibility;

/// <summary>
/// Names from before the product was called Runova (release 1.63 and older) that something
/// outside this binary still uses: servers on the old layout, old desktops, containers and
/// backups made back then. Each group says how long it has to stay.
/// </summary>
/// <remarks>
/// Strings that feed encryption keys are not here; they live in <see cref="FrozenIdentifiers"/>
/// and never change.
/// </remarks>
internal static class LegacyNames
{
    // The server layout. Kept while servers on it are supported (about 12 months), since the new
    // binary runs there too until `migrate-layout` moves it.
    public const string Root = "/opt/agentmate-core";
    public const string DataDirectory = "/var/lib/agentmate-core";
    public const string ConfigDirectory = "/etc/agentmate-core";
    public const string RuntimeDirectory = "/run/agentmate-core";
    public const string Unit = "agentmate-core";
    public const string Binary = "agentmate-core";
    public const string Group = "agentmate";
    public const string NeedrestartOverridePath = "/etc/needrestart/conf.d/agentmate-core.conf";
    public const string TarballPrefix = "agentmate-core-";

    /// <summary>Transient units the old core started (a firewall revert timer can still be waiting).</summary>
    public const string TransientUnitPrefix = "agentmate-";

    // nginx and sshd files a server set up before the rename keeps where they are, for good: the
    // core keeps using whichever names it finds there.
    public const string NginxConfigRoot = "/etc/nginx/agentmate";
    public const string NginxWebRoot = "/var/www/agentmate";
    public const string NginxNamePrefix = "agentmate";
    public const string SshdDropInPath = "/etc/ssh/sshd_config.d/00-agentmate.conf";

    // Wire names an old desktop sends. Accepted for good, since the app cannot know which core
    // answers before its first request.
    public const string Host = "agentmate-core";
    public const string AuthPrefix = "agentmate-core/auth/v1";
    public const string ExecPrefix = "agentmate-core/exec/v1";
    public const string CoreVersionHeader = "X-AgentMate-Core-Version";
    public const string CoreFileHeader = "X-AgentMate-Core-File";
    public const string CoreSha256Header = "X-AgentMate-Core-Sha256";
    public const string MtimeHeader = "X-AgentMate-Mtime-Ms";

    // Files and labels made before the rename. Read for good: old backups, old stacks.
    public const string BackupFilePrefix = "agentmate-";
    public const string BackupExtension = ".ambackup";
    public const string BackupProbePrefix = ".agentmate";
    public const string LoopbackOverrideFile = "agentmate.override.yaml";
    public const string FilesHelperLabel = "agentmate.files";
    public const string FilesVolumeLabel = "agentmate.files.volume";
    public const string BackupHelperLabel = "agentmate.backup-helper";
}
