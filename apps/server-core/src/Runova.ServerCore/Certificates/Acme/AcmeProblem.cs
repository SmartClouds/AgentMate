using System.Collections.Frozen;
using System.Globalization;
using System.Net;
using System.Text.Json;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>The error types of RFC 8555 section 6.7, RFC 9773 (alreadyReplaced) and ACME profiles.</summary>
internal enum AcmeErrorType
{
    /// <summary>A type outside the ACME namespace, or none at all.</summary>
    Unknown,
    AccountDoesNotExist,
    AlreadyReplaced,
    AlreadyRevoked,
    BadCsr,
    BadNonce,
    BadPublicKey,
    BadRevocationReason,
    BadSignatureAlgorithm,
    Caa,
    Compound,
    Connection,
    Dns,
    ExternalAccountRequired,
    IncorrectResponse,
    InvalidContact,
    InvalidProfile,
    Malformed,
    OrderNotReady,
    RateLimited,
    RejectedIdentifier,
    ServerInternal,
    Tls,
    Unauthorized,
    UnsupportedContact,
    UnsupportedIdentifier,
    UserActionRequired,
}

/// <summary>
/// An ACME problem document (RFC 7807 with the ACME error types). It comes back from failed
/// requests and sits in the "error" member of orders and challenges.
/// </summary>
internal sealed class AcmeProblem
{
    public const string ErrorNamespace = "urn:ietf:params:acme:error:";

    private const int MaxSubproblems = 20;

    private static readonly FrozenDictionary<string, AcmeErrorType> _errorTypes =
        new Dictionary<string, AcmeErrorType>(StringComparer.Ordinal)
        {
            ["accountDoesNotExist"] = AcmeErrorType.AccountDoesNotExist,
            ["alreadyReplaced"] = AcmeErrorType.AlreadyReplaced,
            ["alreadyRevoked"] = AcmeErrorType.AlreadyRevoked,
            ["badCSR"] = AcmeErrorType.BadCsr,
            ["badNonce"] = AcmeErrorType.BadNonce,
            ["badPublicKey"] = AcmeErrorType.BadPublicKey,
            ["badRevocationReason"] = AcmeErrorType.BadRevocationReason,
            ["badSignatureAlgorithm"] = AcmeErrorType.BadSignatureAlgorithm,
            ["caa"] = AcmeErrorType.Caa,
            ["compound"] = AcmeErrorType.Compound,
            ["connection"] = AcmeErrorType.Connection,
            ["dns"] = AcmeErrorType.Dns,
            ["externalAccountRequired"] = AcmeErrorType.ExternalAccountRequired,
            ["incorrectResponse"] = AcmeErrorType.IncorrectResponse,
            ["invalidContact"] = AcmeErrorType.InvalidContact,
            ["invalidProfile"] = AcmeErrorType.InvalidProfile,
            ["malformed"] = AcmeErrorType.Malformed,
            ["orderNotReady"] = AcmeErrorType.OrderNotReady,
            ["rateLimited"] = AcmeErrorType.RateLimited,
            ["rejectedIdentifier"] = AcmeErrorType.RejectedIdentifier,
            ["serverInternal"] = AcmeErrorType.ServerInternal,
            ["tls"] = AcmeErrorType.Tls,
            ["unauthorized"] = AcmeErrorType.Unauthorized,
            ["unsupportedContact"] = AcmeErrorType.UnsupportedContact,
            ["unsupportedIdentifier"] = AcmeErrorType.UnsupportedIdentifier,
            ["userActionRequired"] = AcmeErrorType.UserActionRequired,
        }.ToFrozenDictionary(StringComparer.Ordinal);

    public AcmeProblem(string type)
    {
        Type = string.IsNullOrWhiteSpace(type) ? "about:blank" : type;
        ErrorType = Type.StartsWith(ErrorNamespace, StringComparison.Ordinal)
            && _errorTypes.TryGetValue(Type[ErrorNamespace.Length..], out var known)
                ? known
                : AcmeErrorType.Unknown;
    }

    /// <summary>The type URI, "about:blank" when the server gave none.</summary>
    public string Type { get; }

    public AcmeErrorType ErrorType { get; }

    public string? Title { get; init; }

    public string? Detail { get; init; }

    public int? Status { get; init; }

    /// <summary>For subproblems: which identifier this one is about (RFC 8555 section 6.7.1).</summary>
    public AcmeIdentifier? Identifier { get; init; }

    public IReadOnlyList<AcmeProblem> Subproblems { get; init; } = [];

    /// <summary>The short ACME type ("badCSR"), the full URI for other types, or null for none.</summary>
    public string? ShortType =>
        Type.StartsWith(ErrorNamespace, StringComparison.Ordinal) ? Type[ErrorNamespace.Length..]
        : Type == "about:blank" ? null
        : Type;

    /// <summary>A problem document from a response body, or null when the body is not one.</summary>
    public static AcmeProblem? TryParse(ReadOnlySpan<byte> json)
    {
        using var document = AcmeJson.TryParseObject(json.ToArray());
        return document is null ? null : FromJson(document.RootElement);
    }

    /// <summary>A problem document from the "error" member of an order or a challenge.</summary>
    public static AcmeProblem? FromJson(JsonElement element, int depth = 0)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (element.TryGetProperty("type", out var type) && type.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var identifier = element.ReadObject("identifier");
        var identifierValue = identifier is { } about ? AcmeText.Clean(about.ReadString("value"), 253) : null;
        return new AcmeProblem(element.ReadString("type") ?? string.Empty)
        {
            Title = AcmeText.Clean(element.ReadString("title")),
            Detail = AcmeText.Clean(element.ReadString("detail")),
            Status = element.ReadInt32("status"),
            Identifier = identifierValue is null
                ? null
                : new AcmeIdentifier(identifier!.Value.ReadString("type") ?? AcmeIdentifier.DnsType, identifierValue),
            Subproblems = depth > 0
                ? []
                : [.. element.ReadObjects("subproblems").Take(MaxSubproblems).Select(sub => FromJson(sub, depth + 1)).OfType<AcmeProblem>()],
        };
    }

    /// <summary>One line for people: the detail, then what each subproblem says about its identifier.</summary>
    public string Describe()
    {
        var text = Detail ?? Title ?? "The CA gave no detail";
        if (Subproblems.Count == 0)
        {
            return text;
        }

        var parts = Subproblems.Select(sub => $"{sub.Identifier?.Value ?? "unknown"}: {sub.Detail ?? sub.Title ?? sub.ShortType}");
        return AcmeText.Clean($"{text} ({string.Join("; ", parts)})", 2 * AcmeText.MaxLength)!;
    }
}

/// <summary>
/// Talking to the CA went wrong: no answer in time, an answer that could not be read, a redirect,
/// or a result that does not match the request. Messages say what failed, never with secrets.
/// </summary>
internal class AcmeException : Exception
{
    public AcmeException()
    {
    }

    public AcmeException(string message)
        : base(message)
    {
    }

    public AcmeException(string message, Exception? innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>The CA refused a request with a problem document (RFC 8555 section 6.7).</summary>
internal class AcmeProblemException(string message, AcmeProblem problem, HttpStatusCode statusCode, DateTimeOffset? retryAt)
    : AcmeException(message)
{
    public AcmeProblem Problem { get; } = problem;

    public AcmeErrorType ErrorType => Problem.ErrorType;

    public HttpStatusCode StatusCode { get; } = statusCode;

    /// <summary>When the CA said to try again (its Retry-After header), if it said.</summary>
    public DateTimeOffset? RetryAt { get; } = retryAt;

    /// <param name="operation">What was being done, as the start of a sentence ("Ordering the certificate").</param>
    /// <param name="problem">What the CA said.</param>
    /// <param name="statusCode">The HTTP status of the answer.</param>
    /// <param name="retryAt">When the CA said to try again, if it did.</param>
    /// <param name="seeAlso">A page the operator has to visit, such as changed terms of service.</param>
    public static AcmeProblemException Create(
        string operation,
        AcmeProblem problem,
        HttpStatusCode statusCode,
        DateTimeOffset? retryAt,
        Uri? seeAlso = null)
    {
        ArgumentNullException.ThrowIfNull(problem);
        var see = seeAlso is null ? string.Empty : $" (see {seeAlso.AbsoluteUri})";
        if (problem.ErrorType == AcmeErrorType.RateLimited)
        {
            var after = retryAt is { } at
                ? string.Create(CultureInfo.InvariantCulture, $"; try again after {at:u}")
                : string.Empty;
            return new AcmeRateLimitedException(
                $"{operation} was rate limited by the CA{after}: {problem.Describe()}",
                problem,
                statusCode,
                retryAt);
        }

        var type = problem.ShortType ?? string.Create(CultureInfo.InvariantCulture, $"HTTP {(int)statusCode}");
        return new AcmeProblemException($"{operation} failed ({type}): {problem.Describe()}{see}", problem, statusCode, retryAt);
    }
}

/// <summary>
/// A rate limit of the CA was hit (RFC 8555 section 6.6). Trying again before
/// <see cref="AcmeProblemException.RetryAt"/> only fails again.
/// </summary>
internal sealed class AcmeRateLimitedException(string message, AcmeProblem problem, HttpStatusCode statusCode, DateTimeOffset? retryAt)
    : AcmeProblemException(message, problem, statusCode, retryAt);
