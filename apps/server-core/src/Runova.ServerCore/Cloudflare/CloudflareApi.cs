using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Cloudflare;

/// <summary>Cloudflare's published edge ranges. The endpoint needs no token.</summary>
internal interface ICloudflareRangeSource
{
    Task<CloudflareRanges> FetchAsync(CancellationToken cancellationToken);
}

internal sealed record CloudflareTxtRecord(string Id, string Name, string Content);

/// <summary>The few DNS calls DNS-01 needs, each with the zone's own token.</summary>
internal interface ICloudflareDnsApi
{
    /// <summary>Null when the token may read the zone's DNS records; otherwise why not, in words.</summary>
    Task<string?> CheckAsync(string zoneId, string token, CancellationToken cancellationToken);

    /// <summary>Adds a TXT record and returns its id.</summary>
    Task<string> CreateTxtAsync(string zoneId, string token, string name, string content, CancellationToken cancellationToken);

    Task<IReadOnlyList<CloudflareTxtRecord>> FindTxtAsync(string zoneId, string token, string name, CancellationToken cancellationToken);

    Task DeleteAsync(string zoneId, string token, string recordId, CancellationToken cancellationToken);
}

/// <summary>Cloudflare refused a call or could not be reached. The message is safe to show and log.</summary>
internal sealed class CloudflareApiException(string message, HttpStatusCode? status = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
}

/// <summary>One client for Cloudflare's API; tests put a fake handler behind it.</summary>
internal interface ICloudflareHttp
{
    HttpClient Client { get; }
}

internal sealed class CloudflareHttp : ICloudflareHttp, IDisposable
{
    public HttpClient Client { get; } = new(new SocketsHttpHandler { AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(30),
    };

    public void Dispose() => Client.Dispose();
}

/// <summary>
/// Cloudflare's v4 API over plain HTTP: the ranges (no token) and DNS records (the zone's token,
/// sent as a bearer header and nowhere else). Error text from Cloudflare is clipped and stripped
/// of control characters before it is passed on; the token can never be in it, since it is only
/// ever in a request header.
/// </summary>
internal sealed class CloudflareApi(ICloudflareHttp http) : ICloudflareRangeSource, ICloudflareDnsApi
{
    public static readonly Uri BaseUri = new("https://api.cloudflare.com/client/v4/");

    private const int MaxErrorLength = 300;

    public async Task<CloudflareRanges> FetchAsync(CancellationToken cancellationToken)
    {
        var result = await SendAsync(HttpMethod.Get, "ips", token: null, body: null, cancellationToken);
        return CloudflareRangeList.Parse(
            Strings(result?["ipv4_cidrs"]),
            Strings(result?["ipv6_cidrs"]),
            fetchedAtUnixMs: 0);
    }

    public async Task<string?> CheckAsync(string zoneId, string token, CancellationToken cancellationToken)
    {
        try
        {
            await SendAsync(HttpMethod.Get, $"zones/{Zone(zoneId)}/dns_records?type=TXT&per_page=5", token, null, cancellationToken);
            return null;
        }
        catch (CloudflareApiException refused) when (refused.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.NotFound or HttpStatusCode.BadRequest)
        {
            return refused.Status == HttpStatusCode.Unauthorized
                ? $"Cloudflare does not accept this token ({refused.Message})."
                : $"This token cannot read the zone's DNS records ({refused.Message}). It needs Zone > DNS > Edit on this zone.";
        }
    }

    public async Task<string> CreateTxtAsync(string zoneId, string token, string name, string content, CancellationToken cancellationToken)
    {
        var body = new JsonObject
        {
            ["type"] = "TXT",
            ["name"] = name,
            ["content"] = content,
            ["ttl"] = 60,
            ["comment"] = "Runova DNS-01 challenge, removed after validation",
        };
        var result = await SendAsync(HttpMethod.Post, $"zones/{Zone(zoneId)}/dns_records", token, body, cancellationToken);
        return result?["id"]?.GetValue<string>() is { Length: > 0 } id
            ? id
            : throw new CloudflareApiException("Cloudflare made the record but did not say its id.");
    }

    public async Task<IReadOnlyList<CloudflareTxtRecord>> FindTxtAsync(string zoneId, string token, string name, CancellationToken cancellationToken)
    {
        var result = await SendAsync(
            HttpMethod.Get,
            $"zones/{Zone(zoneId)}/dns_records?type=TXT&per_page=100&name={Uri.EscapeDataString(name)}",
            token,
            null,
            cancellationToken);
        return result is JsonArray records
            ? [.. records.OfType<JsonObject>().Select(record => new CloudflareTxtRecord(
                record["id"]?.GetValue<string>() ?? string.Empty,
                record["name"]?.GetValue<string>() ?? string.Empty,
                Unquote(record["content"]?.GetValue<string>() ?? string.Empty))).Where(record => record.Id.Length > 0)]
            : [];
    }

    public async Task DeleteAsync(string zoneId, string token, string recordId, CancellationToken cancellationToken)
    {
        if (!IsId(recordId))
        {
            throw new CloudflareApiException("That is not a Cloudflare record id.");
        }

        try
        {
            await SendAsync(HttpMethod.Delete, $"zones/{Zone(zoneId)}/dns_records/{recordId}", token, null, cancellationToken);
        }
        catch (CloudflareApiException gone) when (gone.Status == HttpStatusCode.NotFound)
        {
            // Already gone is what removing wanted.
        }
    }

    /// <summary>Cloudflare's ids: 32 lowercase hex characters.</summary>
    public static bool IsId(string? id) => id is { Length: 32 } && id.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');

    /// <summary>What a token may be: printable ASCII without spaces, so it cannot break out of its header.</summary>
    public static bool IsToken(string? token) => token is { Length: >= 20 and <= 512 } && token.All(c => c is > ' ' and <= '~');

    private static string Zone(string zoneId) => IsId(zoneId) ? zoneId : throw new CloudflareApiException("That is not a Cloudflare zone id.");

    private async Task<JsonNode?> SendAsync(HttpMethod method, string path, string? token, JsonObject? body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, new Uri(BaseUri, path));
        if (token is not null)
        {
            if (!IsToken(token))
            {
                throw new CloudflareApiException("That is not a Cloudflare API token.");
            }

            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        if (body is not null)
        {
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = await http.Client.SendAsync(request, cancellationToken);
        }
        catch (HttpRequestException failed)
        {
            throw new CloudflareApiException($"Cloudflare could not be reached: {Clean(failed.Message)}");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new CloudflareApiException("Cloudflare took too long to answer.");
        }

        using (response)
        {
            JsonNode? envelope = null;
            try
            {
                envelope = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            }
            catch (JsonException)
            {
                // Said below by the status alone.
            }

            if (response.IsSuccessStatusCode && envelope?["success"]?.GetValue<bool>() == true)
            {
                return envelope["result"];
            }

            var words = envelope?["errors"] is JsonArray errors
                ? string.Join("; ", errors.OfType<JsonObject>().Select(error =>
                    string.Create(CultureInfo.InvariantCulture, $"{error["message"]?.GetValue<string>()} (code {error["code"]?.ToString()})")))
                : string.Empty;
            throw new CloudflareApiException(
                Clean(words.Length > 0 ? words : $"status {(int)response.StatusCode}"),
                response.StatusCode);
        }
    }

    private static string[] Strings(JsonNode? node) =>
        node is JsonArray array ? [.. array.Select(item => item?.GetValue<string>() ?? string.Empty)] : [];

    /// <summary>Cloudflare may hand TXT content back in quotes.</summary>
    private static string Unquote(string content) =>
        content.Length >= 2 && content[0] == '"' && content[^1] == '"' ? content[1..^1] : content;

    private static string Clean(string text)
    {
        var clean = new string([.. text.Select(c => char.IsControl(c) ? ' ' : c)]);
        return clean.Length <= MaxErrorLength ? clean : clean[..(MaxErrorLength - 1)] + "…";
    }
}
