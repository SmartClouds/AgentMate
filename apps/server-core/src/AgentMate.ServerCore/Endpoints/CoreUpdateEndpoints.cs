using System.Globalization;
using System.Security.Claims;
using AgentMate.ServerCore.Audit;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Security;
using AgentMate.ServerCore.Updates;
using Microsoft.AspNetCore.Http.Features;

namespace AgentMate.ServerCore.Endpoints;

/// <summary>
/// The release upload behind a core update, for a server that could not fetch the release itself.
/// The tarball is the raw request body (tens of megabytes, too large for a hub message) and the
/// headers say which release it is; the core checks it against them before anything is unpacked.
/// Owner with a step-up, like the hub's UpdateCore. Refusals are JSON { code, message }.
/// </summary>
internal static class CoreUpdateEndpoints
{
    public const string Path = "/api/v1/core/update";

    public const string VersionHeader = "X-AgentMate-Core-Version";

    public const string FileHeader = "X-AgentMate-Core-File";

    public const string Sha256Header = "X-AgentMate-Core-Sha256";

    public static IEndpointRouteBuilder MapCoreUpdateEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPut(Path, UploadAsync).RequireAuthorization(CorePolicies.Owner, CorePolicies.StepUp);
        return endpoints;
    }

    private static async Task<IResult> UploadAsync(HttpContext context, CoreUpdater updater, AuditLog audit)
    {
        // The core's 10 MB request limit is for everything else; the release checks its own size.
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = CoreUpdateRules.MaxSize;
        }

        var headers = context.Request.Headers;
        var request = new CoreUpdateRequest(
            headers[VersionHeader].ToString(),
            headers[FileHeader].ToString(),
            headers[Sha256Header].ToString(),
            context.Request.ContentLength ?? 0);
        var parameters = new Dictionary<string, string?>
        {
            ["version"] = request.Version,
            ["sha256"] = request.Sha256,
            ["via"] = "upload",
            ["bytes"] = request.Size.ToString(CultureInfo.InvariantCulture),
        };
        try
        {
            if (context.Request.ContentLength is null)
            {
                throw new CoreUpdateException(CoreUpdateError.Invalid, "Send the release with a Content-Length.");
            }

            var result = await updater.ReceiveAsync(request, context.Request.Body, context.RequestAborted);
            parameters["outcome"] = Jobs.JobEngine.KindName(result.Outcome);
            await AuditAsync(audit, context, AuditResult.Success, parameters);
            return TypedResults.Json(result, CoreJson.Options);
        }
        catch (CoreUpdateException error)
        {
            parameters["error"] = error.Code;
            await AuditAsync(audit, context, error.Error is CoreUpdateError.Invalid or CoreUpdateError.Busy ? AuditResult.Denied : AuditResult.Failed, parameters);
            var status = error.Error switch
            {
                CoreUpdateError.Busy or CoreUpdateError.Unsupported => StatusCodes.Status409Conflict,
                CoreUpdateError.Mismatch => StatusCodes.Status422UnprocessableEntity,
                CoreUpdateError.Failed => StatusCodes.Status500InternalServerError,
                _ => StatusCodes.Status400BadRequest,
            };
            return TypedResults.Json(new { code = error.Code, message = error.Message }, CoreJson.Options, statusCode: status);
        }
        catch (Exception error) when (context.RequestAborted.IsCancellationRequested || error is BadHttpRequestException or IOException)
        {
            // The app went away part of the way through; nothing was unpacked.
            await AuditAsync(audit, context, AuditResult.Cancelled, parameters);
            return Results.Empty;
        }
    }

    private static async Task AuditAsync(AuditLog audit, HttpContext context, string result, Dictionary<string, string?> parameters)
    {
        var user = context.User;
        await audit.AppendAsync(new AuditEntry(
            "core.update",
            result,
            Guid.TryParse(user.FindFirstValue(ClaimTypes.NameIdentifier), out var userId) ? userId : null,
            Guid.TryParse(user.FindFirstValue(CoreAuthentication.DeviceClaim), out var deviceId) ? deviceId : null,
            PeerCredentials.UidOf(context),
            CoreVersion.Current,
            parameters));
    }
}
