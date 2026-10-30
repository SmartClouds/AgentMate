using Microsoft.AspNetCore.Http.HttpResults;
using Runova.Website.Core.Problems;

namespace Runova.Website.Api.Problems;

/// <summary>Problem results with a type from the contract, for endpoints to return.</summary>
internal static class ApiProblems
{
    public static ProblemHttpResult Of(ProblemType type, string detail, IDictionary<string, object?>? extensions = null) =>
        TypedResults.Problem(detail, statusCode: type.Status, title: type.Title, type: type.Uri, extensions: extensions);

    /// <summary>A 400 <c>validation-failed</c> for one request field.</summary>
    public static ValidationProblem Invalid(string field, string message) =>
        Invalid(new Dictionary<string, string[]> { [field] = [message] });

    /// <summary>A 400 <c>validation-failed</c> keyed by the JSON paths of the request fields.</summary>
    public static ValidationProblem Invalid(IDictionary<string, string[]> errors) =>
        TypedResults.ValidationProblem(
            errors,
            detail: "One or more fields are not valid.",
            title: ProblemTypes.ValidationFailed.Title,
            type: ProblemTypes.ValidationFailed.Uri);
}
