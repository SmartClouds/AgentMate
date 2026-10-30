using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Jobs;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.ApiClients;
using Runova.Website.IntegrationTests.Infrastructure;
using Runova.Website.IntegrationTests.News;

namespace Runova.Website.IntegrationTests.ApiClients;

/// <summary>Signed requests from API clients, checked through the C# reference client.</summary>
public sealed class SignedRequestTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string News = "/api/v1/news";
    private const string Clients = "/api/v1/api-clients";
    private const string Unauthenticated = "The request could not be authenticated.";

    private const string VectorOneBody =
        """{"slug":"openssh-10-3-fixes-a-pre-auth-crash","title":"OpenSSH 10.3 fixes a pre-auth crash","category":"security","severity":"high"}""";

    private const string VectorTwoTarget = "/api/v1/news?technology=openssh&q=open+ssh&category=security&technology=nodejs&page=2";

    private readonly FakeTimeProvider _time = new(TestApiClients.Now);
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), time: _time);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public void The_reference_client_gives_both_vector_signatures()
    {
        var one = RunovaSigningHandler.Sign(
            TestApiClients.VectorKeyId, TestApiClients.VectorSecret, "POST", new Uri("https://localhost" + News),
            System.Text.Encoding.UTF8.GetBytes(VectorOneBody), "1793361600", "AAECAwQFBgcICQoLDA0ODw");
        var two = RunovaSigningHandler.Sign(
            TestApiClients.VectorKeyId, TestApiClients.VectorSecret, "GET", new Uri("https://localhost" + VectorTwoTarget),
            [], "1793361600", "EBESExQVFhcYGRobHB0eHw");

        Assert.Equal("v1=ff628625fe8c31a13fda3a8c74b3e4864249c0a36c266b8698de7a89e43d4284", one.Single(h => h.Name == "X-Runova-Signature").Value);
        Assert.Equal("8e4afa4190017c2893f9af2cd4dce8f52e69c22490083ce787849a95bb922147", one.Single(h => h.Name == "X-Runova-Content-SHA256").Value);
        Assert.Equal("v1=5e21809896d8ca8d6aa37226007ad4c786b61f5ac3756ed364e69fdee515e20e", two.Single(h => h.Name == "X-Runova-Signature").Value);
        Assert.Equal(
            "category=security&page=2&q=open%20ssh&technology=nodejs&technology=openssh",
            RunovaSigningHandler.CanonicalQuery("?technology=openssh&q=open+ssh&category=security&technology=nodejs&page=2"));
    }

    [Fact]
    public async Task The_handler_accepts_vector_one_and_answers_for_the_body_not_the_signature()
    {
        await TestApiClients.AddAsync(_factory.Services, TestApiClients.VectorKeyId, TestApiClients.VectorSecret);
        using var request = TestApiClients.Signed(
            TestApiClients.VectorKeyId, TestApiClients.VectorSecret, HttpMethod.Post, News, VectorOneBody, nonce: "AAECAwQFBgcICQoLDA0ODw");
        Assert.Equal("v1=ff628625fe8c31a13fda3a8c74b3e4864249c0a36c266b8698de7a89e43d4284", request.Headers.GetValues("X-Runova-Signature").Single());

        var response = await TestApiClients.Raw(_factory).SendAsync(request, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), News);
    }

    [Fact]
    public async Task The_handler_accepts_vector_two_and_refuses_it_once_changed()
    {
        await TestApiClients.AddAsync(_factory.Services, TestApiClients.VectorKeyId, TestApiClients.VectorSecret);
        using var request = TestApiClients.Signed(
            TestApiClients.VectorKeyId, TestApiClients.VectorSecret, HttpMethod.Get, VectorTwoTarget, nonce: "EBESExQVFhcYGRobHB0eHw");
        Assert.Equal("v1=5e21809896d8ca8d6aa37226007ad4c786b61f5ac3756ed364e69fdee515e20e", request.Headers.GetValues("X-Runova-Signature").Single());
        using var changed = TestApiClients.Signed(
            TestApiClients.VectorKeyId,
            TestApiClients.VectorSecret,
            HttpMethod.Get,
            VectorTwoTarget,
            nonce: "EBESExQVFhcYGRobHB0eHx",
            change: h => h["X-Runova-Signature"] = "v1=5e21809896d8ca8d6aa37226007ad4c786b61f5ac3756ed364e69fdee515e20f");

        var response = await TestApiClients.Raw(_factory).SendAsync(request, TestContext.Current.CancellationToken);
        var refused = await TestApiClients.Raw(_factory).SendAsync(changed, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await AssertUnauthenticatedAsync(refused, "/api/v1/news");
    }

    public static TheoryData<string> RefusedCases =>
    [
        "bad signature", "signature of another secret", "no v1 prefix", "old timestamp", "future timestamp", "timestamp not a number",
        "reused nonce", "short nonce", "unknown key id", "malformed key id", "missing header", "body changed", "content hash wrong",
        "path changed", "query added", "method changed", "revoked client", "expired client", "disallowed ip", "no ip with an allowlist",
    ];

    [Theory]
    [MemberData(nameof(RefusedCases))]
    public async Task Every_failed_check_gives_the_same_401(string @case)
    {
        var (keyId, secret) = await TestApiClients.AddAsync(
            _factory.Services,
            revokedAt: @case == "revoked client" ? TestApiClients.Now.AddMinutes(-1) : null,
            expiresAt: @case == "expired client" ? TestApiClients.Now : null,
            ipAllowlist: @case is "disallowed ip" or "no ip with an allowlist" ? ["203.0.113.0/24", "2001:db8::/32"] : null);
        var body = NewsWriteTests.Body("signed-" + @case.Replace(' ', '-')).ToJsonString();
        var now = TestApiClients.Now.ToUnixTimeSeconds();
        var http = TestApiClients.Raw(_factory);
        var nonce = RunovaSigningHandler.Base64Url(new byte[16]);
        if (@case == "reused nonce")
        {
            using var first = TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, nonce: nonce);
            Assert.Equal(HttpStatusCode.Created, (await http.SendAsync(first, TestContext.Current.CancellationToken)).StatusCode);
            body = NewsWriteTests.Body("signed-again").ToJsonString();
        }

        using var request = @case switch
        {
            "bad signature" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, change: h => h["X-Runova-Signature"] = "v1=" + new string('0', 64)),
            "signature of another secret" => TestApiClients.Signed(keyId, Core.Signing.RequestSignature.NewSecret(), HttpMethod.Post, News, body),
            "no v1 prefix" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, change: h => h["X-Runova-Signature"] = h["X-Runova-Signature"][3..]),
            "old timestamp" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, timestamp: now - 301),
            "future timestamp" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, timestamp: now + 301),
            "timestamp not a number" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, change: h => h["X-Runova-Timestamp"] = "1793361600.0"),
            "reused nonce" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, nonce: nonce),
            "short nonce" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, nonce: "AAECAwQFBgcICQoLDA0O"),
            "unknown key id" => TestApiClients.Signed("rk_ffffffffffffffff", secret, HttpMethod.Post, News, body),
            "malformed key id" => TestApiClients.Signed(keyId.ToUpperInvariant(), secret, HttpMethod.Post, News, body),
            "missing header" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, change: h => h.Remove("X-Runova-Nonce")),
            "body changed" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, sentBody: body.Replace("high", "critical", StringComparison.Ordinal)),
            "content hash wrong" => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body, change: h => h["X-Runova-Content-SHA256"] = new string('a', 64)),
            "path changed" => Retarget(TestApiClients.Signed(keyId, secret, HttpMethod.Post, News + "/", body), News),
            "query added" => Retarget(TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body), News + "?draft=true"),
            "method changed" => Remethod(TestApiClients.Signed(keyId, secret, HttpMethod.Put, News, body), HttpMethod.Post),
            "disallowed ip" => WithIp(TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body), "198.51.100.7"),
            _ => TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, body),
        };
        if (@case is not ("disallowed ip" or "no ip with an allowlist"))
        {
            request.Headers.TryAddWithoutValidation(TestApiClients.RemoteIpHeader, "203.0.113.9");
        }

        var response = await http.SendAsync(request, TestContext.Current.CancellationToken);

        await AssertUnauthenticatedAsync(response, News);
        await using var scope = _factory.Services.CreateAsyncScope();
        var slugs = await scope.ServiceProvider.GetRequiredService<AppDbContext>().NewsItems.Select(i => i.Slug)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(@case == "reused nonce" ? ["signed-reused-nonce"] : [], slugs);
    }

    [Theory]
    [InlineData("203.0.113.9")]
    [InlineData("::ffff:203.0.113.200")]
    [InlineData("2001:db8::42")]
    public async Task An_address_in_the_allowlist_gets_through(string ip)
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"]);
        using var request = WithIp(TestApiClients.Signed(keyId, secret, HttpMethod.Post, News, NewsWriteTests.Body("allowed").ToJsonString()), ip);

        var response = await TestApiClients.Raw(_factory).SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task A_client_without_the_scope_is_forbidden()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, scopes: ["posts:write"]);

        var response = await TestApiClients.Http(_factory, keyId, secret)
            .PostAsync(News, SignedContent.Json(NewsWriteTests.Body("no-scope").ToJsonString()), TestContext.Current.CancellationToken);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), News);
        Assert.DoesNotContain("scope", problem.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_signed_client_reaches_no_user_resource()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, scopes: ["news:write", "posts:write"]);
        var http = TestApiClients.Http(_factory, keyId, secret);

        foreach (var path in new[] { "/api/v1/users/me", "/api/v1/users", "/api/v1/audit-entries" })
        {
            var response = await http.GetAsync(path, TestContext.Current.CancellationToken);
            Assert.True(response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.NotFound, $"{path}: {response.StatusCode}");
        }

        var me = await http.GetAsync("/api/v1/users/me", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Forbidden, me.StatusCode);
    }

    [Fact]
    public async Task A_client_creates_news_without_cookies_or_antiforgery_and_is_its_author()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, name: "Advisory importer");
        var http = TestApiClients.Http(_factory, keyId, secret);

        var response = await http.PostAsync(News, SignedContent.Json(NewsWriteTests.Body("from-a-client").ToJsonString()), TestContext.Current.CancellationToken);
        var item = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        var id = item.GetProperty("id").GetInt64();

        var createdBy = item.GetProperty("createdBy");
        Assert.Equal("api-client", createdBy.GetProperty("kind").GetString());
        Assert.Equal("Advisory importer", createdBy.GetProperty("name").GetString());
        Assert.False(response.Headers.Contains("Set-Cookie"));

        // The same client then patches it with If-Match, still signed.
        using var patch = new HttpRequestMessage(HttpMethod.Patch, $"{News}/{id}") { Content = SignedContent.Json("""{"title":"Patched by the client"}""") };
        patch.Headers.TryAddWithoutValidation("If-Match", response.Headers.ETag!.ToString());
        Assert.Equal(HttpStatusCode.OK, (await http.SendAsync(patch, TestContext.Current.CancellationToken)).StatusCode);

        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var client = await db.ApiClients.SingleAsync(c => c.Name == "Advisory importer", TestContext.Current.CancellationToken);
        Assert.Equal(client.Id, createdBy.GetProperty("id").GetInt64());
        Assert.Equal(TestApiClients.Now, client.LastUsedAt);
        var entries = await db.AuditEntries.Where(e => e.TargetType == "news").OrderBy(e => e.Id).ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["news.create", "news.update"], entries.Select(e => e.Action));
        Assert.All(entries, e =>
        {
            Assert.Equal("api-client", e.ActorKind);
            Assert.Equal(client.Id, e.ActorId);
        });
    }

    [Fact]
    public async Task Last_used_moves_at_most_once_a_minute()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services);
        var http = TestApiClients.Http(_factory, keyId, secret, clock: () => _time.GetUtcNow().ToUnixTimeSeconds());

        await http.GetAsync(News, TestContext.Current.CancellationToken);
        _time.Advance(TimeSpan.FromSeconds(59));
        await http.GetAsync(News, TestContext.Current.CancellationToken);
        Assert.Equal(TestApiClients.Now, await LastUsedAsync(keyId));

        _time.Advance(TimeSpan.FromSeconds(1));
        await http.GetAsync(News, TestContext.Current.CancellationToken);
        Assert.Equal(TestApiClients.Now.AddMinutes(1), await LastUsedAsync(keyId));
    }

    [Fact]
    public async Task After_rotation_both_secrets_work_until_the_overlap_ends()
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        var created = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, Clients, new { name = "Rotating importer", scopes = new[] { "news:write" }, ipAllowlist = Array.Empty<string>(), expiresAt = (string?)null }),
            HttpStatusCode.Created);
        var id = created.GetProperty("client").GetProperty("id").GetInt64();
        var oldKey = (created.GetProperty("keyId").GetString()!, created.GetProperty("secret").GetString()!);
        Assert.Equal(HttpStatusCode.OK, await StatusAsync(oldKey));

        var rotated = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, $"{Clients}/{id}/secrets", new { overlapMinutes = 30 }), HttpStatusCode.Created);
        var newKey = (rotated.GetProperty("keyId").GetString()!, rotated.GetProperty("secret").GetString()!);

        Assert.Equal(HttpStatusCode.OK, await StatusAsync(oldKey));
        Assert.Equal(HttpStatusCode.OK, await StatusAsync(newKey));

        _time.Advance(TimeSpan.FromMinutes(29));
        Assert.Equal(HttpStatusCode.OK, await StatusAsync(oldKey));

        _time.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(oldKey));
        Assert.Equal(HttpStatusCode.OK, await StatusAsync(newKey));

        // The old secret does not sign with the new key id either.
        Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync((newKey.Item1, oldKey.Item2)));
    }

    [Fact]
    public async Task Repeating_a_post_with_the_same_idempotency_key_replays_the_first_answer()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services);
        var http = TestApiClients.Http(_factory, keyId, secret);
        var body = NewsWriteTests.Body("only-once").ToJsonString();

        var first = await PostAsync(http, body, "import-2026-10-30-001");
        var again = await PostAsync(http, body, "import-2026-10-30-001");
        var otherBody = await PostAsync(http, NewsWriteTests.Body("something-else").ToJsonString(), "import-2026-10-30-001");

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.False(first.Headers.Contains("Idempotent-Replayed"));
        Assert.Equal(HttpStatusCode.Created, again.StatusCode);
        Assert.Equal("true", again.Headers.GetValues("Idempotent-Replayed").Single());
        Assert.Equal(first.Headers.Location, again.Headers.Location);
        Assert.Equal(first.Headers.ETag, again.Headers.ETag);
        Assert.Equal(first.Content.Headers.ContentType, again.Content.Headers.ContentType);
        Assert.Equal(
            await first.Content.ReadAsStringAsync(TestContext.Current.CancellationToken),
            await again.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        await ProblemAssert.IsProblemAsync(otherBody, (HttpStatusCode)422, ProblemAssert.Type("idempotency-key-reused"), News);
        Assert.Equal(1, await NewsCountAsync());

        // Another key, or the same key from another client, makes a new item.
        Assert.Equal(HttpStatusCode.Created, (await PostAsync(http, NewsWriteTests.Body("second").ToJsonString(), "import-2026-10-30-002")).StatusCode);
        var (otherKeyId, otherSecret) = await TestApiClients.AddAsync(_factory.Services);
        var other = await PostAsync(TestApiClients.Http(_factory, otherKeyId, otherSecret), NewsWriteTests.Body("third").ToJsonString(), "import-2026-10-30-001");
        Assert.Equal(HttpStatusCode.Created, other.StatusCode);
        Assert.Equal(3, await NewsCountAsync());
    }

    [Fact]
    public async Task An_idempotency_key_works_for_a_staff_session_and_keeps_a_refusal_too()
    {
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));
        var invalid = NewsWriteTests.Body("not-valid", severity: "huge");

        var first = await editor.SendAsync(HttpMethod.Post, News, invalid, headers: new Dictionary<string, string> { ["Idempotency-Key"] = "k1" });
        var again = await editor.SendAsync(HttpMethod.Post, News, invalid, headers: new Dictionary<string, string> { ["Idempotency-Key"] = "k1" });
        var badKey = await editor.SendAsync(HttpMethod.Post, News, invalid, headers: new Dictionary<string, string> { ["Idempotency-Key"] = "has space" });

        Assert.Equal(HttpStatusCode.BadRequest, first.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
        Assert.Equal("true", again.Headers.GetValues("Idempotent-Replayed").Single());
        var problem = await ProblemAssert.IsProblemAsync(badKey, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), News);
        Assert.True(problem.GetProperty("errors").TryGetProperty("Idempotency-Key", out _));
    }

    [Fact]
    public async Task A_failed_first_attempt_is_not_kept()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services);
        await using (var scope = _factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var client = await db.ApiClients.SingleAsync(TestContext.Current.CancellationToken);
            db.IdempotencyRecords.Add(new IdempotencyRecord
            {
                CallerKind = "api-client",
                CallerId = client.Id,
                Key = "expired",
                RequestHash = new byte[32],
                StatusCode = 201,
                Body = "{}",
                CreatedAt = TestApiClients.Now.AddHours(-24).AddSeconds(-1),
            });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        var response = await PostAsync(TestApiClients.Http(_factory, keyId, secret), NewsWriteTests.Body("after-expiry").ToJsonString(), "expired");

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.False(response.Headers.Contains("Idempotent-Replayed"));
    }

    [Fact]
    public async Task Going_over_the_rate_limit_answers_429_with_retry_after()
    {
        using var factory = new WebsiteApiFactory(
            await postgres.CreateDatabaseAsync(),
            time: _time,
            settings: new Dictionary<string, string>
            {
                ["RateLimits:ApiClients:TokenLimit"] = "3",
                ["RateLimits:ApiClients:TokensPerPeriod"] = "1",
                ["RateLimits:ApiClients:ReplenishmentPeriod"] = "00:10:00",
            });
        var (keyId, secret) = await TestApiClients.AddAsync(factory.Services);
        var (otherKeyId, otherSecret) = await TestApiClients.AddAsync(factory.Services);
        var http = TestApiClients.Http(factory, keyId, secret);

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await http.GetAsync(News, TestContext.Current.CancellationToken)).StatusCode);
        }

        var limited = await http.GetAsync(News, TestContext.Current.CancellationToken);
        var other = await TestApiClients.Http(factory, otherKeyId, otherSecret).GetAsync(News, TestContext.Current.CancellationToken);
        var anonymous = await TestApiClients.Raw(factory).GetAsync(News, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(limited, HttpStatusCode.TooManyRequests, ProblemAssert.Type("rate-limited"), News);
        var retryAfter = limited.Headers.RetryAfter?.Delta;
        Assert.NotNull(retryAfter);
        Assert.InRange(retryAfter.Value, TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(10));
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
        Assert.Equal(HttpStatusCode.OK, anonymous.StatusCode);
    }

    [Fact]
    public async Task The_default_limit_is_a_burst_of_20()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services);
        var http = TestApiClients.Http(_factory, keyId, secret);

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 25; i++)
        {
            statuses.Add((await http.GetAsync(News, TestContext.Current.CancellationToken)).StatusCode);
        }

        Assert.All(statuses.Take(20), s => Assert.Equal(HttpStatusCode.OK, s));
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses.Skip(20));
    }

    [Fact]
    public async Task The_purge_jobs_delete_old_nonces_and_idempotency_records()
    {
        await using (var scope = _factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.SignatureNonces.AddRange(
                new SignatureNonce { KeyId = "rk_00000000000000a1", Nonce = "old-old-old-old-old-old-x", SeenAt = TestApiClients.Now.AddMinutes(-10) },
                new SignatureNonce { KeyId = "rk_00000000000000a1", Nonce = "new-new-new-new-new-new-x", SeenAt = TestApiClients.Now.AddMinutes(-9) });
            db.IdempotencyRecords.AddRange(
                new IdempotencyRecord { CallerKind = "user", CallerId = 1, Key = "old", RequestHash = new byte[32], StatusCode = 201, CreatedAt = TestApiClients.Now.AddHours(-24) },
                new IdempotencyRecord { CallerKind = "user", CallerId = 1, Key = "new", RequestHash = new byte[32], StatusCode = 201, CreatedAt = TestApiClients.Now.AddHours(-23) });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        await using (var scope = _factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<SignatureNoncesPurgeJob>().RunAsync(TestContext.Current.CancellationToken);
            await scope.ServiceProvider.GetRequiredService<IdempotencyPurgeJob>().RunAsync(TestContext.Current.CancellationToken);
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal(["new-new-new-new-new-new-x"], await db.SignatureNonces.Select(n => n.Nonce).ToListAsync(TestContext.Current.CancellationToken));
            Assert.Equal(["new"], await db.IdempotencyRecords.Select(r => r.Key).ToListAsync(TestContext.Current.CancellationToken));
        }

        Assert.Equal("*/10 * * * *", RecurringJobRegistry.Schedules[RecurringJobRegistry.SignatureNoncesPurge]);
        Assert.Equal("0 * * * *", RecurringJobRegistry.Schedules[RecurringJobRegistry.IdempotencyPurge]);
    }

    private async Task<HttpStatusCode> StatusAsync((string KeyId, string Secret) key) =>
        (await TestApiClients.Http(_factory, key.KeyId, key.Secret, clock: () => _time.GetUtcNow().ToUnixTimeSeconds())
            .GetAsync(News, TestContext.Current.CancellationToken)).StatusCode;

    private static async Task<HttpResponseMessage> PostAsync(HttpClient http, string body, string idempotencyKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, News) { Content = SignedContent.Json(body) };
        request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        return await http.SendAsync(request, TestContext.Current.CancellationToken);
    }

    private async Task<int> NewsCountAsync()
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().NewsItems.CountAsync(TestContext.Current.CancellationToken);
    }

    private async Task<DateTimeOffset?> LastUsedAsync(string keyId)
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().ApiClients
            .Where(c => c.Keys.Any(k => k.KeyId == keyId)).Select(c => c.LastUsedAt).SingleAsync(TestContext.Current.CancellationToken);
    }

    /// <summary>Every refusal reads the same, so a caller can not tell which check failed.</summary>
    private static async Task AssertUnauthenticatedAsync(HttpResponseMessage response, string instance)
    {
        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), instance);
        Assert.Equal(Unauthenticated, problem.GetProperty("detail").GetString());
        Assert.Equal(
            ["type", "title", "status", "detail", "instance", "traceId"],
            problem.EnumerateObject().Select(p => p.Name));
        Assert.Empty(response.Headers.WwwAuthenticate);
    }

    private static HttpRequestMessage Retarget(HttpRequestMessage request, string pathAndQuery)
    {
        request.RequestUri = new Uri(new Uri("https://localhost"), pathAndQuery);
        return request;
    }

    private static HttpRequestMessage Remethod(HttpRequestMessage request, HttpMethod method)
    {
        request.Method = method;
        return request;
    }

    private static HttpRequestMessage WithIp(HttpRequestMessage request, string ip)
    {
        request.Headers.TryAddWithoutValidation(TestApiClients.RemoteIpHeader, ip);
        return request;
    }
}
