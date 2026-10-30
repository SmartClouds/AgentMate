using System.Net.Http.Json;
using System.Text.Json;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// A browser-like client: keeps the session cookie and sends the antiforgery header on unsafe
/// methods, as the admin app does.
/// </summary>
internal sealed class ApiClient(HttpClient http)
{
    public const string AntiforgeryHeader = "X-XSRF-TOKEN";

    private string? _antiforgeryToken;

    public HttpClient Http => http;

    /// <summary>Fetches a fresh antiforgery token, which belongs to whoever is signed in now.</summary>
    public async Task<string> RefreshAntiforgeryTokenAsync()
    {
        var response = await http.GetAsync("/api/v1/csrf-tokens/current", TestContext.Current.CancellationToken);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
        return _antiforgeryToken = body.GetProperty("token").GetString()!;
    }

    public async Task<HttpResponseMessage> SignInAsync(
        string email, string password, string? twoFactorCode = null, string? recoveryCode = null)
    {
        await RefreshAntiforgeryTokenAsync();
        var response = await SendAsync(HttpMethod.Post, "/api/v1/sessions", new { email, password, twoFactorCode, recoveryCode });
        if (response.IsSuccessStatusCode)
        {
            await RefreshAntiforgeryTokenAsync();
        }

        return response;
    }

    public Task<HttpResponseMessage> GetAsync(string path) => http.GetAsync(path, TestContext.Current.CancellationToken);

    /// <summary>
    /// Sends with the antiforgery token held now, none when <paramref name="antiforgeryToken"/> is
    /// empty, or the one given.
    /// </summary>
    public Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body = null, string? antiforgeryToken = null)
    {
        var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        var token = antiforgeryToken ?? _antiforgeryToken;
        if (!string.IsNullOrEmpty(token))
        {
            request.Headers.Add(AntiforgeryHeader, token);
        }

        return http.SendAsync(request, TestContext.Current.CancellationToken);
    }
}
