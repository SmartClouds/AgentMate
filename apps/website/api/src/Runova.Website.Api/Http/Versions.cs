using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Net.Http.Headers;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;

namespace Runova.Website.Api.Http;

/// <summary>
/// Strong ETags made from a row's version, and the <c>If-Match</c> check that every write to a
/// versioned resource needs.
/// </summary>
internal static class Versions
{
    public static string ETag(uint version) => $"\"{version.ToString(CultureInfo.InvariantCulture)}\"";

    public static void SetETag(HttpResponse response, uint version) => response.Headers.ETag = ETag(version);

    /// <summary>
    /// Null when <c>If-Match</c> names the current version (or is <c>*</c>); otherwise 428 when it
    /// is missing, or 412 with the <c>currentVersion</c> extension when it is stale.
    /// </summary>
    public static ProblemHttpResult? CheckIfMatch(HttpRequest request, uint current)
    {
        var ifMatch = request.Headers.IfMatch;
        if (ifMatch.Count == 0)
        {
            return ApiProblems.Of(ProblemTypes.PreconditionRequired, "Send If-Match with the ETag you last read.");
        }

        var tag = ETag(current);
        var matches = EntityTagHeaderValue.TryParseList(ifMatch, out var tags)
            && tags.Any(t => t.Equals(EntityTagHeaderValue.Any) || (!t.IsWeak && t.Tag == tag));
        return matches ? null : Stale(current);
    }

    /// <summary>The 412 for a write made against an older version, with the current one.</summary>
    public static ProblemHttpResult Stale(uint current) =>
        ApiProblems.Of(
            ProblemTypes.PreconditionFailed,
            "This was changed since you read it. Read it again and reapply your change.",
            new Dictionary<string, object?> { ["currentVersion"] = current.ToString(CultureInfo.InvariantCulture) });
}
