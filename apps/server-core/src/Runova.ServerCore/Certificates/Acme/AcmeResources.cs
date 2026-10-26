using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>The status values of accounts, orders, authorizations and challenges (RFC 8555 section 7.1.6).</summary>
internal enum AcmeStatus
{
    Unknown,
    Pending,
    Ready,
    Processing,
    Valid,
    Invalid,
    Deactivated,
    Expired,
    Revoked,
}

/// <summary>The challenge types this client can answer.</summary>
internal static class AcmeChallengeTypes
{
    public const string Http01 = "http-01";
    public const string Dns01 = "dns-01";
}

/// <summary>Revocation reasons Let's Encrypt accepts (RFC 5280 section 5.3.1).</summary>
internal enum AcmeRevocationReason
{
    Unspecified = 0,
    KeyCompromise = 1,
    AffiliationChanged = 3,
    Superseded = 4,
    CessationOfOperation = 5,
}

/// <summary>The CA's directory (RFC 8555 section 7.1.1), plus ARI's renewalInfo (RFC 9773 section 3).</summary>
internal sealed class AcmeDirectory
{
    public required Uri Url { get; init; }

    public required Uri NewNonce { get; init; }

    public required Uri NewAccount { get; init; }

    public required Uri NewOrder { get; init; }

    public required Uri RevokeCert { get; init; }

    public Uri? KeyChange { get; init; }

    /// <summary>Present only when the CA supports ARI; then renewals send "replaces".</summary>
    public Uri? RenewalInfo { get; init; }

    public Uri? TermsOfService { get; init; }

    public Uri? Website { get; init; }

    public IReadOnlyList<string> CaaIdentities { get; init; } = [];

    public bool ExternalAccountRequired { get; init; }

    /// <summary>Names of the certificate profiles the CA offers, if it offers any.</summary>
    public IReadOnlyList<string> Profiles { get; init; } = [];

    internal static AcmeDirectory Parse(Uri url, JsonElement json)
    {
        const string Operation = "Reading the ACME directory";
        var meta = json.ReadObject("meta");
        return new AcmeDirectory
        {
            Url = url,
            NewNonce = AcmeUrls.Require(json, "newNonce", url, Operation),
            NewAccount = AcmeUrls.Require(json, "newAccount", url, Operation),
            NewOrder = AcmeUrls.Require(json, "newOrder", url, Operation),
            RevokeCert = AcmeUrls.Require(json, "revokeCert", url, Operation),
            KeyChange = AcmeUrls.Optional(json, "keyChange", url, Operation),
            RenewalInfo = AcmeUrls.Optional(json, "renewalInfo", url, Operation),
            TermsOfService = meta is { } m ? AcmeUrls.OptionalAnyScheme(m, "termsOfService", url) : null,
            Website = meta is { } w ? AcmeUrls.OptionalAnyScheme(w, "website", url) : null,
            CaaIdentities = meta?.ReadStrings("caaIdentities") ?? [],
            ExternalAccountRequired = meta?.ReadBoolean("externalAccountRequired") ?? false,
            Profiles = meta?.ReadObject("profiles") is { } profiles
                ? [.. profiles.EnumerateObject().Select(profile => profile.Name)]
                : [],
        };
    }
}

/// <summary>
/// A registered ACME account: its URL (the "kid" of every request) and its key. The account owns
/// the key and disposes it.
/// </summary>
internal sealed class AcmeAccount(Uri directoryUrl, Uri url, AcmeAccountKey key) : IDisposable
{
    /// <summary>The directory of the CA the account belongs to.</summary>
    public Uri DirectoryUrl { get; } = directoryUrl;

    /// <summary>The account URL from the Location header of newAccount.</summary>
    public Uri Url { get; } = url;

    public AcmeAccountKey Key { get; } = key;

    public AcmeStatus Status { get; init; } = AcmeStatus.Valid;

    /// <summary>The contact URIs, as "mailto:" addresses.</summary>
    public IReadOnlyList<string> Contact { get; init; } = [];

    public void Dispose() => Key.Dispose();
}

/// <summary>An order for a certificate (RFC 8555 section 7.1.3).</summary>
internal sealed class AcmeOrder
{
    public required Uri Url { get; init; }

    public required AcmeStatus Status { get; init; }

    public DateTimeOffset? Expires { get; init; }

    public IReadOnlyList<AcmeIdentifier> Identifiers { get; init; } = [];

    public IReadOnlyList<Uri> Authorizations { get; init; } = [];

    public required Uri Finalize { get; init; }

    public Uri? Certificate { get; init; }

    public AcmeProblem? Error { get; init; }

    /// <summary>The certificate this order replaces, as the CA echoes it back (RFC 9773 section 5).</summary>
    public string? Replaces { get; init; }

    public string? Profile { get; init; }

    /// <summary>How long the CA asked to wait before asking again, from the response that carried this.</summary>
    public TimeSpan? RetryAfter { get; init; }

    internal static AcmeOrder Parse(Uri url, JsonElement json, TimeSpan? retryAfter, string operation) => new()
    {
        Url = url,
        Status = AcmeStatuses.Parse(json.ReadString("status")),
        Expires = json.ReadTimestamp("expires"),
        Identifiers = AcmeIdentifiers.Read(json),
        Authorizations = [.. json.ReadStrings("authorizations").Select(value => AcmeUrls.Parse(value, url, operation))],
        Finalize = AcmeUrls.Require(json, "finalize", url, operation),
        Certificate = AcmeUrls.Optional(json, "certificate", url, operation),
        Error = json.ReadObject("error") is { } error ? AcmeProblem.FromJson(error) : null,
        Replaces = json.ReadString("replaces"),
        Profile = json.ReadString("profile"),
        RetryAfter = retryAfter,
    };
}

/// <summary>An authorization for one identifier (RFC 8555 section 7.1.4).</summary>
internal sealed class AcmeAuthorization
{
    public required Uri Url { get; init; }

    public required AcmeStatus Status { get; init; }

    /// <summary>The identifier; for a wildcard this is the base name without "*." (see <see cref="Wildcard"/>).</summary>
    public required AcmeIdentifier Identifier { get; init; }

    public bool Wildcard { get; init; }

    public DateTimeOffset? Expires { get; init; }

    public IReadOnlyList<AcmeChallenge> Challenges { get; init; } = [];

    public TimeSpan? RetryAfter { get; init; }

    /// <summary>The name as ordered, with "*." again for a wildcard.</summary>
    public string Domain => Wildcard ? $"*.{Identifier.Value}" : Identifier.Value;

    public AcmeChallenge? FindChallenge(string type) =>
        Challenges.FirstOrDefault(challenge => string.Equals(challenge.Type, type, StringComparison.Ordinal));

    internal static AcmeAuthorization Parse(Uri url, JsonElement json, TimeSpan? retryAfter, string operation)
    {
        var identifier = json.ReadObject("identifier") is { } value
            && value.ReadString("type") is { } type
            && value.ReadString("value") is { } name
                ? new AcmeIdentifier(type, name)
                : throw new AcmeException($"{operation} failed: the CA sent an authorization without an identifier.");
        return new AcmeAuthorization
        {
            Url = url,
            Status = AcmeStatuses.Parse(json.ReadString("status")),
            Identifier = identifier,
            Wildcard = json.ReadBoolean("wildcard") ?? false,
            Expires = json.ReadTimestamp("expires"),
            Challenges = [.. json.ReadObjects("challenges").Select(challenge => AcmeChallenge.Parse(challenge, url, operation))],
            RetryAfter = retryAfter,
        };
    }
}

/// <summary>A challenge of an authorization (RFC 8555 section 7.1.5).</summary>
internal sealed class AcmeChallenge
{
    private const int MaxTokenLength = 512;

    public required string Type { get; init; }

    public required Uri Url { get; init; }

    /// <summary>
    /// The token, checked to be base64url (RFC 8555 section 8.3), so it is safe as a file name in a
    /// webroot and as a URL path segment.
    /// </summary>
    public string? Token { get; init; }

    public required AcmeStatus Status { get; init; }

    public AcmeProblem? Error { get; init; }

    public DateTimeOffset? Validated { get; init; }

    /// <summary>The key authorization for this challenge's token and the account key (RFC 8555 section 8.1).</summary>
    public string KeyAuthorization(AcmeAccountKey accountKey)
    {
        ArgumentNullException.ThrowIfNull(accountKey);
        return Token is null
            ? throw new AcmeException($"The CA's {Type} challenge has no token.")
            : $"{Token}.{accountKey.Thumbprint}";
    }

    /// <summary>The TXT record value for DNS-01: base64url(SHA-256(key authorization)) (RFC 8555 section 8.4).</summary>
    public string DnsTxtValue(AcmeAccountKey accountKey) =>
        System.Buffers.Text.Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(KeyAuthorization(accountKey))));

    internal static AcmeChallenge Parse(JsonElement json, Uri baseUrl, string operation)
    {
        var token = json.ReadString("token");
        if (token is not null && !IsBase64Url(token))
        {
            throw new AcmeException($"{operation} failed: the CA sent a challenge token that is not base64url.");
        }

        return new AcmeChallenge
        {
            Type = AcmeText.Clean(json.ReadString("type"), 64) ?? "unknown",
            Url = AcmeUrls.Require(json, "url", baseUrl, operation),
            Token = token,
            Status = AcmeStatuses.Parse(json.ReadString("status")),
            Error = json.ReadObject("error") is { } error ? AcmeProblem.FromJson(error) : null,
            Validated = json.ReadTimestamp("validated"),
        };
    }

    private static bool IsBase64Url(string token) =>
        token.Length is > 0 and <= MaxTokenLength
        && token.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
}

/// <summary>
/// A downloaded certificate chain (RFC 8555 section 7.4.2): the end-entity certificate first, then
/// its issuers, as PEM and as DER, with the URLs of alternate chains the CA offered.
/// </summary>
internal sealed class AcmeCertificateChain
{
    private const int MaxCertificates = 10;

    private AcmeCertificateChain(IReadOnlyList<byte[]> certificates, IReadOnlyList<Uri> alternates)
    {
        Certificates = certificates;
        Alternates = alternates;
        Pem = string.Concat(certificates.Select(der => PemEncoding.WriteString("CERTIFICATE", der) + "\n"));
    }

    /// <summary>The chain as PEM, leaf first, one certificate after another.</summary>
    public string Pem { get; }

    /// <summary>DER of each certificate, leaf first.</summary>
    public IReadOnlyList<byte[]> Certificates { get; }

    /// <summary>Other chains for the same leaf, from Link rel="alternate" headers.</summary>
    public IReadOnlyList<Uri> Alternates { get; }

    public X509Certificate2 LoadLeaf() => X509CertificateLoader.LoadCertificate(Certificates[0]);

    /// <summary>
    /// The common name of the issuer of the topmost certificate, which is how a chain is chosen
    /// ("preferred chain", as certbot calls it).
    /// </summary>
    public string? TopIssuerName()
    {
        using var top = X509CertificateLoader.LoadCertificate(Certificates[^1]);
        return top.IssuerName.EnumerateRelativeDistinguishedNames()
            .Where(name => !name.HasMultipleElements && name.GetSingleElementType().Value == "2.5.4.3")
            .Select(name => name.GetSingleElementValue())
            .FirstOrDefault();
    }

    /// <exception cref="AcmeException">The text holds no certificate, too many, or one that does not parse.</exception>
    internal static AcmeCertificateChain Parse(string pem, IReadOnlyList<Uri> alternates, string operation)
    {
        var certificates = new List<byte[]>();
        var rest = pem.AsSpan();
        while (PemEncoding.TryFind(rest, out var fields))
        {
            if (rest[fields.Label].SequenceEqual("CERTIFICATE"))
            {
                if (certificates.Count == MaxCertificates)
                {
                    throw new AcmeException($"{operation} failed: the chain has more than {MaxCertificates} certificates.");
                }

                var der = new byte[fields.DecodedDataLength];
                if (!Convert.TryFromBase64Chars(rest[fields.Base64Data], der, out var written))
                {
                    throw new AcmeException($"{operation} failed: the chain is not valid PEM.");
                }

                certificates.Add(der[..written]);
            }

            rest = rest[fields.Location.End..];
        }

        if (certificates.Count == 0)
        {
            throw new AcmeException($"{operation} failed: the CA's answer holds no certificate.");
        }

        foreach (var der in certificates)
        {
            try
            {
                using var certificate = X509CertificateLoader.LoadCertificate(der);
            }
            catch (CryptographicException error)
            {
                throw new AcmeException($"{operation} failed: the chain holds a certificate that does not parse.", error);
            }
        }

        return new AcmeCertificateChain(certificates, alternates);
    }
}

internal static class AcmeStatuses
{
    public static AcmeStatus Parse(string? status) => status switch
    {
        "pending" => AcmeStatus.Pending,
        "ready" => AcmeStatus.Ready,
        "processing" => AcmeStatus.Processing,
        "valid" => AcmeStatus.Valid,
        "invalid" => AcmeStatus.Invalid,
        "deactivated" => AcmeStatus.Deactivated,
        "expired" => AcmeStatus.Expired,
        "revoked" => AcmeStatus.Revoked,
        _ => AcmeStatus.Unknown,
    };

    /// <summary>The status as the protocol writes it, for messages.</summary>
    public static string Name(AcmeStatus status) => status switch
    {
        AcmeStatus.Pending => "pending",
        AcmeStatus.Ready => "ready",
        AcmeStatus.Processing => "processing",
        AcmeStatus.Valid => "valid",
        AcmeStatus.Invalid => "invalid",
        AcmeStatus.Deactivated => "deactivated",
        AcmeStatus.Expired => "expired",
        AcmeStatus.Revoked => "revoked",
        _ => "unknown",
    };
}

internal static class AcmeIdentifiers
{
    public static IReadOnlyList<AcmeIdentifier> Read(JsonElement json) =>
    [
        .. json.ReadObjects("identifiers")
            .Select(identifier => (Type: identifier.ReadString("type"), Value: identifier.ReadString("value")))
            .Where(identifier => identifier.Type is not null && identifier.Value is not null)
            .Select(identifier => new AcmeIdentifier(identifier.Type!, identifier.Value!)),
    ];
}

/// <summary>
/// URLs from the CA. ACME runs over HTTPS only (RFC 8555 section 6.1), so a URL with any other
/// scheme is refused before anything is sent to it.
/// </summary>
internal static class AcmeUrls
{
    private const int MaxUrlLength = 2048;

    public static Uri Require(JsonElement json, string name, Uri baseUrl, string operation) =>
        Optional(json, name, baseUrl, operation)
        ?? throw new AcmeException($"{operation} failed: the CA's answer has no \"{name}\" URL.");

    public static Uri? Optional(JsonElement json, string name, Uri baseUrl, string operation) =>
        json.ReadString(name) is { } value ? Parse(value, baseUrl, operation) : null;

    /// <summary>A URL for people (terms of service, website): shown, never requested.</summary>
    public static Uri? OptionalAnyScheme(JsonElement json, string name, Uri baseUrl) =>
        json.ReadString(name) is { Length: <= MaxUrlLength } value && Uri.TryCreate(baseUrl, value, out var url) ? url : null;

    public static Uri Parse(string value, Uri baseUrl, string operation)
    {
        if (value.Length > MaxUrlLength || !Uri.TryCreate(baseUrl, value, out var url))
        {
            throw new AcmeException($"{operation} failed: the CA sent a URL that does not parse.");
        }

        return RequireHttps(url, operation);
    }

    public static Uri RequireHttps(Uri url, string operation)
    {
        ArgumentNullException.ThrowIfNull(url);
        return url.IsAbsoluteUri && url.Scheme == Uri.UriSchemeHttps && string.IsNullOrEmpty(url.UserInfo)
            ? url
            : throw new AcmeException($"{operation} failed: the CA sent a URL that is not plain HTTPS.");
    }
}
