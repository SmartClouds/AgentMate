using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>
/// How the client talks to a CA: the directory, nonces and badNonce retries (RFC 8555 section
/// 6.5), accounts and key changes, and what it refuses (redirects, plain HTTP, oversized or late
/// answers).
/// </summary>
public sealed class AcmeClientTests : IDisposable
{
    private readonly AcmeTestKit _kit = new();

    [Fact]
    public async Task The_directory_is_read_once_and_kept()
    {
        var first = await _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken);
        var second = await _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken);

        Assert.Same(first, second);
        Assert.Single(_kit.Server.RequestsTo("/directory"));
        Assert.Equal(new Uri("https://acme.test/new-order"), first.NewOrder);
        Assert.Equal(new Uri("https://acme.test/renewal-info"), first.RenewalInfo);
        Assert.Equal(FakeAcmeServer.TermsUrl, first.TermsOfService);
        Assert.Equal(["classic", "shortlived"], first.Profiles);
        Assert.Equal(["acme.test"], first.CaaIdentities);
    }

    [Fact]
    public async Task Every_request_names_the_client_and_signed_ones_use_the_bare_jose_content_type()
    {
        using var account = await _kit.CreateAccountAsync();

        Assert.All(_kit.Server.Requests, request => Assert.StartsWith("runova-core/", request.UserAgent, StringComparison.Ordinal));
        var post = Assert.Single(_kit.Server.RequestsTo("/new-account"));
        Assert.Equal("application/jose+json", post.ContentType);
        Assert.Equal(HttpStatusCode.Created, post.Status);
    }

    [Fact]
    public async Task A_new_account_agrees_to_the_terms_and_gives_its_contact()
    {
        using var account = await _kit.CreateAccountAsync();

        var payload = _kit.Server.RequestsTo("/new-account").Single().Payload!.Value;
        Assert.True(payload.GetProperty("termsOfServiceAgreed").GetBoolean());
        Assert.Equal("mailto:admin@example.test", payload.GetProperty("contact")[0].GetString());
        Assert.Equal(new Uri("https://acme.test/account/1"), account.Url);
        Assert.Equal(AcmeStatus.Valid, account.Status);
        Assert.Equal(FakeAcmeServer.DirectoryUrl, account.DirectoryUrl);
    }

    [Fact]
    public async Task No_account_is_created_until_the_terms_of_service_are_accepted()
    {
        using var key = AcmeAccountKey.Generate();

        var error = await Assert.ThrowsAsync<AcmeException>(() =>
            _kit.Client.CreateAccountAsync(key, [], termsOfServiceAgreed: false, TestContext.Current.CancellationToken));

        Assert.Contains(FakeAcmeServer.TermsUrl.AbsoluteUri, error.Message, StringComparison.Ordinal);
        Assert.Empty(_kit.Server.RequestsTo("/new-account"));
    }

    [Theory]
    [InlineData("not an address")]
    [InlineData("a@b.test,c@d.test")]
    [InlineData("admin@example.test?subject=hi")]
    [InlineData("")]
    public async Task Contact_addresses_must_be_plain_email_addresses(string email)
    {
        using var key = AcmeAccountKey.Generate();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            _kit.Client.CreateAccountAsync(key, [email], termsOfServiceAgreed: true, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_account_is_found_again_by_its_key()
    {
        using var account = await _kit.CreateAccountAsync();
        using var sameKey = AcmeAccountKey.FromPkcs8(account.Key.ExportPkcs8());
        using var otherKey = AcmeAccountKey.Generate();

        using var found = await _kit.Client.FindAccountAsync(sameKey, TestContext.Current.CancellationToken);
        var missing = await _kit.Client.FindAccountAsync(otherKey, TestContext.Current.CancellationToken);

        Assert.Equal(account.Url, found!.Url);
        Assert.Null(missing);
    }

    [Fact]
    public async Task Nonces_from_earlier_answers_are_used_so_new_nonce_is_asked_only_once()
    {
        using var account = await _kit.CreateAccountAsync();

        await _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, TestContext.Current.CancellationToken);

        Assert.Single(_kit.Server.RequestsTo("/new-nonce"));
        Assert.Equal(HttpMethod.Head, _kit.Server.RequestsTo("/new-nonce")[0].Method);
    }

    [Fact]
    public async Task A_bad_nonce_is_retried_with_the_nonce_from_the_error()
    {
        _kit.Server.RejectValidNonces = 2;

        using var account = await _kit.CreateAccountAsync();

        var posts = _kit.Server.RequestsTo("/new-account");
        Assert.Equal(3, posts.Count);
        Assert.Equal("badNonce", posts[0].ErrorType);
        Assert.Equal("badNonce", posts[1].ErrorType);
        Assert.Equal(posts[0].ResponseNonce, posts[1].Jws!.Nonce);
        Assert.Equal(posts[1].ResponseNonce, posts[2].Jws!.Nonce);
        Assert.Equal(HttpStatusCode.Created, posts[2].Status);
    }

    [Fact]
    public async Task Bad_nonces_are_not_retried_forever()
    {
        _kit.Server.RejectValidNonces = 100;
        using var key = AcmeAccountKey.Generate();

        var error = await Assert.ThrowsAsync<AcmeProblemException>(() =>
            _kit.Client.CreateAccountAsync(key, [], termsOfServiceAgreed: true, TestContext.Current.CancellationToken));

        Assert.Equal(AcmeErrorType.BadNonce, error.ErrorType);
        Assert.Equal(1 + _kit.Options.BadNonceRetries, _kit.Server.RequestsTo("/new-account").Count);
    }

    [Fact]
    public async Task A_rate_limit_says_when_to_try_again_from_retry_after_seconds()
    {
        using var account = await _kit.CreateAccountAsync();
        _kit.Server.Intercept = (request, _) => Task.FromResult(request.Path == "/new-order" ? RateLimited(TimeSpan.FromHours(1)) : null);

        var error = await Assert.ThrowsAsync<AcmeRateLimitedException>(() =>
            _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, TestContext.Current.CancellationToken));

        Assert.Equal(_kit.Clock.GetUtcNow().AddHours(1), error.RetryAt);
        Assert.Equal(HttpStatusCode.TooManyRequests, error.StatusCode);
        Assert.Contains("too many certificates for example.test", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_rate_limit_says_when_to_try_again_from_a_retry_after_date()
    {
        using var account = await _kit.CreateAccountAsync();
        var at = new DateTimeOffset(2026, 10, 3, 9, 15, 0, TimeSpan.Zero);
        _kit.Server.Intercept = (request, _) =>
        {
            if (request.Path != "/new-order")
            {
                return Task.FromResult<HttpResponseMessage?>(null);
            }

            var response = RateLimited(TimeSpan.Zero);
            response.Headers.RetryAfter = new RetryConditionHeaderValue(at);
            return Task.FromResult<HttpResponseMessage?>(response);
        };

        var error = await Assert.ThrowsAsync<AcmeRateLimitedException>(() =>
            _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, TestContext.Current.CancellationToken));

        Assert.Equal(at, error.RetryAt);
    }

    [Fact]
    public async Task A_redirect_is_refused_rather_than_followed()
    {
        _kit.Server.Intercept = (request, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Found);
            response.Headers.Location = new Uri("https://elsewhere.test/directory");
            return Task.FromResult<HttpResponseMessage?>(response);
        };

        var error = await Assert.ThrowsAsync<AcmeException>(() => _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken));

        Assert.Contains("redirect", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_answer_larger_than_the_limit_is_refused()
    {
        _kit.Server.Intercept = (_, _) => Task.FromResult<HttpResponseMessage?>(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(new MemoryStream(new byte[_kit.Options.MaxResponseBytes + 1])),
        });

        var error = await Assert.ThrowsAsync<AcmeException>(() => _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken));

        Assert.Contains("larger than", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_url_that_is_not_https_is_refused()
    {
        _kit.Server.Intercept = (_, _) => Task.FromResult<HttpResponseMessage?>(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"newNonce":"http://acme.test/new-nonce","newAccount":"https://acme.test/a","newOrder":"https://acme.test/o","revokeCert":"https://acme.test/r"}""",
                Encoding.UTF8,
                "application/json"),
        });

        var error = await Assert.ThrowsAsync<AcmeException>(() => _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken));

        Assert.Contains("HTTPS", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_directory_that_is_not_https_is_refused_up_front()
    {
        Assert.Throws<ArgumentException>(() => new AcmeClientOptions { DirectoryUrl = new Uri("http://acme.test/directory") }.Validate());
    }

    [Fact]
    public async Task A_request_that_gets_no_answer_times_out_on_the_clock()
    {
        var waiting = new TaskCompletionSource();
        _kit.Server.Intercept = async (_, cancellationToken) =>
        {
            waiting.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return null;
        };

        var call = _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken);
        await waiting.Task.WaitAsync(TestContext.Current.CancellationToken);
        _kit.Clock.Advance(_kit.Options.RequestTimeout);

        var error = await Assert.ThrowsAsync<AcmeException>(() => call);
        Assert.IsType<TimeoutException>(error.InnerException);
        Assert.Contains("did not answer within 30 seconds", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Cancelling_is_not_reported_as_a_timeout()
    {
        using var cancel = new CancellationTokenSource();
        _kit.Server.Intercept = async (_, cancellationToken) =>
        {
            await cancel.CancelAsync();
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return null;
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _kit.Client.GetDirectoryAsync(cancel.Token));
    }

    [Fact]
    public async Task An_error_without_a_problem_document_still_says_what_failed()
    {
        _kit.Server.Intercept = (_, _) => Task.FromResult<HttpResponseMessage?>(new HttpResponseMessage(HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html>upstream down</html>", Encoding.UTF8, "text/html"),
        });

        var error = await Assert.ThrowsAsync<AcmeProblemException>(() => _kit.Client.GetDirectoryAsync(TestContext.Current.CancellationToken));

        Assert.Equal(HttpStatusCode.BadGateway, error.StatusCode);
        Assert.Equal("Reading the ACME directory failed (HTTP 502): The CA answered 502 Bad Gateway.", error.Message);
    }

    [Fact]
    public async Task A_refusal_over_the_terms_of_service_points_at_them()
    {
        using var key = AcmeAccountKey.Generate();
        _kit.Server.Intercept = (request, _) =>
        {
            if (request.Path != "/new-account")
            {
                return Task.FromResult<HttpResponseMessage?>(null);
            }

            var response = FakeAcmeServer.ProblemResponse(HttpStatusCode.Forbidden, "userActionRequired", "Terms changed");
            response.Headers.TryAddWithoutValidation("Link", "<https://acme.test/terms/v2>;rel=\"terms-of-service\"");
            return Task.FromResult<HttpResponseMessage?>(response);
        };

        var error = await Assert.ThrowsAsync<AcmeProblemException>(() =>
            _kit.Client.CreateAccountAsync(key, [], termsOfServiceAgreed: true, TestContext.Current.CancellationToken));

        Assert.Equal(AcmeErrorType.UserActionRequired, error.ErrorType);
        Assert.Contains("https://acme.test/terms/v2", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_account_key_can_be_rolled_over()
    {
        using var account = await _kit.CreateAccountAsync();
        var newKey = AcmeAccountKey.Generate();

        using var rolled = await _kit.Client.ChangeKeyAsync(account, newKey, TestContext.Current.CancellationToken);

        Assert.Equal(account.Url, rolled.Url);
        Assert.Same(newKey, rolled.Key);
        var inner = JwsReader.Parse(_kit.Server.RequestsTo("/key-change").Single().Jws!.Payload);
        Assert.Null(inner.Nonce);
        Assert.Equal(account.Url.AbsoluteUri, inner.PayloadJson.GetProperty("account").GetString());
        var order = await _kit.Client.NewOrderAsync(rolled, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, TestContext.Current.CancellationToken);
        Assert.Equal(AcmeStatus.Pending, order.Status);
        var refused = await Assert.ThrowsAsync<AcmeProblemException>(() =>
            _kit.Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(["example.test"]), replaces: null, TestContext.Current.CancellationToken));
        Assert.Equal(AcmeErrorType.Malformed, refused.ErrorType);
    }

    public void Dispose() => _kit.Dispose();

    private static HttpResponseMessage RateLimited(TimeSpan retryAfter)
    {
        var response = FakeAcmeServer.ProblemResponse(
            HttpStatusCode.TooManyRequests,
            "rateLimited",
            "too many certificates for example.test in the last 168 hours");
        response.Headers.RetryAfter = new RetryConditionHeaderValue(retryAfter);
        return response;
    }
}
