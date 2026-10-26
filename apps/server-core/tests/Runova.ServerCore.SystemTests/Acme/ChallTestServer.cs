using System.Net.Http.Json;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.SystemTests.Acme;

/// <summary>
/// Answers challenges through pebble-challtestsrv, which Pebble asks for every DNS name and whose
/// HTTP server answers every HTTP-01 request: the stand-in for the nginx webroot (HTTP-01) and
/// for Cloudflare (DNS-01) until those exist.
/// </summary>
internal sealed class ChallTestServer(HttpClient management) : IHttp01ChallengePublisher, IDns01ChallengeHook
{
    public int Published { get; private set; }

    public Task SetDefaultAddressAsync(string address, CancellationToken cancellationToken) =>
        PostAsync("set-default-ipv4", new { ip = address }, cancellationToken);

    /// <summary>Points one name at an address, as a DNS record for a real server would.</summary>
    public Task AddAddressAsync(string host, string address, CancellationToken cancellationToken) =>
        PostAsync("add-a", new { host = host + ".", addresses = new[] { address } }, cancellationToken);

    public async Task PublishAsync(string domain, string token, string keyAuthorization, CancellationToken cancellationToken)
    {
        await PostAsync("add-http01", new { token, content = keyAuthorization }, cancellationToken);
        Published++;
    }

    public Task RemoveAsync(string domain, string token, CancellationToken cancellationToken) =>
        PostAsync("del-http01", new { token }, cancellationToken);

    async Task IDns01ChallengeHook.PublishAsync(string domain, string recordName, string value, CancellationToken cancellationToken)
    {
        await PostAsync("set-txt", new { host = recordName + ".", value }, cancellationToken);
        Published++;
    }

    /// <summary>challtestsrv can only clear a record name as a whole, which is fine once validation is over.</summary>
    Task IDns01ChallengeHook.RemoveAsync(string domain, string recordName, string value, CancellationToken cancellationToken) =>
        PostAsync("clear-txt", new { host = recordName + "." }, cancellationToken);

    private async Task PostAsync(string path, object body, CancellationToken cancellationToken)
    {
        using var response = await management.PostAsJsonAsync(path, body, cancellationToken);
        response.EnsureSuccessStatusCode();
    }
}
