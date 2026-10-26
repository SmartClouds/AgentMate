using System.Buffers.Text;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>A request as the fake CA saw it, and what it answered.</summary>
internal sealed class FakeAcmeRequest
{
    public required HttpMethod Method { get; init; }

    public required string Path { get; init; }

    public required DateTimeOffset At { get; init; }

    public string? UserAgent { get; init; }

    public string? ContentType { get; init; }

    public string? Accept { get; init; }

    public JwsReader? Jws { get; init; }

    /// <summary>The JSON payload of a signed request, or null for POST-as-GET and unsigned requests.</summary>
    public JsonElement? Payload => Jws is { Payload.Length: > 0 } jws ? jws.PayloadJson : null;

    public HttpStatusCode Status { get; set; }

    public string? ErrorType { get; set; }

    /// <summary>The Replay-Nonce the answer carried.</summary>
    public string? ResponseNonce { get; set; }
}

/// <summary>
/// An ACME server inside a message handler: nonces, JWS verification, accounts, key changes,
/// orders, authorizations, HTTP-01 and DNS-01 checked against the in-memory publishers, a
/// two-level CA with an alternate chain, revocation and ARI. It follows RFC 8555 and RFC 9773
/// closely enough (and as strictly as Pebble where the RFC lets servers choose) to drive the
/// client through every state and error it has to handle.
/// </summary>
internal sealed class FakeAcmeServer : HttpMessageHandler
{
    public static readonly Uri Base = new("https://acme.test/");
    public static readonly Uri DirectoryUrl = new(Base, "directory");
    public static readonly Uri TermsUrl = new("https://acme.test/terms/v1");

    private const string ErrorNamespace = "urn:ietf:params:acme:error:";

    private readonly Lock _gate = new();
    private readonly TimeProvider _time;
    private readonly InMemoryHttp01ChallengePublisher _http01;
    private readonly InMemoryDns01ChallengeHook _dns01;
    private readonly HashSet<string> _nonces = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Account> _accounts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Order> _orders = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Authorization> _authorizations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Challenge> _challenges = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Issued> _issued = new(StringComparer.Ordinal);
    private readonly List<FakeAcmeRequest> _requests = [];
    private readonly FakeCertificateAuthority _ca;
    private int _next;

    public FakeAcmeServer(TimeProvider time, InMemoryHttp01ChallengePublisher http01, InMemoryDns01ChallengeHook dns01)
    {
        _time = time;
        _http01 = http01;
        _dns01 = dns01;
        _ca = new FakeCertificateAuthority(time.GetUtcNow());
    }

    /// <summary>Whether the directory lists renewalInfo (ARI).</summary>
    public bool OfferRenewalInfo { get; set; } = true;

    /// <summary>Whether new accounts must agree to <see cref="TermsUrl"/>.</summary>
    public bool RequireTermsOfService { get; set; } = true;

    /// <summary>How many of the next valid nonces are refused anyway, as Pebble does with 5% of them.</summary>
    public int RejectValidNonces { get; set; }

    /// <summary>How many authorization polls still say pending after the challenge was answered.</summary>
    public int PendingPollsAfterAnswer { get; set; }

    /// <summary>How many order polls still say processing after finalize.</summary>
    public int ProcessingPolls { get; set; }

    /// <summary>The Retry-After of pending and processing answers.</summary>
    public int RetryAfterSeconds { get; set; } = 3;

    /// <summary>Sends Retry-After as an HTTP date instead of seconds.</summary>
    public bool RetryAfterAsDate { get; set; }

    /// <summary>Hands out an account's valid authorizations again in new orders, as CAs may.</summary>
    public bool ReuseValidAuthorizations { get; set; }

    /// <summary>Runs before the normal handling; a non-null response replaces it.</summary>
    public Func<FakeAcmeRequest, CancellationToken, Task<HttpResponseMessage?>>? Intercept { get; set; }

    public X509Certificate2 Root => _ca.Root;

    public X509Certificate2 AlternateRoot => _ca.AlternateRoot;

    public string AlternateRootName => _ca.AlternateRoot.GetNameInfo(X509NameType.SimpleName, forIssuer: false);

    public IReadOnlyList<FakeAcmeRequest> Requests
    {
        get
        {
            lock (_gate)
            {
                return [.. _requests];
            }
        }
    }

    public IReadOnlyList<FakeAcmeRequest> RequestsTo(string pathPrefix) =>
        [.. Requests.Where(request => request.Path.StartsWith(pathPrefix, StringComparison.Ordinal))];

    /// <summary>The ARI identifier the CA itself uses for a certificate it issued.</summary>
    public string? CertificateIdOf(byte[] leafDer)
    {
        lock (_gate)
        {
            return _issued.Values.FirstOrDefault(issued => issued.Der.AsSpan().SequenceEqual(leafDer))?.CertificateId;
        }
    }

    public bool IsRevoked(string certificateId)
    {
        lock (_gate)
        {
            return _issued.Values.Any(issued => issued.CertificateId == certificateId && issued.RevokedReason is not null);
        }
    }

    public static HttpResponseMessage ProblemResponse(HttpStatusCode status, string type, string detail)
    {
        var body = Write(writer =>
        {
            writer.WriteString("type", ErrorNamespace + type);
            writer.WriteString("detail", detail);
            writer.WriteNumber("status", (int)status);
        });
        var response = new HttpResponseMessage(status) { Content = new ByteArrayContent(body) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/problem+json");
        return response;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        JwsReader? jws = null;
        if (request.Method == HttpMethod.Post)
        {
            try
            {
                jws = JwsReader.Parse(body);
            }
            catch (Exception error) when (error is JsonException or FormatException or InvalidOperationException or Xunit.Sdk.XunitException)
            {
                jws = null;
            }
        }

        var seen = new FakeAcmeRequest
        {
            Method = request.Method,
            Path = request.RequestUri!.AbsolutePath,
            At = _time.GetUtcNow(),
            UserAgent = request.Headers.UserAgent.ToString(),
            ContentType = request.Content?.Headers.ContentType?.ToString(),
            Accept = request.Headers.Accept.ToString(),
            Jws = jws,
        };
        lock (_gate)
        {
            _requests.Add(seen);
        }

        HttpResponseMessage? response = null;
        if (Intercept is { } intercept)
        {
            response = await intercept(seen, cancellationToken);
        }

        if (response is null)
        {
            lock (_gate)
            {
                response = Handle(request, seen);
            }
        }

        if (!response.Headers.Contains("Replay-Nonce") && (request.Method == HttpMethod.Post || seen.Path == "/new-nonce"))
        {
            response.Headers.TryAddWithoutValidation("Replay-Nonce", NewNonce());
        }

        seen.Status = response.StatusCode;
        seen.ResponseNonce = response.Headers.TryGetValues("Replay-Nonce", out var nonces) ? nonces.First() : null;
        if (response.Content?.Headers.ContentType?.MediaType == "application/problem+json")
        {
            using var problem = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(cancellationToken));
            seen.ErrorType = problem.RootElement.TryGetProperty("type", out var type) ? type.GetString()?.Replace(ErrorNamespace, string.Empty, StringComparison.Ordinal) : null;
        }

        response.RequestMessage = request;
        return response;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _ca.Dispose();
            foreach (var account in _accounts.Values)
            {
                account.Key.Dispose();
            }
        }

        base.Dispose(disposing);
    }

    private static byte[] Write(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            write(writer);
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }

    private static HttpResponseMessage Json(HttpStatusCode status, Action<Utf8JsonWriter> write, Uri? location = null)
    {
        var response = new HttpResponseMessage(status) { Content = new ByteArrayContent(Write(write)) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        response.Headers.Location = location;
        response.Headers.TryAddWithoutValidation("Link", $"<{DirectoryUrl}>;rel=\"index\"");
        return response;
    }

    private static string Thumbprint(JsonElement jwk) =>
        Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{{\"crv\":\"{jwk.GetProperty("crv").GetString()}\",\"kty\":\"{jwk.GetProperty("kty").GetString()}\","
            + $"\"x\":\"{jwk.GetProperty("x").GetString()}\",\"y\":\"{jwk.GetProperty("y").GetString()}\"}}")));

    private string NewNonce()
    {
        lock (_gate)
        {
            var nonce = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(16));
            _nonces.Add(nonce);
            return nonce;
        }
    }

    private string NextId() => (++_next).ToString(CultureInfo.InvariantCulture);

    private static Uri Url(string path) => new(Base, path);

    private void AddRetryAfter(HttpResponseMessage response)
    {
        if (RetryAfterAsDate)
        {
            response.Headers.RetryAfter = new RetryConditionHeaderValue(_time.GetUtcNow().AddSeconds(RetryAfterSeconds));
        }
        else
        {
            response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(RetryAfterSeconds));
        }
    }

    private bool TakeNonce(string? nonce)
    {
        if (nonce is null || !_nonces.Remove(nonce))
        {
            return false;
        }

        if (RejectValidNonces > 0)
        {
            RejectValidNonces--;
            return false;
        }

        return true;
    }

    private HttpResponseMessage Handle(HttpRequestMessage request, FakeAcmeRequest seen)
    {
        var path = seen.Path;
        if (string.IsNullOrEmpty(seen.UserAgent))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "Every request needs a User-Agent");
        }

        if (request.Method == HttpMethod.Get && path == "/directory")
        {
            return Directory();
        }

        if (path == "/new-nonce" && (request.Method == HttpMethod.Head || request.Method == HttpMethod.Get))
        {
            var response = new HttpResponseMessage(request.Method == HttpMethod.Head ? HttpStatusCode.OK : HttpStatusCode.NoContent);
            response.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
            return response;
        }

        if (request.Method == HttpMethod.Get && path.StartsWith("/renewal-info/", StringComparison.Ordinal))
        {
            return RenewalInfo(path["/renewal-info/".Length..]);
        }

        if (request.Method != HttpMethod.Post)
        {
            return new HttpResponseMessage(HttpStatusCode.MethodNotAllowed);
        }

        if (seen.ContentType != AcmeJws.MediaType)
        {
            return ProblemResponse(HttpStatusCode.UnsupportedMediaType, "malformed", "Content-Type must be exactly application/jose+json");
        }

        if (seen.Jws is not { } jws)
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The body is not a flattened JWS");
        }

        if (jws.Algorithm != "ES256")
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "badSignatureAlgorithm", "Only ES256 is supported");
        }

        if (jws.Url != request.RequestUri!.AbsoluteUri)
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The url header does not match the request");
        }

        if (!TakeNonce(jws.Nonce))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "badNonce", "The nonce is not one this server issued, or it was used");
        }

        Account? account = null;
        if (jws.KeyId is { } kid)
        {
            account = _accounts.Values.FirstOrDefault(candidate => candidate.Url == kid);
            if (account is null)
            {
                return ProblemResponse(HttpStatusCode.BadRequest, "accountDoesNotExist", "No account has this URL");
            }

            if (jws.Jwk is not null || !jws.VerifyWith(account.Key))
            {
                return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The signature does not verify");
            }
        }
        else if (jws.Jwk is { } jwk && path == "/new-account")
        {
            using var key = JwsReader.ImportJwk(jwk);
            if (!jws.VerifyWith(key))
            {
                return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The signature does not verify");
            }
        }
        else
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "A kid is needed here");
        }

        var (resource, id) = SplitPath(path);
        return resource switch
        {
            "new-account" => NewAccount(jws),
            "account" => AccountResource(account!, id),
            "key-change" => KeyChange(account!, jws),
            "new-order" => NewOrder(account!, jws),
            "order" => OrderResource(account!, id),
            "authz" => AuthorizationResource(account!, id),
            "challenge" => AnswerChallenge(account!, id, jws),
            "finalize" => Finalize(account!, id, jws),
            "cert" => CertificateResource(account!, id),
            "revoke-cert" => Revoke(account!, jws),
            _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        };
    }

    private static (string Resource, string Id) SplitPath(string path)
    {
        var trimmed = path.TrimStart('/');
        var slash = trimmed.IndexOf('/', StringComparison.Ordinal);
        return slash < 0 ? (trimmed, string.Empty) : (trimmed[..slash], trimmed[(slash + 1)..]);
    }

    private HttpResponseMessage Directory() => Json(HttpStatusCode.OK, writer =>
    {
        writer.WriteString("newNonce", Url("new-nonce").AbsoluteUri);
        writer.WriteString("newAccount", Url("new-account").AbsoluteUri);
        writer.WriteString("newOrder", Url("new-order").AbsoluteUri);
        writer.WriteString("revokeCert", Url("revoke-cert").AbsoluteUri);
        writer.WriteString("keyChange", Url("key-change").AbsoluteUri);
        if (OfferRenewalInfo)
        {
            writer.WriteString("renewalInfo", Url("renewal-info").AbsoluteUri);
        }

        writer.WriteStartObject("meta");
        if (RequireTermsOfService)
        {
            writer.WriteString("termsOfService", TermsUrl.AbsoluteUri);
        }

        writer.WriteString("website", "https://acme.test/docs");
        writer.WriteStartArray("caaIdentities");
        writer.WriteStringValue("acme.test");
        writer.WriteEndArray();
        writer.WriteStartObject("profiles");
        writer.WriteString("classic", "The usual 90 days");
        writer.WriteString("shortlived", "Six days");
        writer.WriteEndObject();
        writer.WriteEndObject();
    });

    private HttpResponseMessage NewAccount(JwsReader jws)
    {
        var payload = jws.PayloadJson;
        var jwk = jws.Jwk!.Value;
        var thumbprint = Thumbprint(jwk);
        var existing = _accounts.Values.FirstOrDefault(account => account.Thumbprint == thumbprint);
        if (payload.TryGetProperty("onlyReturnExisting", out var only) && only.GetBoolean())
        {
            return existing is null
                ? ProblemResponse(HttpStatusCode.BadRequest, "accountDoesNotExist", "No account has this key")
                : AccountJson(existing, HttpStatusCode.OK);
        }

        if (existing is not null)
        {
            return AccountJson(existing, HttpStatusCode.OK);
        }

        if (RequireTermsOfService && !(payload.TryGetProperty("termsOfServiceAgreed", out var agreed) && agreed.GetBoolean()))
        {
            var refused = ProblemResponse(HttpStatusCode.Forbidden, "userActionRequired", "The terms of service have to be agreed to");
            refused.Headers.TryAddWithoutValidation("Link", $"<{TermsUrl}>;rel=\"terms-of-service\"");
            return refused;
        }

        var contact = payload.TryGetProperty("contact", out var list)
            ? list.EnumerateArray().Select(item => item.GetString()!).ToList()
            : [];
        if (contact.Any(item => !item.StartsWith("mailto:", StringComparison.Ordinal)))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "unsupportedContact", "Only mailto contacts are supported");
        }

        var id = NextId();
        var created = new Account(id, Url($"account/{id}").AbsoluteUri, JwsReader.ImportJwk(jwk), thumbprint, contact);
        _accounts[id] = created;
        return AccountJson(created, HttpStatusCode.Created);
    }

    private static HttpResponseMessage AccountJson(Account account, HttpStatusCode status) =>
        Json(
            status,
            writer =>
            {
                writer.WriteString("status", "valid");
                writer.WriteStartArray("contact");
                foreach (var contact in account.Contact)
                {
                    writer.WriteStringValue(contact);
                }

                writer.WriteEndArray();
                writer.WriteString("orders", Url($"orders/{account.Id}").AbsoluteUri);
            },
            new Uri(account.Url));

    private static HttpResponseMessage AccountResource(Account account, string id) =>
        account.Id == id ? AccountJson(account, HttpStatusCode.OK) : ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "Not your account");

    private static HttpResponseMessage KeyChange(Account account, JwsReader outer)
    {
        JwsReader inner;
        try
        {
            inner = JwsReader.Parse(outer.Payload);
        }
        catch (Exception error) when (error is JsonException or FormatException or InvalidOperationException or Xunit.Sdk.XunitException)
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The payload is not a JWS");
        }

        if (inner.Jwk is not { } newJwk || inner.Nonce is not null || inner.Url != outer.Url)
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The inner JWS needs a jwk, the same url and no nonce");
        }

        var newKey = JwsReader.ImportJwk(newJwk);
        var payload = inner.PayloadJson;
        var oldKey = payload.GetProperty("oldKey");
        if (!inner.VerifyWith(newKey)
            || payload.GetProperty("account").GetString() != account.Url
            || Thumbprint(oldKey) != account.Thumbprint
            || Thumbprint(newJwk) == account.Thumbprint)
        {
            newKey.Dispose();
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The key change does not add up");
        }

        account.Key.Dispose();
        account.Key = newKey;
        account.Thumbprint = Thumbprint(newJwk);
        return new HttpResponseMessage(HttpStatusCode.OK);
    }

    private HttpResponseMessage NewOrder(Account account, JwsReader jws)
    {
        var payload = jws.PayloadJson;
        var names = payload.GetProperty("identifiers").EnumerateArray()
            .Select(identifier => identifier.GetProperty("value").GetString()!)
            .ToList();
        string? replaces = null;
        if (payload.TryGetProperty("replaces", out var replacesValue))
        {
            replaces = replacesValue.GetString();
            var old = _issued.Values.FirstOrDefault(issued => issued.CertificateId == replaces);
            if (old is null)
            {
                return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The replaced certificate is unknown");
            }

            if (old.AccountId != account.Id)
            {
                return ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "The replaced certificate belongs to another account");
            }

            if (old.Replaced)
            {
                return ProblemResponse(HttpStatusCode.Conflict, "alreadyReplaced", "The certificate already has a replacement");
            }
        }

        var order = new Order(NextId(), account.Id, names, replaces);
        foreach (var name in names)
        {
            var wildcard = name.StartsWith("*.", StringComparison.Ordinal);
            var baseName = wildcard ? name[2..] : name;
            var reused = ReuseValidAuthorizations
                ? _authorizations.Values.FirstOrDefault(authorization => authorization.AccountId == account.Id
                    && authorization.Name == baseName
                    && authorization.Wildcard == wildcard
                    && authorization.Status == "valid")
                : null;
            if (reused is not null)
            {
                order.AuthorizationIds.Add(reused.Id);
                continue;
            }

            var authorization = new Authorization(NextId(), account.Id, baseName, wildcard);
            foreach (var type in wildcard ? [AcmeChallengeTypes.Dns01] : new[] { AcmeChallengeTypes.Http01, AcmeChallengeTypes.Dns01 })
            {
                var challenge = new Challenge(NextId(), authorization.Id, type, Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)));
                _challenges[challenge.Id] = challenge;
                authorization.ChallengeIds.Add(challenge.Id);
            }

            _authorizations[authorization.Id] = authorization;
            order.AuthorizationIds.Add(authorization.Id);
        }

        _orders[order.Id] = order;
        UpdateOrder(order);
        return OrderJson(order, HttpStatusCode.Created, Url($"order/{order.Id}"));
    }

    private void UpdateOrder(Order order)
    {
        if (order.Status is not ("pending" or "ready"))
        {
            return;
        }

        var authorizations = order.AuthorizationIds.Select(id => _authorizations[id]).ToList();
        if (authorizations.FirstOrDefault(authorization => authorization.Status == "invalid") is { } failed)
        {
            order.Status = "invalid";
            order.Error = (ErrorNamespace + "unauthorized", $"Validation of {failed.Name} failed");
        }
        else if (authorizations.All(authorization => authorization.Status == "valid"))
        {
            order.Status = "ready";
        }
    }

    private HttpResponseMessage OrderJson(Order order, HttpStatusCode status, Uri? location = null)
    {
        var response = Json(
            status,
            writer =>
            {
                writer.WriteString("status", order.Status);
                writer.WriteString("expires", _time.GetUtcNow().AddDays(7).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture));
                writer.WriteStartArray("identifiers");
                foreach (var name in order.Names)
                {
                    writer.WriteStartObject();
                    writer.WriteString("type", "dns");
                    writer.WriteString("value", name);
                    writer.WriteEndObject();
                }

                writer.WriteEndArray();
                writer.WriteStartArray("authorizations");
                foreach (var id in order.AuthorizationIds)
                {
                    writer.WriteStringValue(Url($"authz/{id}").AbsoluteUri);
                }

                writer.WriteEndArray();
                writer.WriteString("finalize", Url($"finalize/{order.Id}").AbsoluteUri);
                if (order.CertificateId is { } certificate)
                {
                    writer.WriteString("certificate", Url($"cert/{certificate}").AbsoluteUri);
                }

                if (order.Replaces is { } replaces)
                {
                    writer.WriteString("replaces", replaces);
                }

                if (order.Error is { } error)
                {
                    writer.WriteStartObject("error");
                    writer.WriteString("type", error.Type);
                    writer.WriteString("detail", error.Detail);
                    writer.WriteEndObject();
                }
            },
            location);
        if (order.Status == "processing")
        {
            AddRetryAfter(response);
        }

        return response;
    }

    private HttpResponseMessage OrderResource(Account account, string id)
    {
        if (!_orders.TryGetValue(id, out var order))
        {
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        if (order.AccountId != account.Id)
        {
            return ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "Not your order");
        }

        if (order.Status == "processing")
        {
            if (order.ProcessingPollsLeft > 0)
            {
                order.ProcessingPollsLeft--;
            }
            else
            {
                order.Status = "valid";
            }
        }

        return OrderJson(order, HttpStatusCode.OK);
    }

    private HttpResponseMessage AuthorizationResource(Account account, string id)
    {
        if (!_authorizations.TryGetValue(id, out var authorization))
        {
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        if (authorization.AccountId != account.Id)
        {
            return ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "Not your authorization");
        }

        if (authorization.Status == "pending" && authorization.AnsweredChallengeId is not null)
        {
            if (authorization.PendingPollsLeft > 0)
            {
                authorization.PendingPollsLeft--;
            }
            else
            {
                Validate(authorization);
            }
        }

        var response = Json(HttpStatusCode.OK, writer =>
        {
            writer.WriteString("status", authorization.Status);
            writer.WriteStartObject("identifier");
            writer.WriteString("type", "dns");
            writer.WriteString("value", authorization.Name);
            writer.WriteEndObject();
            if (authorization.Wildcard)
            {
                writer.WriteBoolean("wildcard", true);
            }

            writer.WriteString("expires", _time.GetUtcNow().AddDays(30).ToString("O", CultureInfo.InvariantCulture));
            writer.WriteStartArray("challenges");
            foreach (var challengeId in authorization.ChallengeIds)
            {
                var challenge = _challenges[challengeId];

                // As Pebble does: once decided, only the challenge that decided it is listed.
                if (authorization.Status != "pending" && challenge.Id != authorization.AnsweredChallengeId)
                {
                    continue;
                }

                WriteChallenge(writer, challenge);
            }

            writer.WriteEndArray();
        });
        if (authorization.Status == "pending" && authorization.AnsweredChallengeId is not null)
        {
            AddRetryAfter(response);
        }

        return response;
    }

    private static void WriteChallenge(Utf8JsonWriter writer, Challenge challenge)
    {
        writer.WriteStartObject();
        writer.WriteString("type", challenge.Type);
        writer.WriteString("url", Url($"challenge/{challenge.Id}").AbsoluteUri);
        writer.WriteString("token", challenge.Token);
        writer.WriteString("status", challenge.Status);
        if (challenge.Error is { } error)
        {
            writer.WriteStartObject("error");
            writer.WriteString("type", ErrorNamespace + error.Type);
            writer.WriteString("detail", error.Detail);
            writer.WriteNumber("status", 403);
            writer.WriteEndObject();
        }

        writer.WriteEndObject();
    }

    private HttpResponseMessage AnswerChallenge(Account account, string id, JwsReader jws)
    {
        if (!_challenges.TryGetValue(id, out var challenge))
        {
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        var authorization = _authorizations[challenge.AuthorizationId];
        if (authorization.AccountId != account.Id)
        {
            return ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "Not your challenge");
        }

        // Pebble's strict mode: the answer to a challenge is exactly "{}".
        if (!jws.Payload.AsSpan().SequenceEqual("{}"u8))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "A challenge is answered with {}");
        }

        if (authorization.Status != "pending" || challenge.Status != "pending")
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "malformed", "The challenge is no longer pending");
        }

        authorization.AnsweredChallengeId = challenge.Id;
        authorization.PendingPollsLeft = PendingPollsAfterAnswer;
        challenge.Status = "processing";
        if (PendingPollsAfterAnswer == 0)
        {
            Validate(authorization);
        }

        return Json(HttpStatusCode.OK, writer =>
        {
            writer.WriteString("type", challenge.Type);
            writer.WriteString("url", Url($"challenge/{challenge.Id}").AbsoluteUri);
            writer.WriteString("token", challenge.Token);
            writer.WriteString("status", challenge.Status);
        });
    }

    private void Validate(Authorization authorization)
    {
        var challenge = _challenges[authorization.AnsweredChallengeId!];
        var account = _accounts[authorization.AccountId];
        var keyAuthorization = $"{challenge.Token}.{account.Thumbprint}";
        if (challenge.Type == AcmeChallengeTypes.Http01)
        {
            var served = _http01.Find(authorization.Name, challenge.Token);
            if (served == keyAuthorization)
            {
                challenge.Status = "valid";
            }
            else
            {
                challenge.Status = "invalid";
                challenge.Error = ("incorrectResponse", served is null
                    ? $"http://{authorization.Name}/.well-known/acme-challenge/{challenge.Token} returned 404"
                    : $"The key authorization served for {authorization.Name} does not match");
            }
        }
        else
        {
            var expected = Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(keyAuthorization)));
            if (_dns01.Find($"_acme-challenge.{authorization.Name}").Contains(expected))
            {
                challenge.Status = "valid";
            }
            else
            {
                challenge.Status = "invalid";
                challenge.Error = ("dns", $"No TXT record with the expected value at _acme-challenge.{authorization.Name}");
            }
        }

        authorization.Status = challenge.Status;
        foreach (var order in _orders.Values.Where(order => order.AuthorizationIds.Contains(authorization.Id)))
        {
            UpdateOrder(order);
        }
    }

    private HttpResponseMessage Finalize(Account account, string id, JwsReader jws)
    {
        if (!_orders.TryGetValue(id, out var order) || order.AccountId != account.Id)
        {
            return ProblemResponse(HttpStatusCode.NotFound, "malformed", "No such order");
        }

        if (order.Status != "ready")
        {
            return ProblemResponse(HttpStatusCode.Forbidden, "orderNotReady", $"The order is {order.Status}, not ready");
        }

        CertificateRequest csr;
        try
        {
            csr = CertificateRequest.LoadSigningRequest(
                Base64Url.DecodeFromChars(jws.PayloadJson.GetProperty("csr").GetString()),
                HashAlgorithmName.SHA256,
                CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);
        }
        catch (CryptographicException)
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "badCSR", "The CSR does not parse or its signature is wrong");
        }

        var san = csr.CertificateExtensions.OfType<X509SubjectAlternativeNameExtension>().FirstOrDefault();
        var requested = san?.EnumerateDnsNames().Order(StringComparer.Ordinal).ToList() ?? [];
        if (!requested.SequenceEqual(order.Names.Order(StringComparer.Ordinal)))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "badCSR", "The CSR names do not match the order");
        }

        if (_accounts.Values.Any(other => other.Key.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(csr.PublicKey.ExportSubjectPublicKeyInfo())))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "badCSR", "The CSR uses an account key");
        }

        var number = _issued.Count + 1;
        var serial = RandomNumberGenerator.GetBytes(16);

        // Every other certificate gets a serial with the top bit set, so its DER encoding needs a
        // leading zero byte, which the ARI identifier has to keep.
        serial[0] = number % 2 == 0 ? (byte)(serial[0] | 0x80) : (byte)((serial[0] & 0x7F) | 0x01);
        var now = _time.GetUtcNow();
        using var leaf = _ca.Issue(csr, san!, now.AddMinutes(-1), now.AddDays(90), serial);
        var serialContent = (serial[0] & 0x80) != 0 ? [0, .. serial] : serial;
        var issued = new Issued(
            NextId(),
            account.Id,
            leaf.RawData,
            $"{Base64Url.EncodeToString(_ca.IntermediateKeyId)}.{Base64Url.EncodeToString(serialContent)}",
            now.AddMinutes(-1),
            now.AddDays(90));
        _issued[issued.Id] = issued;
        if (order.Replaces is { } replaces)
        {
            _issued.Values.First(old => old.CertificateId == replaces).Replaced = true;
        }

        order.CertificateId = issued.Id;
        order.Status = ProcessingPolls > 0 ? "processing" : "valid";
        order.ProcessingPollsLeft = Math.Max(0, ProcessingPolls - 1);
        return OrderJson(order, HttpStatusCode.OK);
    }

    private HttpResponseMessage CertificateResource(Account account, string id)
    {
        var alternate = id.EndsWith("/alt/1", StringComparison.Ordinal);
        var certificateId = alternate ? id[..^"/alt/1".Length] : id;
        if (!_issued.TryGetValue(certificateId, out var issued))
        {
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        if (issued.AccountId != account.Id)
        {
            return ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "Not your certificate");
        }

        var chain = PemEncoding.WriteString("CERTIFICATE", issued.Der) + "\n"
            + PemEncoding.WriteString("CERTIFICATE", alternate ? _ca.AlternateIntermediate.RawData : _ca.Intermediate.RawData) + "\n";
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(chain, Encoding.ASCII) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/pem-certificate-chain");
        response.Headers.TryAddWithoutValidation("Link", $"<{DirectoryUrl}>;rel=\"index\"");
        response.Headers.TryAddWithoutValidation(
            "Link",
            alternate ? $"<{Url($"cert/{certificateId}")}>;rel=\"alternate\"" : $"<{Url($"cert/{certificateId}/alt/1")}>; rel=alternate");
        return response;
    }

    private HttpResponseMessage Revoke(Account account, JwsReader jws)
    {
        var payload = jws.PayloadJson;
        var der = Base64Url.DecodeFromChars(payload.GetProperty("certificate").GetString());
        var issued = _issued.Values.FirstOrDefault(candidate => candidate.Der.AsSpan().SequenceEqual(der));
        if (issued is null)
        {
            return ProblemResponse(HttpStatusCode.NotFound, "malformed", "Unknown certificate");
        }

        if (issued.AccountId != account.Id)
        {
            return ProblemResponse(HttpStatusCode.Forbidden, "unauthorized", "Not your certificate");
        }

        if (issued.RevokedReason is not null)
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "alreadyRevoked", "Certificate has already been revoked");
        }

        var reason = payload.TryGetProperty("reason", out var value) ? value.GetInt32() : 0;
        if (reason is not (0 or 1 or 3 or 4 or 5))
        {
            return ProblemResponse(HttpStatusCode.BadRequest, "badRevocationReason", "That reason is not allowed");
        }

        issued.RevokedReason = reason;
        return new HttpResponseMessage(HttpStatusCode.OK);
    }

    private HttpResponseMessage RenewalInfo(string certificateId)
    {
        var issued = _issued.Values.FirstOrDefault(candidate => candidate.CertificateId == certificateId);
        if (issued is null)
        {
            return ProblemResponse(HttpStatusCode.NotFound, "malformed", "Unknown certificate");
        }

        DateTimeOffset start, end;
        if (issued.RevokedReason is not null)
        {
            start = _time.GetUtcNow().AddDays(-2);
            end = _time.GetUtcNow().AddDays(-1);
        }
        else
        {
            var ideal = issued.NotAfter - ((issued.NotAfter - issued.NotBefore) / 3);
            start = ideal.AddDays(-1);
            end = ideal.AddDays(1);
        }

        var response = Json(HttpStatusCode.OK, writer =>
        {
            writer.WriteStartObject("suggestedWindow");
            writer.WriteString("start", start.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'00Z'", CultureInfo.InvariantCulture));
            writer.WriteString("end", end.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture));
            writer.WriteEndObject();
            writer.WriteString("explanationURL", "https://acme.test/docs/ari");
        });
        response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromHours(6));
        return response;
    }

    private sealed class Account(string id, string url, ECDsa key, string thumbprint, List<string> contact)
    {
        public string Id { get; } = id;

        public string Url { get; } = url;

        public ECDsa Key { get; set; } = key;

        public string Thumbprint { get; set; } = thumbprint;

        public List<string> Contact { get; } = contact;
    }

    private sealed class Order(string id, string accountId, List<string> names, string? replaces)
    {
        public string Id { get; } = id;

        public string AccountId { get; } = accountId;

        public List<string> Names { get; } = names;

        public string? Replaces { get; } = replaces;

        public List<string> AuthorizationIds { get; } = [];

        public string Status { get; set; } = "pending";

        public (string Type, string Detail)? Error { get; set; }

        public string? CertificateId { get; set; }

        public int ProcessingPollsLeft { get; set; }
    }

    private sealed class Authorization(string id, string accountId, string name, bool wildcard)
    {
        public string Id { get; } = id;

        public string AccountId { get; } = accountId;

        public string Name { get; } = name;

        public bool Wildcard { get; } = wildcard;

        public List<string> ChallengeIds { get; } = [];

        public string Status { get; set; } = "pending";

        public string? AnsweredChallengeId { get; set; }

        public int PendingPollsLeft { get; set; }
    }

    private sealed class Challenge(string id, string authorizationId, string type, string token)
    {
        public string Id { get; } = id;

        public string AuthorizationId { get; } = authorizationId;

        public string Type { get; } = type;

        public string Token { get; } = token;

        public string Status { get; set; } = "pending";

        public (string Type, string Detail)? Error { get; set; }
    }

    private sealed class Issued(
        string id,
        string accountId,
        byte[] der,
        string certificateId,
        DateTimeOffset notBefore,
        DateTimeOffset notAfter)
    {
        public string Id { get; } = id;

        public string AccountId { get; } = accountId;

        public byte[] Der { get; } = der;

        public string CertificateId { get; } = certificateId;

        public DateTimeOffset NotBefore { get; } = notBefore;

        public DateTimeOffset NotAfter { get; } = notAfter;

        public bool Replaced { get; set; }

        public int? RevokedReason { get; set; }
    }
}

/// <summary>
/// A root and an intermediate, plus an alternate root that cross-signs the same intermediate key,
/// so one leaf has two chains the way Let's Encrypt's did.
/// </summary>
internal sealed class FakeCertificateAuthority : IDisposable
{
    private readonly ECDsa _intermediateKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public FakeCertificateAuthority(DateTimeOffset now)
    {
        var notBefore = now.AddYears(-1);
        var notAfter = now.AddYears(10);
        Root = CreateRoot("Fake ACME Root X1", notBefore, notAfter);
        AlternateRoot = CreateRoot("Fake ACME Alternate Root X2", notBefore, notAfter);
        Intermediate = CreateIntermediate(Root, notBefore, notAfter);
        AlternateIntermediate = CreateIntermediate(AlternateRoot, notBefore, notAfter);
        IntermediateKeyId = Convert.FromHexString(
            Intermediate.Extensions.OfType<X509SubjectKeyIdentifierExtension>().Single().SubjectKeyIdentifier!);
    }

    public X509Certificate2 Root { get; }

    public X509Certificate2 AlternateRoot { get; }

    public X509Certificate2 Intermediate { get; }

    public X509Certificate2 AlternateIntermediate { get; }

    public byte[] IntermediateKeyId { get; }

    /// <summary>A leaf for the CSR's key and names, signed by the intermediate both chains share.</summary>
    public X509Certificate2 Issue(
        CertificateRequest csr,
        X509SubjectAlternativeNameExtension san,
        DateTimeOffset notBefore,
        DateTimeOffset notAfter,
        byte[] serial)
    {
        var names = san.EnumerateDnsNames().ToList();
        var request = new CertificateRequest(new X500DistinguishedName($"CN={names[0]}"), csr.PublicKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(san);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(csr.PublicKey, false));
        request.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(Intermediate, true, false));
        return request.Create(Intermediate.SubjectName, X509SignatureGenerator.CreateForECDsa(_intermediateKey), notBefore, notAfter, serial);
    }

    public void Dispose()
    {
        _intermediateKey.Dispose();
        Root.Dispose();
        AlternateRoot.Dispose();
        Intermediate.Dispose();
        AlternateIntermediate.Dispose();
    }

    private static X509Certificate2 CreateRoot(string name, DateTimeOffset notBefore, DateTimeOffset notAfter)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={name}", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        return request.CreateSelfSigned(notBefore, notAfter);
    }

    private X509Certificate2 CreateIntermediate(X509Certificate2 root, DateTimeOffset notBefore, DateTimeOffset notAfter)
    {
        var request = new CertificateRequest("CN=Fake ACME Intermediate E1", _intermediateKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign | X509KeyUsageFlags.DigitalSignature,
            true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        request.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(root, true, false));
        return request.Create(root, notBefore, notAfter, RandomNumberGenerator.GetBytes(8));
    }
}
