using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentMate.ServerCore.Notifications;

/// <summary>
/// The network the bot talks through. The core uses real sockets; tests swap in a fake Telegram so no
/// test ever leaves the machine.
/// </summary>
internal interface ITelegramTransport
{
    HttpMessageHandler CreateHandler();
}

/// <summary>
/// Real sockets, with redirects off: api.telegram.org is the one place the token may go, and a
/// redirect could move it somewhere else.
/// </summary>
internal sealed class SocketsTelegramTransport : ITelegramTransport
{
    public HttpMessageHandler CreateHandler() => new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(10),
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    };
}

/// <summary>Delivered says Telegram took the message; otherwise Error says why in words for a person.</summary>
internal sealed record TelegramSendResult(bool Delivered, int? HttpStatus, string? Error);

/// <summary>
/// Sends one plain-text message through the Bot API. Plain text, so nothing in an alert needs escaping.
/// The token is part of the address, so nothing this says about a failure may repeat the address.
/// </summary>
/// <param name="apiBase">Where the Bot API is; api.telegram.org unless <see cref="ApiAddress"/> says otherwise.</param>
internal sealed class TelegramBotClient(ITelegramTransport transport, TimeProvider time, Uri? apiBase = null) : IDisposable
{
    private static readonly Uri _telegram = new("https://api.telegram.org/");

    private readonly Uri _apiBase = apiBase ?? _telegram;

    /// <summary>The longest wait Telegram may ask for that is still worth sitting out.</summary>
    private static readonly TimeSpan _longestWait = TimeSpan.FromSeconds(30);

    private readonly HttpClient _http = new(transport.CreateHandler(), disposeHandler: false)
    {
        Timeout = TimeSpan.FromSeconds(20),
    };

    public void Dispose() => _http.Dispose();

    /// <summary>
    /// api.telegram.org, except on a core started as Development (the DevHost), which may be pointed at
    /// a stand-in on this machine with <c>Core:Telegram:ApiBase</c> for the app's e2e run. Nothing else
    /// is taken, so no setting can send a token anywhere but Telegram on a real server.
    /// </summary>
    public static Uri ApiAddress(IConfiguration configuration, bool development)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        if (development
            && Uri.TryCreate(configuration["Core:Telegram:ApiBase"], UriKind.Absolute, out var standIn)
            && standIn.Scheme == Uri.UriSchemeHttp
            && standIn.IsLoopback)
        {
            return standIn;
        }

        return _telegram;
    }

    public async Task<TelegramSendResult> SendAsync(string token, string chatId, string text, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        var result = await SendOnceAsync(token, chatId, text, cancellationToken);
        if (result.RetryAfter is TimeSpan wait && wait <= _longestWait)
        {
            await Task.Delay(wait, time, cancellationToken);
            result = await SendOnceAsync(token, chatId, text, cancellationToken);
        }

        return new TelegramSendResult(result.Delivered, result.HttpStatus, result.Error is { } error ? Scrub(error, token) : null);
    }

    private async Task<Attempt> SendOnceAsync(string token, string chatId, string text, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(
                // Absolute: "bot123:AAH..." on its own would read as an address with a scheme.
                new Uri($"{_apiBase}bot{token}/sendMessage"),
                new SendMessage(chatId, text, new LinkPreview(true)),
                cancellationToken);
            var answer = await ReadAnswerAsync(response, cancellationToken);
            if (response.IsSuccessStatusCode && answer?.Ok == true)
            {
                return new Attempt(true, (int)response.StatusCode, null, null);
            }

            var retryAfter = answer?.Parameters?.RetryAfter is int seconds and > 0 ? TimeSpan.FromSeconds(seconds) : (TimeSpan?)null;
            return new Attempt(false, (int)response.StatusCode, Explain(response.StatusCode, answer?.Description), retryAfter);
        }
        catch (Exception problem) when (problem is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            var reason = problem is TaskCanceledException ? "it did not answer in time." : problem.Message;
            return new Attempt(false, null, $"Could not reach Telegram: {reason}", null);
        }
    }

    private static async Task<Answer?> ReadAnswerAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            return await response.Content.ReadFromJsonAsync<Answer>(cancellationToken);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Explain(HttpStatusCode status, string? description)
    {
        var code = ((int)status).ToString(CultureInfo.InvariantCulture);
        var said = description ?? string.Empty;
        return status switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.NotFound =>
                "Telegram did not accept the bot token. Copy it again from BotFather, or use the new one if it was revoked.",
            HttpStatusCode.BadRequest when said.Contains("chat not found", StringComparison.OrdinalIgnoreCase) =>
                "Telegram cannot find that chat. Start a chat with the bot, or add it to the group, then try again.",
            HttpStatusCode.Forbidden when said.Contains("blocked", StringComparison.OrdinalIgnoreCase) =>
                "The bot was blocked in that chat. Unblock it in Telegram, then try again.",
            HttpStatusCode.Forbidden =>
                "The bot is not a member of that group or channel, or may not post there. Add it (as an admin for a channel), then try again.",
            HttpStatusCode.TooManyRequests =>
                "Telegram says the bot is sending too many messages right now (HTTP 429). It will try again with the next alert.",
            _ when said.Length > 0 => $"Telegram answered HTTP {code}: {said}",
            _ => $"Telegram answered HTTP {code}.",
        };
    }

    /// <summary>Takes the token out of anything about to be said, whole or just its secret half.</summary>
    private static string Scrub(string text, string token)
    {
        var secret = token[(token.IndexOf(':', StringComparison.Ordinal) + 1)..];
        return text
            .Replace(token, "[token]", StringComparison.Ordinal)
            .Replace(secret, "[token]", StringComparison.Ordinal);
    }

    private sealed record Attempt(bool Delivered, int? HttpStatus, string? Error, TimeSpan? RetryAfter);

    private sealed record SendMessage(
        [property: JsonPropertyName("chat_id")] string ChatId,
        [property: JsonPropertyName("text")] string Text,
        [property: JsonPropertyName("link_preview_options")] LinkPreview LinkPreviewOptions);

    private sealed record LinkPreview([property: JsonPropertyName("is_disabled")] bool IsDisabled);

    private sealed record Answer(
        [property: JsonPropertyName("ok")] bool Ok,
        [property: JsonPropertyName("description")] string? Description,
        [property: JsonPropertyName("parameters")] AnswerParameters? Parameters);

    private sealed record AnswerParameters([property: JsonPropertyName("retry_after")] int? RetryAfter);
}
