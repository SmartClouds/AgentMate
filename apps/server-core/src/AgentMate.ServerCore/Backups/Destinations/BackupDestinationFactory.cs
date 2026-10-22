using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>The real destinations, by kind.</summary>
internal sealed class BackupDestinationFactory(IServiceProvider services) : IBackupDestinationFactory
{
    public async Task<IBackupDestination> OpenAsync(ResolvedDestination destination, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(destination);
        switch (destination.Kind)
        {
            case BackupDestinationKind.Folder:
                return new FolderDestination(destination.Settings.Path ?? throw new BackupDestinationException("The folder destination has no path."));
            case BackupDestinationKind.Ftp:
                return new FtpDestination(destination.Settings, destination.Secret);
            case BackupDestinationKind.Sftp:
                return new SftpDestination(destination.Settings, destination.Secret);
        }

        foreach (var extra in services.GetServices<IExtraBackupDestinations>())
        {
            if (await extra.TryOpenAsync(destination, cancellationToken) is { } opened)
            {
                return opened;
            }
        }

        throw new BackupDestinationException($"{destination.Kind} destinations are not available on this core.");
    }
}

/// <summary>Destinations that need more than their settings (an HTTP client, a Telegram session), registered apart.</summary>
internal interface IExtraBackupDestinations
{
    Task<IBackupDestination?> TryOpenAsync(ResolvedDestination destination, CancellationToken cancellationToken);
}

/// <summary>Tests a destination as the person described it, before or after it is saved.</summary>
internal sealed class BackupDestinationTester(BackupCenter center, IBackupDestinationFactory factory, TelegramLogins telegram)
{
    public async Task<BackupDestinationTest> TestAsync(SaveBackupDestinationRequest? request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var draft = await center.ResolveDraftAsync(request, cancellationToken);
        if (request.Kind == BackupDestinationKind.Telegram && request.Secret?.TelegramLoginId is { } loginId)
        {
            var signedIn = telegram.PeekSession(loginId) ?? throw new BackupRefusedException("The Telegram sign-in expired. Sign in again.");
            draft = draft with { TelegramSession = Convert.ToBase64String(signedIn.Session) };
        }

        var hostKeyMissing = request.Kind == BackupDestinationKind.Sftp && !BackupNaming.IsSha256(draft.Settings.HostKeySha256);
        var problem = BackupDestinationRules.Problem(
            request.Name,
            request.Kind,
            hostKeyMissing ? draft.Settings with { HostKeySha256 = new string('0', 64) } : draft.Settings,
            draft.Secret,
            hasStoredSecret: true,
            request.MaxPartBytes);
        if (problem is not null)
        {
            return new BackupDestinationTest(false, problem, null);
        }

        if (hostKeyMissing)
        {
            var seen = await SftpDestination.ProbeHostKeyAsync(draft.Settings.Host!, draft.Settings.Port ?? 22, cancellationToken);
            return seen is null
                ? new BackupDestinationTest(false, "The SFTP server cannot be reached.", null)
                : new BackupDestinationTest(false, "Check the server's host key and confirm it, then test again.", seen);
        }

        string? outcome;
        string? fingerprint;
        await using (var destination = await factory.OpenAsync(draft, cancellationToken))
        {
            outcome = await destination.TestAsync(cancellationToken);
            fingerprint = destination switch
            {
                FtpDestination ftp => ftp.SeenFingerprint,
                SftpDestination sftp => sftp.SeenFingerprint,
                _ => null,
            };
        }

        if (draft.Id != Guid.Empty)
        {
            await center.RecordDestinationOutcomeAsync(draft.Id, outcome, cancellationToken);
        }

        return new BackupDestinationTest(outcome is null, outcome, fingerprint);
    }
}
