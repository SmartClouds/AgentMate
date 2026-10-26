using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>
/// Issuance end to end against the fake CA: the account from the store, challenges published and
/// cleaned up, the CSR, the chain, the stored result, renewal with "replaces", revocation and ARI.
/// </summary>
public sealed class AcmeIssuerTests : IDisposable
{
    private static readonly AcmeAccountSettings _settings = new(["admin@example.test"], TermsOfServiceAgreed: true);

    private readonly AcmeTestKit _kit = new();

    [Fact]
    public async Task An_account_is_registered_once_and_kept_in_the_store()
    {
        var issuer = _kit.CreateIssuer();

        using (var first = await issuer.EnsureAccountAsync(_settings, TestContext.Current.CancellationToken))
        using (var second = await issuer.EnsureAccountAsync(_settings, TestContext.Current.CancellationToken))
        {
            Assert.Equal(first.Url, second.Url);
            Assert.Equal(first.Key.Thumbprint, second.Key.Thumbprint);
        }

        Assert.Single(_kit.Server.RequestsTo("/new-account"));
        using var stored = await _kit.Accounts.FindAsync(FakeAcmeServer.DirectoryUrl, TestContext.Current.CancellationToken);
        Assert.NotNull(stored);
    }

    [Fact]
    public async Task Issuing_before_there_is_an_account_says_so()
    {
        var issuer = _kit.CreateIssuer();

        var error = await Assert.ThrowsAsync<AcmeException>(() => issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken));

        Assert.Contains("No ACME account", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_certificate_is_issued_for_every_domain_and_stored_with_its_key()
    {
        var issuer = await IssuerWithAccountAsync();

        var record = await issuer.IssueAsync(Request("example.test", "www.example.test"), progress: null, TestContext.Current.CancellationToken);

        Assert.Equal("site-1", record.Name);
        Assert.Equal(["example.test", "www.example.test"], record.Domains);
        Assert.Equal(AcmeCertificateKeyType.EcdsaP256, record.KeyType);
        Assert.Equal(FakeAcmeServer.DirectoryUrl, record.DirectoryUrl);
        Assert.Null(record.Replaced);
        var chain = LoadChain(record.ChainPem);
        Assert.Equal(2, chain.Count);
        Assert.Equal(_kit.Server.CertificateIdOf(chain[0].RawData), record.CertificateId);
        Assert.Equal(["example.test", "www.example.test"], chain[0].Extensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames());
        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(record.PrivateKeyPkcs8.Span, out _);
        Assert.Equal(key.ExportSubjectPublicKeyInfo(), chain[0].PublicKey.ExportSubjectPublicKeyInfo());
        Assert.Equal(_kit.Clock.GetUtcNow().AddDays(90), record.NotAfter, TimeSpan.FromSeconds(1));
        Assert.Equal(_kit.Clock.GetUtcNow(), record.IssuedAt);
        Assert.Same(record, await _kit.Certificates.FindAsync("site-1", TestContext.Current.CancellationToken));
        Assert.Equal(0, _kit.Http01.Count);
        Assert.DoesNotContain(_kit.Server.RequestsTo("/challenge/"), request => request.Status != HttpStatusCode.OK);
    }

    [Fact]
    public async Task Progress_names_each_step_and_each_domain()
    {
        var issuer = await IssuerWithAccountAsync();
        var steps = new List<AcmeIssueProgress>();

        await issuer.IssueAsync(Request("example.test", "www.example.test"), new SynchronousProgress(steps.Add), TestContext.Current.CancellationToken);

        Assert.Equal(
            [
                new AcmeIssueProgress(AcmeIssueStep.Ordering),
                new AcmeIssueProgress(AcmeIssueStep.PublishingChallenge, "example.test"),
                new AcmeIssueProgress(AcmeIssueStep.PublishingChallenge, "www.example.test"),
                new AcmeIssueProgress(AcmeIssueStep.Validating, "example.test"),
                new AcmeIssueProgress(AcmeIssueStep.Validating, "www.example.test"),
                new AcmeIssueProgress(AcmeIssueStep.Finalizing),
                new AcmeIssueProgress(AcmeIssueStep.Downloading),
                new AcmeIssueProgress(AcmeIssueStep.Saving),
            ],
            steps);
    }

    [Fact]
    public async Task A_wildcard_is_validated_over_dns01_next_to_its_base_name_on_one_record()
    {
        var issuer = await IssuerWithAccountAsync();
        var mostValues = 0;
        _kit.Server.Intercept = (request, _) =>
        {
            mostValues = Math.Max(mostValues, _kit.Dns01.Find("_acme-challenge.example.test").Count);
            return Task.FromResult<HttpResponseMessage?>(null);
        };

        var record = await issuer.IssueAsync(Request("example.test", "*.example.test") with { PreferDns01 = true }, progress: null, TestContext.Current.CancellationToken);

        Assert.Equal(["example.test", "*.example.test"], record.Domains);
        Assert.Equal(2, mostValues);
        Assert.Equal(0, _kit.Dns01.Count);
        Assert.Equal(0, _kit.Http01.Count);
    }

    [Fact]
    public async Task A_wildcard_needs_dns01_even_when_http01_is_preferred()
    {
        var issuer = await IssuerWithAccountAsync();

        await issuer.IssueAsync(Request("example.test", "*.example.test"), progress: null, TestContext.Current.CancellationToken);

        var answered = _kit.Server.RequestsTo("/challenge/").Count;
        Assert.Equal(2, answered);
        Assert.Equal(0, _kit.Dns01.Count);
    }

    [Fact]
    public async Task Without_a_dns_hook_a_wildcard_cannot_be_validated()
    {
        var issuer = await IssuerWithAccountAsync(withDns01: false);

        var error = await Assert.ThrowsAsync<AcmeException>(() =>
            issuer.IssueAsync(Request("*.example.test"), progress: null, TestContext.Current.CancellationToken));

        Assert.Contains("*.example.test", error.Message, StringComparison.Ordinal);
        Assert.Contains("no challenge", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Authorizations_the_ca_still_holds_are_not_answered_again()
    {
        _kit.Server.ReuseValidAuthorizations = true;
        var issuer = await IssuerWithAccountAsync();
        await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);
        var answeredBefore = _kit.Server.RequestsTo("/challenge/").Count;

        await issuer.IssueAsync(Request("example.test") with { Name = "site-2" }, progress: null, TestContext.Current.CancellationToken);

        Assert.Equal(answeredBefore, _kit.Server.RequestsTo("/challenge/").Count);
    }

    [Fact]
    public async Task A_failed_validation_names_the_domain_and_what_the_ca_saw_and_still_cleans_up()
    {
        var publisher = new WrongAnswerPublisher(_kit.Http01, "www.example.test");
        var issuer = new AcmeIssuer(
            _kit.Client,
            _kit.Accounts,
            _kit.Certificates,
            publisher,
            _kit.Dns01,
            _kit.Clock,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<AcmeIssuer>.Instance);
        (await issuer.EnsureAccountAsync(_settings, TestContext.Current.CancellationToken)).Dispose();

        var error = await Assert.ThrowsAsync<AcmeValidationException>(() =>
            issuer.IssueAsync(Request("example.test", "www.example.test"), progress: null, TestContext.Current.CancellationToken));

        Assert.Equal("www.example.test", error.Domain);
        Assert.Equal(AcmeChallengeTypes.Http01, error.ChallengeType);
        Assert.Equal(AcmeErrorType.IncorrectResponse, error.ErrorType);
        Assert.StartsWith("Validating www.example.test over http-01 failed (incorrectResponse):", error.Message, StringComparison.Ordinal);
        Assert.Equal(0, _kit.Http01.Count);
        Assert.Null(await _kit.Certificates.FindAsync("site-1", TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_authorization_that_is_already_dead_is_reported_without_answering_anything()
    {
        var issuer = await IssuerWithAccountAsync();
        _kit.Server.Intercept = (request, _) => Task.FromResult(request.Path.StartsWith("/authz/", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"status":"expired","identifier":{"type":"dns","value":"example.test"},"challenges":[]}""",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            }
            : null);

        var error = await Assert.ThrowsAsync<AcmeValidationException>(() =>
            issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken));

        Assert.Equal("Validating example.test failed: The CA's authorization for it is expired.", error.Message);
        Assert.Empty(_kit.Server.RequestsTo("/challenge/"));
        Assert.Equal(0, _kit.Http01.Count);
    }

    [Fact]
    public async Task A_renewal_sends_replaces_for_the_stored_certificate()
    {
        var issuer = await IssuerWithAccountAsync();
        var first = await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);

        var renewed = await issuer.RenewAsync("site-1", progress: null, TestContext.Current.CancellationToken);

        var order = _kit.Server.RequestsTo("/new-order")[^1].Payload!.Value;
        Assert.Equal(first.CertificateId, order.GetProperty("replaces").GetString());
        Assert.Equal(first.CertificateId, renewed.Replaced);
        Assert.NotEqual(first.CertificateId, renewed.CertificateId);
        Assert.Same(renewed, await _kit.Certificates.FindAsync("site-1", TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task When_the_ca_already_has_a_replacement_the_renewal_orders_without_replaces()
    {
        var issuer = await IssuerWithAccountAsync();
        var first = await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);
        await issuer.RenewAsync("site-1", progress: null, TestContext.Current.CancellationToken);

        // As if saving the renewal had failed: the store still holds the replaced certificate.
        await _kit.Certificates.SaveAsync(first, TestContext.Current.CancellationToken);
        var renewed = await issuer.RenewAsync("site-1", progress: null, TestContext.Current.CancellationToken);

        var orders = _kit.Server.RequestsTo("/new-order").TakeLast(2).ToList();
        Assert.Equal("alreadyReplaced", orders[0].ErrorType);
        Assert.Equal(first.CertificateId, orders[0].Payload!.Value.GetProperty("replaces").GetString());
        Assert.False(orders[1].Payload!.Value.TryGetProperty("replaces", out _));
        Assert.Null(renewed.Replaced);
    }

    [Fact]
    public async Task No_replaces_is_sent_to_a_ca_without_renewal_information()
    {
        _kit.Server.OfferRenewalInfo = false;
        var issuer = await IssuerWithAccountAsync();
        await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);

        var renewed = await issuer.RenewAsync("site-1", progress: null, TestContext.Current.CancellationToken);

        Assert.False(_kit.Server.RequestsTo("/new-order")[^1].Payload!.Value.TryGetProperty("replaces", out _));
        Assert.Null(renewed.Replaced);
    }

    [Fact]
    public async Task The_preferred_chain_is_picked_among_the_alternates_and_kept_for_renewals()
    {
        var issuer = await IssuerWithAccountAsync();

        var record = await issuer.IssueAsync(
            Request("example.test") with { PreferredChain = _kit.Server.AlternateRootName },
            progress: null,
            TestContext.Current.CancellationToken);
        var renewed = await issuer.RenewAsync("site-1", progress: null, TestContext.Current.CancellationToken);

        foreach (var pem in new[] { record.ChainPem, renewed.ChainPem })
        {
            var chain = LoadChain(pem);
            Assert.Equal(_kit.Server.AlternateRoot.SubjectName.Name, chain[^1].IssuerName.Name);
            Assert.True(Verifies(chain, _kit.Server.AlternateRoot));
        }

        Assert.Equal(_kit.Server.AlternateRootName, renewed.PreferredChain);
    }

    [Fact]
    public async Task A_preferred_chain_the_ca_does_not_offer_leaves_the_default_chain()
    {
        var issuer = await IssuerWithAccountAsync();

        var record = await issuer.IssueAsync(Request("example.test") with { PreferredChain = "Nobody's Root" }, progress: null, TestContext.Current.CancellationToken);

        var chain = LoadChain(record.ChainPem);
        Assert.True(Verifies(chain, _kit.Server.Root));
    }

    [Fact]
    public async Task A_certificate_for_another_key_is_refused()
    {
        var issuer = await IssuerWithAccountAsync();
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var other = new CertificateRequest("CN=example.test", otherKey, HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(1));
        _kit.Server.Intercept = (request, _) => Task.FromResult(request.Path.StartsWith("/cert/", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(PemEncoding.WriteString("CERTIFICATE", other.RawData)) }
            : null);

        var error = await Assert.ThrowsAsync<AcmeException>(() => issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken));

        Assert.Contains("does not match", error.Message, StringComparison.Ordinal);
        Assert.Null(await _kit.Certificates.FindAsync("site-1", TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_revoked_certificate_is_marked_and_its_window_moves_to_the_past()
    {
        var issuer = await IssuerWithAccountAsync();
        var issued = await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);
        var before = await issuer.GetRenewalInfoAsync("site-1", TestContext.Current.CancellationToken);

        await issuer.RevokeAsync("site-1", AcmeRevocationReason.Superseded, TestContext.Current.CancellationToken);

        var record = await _kit.Certificates.FindAsync("site-1", TestContext.Current.CancellationToken);
        Assert.Equal(_kit.Clock.GetUtcNow(), record!.RevokedAt);
        Assert.True(_kit.Server.IsRevoked(issued.CertificateId));
        Assert.Equal(4, _kit.Server.RequestsTo("/revoke-cert").Single().Payload!.Value.GetProperty("reason").GetInt32());
        Assert.True(before.WindowStart > _kit.Clock.GetUtcNow().AddDays(50));
        var after = await issuer.GetRenewalInfoAsync("site-1", TestContext.Current.CancellationToken);
        Assert.True(after.WindowEnd < _kit.Clock.GetUtcNow());
        var again = await Assert.ThrowsAsync<AcmeProblemException>(() =>
            issuer.RevokeAsync("site-1", AcmeRevocationReason.Superseded, TestContext.Current.CancellationToken));
        Assert.Equal(AcmeErrorType.AlreadyRevoked, again.ErrorType);
    }

    [Fact]
    public async Task A_name_that_was_never_issued_cannot_be_renewed_or_revoked()
    {
        var issuer = await IssuerWithAccountAsync();

        await Assert.ThrowsAsync<AcmeException>(() => issuer.RenewAsync("nothing", progress: null, TestContext.Current.CancellationToken));
        await Assert.ThrowsAsync<AcmeException>(() => issuer.RevokeAsync("nothing", AcmeRevocationReason.Unspecified, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task The_account_key_rolls_over_and_the_store_keeps_the_new_one()
    {
        var issuer = await IssuerWithAccountAsync();
        string before;
        using (var account = await _kit.Accounts.FindAsync(FakeAcmeServer.DirectoryUrl, TestContext.Current.CancellationToken))
        {
            before = account!.Key.Thumbprint;
        }

        await issuer.RollOverAccountKeyAsync(TestContext.Current.CancellationToken);

        using (var account = await _kit.Accounts.FindAsync(FakeAcmeServer.DirectoryUrl, TestContext.Current.CancellationToken))
        {
            Assert.NotEqual(before, account!.Key.Thumbprint);
        }

        var record = await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);
        Assert.NotNull(record);
    }

    [Fact]
    public async Task A_record_never_prints_its_private_key()
    {
        var issuer = await IssuerWithAccountAsync();
        var record = await issuer.IssueAsync(Request("example.test"), progress: null, TestContext.Current.CancellationToken);

        var text = record.ToString();

        Assert.Contains("site-1", text, StringComparison.Ordinal);
        Assert.DoesNotContain(Convert.ToBase64String(record.PrivateKeyPkcs8.Span), text, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE", text, StringComparison.Ordinal);
    }

    public void Dispose() => _kit.Dispose();

    private static AcmeIssueRequest Request(params string[] domains) => new() { Name = "site-1", Domains = domains };

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
        builder.ChainPolicy.VerificationTime = chain[0].NotBefore.AddHours(1);
        builder.ChainPolicy.ExtraStore.AddRange(chain.Skip(1).ToArray());
        return builder.Build(chain[0]);
    }

    private async Task<AcmeIssuer> IssuerWithAccountAsync(bool withDns01 = true)
    {
        var issuer = _kit.CreateIssuer(withDns01: withDns01);
        (await issuer.EnsureAccountAsync(_settings, TestContext.Current.CancellationToken)).Dispose();
        return issuer;
    }

    /// <summary>IProgress without a synchronization context, so reports arrive in order.</summary>
    private sealed class SynchronousProgress(Action<AcmeIssueProgress> report) : IProgress<AcmeIssueProgress>
    {
        public void Report(AcmeIssueProgress value) => report(value);
    }

    /// <summary>Publishes a wrong key authorization for one domain, like a webroot serving a stale file.</summary>
    private sealed class WrongAnswerPublisher(InMemoryHttp01ChallengePublisher inner, string wrongFor) : IHttp01ChallengePublisher
    {
        public Task PublishAsync(string domain, string token, string keyAuthorization, CancellationToken cancellationToken) =>
            inner.PublishAsync(domain, token, domain == wrongFor ? "stale" : keyAuthorization, cancellationToken);

        public Task RemoveAsync(string domain, string token, CancellationToken cancellationToken) =>
            inner.RemoveAsync(domain, token, cancellationToken);
    }
}
