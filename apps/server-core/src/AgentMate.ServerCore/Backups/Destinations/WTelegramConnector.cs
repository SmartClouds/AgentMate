using System.Globalization;
using TL;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>
/// Telegram through WTelegramClient (MTProto) as the person's own account (E28), with their own app
/// id and hash. The session lives in memory and is sealed by the core; after each use a changed
/// session is handed back to be sealed again. WTelegram's own log goes to the core's at warning
/// and above.
/// </summary>
internal sealed partial class WTelegramConnector : ITelegramConnector
{
    /// <summary>How far back a chat is read for backups, in messages.</summary>
    public const int MaxScannedMessages = 20_000;

    public WTelegramConnector(ILogger<WTelegramConnector> logger)
    {
        WTelegram.Helpers.Log = (level, message) =>
        {
            if (level >= 3)
            {
                LogTelegram(logger, message);
            }
        };
    }

    public ITelegramLoginClient StartLogin(int apiId, string apiHash) => new Login(apiId, apiHash);

    public async Task<ITelegramAccount> OpenAsync(int apiId, string apiHash, byte[] session, string chat, Func<byte[], Task> sessionChanged, CancellationToken cancellationToken)
    {
        var store = new MemoryStream();
        await store.WriteAsync(session, cancellationToken);
        store.Position = 0;
        var client = new WTelegram.Client(Config(apiId, apiHash), store);
        try
        {
            await client.LoginUserIfNeeded();
            InputPeer peer = chat is "me" or ""
                ? InputPeer.Self
                : (await client.Contacts_ResolveUsername(chat.TrimStart('@'))).UserOrChat.ToInputPeer();
            return new Account(client, peer, store, session, sessionChanged);
        }
        catch (RpcException refused)
        {
            client.Dispose();
            throw new BackupDestinationException(refused.Message.Contains("AUTH_KEY", StringComparison.Ordinal)
                ? "The Telegram sign-in ended. Edit the destination and sign in again."
                : $"Telegram refused: {refused.Message}", refused);
        }
    }

    private static Func<string, string?> Config(int apiId, string apiHash) => what => what switch
    {
        "api_id" => apiId.ToString(CultureInfo.InvariantCulture),
        "api_hash" => apiHash,
        "device_model" => "AgentMate server core",
        "app_version" => CoreVersion.Current,
        _ => null,
    };

    [LoggerMessage(Level = LogLevel.Warning, Message = "Telegram: {Message}")]
    private static partial void LogTelegram(ILogger logger, string message);

    private sealed class Login : ITelegramLoginClient
    {
        private readonly MemoryStream _store = new();
        private readonly WTelegram.Client _client;

        public Login(int apiId, string apiHash) => _client = new WTelegram.Client(Config(apiId, apiHash), _store);

        public (string Name, bool Premium) Account => _client.User is { } user
            ? ($"{user.first_name} {user.last_name}".Trim(), user.flags.HasFlag(User.Flags.premium))
            : (string.Empty, false);

        public byte[] Session => _store.ToArray();

        public async Task<string?> LoginAsync(string value)
        {
            try
            {
                return await _client.Login(value);
            }
            catch (RpcException refused)
            {
                throw new TelegramRefusedException(refused.Message, refused);
            }
        }

        public ValueTask DisposeAsync()
        {
            _client.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Account(WTelegram.Client client, InputPeer peer, MemoryStream store, byte[] opened, Func<byte[], Task> sessionChanged) : ITelegramAccount
    {
        public async Task<IReadOnlyList<TelegramDocument>> ListAsync(CancellationToken cancellationToken)
        {
            var documents = new List<TelegramDocument>();
            var offset = 0;
            for (var scanned = 0; scanned < MaxScannedMessages;)
            {
                var page = await Call(() => client.Messages_GetHistory(peer, offset_id: offset, limit: 100));
                if (page.Messages.Length == 0)
                {
                    break;
                }

                foreach (var message in page.Messages)
                {
                    if (message is Message { media: MessageMediaDocument { document: Document document } } && FileName(document) is { } name)
                    {
                        documents.Add(new TelegramDocument(message.ID, name, document.size));
                    }
                }

                scanned += page.Messages.Length;
                offset = page.Messages[^1].ID;
            }

            return documents;
        }

        public async Task SendAsync(string fileName, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
        {
            long reported = 0;
            var file = await Call(() => client.UploadFileAsync(content, fileName, (sent, _) =>
            {
                progress?.Report(sent - reported);
                reported = sent;
            }));
            await Call(() => client.SendMediaAsync(peer, string.Empty, file, "application/octet-stream"));
        }

        public async Task<Stream> DownloadAsync(TelegramDocument document, CancellationToken cancellationToken)
        {
            var page = await Call(() => client.Messages_GetHistory(peer, offset_id: document.MessageId + 1, limit: 1));
            if (page.Messages.FirstOrDefault(m => m.ID == document.MessageId) is not Message { media: MessageMediaDocument { document: Document found } })
            {
                throw new BackupDestinationException($"{document.FileName} is no longer in the Telegram chat.");
            }

            var file = RemotePaths.TemporaryFile();
            try
            {
                await Call(() => client.DownloadFileAsync(found, file));
                file.Position = 0;
                return file;
            }
            catch
            {
                await file.DisposeAsync();
                throw;
            }
        }

        public Task DeleteAsync(IReadOnlyList<int> messageIds, CancellationToken cancellationToken) =>
            Call(() => client.DeleteMessages(peer, [.. messageIds]));

        public async ValueTask DisposeAsync()
        {
            var now = store.ToArray();
            client.Dispose();
            if (!now.AsSpan().SequenceEqual(opened))
            {
                await sessionChanged(now);
            }
        }

        private static string? FileName(Document document) =>
            document.attributes?.OfType<DocumentAttributeFilename>().FirstOrDefault()?.file_name;

        private static async Task<T> Call<T>(Func<Task<T>> call)
        {
            try
            {
                return await call();
            }
            catch (RpcException refused)
            {
                throw new BackupDestinationException($"Telegram refused: {refused.Message}", refused);
            }
            catch (Exception error) when (error is IOException or System.Net.Sockets.SocketException)
            {
                throw new BackupDestinationException($"Telegram cannot be reached: {error.Message}", error);
            }
        }
    }
}
