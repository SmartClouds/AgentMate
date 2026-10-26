using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.DevHost.Fakes;

namespace Runova.ServerCore.Tests.DevHost;

/// <summary>The DevHost's pretend CA behaves like a real one as far as the certificate service can tell.</summary>
public sealed class FakeCertificateAuthoritiesTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task It_issues_renews_with_replaces_offers_a_window_and_revokes()
    {
        var store = new InMemoryAcmeCertificateStore();
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var ca = new FakeCertificateAuthorities(store, clock).For(new Uri("https://acme.devhost.test/directory"));
        var steps = new List<AcmeIssueStep>();
        var progress = new Recorder(steps);

        await Assert.ThrowsAsync<AcmeException>(() => ca.EnsureAccountAsync(new AcmeAccountSettings([], TermsOfServiceAgreed: false), Cancel));
        await ca.EnsureAccountAsync(new AcmeAccountSettings([], TermsOfServiceAgreed: true), Cancel);
        var issuing = ca.IssueAsync(new AcmeIssueRequest { Name = "blog", Domains = ["blog.example.com", "www.blog.example.com"] }, progress, Cancel);
        var issued = await RunAsync(clock, issuing);

        Assert.Equal(Enum.GetValues<AcmeIssueStep>(), steps);
        Assert.True(AcmeCertificateId.IsWellFormed(issued.CertificateId));
        var chain = new X509Certificate2Collection();
        chain.ImportFromPem(issued.ChainPem);
        Assert.Equal(2, chain.Count);
        Assert.Equal(["blog.example.com", "www.blog.example.com"], chain[0].Extensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames());
        Assert.Same(issued, await store.FindAsync("blog", Cancel));

        var window = await ca.GetRenewalInfoAsync("blog", Cancel);
        var twoThirds = issued.NotBefore + ((issued.NotAfter - issued.NotBefore) * 2 / 3);
        Assert.InRange(twoThirds, window.WindowStart, window.WindowEnd);

        var renewed = await RunAsync(clock, ca.RenewAsync("blog", progress: null, Cancel));
        Assert.Equal(issued.CertificateId, renewed.Replaced);
        Assert.NotEqual(issued.CertificateId, renewed.CertificateId);

        await ca.RevokeAsync("blog", AcmeRevocationReason.Superseded, Cancel);
        Assert.NotNull((await store.FindAsync("blog", Cancel))!.RevokedAt);
    }

    /// <summary>The pretend CA pauses between steps on the injected clock; this moves it along.</summary>
    private static async Task<T> RunAsync<T>(FakeTimeProvider clock, Task<T> task)
    {
        while (!task.IsCompleted)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(5, Cancel);
        }

        return await task;
    }

    private sealed class Recorder(List<AcmeIssueStep> steps) : IProgress<AcmeIssueProgress>
    {
        public void Report(AcmeIssueProgress value) => steps.Add(value.Step);
    }
}
