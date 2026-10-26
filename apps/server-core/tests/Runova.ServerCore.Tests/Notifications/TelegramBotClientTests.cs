using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Notifications;
using Runova.ServerCore.Tests.ErrorReporting;

namespace Runova.ServerCore.Tests.Notifications;

/// <summary>
/// The Bot API call: one sendMessage to api.telegram.org, answers turned into words a person can act
/// on, one wait when Telegram asks for it, and the token kept out of everything said about it.
/// </summary>
public sealed class TelegramBotClientTests : IDisposable
{
    private const string Token = TelegramSettingsTests.Token;

    private readonly FakeIngest _telegram = new();

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 22, 12, 0, 0, TimeSpan.Zero));

    private readonly TelegramBotClient _client;

    public TelegramBotClientTests() => _client = new TelegramBotClient(new FakeTelegramTransport(_telegram), _time);

    public void Dispose() => _client.Dispose();

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_message_is_one_post_to_send_message_with_the_chat_and_plain_text()
    {
        _telegram.Respond = _ => FakeTelegram.Ok();

        var result = await _client.SendAsync(Token, "-1001234567890", "Disk <b>full</b> & more", Cancel);

        Assert.True(result.Delivered);
        var request = Assert.Single(_telegram.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal($"https://api.telegram.org/bot{Token}/sendMessage", request.Uri.ToString());
        Assert.Equal("application/json", request.ContentType);
        using var body = JsonDocument.Parse(Encoding.Latin1.GetBytes(request.Body));
        Assert.Equal("-1001234567890", body.RootElement.GetProperty("chat_id").GetString());
        Assert.Equal("Disk <b>full</b> & more", body.RootElement.GetProperty("text").GetString());
        Assert.False(body.RootElement.TryGetProperty("parse_mode", out _));
        Assert.True(body.RootElement.GetProperty("link_preview_options").GetProperty("is_disabled").GetBoolean());
    }

    [Fact]
    public async Task A_token_telegram_does_not_know_says_to_copy_it_again()
    {
        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.Unauthorized, "Unauthorized");

        var result = await _client.SendAsync(Token, "123", "hi", Cancel);

        Assert.False(result.Delivered);
        Assert.Equal(401, result.HttpStatus);
        Assert.Contains("did not accept the bot token", result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_chat_the_bot_has_never_seen_says_to_start_a_chat_or_add_the_bot()
    {
        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.BadRequest, "Bad Request: chat not found");

        var result = await _client.SendAsync(Token, "123", "hi", Cancel);

        Assert.Contains("Start a chat with the bot, or add it to the group", result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_bot_blocked_or_removed_from_the_chat_says_so()
    {
        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.Forbidden, "Forbidden: bot was blocked by the user");
        Assert.Contains("blocked", (await _client.SendAsync(Token, "123", "hi", Cancel)).Error, StringComparison.Ordinal);

        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.Forbidden, "Forbidden: bot was kicked from the supergroup chat");
        Assert.Contains("not a member", (await _client.SendAsync(Token, "123", "hi", Cancel)).Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Any_other_answer_passes_telegrams_own_words_on()
    {
        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.BadRequest, "Bad Request: message is too long");

        var result = await _client.SendAsync(Token, "123", "hi", Cancel);

        Assert.Equal("Telegram answered HTTP 400: Bad Request: message is too long", result.Error);
    }

    [Fact]
    public async Task When_telegram_asks_to_wait_it_waits_that_long_once_then_sends_again()
    {
        var answers = new Queue<HttpResponseMessage>([FakeTelegram.TooMany(retryAfter: 3), FakeTelegram.Ok()]);
        _telegram.Respond = _ => answers.Dequeue();

        var sending = _client.SendAsync(Token, "123", "hi", Cancel);
        await WaitForAsync(() => _telegram.Requests.Count == 1);
        Assert.False(sending.IsCompleted);
        await AdvanceUntilAsync(sending);

        Assert.True((await sending).Delivered);
        Assert.Equal(2, _telegram.Requests.Count);
    }

    [Fact]
    public async Task Asked_to_wait_twice_it_gives_up_and_says_why()
    {
        _telegram.Respond = _ => FakeTelegram.TooMany(retryAfter: 1);

        var sending = _client.SendAsync(Token, "123", "hi", Cancel);
        await AdvanceUntilAsync(sending);

        var result = await sending;
        Assert.False(result.Delivered);
        Assert.Equal(429, result.HttpStatus);
        Assert.Contains("too many messages", result.Error, StringComparison.Ordinal);
        Assert.Equal(2, _telegram.Requests.Count);
    }

    [Fact]
    public async Task A_long_wait_is_not_waited_for()
    {
        _telegram.Respond = _ => FakeTelegram.TooMany(retryAfter: 600);

        var result = await _client.SendAsync(Token, "123", "hi", Cancel);

        Assert.False(result.Delivered);
        Assert.Single(_telegram.Requests);
    }

    [Fact]
    public async Task The_token_never_shows_up_in_what_is_said_about_a_failure()
    {
        // HttpClient puts the address (and so the token) into some of its own messages; the
        // client must not pass those on as they are.
        _telegram.Respond = request => throw new HttpRequestException($"Connection refused ({request.RequestUri})");
        var unreachable = await _client.SendAsync(Token, "123", "hi", Cancel);

        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.BadRequest, $"Bad Request: odd bot{Token}");
        var echoed = await _client.SendAsync(Token, "123", "hi", Cancel);

        Assert.False(unreachable.Delivered);
        Assert.StartsWith("Could not reach Telegram", unreachable.Error, StringComparison.Ordinal);
        Assert.DoesNotContain(Token, unreachable.Error, StringComparison.Ordinal);
        Assert.DoesNotContain(Token.Split(':')[1], unreachable.Error, StringComparison.Ordinal);
        Assert.DoesNotContain(Token.Split(':')[1], echoed.Error, StringComparison.Ordinal);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        for (var i = 0; i < 500 && !condition(); i++)
        {
            await Task.Delay(10, Cancel);
        }

        Assert.True(condition());
    }

    /// <summary>Moves the fake clock on a second at a time until the call finishes.</summary>
    private async Task AdvanceUntilAsync(Task sending)
    {
        for (var i = 0; i < 500 && !sending.IsCompleted; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(10, Cancel);
        }

        Assert.True(sending.IsCompleted);
    }
}

/// <summary>Bot API answers, shaped the way api.telegram.org gives them.</summary>
internal static class FakeTelegram
{
    public static HttpResponseMessage Ok(long messageId = 42) =>
        Json(HttpStatusCode.OK, $$$"""{"ok":true,"result":{"message_id":{{{messageId}}}}}""");

    public static HttpResponseMessage Error(HttpStatusCode status, string description) =>
        Json(status, JsonSerializer.Serialize(new { ok = false, error_code = (int)status, description }));

    public static HttpResponseMessage TooMany(int retryAfter) =>
        Json(
            HttpStatusCode.TooManyRequests,
            $$$"""{"ok":false,"error_code":429,"description":"Too Many Requests: retry after {{{retryAfter}}}","parameters":{"retry_after":{{{retryAfter}}}}}""");

    private static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}

/// <summary>The fake Telegram the whole test core talks to, answering every message with "ok" unless a test says otherwise.</summary>
internal sealed class FakeTelegramApi
{
    public FakeIngest Handler { get; } = new() { Respond = _ => FakeTelegram.Ok() };
}

/// <summary>Hands the client the fake Telegram, so no test ever leaves the machine.</summary>
internal sealed class FakeTelegramTransport(FakeIngest telegram) : ITelegramTransport
{
    public HttpMessageHandler CreateHandler() => telegram;
}
