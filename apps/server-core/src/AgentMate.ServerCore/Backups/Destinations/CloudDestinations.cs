using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>Google Drive and OneDrive destinations, over one HttpClient for the core.</summary>
internal sealed class CloudDestinations(IHttpClientFactory clients, BackupCenter center) : IExtraBackupDestinations
{
    public const string HttpClientName = "backup-destinations";

    public Task<IBackupDestination?> TryOpenAsync(ResolvedDestination destination, CancellationToken cancellationToken) => Task.FromResult<IBackupDestination?>(TryOpen(destination));

    private CloudDriveDestination? TryOpen(ResolvedDestination destination)
    {
        ArgumentNullException.ThrowIfNull(destination);
        var settings = destination.Settings;
        var secret = destination.Secret;
        var folder = settings.FolderName ?? BackupDestinationRules.DefaultFolderName;
        return destination.Kind switch
        {
            BackupDestinationKind.GoogleDrive => new CloudDriveDestination(
                new GoogleDriveFiles(clients.CreateClient(HttpClientName), Required(settings.ClientId), secret.ClientSecret, Required(secret.RefreshToken), folder),
                "Google Drive"),
            BackupDestinationKind.OneDrive => new CloudDriveDestination(
                new OneDriveFiles(
                    clients.CreateClient(HttpClientName),
                    Required(settings.ClientId),
                    Required(secret.RefreshToken),
                    folder,
                    rotated => destination.Id == Guid.Empty ? Task.CompletedTask : center.UpdateRefreshTokenAsync(destination.Id, rotated, CancellationToken.None)),
                "OneDrive"),
            _ => null,
        };
    }

    private static string Required(string? value) =>
        string.IsNullOrEmpty(value) ? throw new BackupDestinationException("The destination is missing its sign-in. Edit it and sign in again.") : value;
}

/// <summary>Telegram destinations: the sealed session opened as the account it signed in.</summary>
internal sealed class TelegramDestinations(ITelegramConnector connector, BackupCenter center) : IExtraBackupDestinations
{
    public async Task<IBackupDestination?> TryOpenAsync(ResolvedDestination destination, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(destination);
        if (destination.Kind != BackupDestinationKind.Telegram)
        {
            return null;
        }

        if (destination.TelegramSession is null || destination.Settings.ApiId is not { } apiId || destination.Secret.ApiHash is not { } apiHash)
        {
            throw new BackupDestinationException("The Telegram destination has no sign-in. Edit it and sign in again.");
        }

        var account = await connector.OpenAsync(
            apiId,
            apiHash,
            Convert.FromBase64String(destination.TelegramSession),
            destination.Settings.Chat ?? "me",
            session => destination.Id == Guid.Empty ? Task.CompletedTask : center.UpdateTelegramSessionAsync(destination.Id, Convert.ToBase64String(session), CancellationToken.None),
            cancellationToken);
        return new CloudDriveDestination(new TelegramFiles(account), "Telegram");
    }
}
