using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>A document posted in the chat backups go to.</summary>
internal sealed record TelegramDocument(int MessageId, string FileName, long Size);

/// <summary>Telegram said no; the code (PHONE_CODE_INVALID, FLOOD_WAIT_30, ...) is in the message.</summary>
internal sealed class TelegramRefusedException(string code, Exception? inner = null) : Exception(code, inner);

/// <summary>A signed-in account and the one chat backups go to.</summary>
internal interface ITelegramAccount : IAsyncDisposable
{
    /// <summary>The chat's documents, newest first.</summary>
    Task<IReadOnlyList<TelegramDocument>> ListAsync(CancellationToken cancellationToken);

    Task SendAsync(string fileName, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken);

    Task<Stream> DownloadAsync(TelegramDocument document, CancellationToken cancellationToken);

    Task DeleteAsync(IReadOnlyList<int> messageIds, CancellationToken cancellationToken);
}

/// <summary>A sign-in in progress: each answer returns what Telegram wants next ("verification_code", "password"), or null once in.</summary>
internal interface ITelegramLoginClient : IAsyncDisposable
{
    Task<string?> LoginAsync(string value);

    (string Name, bool Premium) Account { get; }

    byte[] Session { get; }
}

/// <summary>Where Telegram clients come from: WTelegramClient in the core, fakes in the tests.</summary>
internal interface ITelegramConnector
{
    ITelegramLoginClient StartLogin(int apiId, string apiHash);

    Task<ITelegramAccount> OpenAsync(int apiId, string apiHash, byte[] session, string chat, Func<byte[], Task> sessionChanged, CancellationToken cancellationToken);
}

/// <summary>
/// A Telegram chat as a backup folder (E28): each file is a document message. Only documents named
/// like AgentMate's are files here, so the rest of the chat is never touched. A name sent again
/// replaces the older messages of that name.
/// </summary>
internal sealed class TelegramFiles(ITelegramAccount account) : ICloudFiles
{
    public async Task<IReadOnlyList<CloudFile>> ListAsync(CancellationToken cancellationToken) =>
        [.. (await account.ListAsync(cancellationToken))
            .Where(document => document.FileName.StartsWith(BackupNaming.Prefix, StringComparison.Ordinal) || document.FileName.StartsWith(".agentmate", StringComparison.Ordinal))
            .Select(document => new CloudFile(document.MessageId.ToString(System.Globalization.CultureInfo.InvariantCulture), document.FileName, document.Size))];

    public async Task PutAsync(string name, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        var older = (await account.ListAsync(cancellationToken)).Where(document => document.FileName == name).Select(document => document.MessageId).ToList();
        await account.SendAsync(name, content, length, progress, cancellationToken);
        if (older.Count > 0)
        {
            await account.DeleteAsync(older, cancellationToken);
        }
    }

    public async Task<Stream> OpenAsync(CloudFile file, CancellationToken cancellationToken)
    {
        var id = int.Parse(file.Id, System.Globalization.CultureInfo.InvariantCulture);
        var document = (await account.ListAsync(cancellationToken)).FirstOrDefault(d => d.MessageId == id)
            ?? throw new BackupDestinationException($"{file.Name} is no longer in the Telegram chat.");
        return await account.DownloadAsync(document, cancellationToken);
    }

    public Task DeleteAsync(CloudFile file, CancellationToken cancellationToken) =>
        account.DeleteAsync([int.Parse(file.Id, System.Globalization.CultureInfo.InvariantCulture)], cancellationToken);

    public ValueTask DisposeAsync() => account.DisposeAsync();
}

/// <summary>A finished sign-in, handed once to the destination that keeps its session.</summary>
internal sealed record TelegramSession(byte[] Session, string AccountName, bool IsPremium);

/// <summary>
/// Telegram sign-ins in progress (E28), at most ten minutes each. The person's own app id and hash
/// (my.telegram.org), the phone number, the code Telegram sends, then the cloud password when the
/// account has one. The finished session is taken once, by the destination saved with its id.
/// </summary>
internal sealed partial class TelegramLogins(ITelegramConnector connector, TimeProvider time)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, Pending> _pending = new(StringComparer.Ordinal);

    public async Task<TelegramLoginState> StartAsync(StartTelegramLoginRequest? request, CancellationToken cancellationToken)
    {
        Sweep();
        if (request is null || request.ApiId <= 0 || request.ApiHash is null || !ApiHash().IsMatch(request.ApiHash))
        {
            return Refused(string.Empty, TelegramLoginStep.Code, "Enter the app's api_id and api_hash from my.telegram.org.");
        }

        var phone = request.PhoneNumber?.Replace(" ", string.Empty, StringComparison.Ordinal) ?? string.Empty;
        if (!Phone().IsMatch(phone))
        {
            return Refused(string.Empty, TelegramLoginStep.Code, "Enter the phone number with its country code, like +44 7700 900123.");
        }

        var id = Guid.NewGuid().ToString("N");
        var client = connector.StartLogin(request.ApiId, request.ApiHash);
        var pending = new Pending(client, time.GetUtcNow() + Lifetime);
        _pending[id] = pending;
        return await AnswerAsync(id, pending, phone, TelegramLoginStep.Code);
    }

    public async Task<TelegramLoginState> ContinueAsync(ContinueTelegramLoginRequest? request, CancellationToken cancellationToken)
    {
        Sweep();
        if (request?.LoginId is not { } id || !_pending.TryGetValue(id, out var pending))
        {
            return Refused(request?.LoginId ?? string.Empty, TelegramLoginStep.Code, "This sign-in expired. Start again.");
        }

        return pending.Step switch
        {
            TelegramLoginStep.Code when !string.IsNullOrWhiteSpace(request.Code) => await AnswerAsync(id, pending, request.Code.Trim(), TelegramLoginStep.Code),
            TelegramLoginStep.Password when !string.IsNullOrEmpty(request.Password) => await AnswerAsync(id, pending, request.Password, TelegramLoginStep.Password),
            TelegramLoginStep.Done => Done(id, pending),
            _ => Refused(id, pending.Step, pending.Step == TelegramLoginStep.Code ? "Enter the code Telegram sent." : "Enter the account's cloud password."),
        };
    }

    /// <summary>A finished sign-in's session without taking it, to test a destination before it is saved.</summary>
    public TelegramSession? PeekSession(string loginId)
    {
        if (!_pending.TryGetValue(loginId, out var pending) || pending.Step != TelegramLoginStep.Done)
        {
            return null;
        }

        var (name, premium) = pending.Client.Account;
        return new TelegramSession(pending.Client.Session, name, premium);
    }

    /// <summary>The session of a finished sign-in, once; null when there is none (or it was taken).</summary>
    public TelegramSession? TakeSession(string loginId)
    {
        if (!_pending.TryGetValue(loginId, out var pending) || pending.Step != TelegramLoginStep.Done || !_pending.TryRemove(loginId, out _))
        {
            return null;
        }

        var (name, premium) = pending.Client.Account;
        var session = new TelegramSession(pending.Client.Session, name, premium);
        _ = pending.Client.DisposeAsync().AsTask();
        return session;
    }

    private async Task<TelegramLoginState> AnswerAsync(string id, Pending pending, string value, TelegramLoginStep step)
    {
        string? next;
        try
        {
            next = await pending.Client.LoginAsync(value);
        }
        catch (TelegramRefusedException refused)
        {
            return Refused(id, step, Describe(refused.Message));
        }
        catch (Exception error) when (error is IOException or System.Net.Sockets.SocketException or TimeoutException)
        {
            return Refused(id, step, $"Telegram cannot be reached: {error.Message}");
        }

        pending.Step = next switch
        {
            null => TelegramLoginStep.Done,
            "verification_code" => TelegramLoginStep.Code,
            "password" => TelegramLoginStep.Password,
            _ => pending.Step,
        };
        if (next is not (null or "verification_code" or "password"))
        {
            _pending.TryRemove(id, out _);
            await pending.Client.DisposeAsync();
            return Refused(id, step, "This phone number has no Telegram account. Sign up in a Telegram app first.");
        }

        return pending.Step == TelegramLoginStep.Done ? Done(id, pending) : new TelegramLoginState(id, pending.Step, null, null, null);
    }

    private static TelegramLoginState Done(string id, Pending pending) =>
        new(id, TelegramLoginStep.Done, pending.Client.Account.Name, pending.Client.Account.Premium, null);

    private static TelegramLoginState Refused(string id, TelegramLoginStep step, string problem) => new(id, step, null, null, problem);

    private static string Describe(string code) => code switch
    {
        _ when code.Contains("PHONE_CODE_INVALID", StringComparison.Ordinal) => "The code is wrong. Check it and enter it again.",
        _ when code.Contains("PHONE_CODE_EXPIRED", StringComparison.Ordinal) => "The code expired. Start again for a new one.",
        _ when code.Contains("PASSWORD_HASH_INVALID", StringComparison.Ordinal) => "The cloud password is wrong.",
        _ when code.Contains("PHONE_NUMBER_INVALID", StringComparison.Ordinal) => "Telegram does not know that phone number.",
        _ when code.Contains("API_ID_INVALID", StringComparison.Ordinal) => "The api_id or api_hash is wrong. Copy them again from my.telegram.org.",
        _ when code.Contains("FLOOD_WAIT", StringComparison.Ordinal) => $"Telegram asks to wait before trying again ({code}).",
        _ => $"Telegram refused: {code}",
    };

    private void Sweep()
    {
        var now = time.GetUtcNow();
        foreach (var (id, pending) in _pending)
        {
            if (pending.Expires < now && _pending.TryRemove(id, out _))
            {
                _ = pending.Client.DisposeAsync().AsTask();
            }
        }
    }

    [GeneratedRegex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ApiHash();

    [GeneratedRegex(@"^\+[1-9][0-9]{6,15}$", RegexOptions.CultureInvariant)]
    private static partial Regex Phone();

    private sealed class Pending(ITelegramLoginClient client, DateTimeOffset expires)
    {
        public ITelegramLoginClient Client { get; } = client;

        public DateTimeOffset Expires { get; } = expires;

        public TelegramLoginStep Step { get; set; } = TelegramLoginStep.Code;
    }
}
