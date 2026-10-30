namespace Runova.Website.Core.Problems;

/// <summary>A problem type from the contract: its slug under the problems base, status and title.</summary>
public sealed record ProblemType(string Slug, int Status, string Title)
{
    public string Uri => ProblemTypes.BaseUri + Slug;
}

/// <summary>
/// The problem types of docs/website/api-contract.md, in the order of its table. A unit test
/// reads the table and fails when the two drift apart.
/// </summary>
public static class ProblemTypes
{
    public const string BaseUri = "https://runovahq.com/problems/";

    public static readonly ProblemType ValidationFailed = new("validation-failed", 400, "The request is not valid.");
    public static readonly ProblemType Unauthorized = new("unauthorized", 401, "Sign-in is required.");
    public static readonly ProblemType TwoFactorRequired = new("two-factor-required", 401, "A two-factor code is required.");
    public static readonly ProblemType Forbidden = new("forbidden", 403, "This is not allowed for you.");
    public static readonly ProblemType NotFound = new("not-found", 404, "Nothing was found here.");
    public static readonly ProblemType Conflict = new("conflict", 409, "The request conflicts with what is stored.");
    public static readonly ProblemType PreconditionFailed = new("precondition-failed", 412, "The resource has changed since you read it.");
    public static readonly ProblemType PayloadTooLarge = new("payload-too-large", 413, "The request body is too large.");
    public static readonly ProblemType IdempotencyKeyReused = new("idempotency-key-reused", 422, "The idempotency key was already used for another request.");
    public static readonly ProblemType AccountLocked = new("account-locked", 423, "The account is locked for now.");
    public static readonly ProblemType PreconditionRequired = new("precondition-required", 428, "An If-Match header is required.");
    public static readonly ProblemType RateLimited = new("rate-limited", 429, "Too many requests.");
    public static readonly ProblemType Internal = new("internal", 500, "Something went wrong on our side.");
    public static readonly ProblemType Unavailable = new("unavailable", 503, "The service is not available right now.");

    public static IReadOnlyList<ProblemType> All { get; } =
    [
        ValidationFailed, Unauthorized, TwoFactorRequired, Forbidden, NotFound, Conflict, PreconditionFailed,
        PayloadTooLarge, IdempotencyKeyReused, AccountLocked, PreconditionRequired, RateLimited, Internal, Unavailable,
    ];

    // The first type of each status is its general one; 401 means unauthorized unless the code
    // that answers says two-factor-required.
    private static readonly Dictionary<int, ProblemType> _byStatus =
        All.GroupBy(t => t.Status).ToDictionary(g => g.Key, g => g.First());

    /// <summary>The general type for a status, or null when the contract has none.</summary>
    public static ProblemType? ForStatus(int status) => _byStatus.GetValueOrDefault(status);
}
