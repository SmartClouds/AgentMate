using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>Renewal information (RFC 9773 section 4): when the CA would like a certificate renewed.</summary>
public sealed class AcmeRenewalInfoTests : IDisposable
{
    private readonly AcmeTestKit _kit = new();

    [Fact]
    public async Task The_window_of_an_issued_certificate_comes_from_the_ca()
    {
        using var account = await _kit.CreateAccountAsync();
        var chain = await _kit.IssueWithClientAsync(account, "example.test");
        using var leaf = chain.LoadLeaf();

        var info = await _kit.Client.GetRenewalInfoAsync(leaf, TestContext.Current.CancellationToken);

        var id = _kit.Server.CertificateIdOf(chain.Certificates[0])!;
        Assert.Equal(id, info.CertificateId);
        Assert.Equal($"/renewal-info/{id}", _kit.Server.RequestsTo("/renewal-info/").Single().Path);
        // The fake CA backdates by a minute and suggests a day either side of two thirds, as Pebble does.
        var notAfter = _kit.Clock.GetUtcNow().AddDays(90);
        var ideal = notAfter - ((TimeSpan.FromDays(90) + TimeSpan.FromMinutes(1)) / 3);
        Assert.Equal(ideal.AddDays(-1), info.WindowStart, TimeSpan.FromSeconds(1));
        Assert.Equal(ideal.AddDays(1), info.WindowEnd, TimeSpan.FromSeconds(1));
        Assert.Equal(TimeSpan.FromHours(6), info.RetryAfter);
        Assert.Equal(_kit.Clock.GetUtcNow().AddHours(6), info.NextCheckAt);
        Assert.Equal(new Uri("https://acme.test/docs/ari"), info.ExplanationUrl);
    }

    [Fact]
    public async Task A_renewal_time_is_picked_inside_the_window()
    {
        var info = await RenewalInfoAsync("2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z", retryAfter: TimeSpan.FromHours(6));

        Assert.Equal(info.WindowStart, info.PickRenewalTime(0));
        Assert.Equal(new DateTimeOffset(2026, 11, 2, 0, 0, 0, TimeSpan.Zero), info.PickRenewalTime(0.5));
        for (var i = 0; i < 50; i++)
        {
            var picked = info.PickRenewalTime();
            Assert.InRange(picked, info.WindowStart, info.WindowEnd);
        }

        Assert.Throws<ArgumentOutOfRangeException>(() => info.PickRenewalTime(1));
    }

    [Fact]
    public async Task A_window_that_ends_before_it_starts_is_refused()
    {
        var error = await Assert.ThrowsAsync<AcmeException>(() =>
            RenewalInfoAsync("2026-11-03T00:00:00Z", "2026-11-01T00:00:00Z", retryAfter: TimeSpan.FromHours(6)));

        Assert.Contains("ends before it starts", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(5, 60)]
    [InlineData(3600, 3600)]
    [InlineData(7 * 86_400, 86_400)]
    public async Task Retry_after_is_kept_between_a_minute_and_a_day(int sentSeconds, int keptSeconds)
    {
        var info = await RenewalInfoAsync("2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z", TimeSpan.FromSeconds(sentSeconds));

        Assert.Equal(TimeSpan.FromSeconds(keptSeconds), info.RetryAfter);
    }

    [Fact]
    public async Task Without_retry_after_the_next_check_is_in_six_hours()
    {
        var info = await RenewalInfoAsync("2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z", retryAfter: null);

        Assert.Equal(TimeSpan.FromHours(6), info.RetryAfter);
    }

    [Fact]
    public async Task A_ca_without_renewal_info_says_so()
    {
        _kit.Server.OfferRenewalInfo = false;

        var error = await Assert.ThrowsAsync<AcmeException>(() =>
            _kit.Client.GetRenewalInfoAsync("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE", TestContext.Current.CancellationToken));

        Assert.Contains("does not offer renewal information", error.Message, StringComparison.Ordinal);
    }

    public void Dispose() => _kit.Dispose();

    private async Task<AcmeRenewalInfo> RenewalInfoAsync(string start, string end, TimeSpan? retryAfter)
    {
        _kit.Server.Intercept = (request, _) =>
        {
            if (!request.Path.StartsWith("/renewal-info/", StringComparison.Ordinal))
            {
                return Task.FromResult<HttpResponseMessage?>(null);
            }

            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent($$$"""{"suggestedWindow":{"start":"{{{start}}}","end":"{{{end}}}"}}""", Encoding.UTF8, "application/json"),
            };
            if (retryAfter is { } delay)
            {
                response.Headers.RetryAfter = new RetryConditionHeaderValue(delay);
            }

            return Task.FromResult<HttpResponseMessage?>(response);
        };
        return await _kit.Client.GetRenewalInfoAsync("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE", TestContext.Current.CancellationToken);
    }
}
