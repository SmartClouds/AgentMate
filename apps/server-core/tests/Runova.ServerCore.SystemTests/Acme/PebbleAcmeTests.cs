using System.Diagnostics;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.SystemTests.Acme;

/// <summary>
/// The ACME client against Let's Encrypt's Pebble (E11 acceptance criterion 1): issue, check the
/// chain, renew with "replaces", revoke; DNS-01 for a wildcard; alternate chains; key rollover.
/// Pebble rejects 5% of valid nonces on purpose, so every run also covers the badNonce retry.
/// </summary>
public sealed class PebbleAcmeTests(PebbleFixture pebble, ITestOutputHelper output) : IClassFixture<PebbleFixture>
{
    private static readonly AcmeAccountSettings _account = new(["admin@runova.test"], TermsOfServiceAgreed: true);

    [Fact]
    public async Task A_certificate_is_issued_renewed_with_replaces_and_revoked()
    {
        Assert.SkipWhen(pebble.SkipReason is not null, pebble.SkipReason ?? string.Empty);
        var cancellationToken = TestContext.Current.CancellationToken;
        var watch = Stopwatch.StartNew();
        var accounts = new InMemoryAcmeAccountStore();
        var issuer = CreateIssuer(accounts, out var client);
        (await issuer.EnsureAccountAsync(_account, cancellationToken)).Dispose();

        var first = await issuer.IssueAsync(
            new AcmeIssueRequest { Name = "site", Domains = ["pebble.runova.test", "www.pebble.runova.test"] },
            progress: null,
            cancellationToken);

        using var root = await pebble.GetRootAsync(0, cancellationToken);
        var chain = LoadChain(first.ChainPem);
        Assert.True(chain.Count >= 2);
        Assert.True(Verifies(chain, root));
        Assert.Equal(
            ["pebble.runova.test", "www.pebble.runova.test"],
            chain[0].Extensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames().Order(StringComparer.Ordinal));
        Assert.InRange(first.NotAfter - first.NotBefore, TimeSpan.FromDays(90) - TimeSpan.FromMinutes(1), TimeSpan.FromDays(90));

        var window = await issuer.GetRenewalInfoAsync("site", cancellationToken);
        Assert.InRange(window.WindowStart, first.NotBefore, first.NotAfter);
        Assert.InRange(window.WindowEnd, window.WindowStart, first.NotAfter);
        Assert.Equal(TimeSpan.FromHours(6), window.RetryAfter);

        var renewed = await issuer.RenewAsync("site", progress: null, cancellationToken);

        Assert.Equal(first.CertificateId, renewed.Replaced);
        Assert.NotEqual(first.CertificateId, renewed.CertificateId);
        Assert.True(Verifies(LoadChain(renewed.ChainPem), root));

        // Pebble recorded the replacement: claiming to replace the first certificate again fails.
        using (var account = await accounts.FindAsync(client.DirectoryUrl, cancellationToken))
        {
            var refused = await ReplaceAgainAsync(client, account!, first.CertificateId, cancellationToken);
            Assert.Equal(AcmeErrorType.AlreadyReplaced, refused.ErrorType);
        }

        await issuer.RevokeAsync("site", AcmeRevocationReason.Superseded, cancellationToken);

        var again = await Assert.ThrowsAsync<AcmeProblemException>(() =>
            issuer.RevokeAsync("site", AcmeRevocationReason.Superseded, cancellationToken));
        Assert.Equal(AcmeErrorType.AlreadyRevoked, again.ErrorType);
        var afterRevocation = await issuer.GetRenewalInfoAsync("site", cancellationToken);
        Assert.True(afterRevocation.WindowStart <= DateTimeOffset.UtcNow.AddMinutes(1), $"{afterRevocation.WindowStart}");
        output.WriteLine($"Issue, renew and revoke against Pebble took {watch.Elapsed.TotalSeconds:0.0} s.");
    }

    [Fact]
    public async Task A_wildcard_is_validated_over_dns01_and_the_alternate_chain_can_be_preferred()
    {
        Assert.SkipWhen(pebble.SkipReason is not null, pebble.SkipReason ?? string.Empty);
        var cancellationToken = TestContext.Current.CancellationToken;
        var issuer = CreateIssuer(new InMemoryAcmeAccountStore(), out _);
        (await issuer.EnsureAccountAsync(_account, cancellationToken)).Dispose();
        using var defaultRoot = await pebble.GetRootAsync(0, cancellationToken);
        using var alternateRoot = await pebble.GetRootAsync(1, cancellationToken);

        var record = await issuer.IssueAsync(
            new AcmeIssueRequest
            {
                Name = "wild",
                Domains = ["wild.runova.test", "*.wild.runova.test"],
                PreferredChain = alternateRoot.GetNameInfo(X509NameType.SimpleName, forIssuer: false),
            },
            progress: null,
            cancellationToken);

        var chain = LoadChain(record.ChainPem);
        Assert.Contains("*.wild.runova.test", chain[0].Extensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames());
        Assert.True(Verifies(chain, alternateRoot));
        Assert.False(Verifies(chain, defaultRoot));
    }

    [Fact]
    public async Task The_account_key_rolls_over_and_the_new_key_orders()
    {
        Assert.SkipWhen(pebble.SkipReason is not null, pebble.SkipReason ?? string.Empty);
        var cancellationToken = TestContext.Current.CancellationToken;
        var accounts = new InMemoryAcmeAccountStore();
        var issuer = CreateIssuer(accounts, out var client);
        string before;
        using (var account = await issuer.EnsureAccountAsync(_account, cancellationToken))
        {
            before = account.Key.Thumbprint;
        }

        await issuer.RollOverAccountKeyAsync(cancellationToken);

        using (var rolled = await accounts.FindAsync(client.DirectoryUrl, cancellationToken))
        {
            Assert.NotEqual(before, rolled!.Key.Thumbprint);
            using var found = await client.FindAccountAsync(AcmeAccountKey.FromPkcs8(rolled.Key.ExportPkcs8()), cancellationToken);
            Assert.Equal(rolled.Url, found!.Url);
        }

        var record = await issuer.IssueAsync(new AcmeIssueRequest { Name = "rolled", Domains = ["rolled.runova.test"] }, progress: null, cancellationToken);
        Assert.Equal(["rolled.runova.test"], record.Domains);
    }

    private static List<X509Certificate2> LoadChain(string pem)
    {
        var collection = new X509Certificate2Collection();
        collection.ImportFromPem(pem);
        return [.. collection];
    }

    private static bool Verifies(List<X509Certificate2> chain, X509Certificate2 root)
    {
        using var builder = new X509Chain();
        builder.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        builder.ChainPolicy.CustomTrustStore.Add(root);
        builder.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        builder.ChainPolicy.ExtraStore.AddRange(chain.Skip(1).ToArray());
        return builder.Build(chain[0]);
    }

    /// <summary>
    /// Pebble marks a certificate replaced just after it finishes the replacement, on a goroutine
    /// of its own, so the refusal is given a moment to appear.
    /// </summary>
    private static async Task<AcmeProblemException> ReplaceAgainAsync(
        AcmeClient client,
        AcmeAccount account,
        string certificateId,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["pebble.runova.test"]), certificateId, cancellationToken);
            }
            catch (AcmeProblemException error) when (error.ErrorType == AcmeErrorType.AlreadyReplaced || attempt == 5)
            {
                return error;
            }

            if (attempt == 5)
            {
                throw new InvalidOperationException("Pebble accepted a second replacement of the same certificate.");
            }

            await Task.Delay(TimeSpan.FromMilliseconds(500), cancellationToken);
        }
    }

    private AcmeIssuer CreateIssuer(InMemoryAcmeAccountStore accounts, out AcmeClient client)
    {
        client = pebble.CreateClient();
        return new AcmeIssuer(
            client,
            accounts,
            new InMemoryAcmeCertificateStore(),
            pebble.Challenges,
            pebble.Challenges,
            TimeProvider.System,
            NullLogger<AcmeIssuer>.Instance);
    }
}
