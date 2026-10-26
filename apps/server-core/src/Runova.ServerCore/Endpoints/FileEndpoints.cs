using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Net.Http.Headers;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Files;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Endpoints;

/// <summary>
/// A file manager session's transfers (E27), Admin only like the rest of it: a file down as plain
/// bytes (one byte range at most, for the editor's partial reads) and a file up as the raw request
/// body, streamed into the container without being held anywhere. Refusals are JSON
/// { code, message } with a status that fits; every transfer lands in the audit trail.
/// </summary>
internal static class FileEndpoints
{
    public const string Prefix = "/api/v1/files";

    /// <summary>The file's modification time, unix milliseconds in whole seconds.</summary>
    public const string MtimeHeader = "X-Runova-Mtime-Ms";

    private const int CopyBuffer = 128 * 1024;

    public static IEndpointRouteBuilder MapFileEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup(Prefix).RequireAuthorization(CorePolicies.Admin);
        group.MapGet("/{sessionId:guid}/content", DownloadAsync);
        group.MapPut("/{sessionId:guid}/content", UploadAsync);
        return endpoints;
    }

    private static async Task<IResult> DownloadAsync(Guid sessionId, string? path, HttpContext context, ContainerFilesService files, AuditLog audit)
    {
        var parameters = new Dictionary<string, string?> { ["path"] = path };
        var target = files.Describe(sessionId);
        try
        {
            await using var download = await files.OpenDownloadAsync(sessionId, UserOf(context), path!, context.RequestAborted);
            var range = context.Request.Headers.Range.ToString();
            var (start, length) = (0L, download.Size);
            if (range.Length > 0 && ParseRange(range, download.Size) is var (from, count))
            {
                if (count < 0)
                {
                    context.Response.Headers.ContentRange = $"bytes */{download.Size}";
                    return Refuse(new FileOperationException(FileErrorCode.InvalidInput, $"The file is {download.Size} bytes; that range starts past its end."), StatusCodes.Status416RangeNotSatisfiable);
                }

                (start, length) = (from, count);
                parameters["range"] = $"{from}-{from + count - 1}";
                context.Response.StatusCode = StatusCodes.Status206PartialContent;
                context.Response.Headers.ContentRange = $"bytes {from}-{from + count - 1}/{download.Size}";
            }

            parameters["bytes"] = length.ToString(CultureInfo.InvariantCulture);
            await AuditAsync(audit, context, "files.download", AuditResult.Success, target, parameters);
            context.Response.ContentType = "application/octet-stream";
            context.Response.ContentLength = length;
            context.Response.Headers[MtimeHeader] = download.MtimeUnixMs.ToString(CultureInfo.InvariantCulture);
            // An app from before the rename reads the old name.
            context.Response.Headers[LegacyNames.MtimeHeader] = download.MtimeUnixMs.ToString(CultureInfo.InvariantCulture);
            context.Response.Headers.AcceptRanges = "bytes";
            await CopyAsync(download.Body, context.Response.Body, start, length, context.RequestAborted);
            return Results.Empty;
        }
        catch (FileOperationException error)
        {
            parameters["error"] = error.CodeName;
            await AuditAsync(audit, context, "files.download", AuditResult.Failed, target, parameters);
            return Refuse(error);
        }
    }

    private static async Task<IResult> UploadAsync(Guid sessionId, string? path, string? mode, HttpContext context, ContainerFilesService files, AuditLog audit)
    {
        var parameters = new Dictionary<string, string?> { ["path"] = path, ["mode"] = mode };
        var target = files.Describe(sessionId);
        // The core's 10 MB request limit is for everything else; a file can be as large as the disk.
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = null;
        }

        try
        {
            if (context.Request.ContentLength is not long length)
            {
                return Refuse(new FileOperationException(FileErrorCode.InvalidInput, "Send the file with a Content-Length."), StatusCodes.Status411LengthRequired);
            }

            parameters["bytes"] = length.ToString(CultureInfo.InvariantCulture);
            int? bits = null;
            if (!string.IsNullOrEmpty(mode))
            {
                bits = mode.Length <= 4 && mode.All(c => c is >= '0' and <= '7')
                    ? Convert.ToInt32(mode, 8)
                    : throw new FileOperationException(FileErrorCode.InvalidInput, "A mode is octal permission bits, such as 644.");
            }

            var entry = await files.UploadAsync(sessionId, UserOf(context), path!, length, bits, context.Request.Body, context.RequestAborted);
            await AuditAsync(audit, context, "files.upload", AuditResult.Success, target, parameters);
            return TypedResults.Json(entry, CoreJson.Options);
        }
        catch (FileOperationException error)
        {
            parameters["error"] = error.CodeName;
            await AuditAsync(audit, context, "files.upload", AuditResult.Failed, target, parameters);
            return Refuse(error);
        }
        catch (Exception error) when (context.RequestAborted.IsCancellationRequested || error is BadHttpRequestException or IOException)
        {
            // The client went away part of the way through; nothing was put in place.
            await AuditAsync(audit, context, "files.upload", AuditResult.Cancelled, target, parameters);
            return Results.Empty;
        }
    }

    /// <summary>
    /// One range: "bytes=a-b", "bytes=a-" or "bytes=-n", as (start, length), clipped to the file.
    /// A start past the end is (0, -1). Anything else (several ranges, other units) is null, and
    /// the whole file is sent.
    /// </summary>
    internal static (long Start, long Length)? ParseRange(string header, long size)
    {
        if (!RangeHeaderValue.TryParse(header, out var parsed) || parsed.Unit != "bytes" || parsed.Ranges.Count != 1)
        {
            return null;
        }

        var range = parsed.Ranges.First();
        if (range.From is null)
        {
            var suffix = Math.Min(range.To ?? 0, size);
            return suffix <= 0 ? (0, -1) : (size - suffix, suffix);
        }

        var start = range.From.Value;
        if (start >= size)
        {
            return (0, -1);
        }

        var end = Math.Min(range.To ?? (size - 1), size - 1);
        return end < start ? null : (start, end - start + 1);
    }

    private static async Task CopyAsync(Stream source, Stream destination, long skip, long length, CancellationToken cancellationToken)
    {
        var buffer = new byte[CopyBuffer];
        while (skip > 0)
        {
            var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, skip)), cancellationToken);
            if (read == 0)
            {
                return;
            }

            skip -= read;
        }

        while (length > 0)
        {
            var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, length)), cancellationToken);
            if (read == 0)
            {
                return;
            }

            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            length -= read;
        }
    }

    private static JsonHttpResult<FileErrorBody> Refuse(FileOperationException error, int? status = null) =>
        TypedResults.Json(new FileErrorBody(error.CodeName, error.Message), CoreJson.Options, statusCode: status ?? error.HttpStatus);

    private static Guid UserOf(HttpContext context) => Guid.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    private static async Task AuditAsync(AuditLog audit, HttpContext context, string action, string result, string? target, Dictionary<string, string?> parameters)
    {
        var user = context.User;
        await audit.AppendAsync(new AuditEntry(
            action,
            result,
            Guid.TryParse(user.FindFirstValue(ClaimTypes.NameIdentifier), out var userId) ? userId : null,
            Guid.TryParse(user.FindFirstValue(CoreAuthentication.DeviceClaim), out var deviceId) ? deviceId : null,
            PeerCredentials.UidOf(context),
            target,
            parameters));
    }
}
