using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>
/// The order state machine of RFC 8555 section 7.4 through the low-level client: pending,
/// answered, polled with Retry-After, ready, finalized, processing, valid, downloaded.
/// </summary>
public sealed class AcmeOrderFlowTests : IDisposable
{
    private readonly AcmeTestKit _kit = new();

    [Fact]
    public async Task An_order_runs_from_pending_to_a_downloaded_chain()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var account = await _kit.CreateAccountAsync();
        var order = await _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, cancellationToken);
        Assert.Equal(AcmeStatus.Pending, order.Status);

        var authorization = await _kit.Client.GetAuthorizationAsync(account, Assert.Single(order.Authorizations), cancellationToken);
        Assert.Equal("example.test", authorization.Domain);
        var challenge = authorization.FindChallenge(AcmeChallengeTypes.Http01)!;
        await _kit.Http01.PublishAsync("example.test", challenge.Token!, challenge.KeyAuthorization(account.Key), cancellationToken);
        await _kit.Client.RespondToChallengeAsync(account, challenge, cancellationToken);
        authorization = await _kit.Client.WaitForAuthorizationAsync(account, authorization.Url, cancellationToken);
        Assert.Equal(AcmeStatus.Valid, authorization.Status);

        order = await _kit.Client.WaitForOrderAsync(account, order.Url, cancellationToken);
        Assert.Equal(AcmeStatus.Ready, order.Status);
        using var certificateKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        order = await _kit.Client.FinalizeAsync(account, order, AcmeCsr.Create(["example.test"], certificateKey), cancellationToken);
        order = await _kit.Client.WaitForOrderAsync(account, order.Url, cancellationToken);
        Assert.Equal(AcmeStatus.Valid, order.Status);

        var chain = await _kit.Client.DownloadCertificateAsync(account, order.Certificate!, cancellationToken);

        Assert.Equal(2, chain.Certificates.Count);
        Assert.StartsWith("-----BEGIN CERTIFICATE-----\n", chain.Pem, StringComparison.Ordinal);
        using var leaf = chain.LoadLeaf();
        Assert.Equal(["example.test"], leaf.Extensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames());
        Assert.Equal(new Uri($"{order.Certificate}/alt/1"), Assert.Single(chain.Alternates));
        Assert.Equal("Fake ACME Root X1", chain.TopIssuerName());
        Assert.Equal("application/pem-certificate-chain", _kit.Server.RequestsTo("/cert/").Single().Accept);
    }

    [Fact]
    public async Task The_answer_to_a_challenge_is_an_empty_object()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var account = await _kit.CreateAccountAsync();
        var order = await _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, cancellationToken);
        var authorization = await _kit.Client.GetAuthorizationAsync(account, order.Authorizations[0], cancellationToken);

        await _kit.Client.RespondToChallengeAsync(account, authorization.FindChallenge(AcmeChallengeTypes.Http01)!, cancellationToken);

        Assert.Equal("{}"u8.ToArray(), _kit.Server.RequestsTo("/challenge/").Single().Jws!.Payload);
    }

    [Fact]
    public async Task Resources_are_read_with_post_as_get()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var account = await _kit.CreateAccountAsync();
        var order = await _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, cancellationToken);

        await _kit.Client.GetAuthorizationAsync(account, order.Authorizations[0], cancellationToken);
        await _kit.Client.GetOrderAsync(account, order.Url, cancellationToken);

        var reads = _kit.Server.RequestsTo("/authz/").Concat(_kit.Server.RequestsTo("/order/")).ToList();
        Assert.Equal(2, reads.Count);
        Assert.All(reads, read =>
        {
            Assert.Equal(HttpMethod.Post, read.Method);
            Assert.Equal(string.Empty, read.Jws!.PayloadPart);
            Assert.Equal(account.Url.AbsoluteUri, read.Jws.KeyId);
        });
    }

    [Fact]
    public async Task Polling_waits_as_long_as_retry_after_asks()
    {
        _kit.Server.PendingPollsAfterAnswer = 2;
        _kit.Server.RetryAfterSeconds = 3;
        var (account, _, authorization) = await AnsweredAuthorizationAsync();

        var result = await _kit.RunAsync(_kit.Client.WaitForAuthorizationAsync(account, authorization.Url, TestContext.Current.CancellationToken));

        Assert.Equal(AcmeStatus.Valid, result.Status);
        var polls = _kit.Server.RequestsTo("/authz/").Skip(1).ToList();
        Assert.Equal(3, polls.Count);
        Assert.True(polls[1].At - polls[0].At >= TimeSpan.FromSeconds(3), $"{polls[1].At - polls[0].At}");
        Assert.True(polls[2].At - polls[1].At >= TimeSpan.FromSeconds(3), $"{polls[2].At - polls[1].At}");
        account.Dispose();
    }

    [Fact]
    public async Task Retry_after_as_an_http_date_is_honored_too()
    {
        _kit.Server.PendingPollsAfterAnswer = 1;
        _kit.Server.RetryAfterSeconds = 7;
        _kit.Server.RetryAfterAsDate = true;
        var (account, _, authorization) = await AnsweredAuthorizationAsync();

        await _kit.RunAsync(_kit.Client.WaitForAuthorizationAsync(account, authorization.Url, TestContext.Current.CancellationToken));

        var polls = _kit.Server.RequestsTo("/authz/").Skip(1).ToList();
        Assert.True(polls[1].At - polls[0].At >= TimeSpan.FromSeconds(7), $"{polls[1].At - polls[0].At}");
        account.Dispose();
    }

    [Fact]
    public async Task Polling_gives_up_when_the_ca_takes_too_long()
    {
        using var kit = new AcmeTestKit(new AcmeClientOptions
        {
            DirectoryUrl = FakeAcmeServer.DirectoryUrl,
            PollTimeout = TimeSpan.FromSeconds(20),
        });
        kit.Server.PendingPollsAfterAnswer = 1_000;
        var cancellationToken = TestContext.Current.CancellationToken;
        using var account = await kit.CreateAccountAsync();
        var order = await kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["slow.example"]), replaces: null, cancellationToken);
        var authorization = await kit.Client.GetAuthorizationAsync(account, order.Authorizations[0], cancellationToken);
        await kit.Client.RespondToChallengeAsync(account, authorization.FindChallenge(AcmeChallengeTypes.Http01)!, cancellationToken);

        var error = await Assert.ThrowsAsync<AcmeException>(() =>
            kit.RunAsync(kit.Client.WaitForAuthorizationAsync(account, authorization.Url, cancellationToken)));

        Assert.IsType<TimeoutException>(error.InnerException);
        Assert.Equal("Validating slow.example took longer than 20 seconds.", error.Message);
    }

    [Fact]
    public async Task An_order_that_is_still_processing_is_polled_until_valid()
    {
        _kit.Server.ProcessingPolls = 2;
        var cancellationToken = TestContext.Current.CancellationToken;
        var (account, order, authorization) = await AnsweredAuthorizationAsync();
        await _kit.Client.WaitForAuthorizationAsync(account, authorization.Url, cancellationToken);
        order = await _kit.Client.GetOrderAsync(account, order.Url, cancellationToken);
        using var certificateKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        order = await _kit.Client.FinalizeAsync(account, order, AcmeCsr.Create(["example.test"], certificateKey), cancellationToken);
        Assert.Equal(AcmeStatus.Processing, order.Status);
        Assert.Equal(TimeSpan.FromSeconds(3), order.RetryAfter);
        order = await _kit.RunAsync(_kit.Client.WaitForOrderAsync(account, order.Url, cancellationToken));

        Assert.Equal(AcmeStatus.Valid, order.Status);
        Assert.NotNull(order.Certificate);
        account.Dispose();
    }

    [Fact]
    public async Task Finalizing_too_early_is_an_order_not_ready_error()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var account = await _kit.CreateAccountAsync();
        var order = await _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, cancellationToken);
        using var certificateKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var error = await Assert.ThrowsAsync<AcmeProblemException>(() =>
            _kit.Client.FinalizeAsync(account, order, AcmeCsr.Create(["example.test"], certificateKey), cancellationToken));

        Assert.Equal(AcmeErrorType.OrderNotReady, error.ErrorType);
        Assert.StartsWith("Finalizing the order failed (orderNotReady):", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_token_that_is_not_base64url_is_refused_before_it_reaches_a_webroot()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var account = await _kit.CreateAccountAsync();
        _kit.Server.Intercept = (request, _) => Task.FromResult(request.Path.StartsWith("/authz/", StringComparison.Ordinal)
            ? new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"status":"pending","identifier":{"type":"dns","value":"example.test"},"challenges":[{"type":"http-01","url":"https://acme.test/challenge/1","token":"../../etc/passwd","status":"pending"}]}""",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            }
            : null);

        var error = await Assert.ThrowsAsync<AcmeException>(() =>
            _kit.Client.GetAuthorizationAsync(account, new Uri("https://acme.test/authz/1"), cancellationToken));

        Assert.Contains("base64url", error.Message, StringComparison.Ordinal);
    }

    public void Dispose() => _kit.Dispose();

    private async Task<(AcmeAccount Account, AcmeOrder Order, AcmeAuthorization Authorization)> AnsweredAuthorizationAsync()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var account = await _kit.CreateAccountAsync();
        var order = await _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, cancellationToken);
        var authorization = await _kit.Client.GetAuthorizationAsync(account, order.Authorizations[0], cancellationToken);
        var challenge = authorization.FindChallenge(AcmeChallengeTypes.Http01)!;
        await _kit.Http01.PublishAsync("example.test", challenge.Token!, challenge.KeyAuthorization(account.Key), cancellationToken);
        await _kit.Client.RespondToChallengeAsync(account, challenge, cancellationToken);
        return (account, order, authorization);
    }
}
