using System.Diagnostics;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;
using Runova.Website.Core.Problems;

namespace Runova.Website.Api.Problems;

/// <summary>
/// Writes every error as <c>application/problem+json</c> in the contract's shape, whatever the
/// request's Accept header says (the built-in writer gives up on <c>text/html</c> and leaves a
/// plain text body). Registered ahead of the built-in writer, so it always wins.
/// </summary>
internal sealed class ProblemJsonWriter(IOptions<JsonOptions> json, IOptions<ProblemDetailsOptions> options) : IProblemDetailsWriter
{
    public const string ContentType = "application/problem+json";

    // TypedResults.Problem fills in links to RFC 9110; those count as no type at all.
    private const string FrameworkTypePrefix = "https://tools.ietf.org/";

    public bool CanWrite(ProblemDetailsContext context) => true;

    public ValueTask WriteAsync(ProblemDetailsContext context)
    {
        var http = context.HttpContext;
        var problem = context.ProblemDetails;
        var status = problem.Status ??= http.Response.StatusCode;
        http.Response.StatusCode = status;

        var reasonPhrase = ReasonPhrases.GetReasonPhrase(status);
        if (problem.Type is null || problem.Type.StartsWith(FrameworkTypePrefix, StringComparison.Ordinal))
        {
            // A status the contract has no type for gets RFC 9457's default.
            var type = ProblemTypes.ForStatus(status);
            problem.Type = type?.Uri ?? "about:blank";
            if (problem.Title is null || problem.Title == reasonPhrase)
            {
                problem.Title = type?.Title ?? reasonPhrase;
            }
        }

        problem.Title ??= reasonPhrase;
        problem.Instance ??= http.Request.PathBase + http.Request.Path;
        problem.Extensions.TryAdd("traceId", Activity.Current?.Id ?? http.TraceIdentifier);

        options.Value.CustomizeProblemDetails?.Invoke(context);

        return new ValueTask(http.Response.WriteAsJsonAsync(
            problem, json.Value.SerializerOptions.GetTypeInfo(problem.GetType()), ContentType, http.RequestAborted));
    }
}
