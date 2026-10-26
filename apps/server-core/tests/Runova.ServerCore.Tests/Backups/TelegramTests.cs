using System.Collections.Concurrent;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>A Telegram account in memory: documents in one chat, with Telegram's per-file size cap.</summary>
internal sealed class FakeTelegramAccount(long maxFileBytes) : ITelegramAccount
{
    private readonly ConcurrentDictionary<int, (string Name, byte[] Bytes)> _messages = new();
    private int _ids;

    public List<long> Sent { get; } = [];

    public void Post(string name, byte[] bytes) => _messages[Interlocked.Increment(ref _ids)] = (name, bytes);

    public Task<IReadOnlyList<TelegramDocument>> ListAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<TelegramDocument>>([.. _messages.OrderByDescending(m => m.Key).Select(m => new TelegramDocument(m.Key, m.Value.Name, m.Value.Bytes.Length))]);

    public async Task SendAsync(string fileName, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        if (length > maxFileBytes)
        {
            throw new BackupDestinationException("FILE_PARTS_INVALID: the file is larger than Telegram takes.");
        }

        var bytes = new MemoryStream();
        await content.CopyToAsync(bytes, cancellationToken);
        Sent.Add(bytes.Length);
        Post(fileName, bytes.ToArray());
    }

    public Task<Stream> DownloadAsync(TelegramDocument document, CancellationToken cancellationToken) =>
        Task.FromResult<Stream>(new MemoryStream(_messages[document.MessageId].Bytes));

    public Task DeleteAsync(IReadOnlyList<int> messageIds, CancellationToken cancellationToken)
    {
        foreach (var id in messageIds)
        {
            _messages.TryRemove(id, out _);
        }

        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>A Telegram sign-in as the fake server sees it: a code, maybe a cloud password, then a session.</summary>
internal sealed class FakeTelegramLogin(string? password) : ITelegramLoginClient
{
    public List<string> Sent { get; } = [];

    public (string Name, bool Premium) Account => ("Ada Lovelace", true);

    public byte[] Session => "session-bytes"u8.ToArray();

    public Task<string?> LoginAsync(string value)
    {
        Sent.Add(value);
        return Task.FromResult<string?>(value switch
        {
            "+15550100" => "verification_code",
            "12345" when password is not null => "password",
            "12345" => null,
            "00000" => throw new TelegramRefusedException("PHONE_CODE_INVALID"),
            _ when value == password => null,
            _ => throw new TelegramRefusedException("PASSWORD_HASH_INVALID"),
        });
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

internal sealed class FakeTelegramConnector(string? password = null) : ITelegramConnector
{
    public FakeTelegramAccount Account { get; } = new(10 * 1024 * 1024);

    public List<FakeTelegramLogin> Logins { get; } = [];

    public ITelegramLoginClient StartLogin(int apiId, string apiHash)
    {
        var login = new FakeTelegramLogin(password);
        Logins.Add(login);
        return login;
    }

    public Task<ITelegramAccount> OpenAsync(int apiId, string apiHash, byte[] session, string chat, Func<byte[], Task> sessionChanged, CancellationToken cancellationToken) =>
        Task.FromResult<ITelegramAccount>(Account);
}

/// <summary>Signing in to Telegram (E28): phone, code, the cloud password when there is one, then a session kept once.</summary>
public sealed class TelegramLoginTests
{
    private readonly FakeTimeProvider _clock = new();

    private static StartTelegramLoginRequest Start(string phone = "+15550100") => new(123456, new string('b', 32), phone);

    [Fact]
    public async Task Phone_then_code_then_password_ends_with_the_account_and_its_session_taken_once()
    {
        var logins = new TelegramLogins(new FakeTelegramConnector(password: "cloud pw"), _clock);

        var code = await logins.StartAsync(Start(), CancellationToken.None);
        var passwordStep = await logins.ContinueAsync(new ContinueTelegramLoginRequest(code.LoginId, "12345", null), CancellationToken.None);
        var done = await logins.ContinueAsync(new ContinueTelegramLoginRequest(code.LoginId, null, "cloud pw"), CancellationToken.None);

        Assert.Equal(TelegramLoginStep.Code, code.Step);
        Assert.Equal(TelegramLoginStep.Password, passwordStep.Step);
        Assert.Equal(TelegramLoginStep.Done, done.Step);
        Assert.Equal(("Ada Lovelace", true), (done.AccountName, done.IsPremium));
        Assert.Equal("session-bytes"u8.ToArray(), logins.TakeSession(code.LoginId)!.Session);
        Assert.Null(logins.TakeSession(code.LoginId));
    }

    [Fact]
    public async Task A_wrong_code_stays_on_the_code_step_and_says_so()
    {
        var logins = new TelegramLogins(new FakeTelegramConnector(), _clock);
        var code = await logins.StartAsync(Start(), CancellationToken.None);

        var wrong = await logins.ContinueAsync(new ContinueTelegramLoginRequest(code.LoginId, "00000", null), CancellationToken.None);
        var right = await logins.ContinueAsync(new ContinueTelegramLoginRequest(code.LoginId, "12345", null), CancellationToken.None);

        Assert.Equal(TelegramLoginStep.Code, wrong.Step);
        Assert.Contains("code is wrong", wrong.Problem, StringComparison.Ordinal);
        Assert.Equal(TelegramLoginStep.Done, right.Step);
    }

    [Fact]
    public async Task A_sign_in_left_waiting_expires_and_a_bad_phone_is_refused_before_telegram()
    {
        var logins = new TelegramLogins(new FakeTelegramConnector(), _clock);
        var code = await logins.StartAsync(Start(), CancellationToken.None);
        _clock.Advance(TelegramLogins.Lifetime + TimeSpan.FromSeconds(1));

        var expired = await logins.ContinueAsync(new ContinueTelegramLoginRequest(code.LoginId, "12345", null), CancellationToken.None);
        var badPhone = await logins.StartAsync(Start("not a phone"), CancellationToken.None);

        Assert.Contains("Start again", expired.Problem, StringComparison.Ordinal);
        Assert.Contains("phone number", badPhone.Problem, StringComparison.Ordinal);
    }
}

/// <summary>A Telegram chat as files: the destination contract, with parts under Telegram's cap.</summary>
public sealed class TelegramDestinationTests : BackupDestinationContract
{
    private readonly FakeTelegramAccount _account = new(100_000);

    private protected override Task<IBackupDestination> CreateAsync() =>
        Task.FromResult<IBackupDestination>(new CloudDriveDestination(new TelegramFiles(_account), "Telegram"));

    private protected override Task PutForeignFileAsync(string name, byte[] contents)
    {
        _account.Post(name, contents);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task Sending_a_name_again_leaves_one_message_of_that_name()
    {
        var files = new TelegramFiles(_account);
        await files.PutAsync("runova-x.ambackup", new MemoryStream([1]), 1, null, Cancel);
        await files.PutAsync("runova-x.ambackup", new MemoryStream([2]), 1, null, Cancel);

        var file = Assert.Single(await files.ListAsync(Cancel));
        await using var stream = await files.OpenAsync(file, Cancel);
        Assert.Equal(2, stream.ReadByte());
    }

    [Fact]
    public async Task Messages_that_are_not_backups_are_not_files()
    {
        _account.Post("holiday.jpg", [1]);

        Assert.Empty(await new TelegramFiles(_account).ListAsync(Cancel));
    }
}
