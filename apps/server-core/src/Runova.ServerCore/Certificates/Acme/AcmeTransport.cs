using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>A link from a Link header (RFC 8288), resolved against the URL of the request.</summary>
internal sealed record AcmeLink(Uri Url, string Relation);

/// <summary>An answer from the CA, read in full (within the size limit) before the connection is let go.</summary>
internal sealed class AcmeResponse
{
    public required Uri RequestUrl { get; init; }

    public required HttpStatusCode StatusCode { get; init; }

    public string? ReasonPhrase { get; init; }

    /// <summary>When the answer arrived, on the client's clock.</summary>
    public required DateTimeOffset ReceivedAt { get; init; }

    public Uri? Location { get; init; }

    public IReadOnlyList<AcmeLink> Links { get; init; } = [];

    /// <summary>Retry-After as a delay from <see cref="ReceivedAt"/>, whichever form the CA used.</summary>
    public TimeSpan? RetryAfter { get; init; }

    public string? MediaType { get; init; }

    public string? ReplayNonce { get; init; }

    public ReadOnlyMemory<byte> Body { get; init; }

    public bool IsSuccess => (int)StatusCode is >= 200 and < 300;

    public DateTimeOffset? RetryAt => RetryAfter is { } delay ? ReceivedAt + delay : null;

    public IEnumerable<Uri> LinksTo(string relation) =>
        Links.Where(link => string.Equals(link.Relation, relation, StringComparison.OrdinalIgnoreCase)).Select(link => link.Url);

    /// <exception cref="AcmeException">The body is not a JSON object.</exception>
    public JsonDocument ReadJson(string operation) =>
        AcmeJson.TryParseObject(Body)
        ?? throw new AcmeException($"{operation} failed: the answer from {RequestUrl.Host} is not a JSON object.");

    /// <summary>The problem document of an error answer, or one made up from the status line.</summary>
    public AcmeProblem Problem()
    {
        var problem = MediaType is null || MediaType.Contains("json", StringComparison.OrdinalIgnoreCase)
            ? AcmeProblem.TryParse(Body.Span)
            : null;
        return problem ?? new AcmeProblem(string.Empty)
        {
            Detail = string.Create(
                CultureInfo.InvariantCulture,
                $"The CA answered {(int)StatusCode} {AcmeText.Clean(ReasonPhrase, 60) ?? "without a reason"}."),
            Status = (int)StatusCode,
        };
    }

    public AcmeProblemException ToException(string operation) => ToException(operation, Problem());

    public AcmeProblemException ToException(string operation, AcmeProblem problem)
    {

        // RFC 8555 section 7.3.3: a changed terms of service comes with a link to the new ones.
        var terms = problem.ErrorType == AcmeErrorType.UserActionRequired ? LinksTo("terms-of-service").FirstOrDefault() : null;
        return AcmeProblemException.Create(operation, problem, StatusCode, RetryAt, terms);
    }
}

/// <summary>
/// HTTP for ACME: HTTPS only, no redirects, a size limit on answers, a timeout on the client's
/// clock for each request, Link and Retry-After parsing, and nonces for signed requests with the
/// badNonce retry of RFC 8555 section 6.5.
/// </summary>
internal sealed partial class AcmeTransport(HttpClient http, AcmeClientOptions options, TimeProvider time, ILogger logger)
{
    private const int MaxLinks = 20;

    private readonly AcmeNoncePool _nonces = new();

    /// <summary>
    /// The handler a production client should use: no redirects, no cookies, no decompression,
    /// short header limits. Pass it to an HttpClient with an infinite timeout; the client keeps
    /// its own time limits.
    /// </summary>
    public static SocketsHttpHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.None,
        ConnectTimeout = TimeSpan.FromSeconds(15),
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        MaxResponseHeadersLength = 64,
        MaxResponseDrainSize = 64 * 1024,
    };

    /// <summary>An unauthenticated GET (the directory, renewal information).</summary>
    public async Task<AcmeResponse> GetAsync(Uri url, string accept, string operation, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        var response = await SendAsync(request, url, accept, operation, cancellationToken);
        return response.IsSuccess ? response : throw response.ToException(operation);
    }

    /// <summary>A signed POST: JWS with a fresh nonce, retried with the CA's nonce after badNonce.</summary>
    /// <param name="payload">JSON, or empty for POST-as-GET.</param>
    public async Task<AcmeResponse> PostAsync(
        Uri url,
        AcmeAccountKey key,
        Uri? keyId,
        ReadOnlyMemory<byte> payload,
        Uri newNonceUrl,
        string accept,
        string operation,
        CancellationToken cancellationToken)
    {
        string? nonce = null;
        for (var attempt = 0; ; attempt++)
        {
            nonce ??= _nonces.TryTake() ?? await NewNonceAsync(newNonceUrl, operation, cancellationToken);
            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new ByteArrayContent(AcmeJws.Sign(key, url, nonce, keyId, payload.Span)),
            };

            // Exactly this media type, without a charset parameter: servers compare it verbatim.
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(AcmeJws.MediaType);
            var response = await SendAsync(request, url, accept, operation, cancellationToken);
            nonce = null;
            if (response.IsSuccess)
            {
                _nonces.Add(response.ReplayNonce);
                return response;
            }

            var problem = response.Problem();
            if (problem.ErrorType == AcmeErrorType.BadNonce && attempt < options.BadNonceRetries)
            {
                LogBadNonce(logger, url.Host, attempt + 1);

                // The retry must use the nonce that came with the error (RFC 8555 section 6.5).
                nonce = AcmeNoncePool.IsValid(response.ReplayNonce) ? response.ReplayNonce : null;
                continue;
            }

            _nonces.Add(response.ReplayNonce);
            if (problem.ErrorType == AcmeErrorType.RateLimited)
            {
                LogRateLimited(logger, url.Host, response.RetryAt);
            }

            throw response.ToException(operation, problem);
        }
    }

    internal static IReadOnlyList<AcmeLink> ParseLinks(IEnumerable<string> values, Uri baseUrl)
    {
        var links = new List<AcmeLink>();
        foreach (var value in values)
        {
            var at = 0;
            while (at < value.Length && links.Count < MaxLinks)
            {
                while (at < value.Length && (value[at] == ',' || char.IsWhiteSpace(value[at])))
                {
                    at++;
                }

                if (at >= value.Length || value[at] != '<')
                {
                    break;
                }

                var close = value.IndexOf('>', at);
                if (close < 0)
                {
                    break;
                }

                var target = value[(at + 1)..close];
                at = close + 1;
                string? relation = null;
                while (at < value.Length && value[at] != ',')
                {
                    if (value[at] != ';')
                    {
                        at++;
                        continue;
                    }

                    at++;
                    var (name, parameter, next) = ReadParameter(value, at);
                    at = next;
                    if (string.Equals(name, "rel", StringComparison.OrdinalIgnoreCase))
                    {
                        relation ??= parameter;
                    }
                }

                if (relation is not null && Uri.TryCreate(baseUrl, target, out var url))
                {
                    foreach (var rel in relation.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                    {
                        links.Add(new AcmeLink(url, rel));
                    }
                }
            }
        }

        return links;
    }

    private static (string Name, string? Value, int Next) ReadParameter(string text, int at)
    {
        while (at < text.Length && char.IsWhiteSpace(text[at]))
        {
            at++;
        }

        var start = at;
        while (at < text.Length && text[at] is not ('=' or ';' or ','))
        {
            at++;
        }

        var name = text[start..at].Trim();
        if (at >= text.Length || text[at] != '=')
        {
            return (name, null, at);
        }

        at++;
        while (at < text.Length && char.IsWhiteSpace(text[at]))
        {
            at++;
        }

        if (at < text.Length && text[at] == '"')
        {
            var end = text.IndexOf('"', at + 1);
            if (end < 0)
            {
                return (name, text[(at + 1)..], text.Length);
            }

            return (name, text[(at + 1)..end], end + 1);
        }

        start = at;
        while (at < text.Length && text[at] is not (';' or ','))
        {
            at++;
        }

        return (name, text[start..at].Trim(), at);
    }

    private static TimeSpan? RetryAfterOf(HttpResponseMessage response, DateTimeOffset now)
    {
        var header = response.Headers.RetryAfter;
        var delay = header?.Delta ?? (header?.Date is { } date ? date - now : null);

        // A CA whose clock runs behind ours can name a moment that has already passed.
        return delay is { } value && value < TimeSpan.Zero ? TimeSpan.Zero : delay;
    }

    private async Task<string> NewNonceAsync(Uri url, string operation, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, url);
        var response = await SendAsync(request, url, "*/*", operation, cancellationToken);
        if (!response.IsSuccess)
        {
            throw response.ToException(operation);
        }

        return AcmeNoncePool.IsValid(response.ReplayNonce)
            ? response.ReplayNonce!
            : throw new AcmeException($"{operation} failed: {url.Host} gave no usable nonce.");
    }

    private async Task<AcmeResponse> SendAsync(
        HttpRequestMessage request,
        Uri url,
        string accept,
        string operation,
        CancellationToken cancellationToken)
    {
        AcmeUrls.RequireHttps(url, operation);
        request.Headers.TryAddWithoutValidation("User-Agent", options.UserAgent);
        request.Headers.Accept.ParseAdd(accept);

        using var timeout = new CancellationTokenSource(options.RequestTimeout, time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);

            // Signed requests name their URL, so a redirect could never be answered correctly; a
            // handler that followed one anyway shows it in the final request URL.
            if ((int)response.StatusCode is >= 300 and < 400
                || (response.RequestMessage?.RequestUri is { } final && final != url))
            {
                throw new AcmeException($"{operation} failed: {url.Host} answered with a redirect, which is not followed.");
            }

            var body = await ReadBodyAsync(response.Content, url, operation, linked.Token);
            var receivedAt = time.GetUtcNow();
            return new AcmeResponse
            {
                RequestUrl = url,
                StatusCode = response.StatusCode,
                ReasonPhrase = response.ReasonPhrase,
                ReceivedAt = receivedAt,
                Location = response.Headers.Location is { } location
                    ? location.IsAbsoluteUri ? location : new Uri(url, location)
                    : null,
                Links = response.Headers.TryGetValues("Link", out var links) ? ParseLinks(links, url) : [],
                RetryAfter = RetryAfterOf(response, receivedAt),
                MediaType = response.Content.Headers.ContentType?.MediaType,
                ReplayNonce = response.Headers.TryGetValues("Replay-Nonce", out var nonces) ? nonces.FirstOrDefault() : null,
                Body = body,
            };
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            // Our time limit or one of the HttpClient's own: either way the caller did not cancel.
            throw new AcmeException(
                $"{operation} failed: {url.Host} did not answer within {AcmeDurations.Describe(options.RequestTimeout)}.",
                new TimeoutException(error.Message, error));
        }
        catch (HttpRequestException error)
        {
            throw new AcmeException($"{operation} failed: {url.Host} could not be reached ({AcmeText.Clean(error.Message, 200)}).", error);
        }
        catch (IOException error)
        {
            throw new AcmeException($"{operation} failed: the connection to {url.Host} broke off ({AcmeText.Clean(error.Message, 200)}).", error);
        }
    }

    private async Task<byte[]> ReadBodyAsync(HttpContent content, Uri url, string operation, CancellationToken cancellationToken)
    {
        var limit = options.MaxResponseBytes;
        if (content.Headers.ContentLength > limit)
        {
            throw TooLarge();
        }

        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, cancellationToken);
            if (read == 0)
            {
                return buffer.ToArray();
            }

            if (buffer.Length + read > limit)
            {
                throw TooLarge();
            }

            buffer.Write(chunk, 0, read);
        }

        AcmeException TooLarge() =>
            new(string.Create(CultureInfo.InvariantCulture, $"{operation} failed: the answer from {url.Host} is larger than {limit / 1024} KB."));
    }

    [LoggerMessage(Level = LogLevel.Debug, Message = "{Host} refused a nonce; retrying with the one it sent back (retry {Attempt}).")]
    private static partial void LogBadNonce(ILogger logger, string host, int attempt);

    [LoggerMessage(Level = LogLevel.Warning, Message = "{Host} rate limited a request; it can be tried again after {RetryAt}.")]
    private static partial void LogRateLimited(ILogger logger, string host, DateTimeOffset? retryAt);
}

internal static class AcmeDurations
{
    /// <summary>"30 seconds", "5 minutes", "6 hours": for messages people read.</summary>
    public static string Describe(TimeSpan span) =>
        span.TotalSeconds < 120 ? Count((int)Math.Round(span.TotalSeconds), "second")
        : span.TotalMinutes < 120 ? Count((int)Math.Round(span.TotalMinutes), "minute")
        : Count((int)Math.Round(span.TotalHours), "hour");

    private static string Count(int count, string unit) =>
        string.Create(CultureInfo.InvariantCulture, $"{count} {unit}{(count == 1 ? string.Empty : "s")}");
}
