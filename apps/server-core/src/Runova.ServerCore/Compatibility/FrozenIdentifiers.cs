namespace Runova.ServerCore.Compatibility;

/// <summary>
/// Strings that are inputs to encryption keys, so they keep the product's old name for good.
/// Data Protection derives every key from the application name and the purpose, and the backup
/// format feeds its label and magic into HKDF and the header. Renaming any of them would leave
/// every core.db secret and every backup made so far unreadable. Nobody sees them: they never
/// reach a screen, a file name or the wire.
/// </summary>
internal static class FrozenIdentifiers
{
    public const string DataProtectionApplicationName = "agentmate-core"; // legacy-name

    public const string CloudflareDnsTokenPurpose = "AgentMate.Cloudflare.DnsToken.v1"; // legacy-name
    public const string BackupDestinationPurpose = "AgentMate.Backups.Destination.v1"; // legacy-name
    public const string CertificatePrivateKeyPurpose = "AgentMate.Certificates.PrivateKey.v1"; // legacy-name
    public const string AcmeAccountKeyPurpose = "AgentMate.Acme.AccountKey.v1"; // legacy-name
    public const string RegistryCredentialPurpose = "AgentMate.Registries.Credential.v1"; // legacy-name
    public const string TelegramTokenPurpose = "AgentMate.Notifications.Telegram.Token.v1"; // legacy-name
    public const string ErrorReportingDsnPurpose = "AgentMate.ErrorReporting.Dsn.v1"; // legacy-name
    public const string SecondFactorPurpose = "agentmate-core.identity.second-factor"; // legacy-name
    public const string AccessTokenPurpose = "agentmate-core.access-token.v1"; // legacy-name

    /// <summary>HKDF info for a backup's content key (format 2).</summary>
    public const string BackupContentKeyLabel = "AgentMate backup content key v2"; // legacy-name

    /// <summary>The first bytes of every backup file. An abbreviation, but just as frozen.</summary>
    public const string BackupMagic = "AMBACKUP";
}
