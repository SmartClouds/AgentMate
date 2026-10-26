using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.HttpResults;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Endpoints;

/// <summary>
/// A stack's files go up over REST, since a compose file and its .env can be larger than a hub
/// message: the revision as JSON, then (when it announced one) its build context as a .tar.gz
/// streamed straight into the safe extractor. Operators only, like deploying. Bodies are capped
/// here and counted as they are read, whatever the server's own limit is.
/// </summary>
internal static class StackEndpoints
{
    public const string Prefix = "/api/v1/stacks";

    /// <summary>The compose file and the .env, 1 MB each at most, and the JSON around them.</summary>
    public const long MaxRevisionBytes = 4L * 1024 * 1024;

    /// <summary>The build context's archive: the unpacked cap plus room for gzip that compresses nothing.</summary>
    public const long MaxContextBytes = 300L * 1024 * 1024;

    public const string ShaHeader = "X-Content-Sha256";

    public static IEndpointRouteBuilder MapStackEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var stacks = endpoints.MapGroup(Prefix).RequireAuthorization(CorePolicies.Operator);
        stacks.MapPost("/{stackId:guid}/revisions", UploadRevisionAsync);
        stacks.MapPut("/{stackId:guid}/revisions/{number:int}/context", UploadContextAsync);
        return endpoints;
    }

    private static async Task<IResult> UploadRevisionAsync(Guid stackId, HttpContext context, StackOperations operations)
    {
        LimitBody(context, MaxRevisionBytes);
        if (context.Request.ContentLength > MaxRevisionBytes)
        {
            return Refuse("The revision is larger than 4 MB.", StatusCodes.Status413PayloadTooLarge);
        }

        StackRevisionUpload? upload;
        try
        {
            await using var body = new CappedStream(context.Request.Body, MaxRevisionBytes);
            upload = await JsonSerializer.DeserializeAsync<StackRevisionUpload>(body, CoreJson.Options, context.RequestAborted);
        }
        catch (BodyTooLargeException)
        {
            return Refuse("The revision is larger than 4 MB.", StatusCodes.Status413PayloadTooLarge);
        }
        catch (JsonException)
        {
            return Refuse("The revision is not the JSON the core expects.", StatusCodes.Status400BadRequest);
        }

        return await RunAsync(() => operations.UploadAsync(stackId, upload, CallerOf(context), context.RequestAborted));
    }

    private static async Task<IResult> UploadContextAsync(Guid stackId, int number, HttpContext context, StackOperations operations)
    {
        LimitBody(context, MaxContextBytes);
        if (context.Request.ContentLength > MaxContextBytes)
        {
            return Refuse("The build context is larger than 300 MB.", StatusCodes.Status413PayloadTooLarge);
        }

        if (context.Request.ContentType is not ("application/gzip" or "application/x-gzip" or "application/octet-stream"))
        {
            return Refuse("Send the build context as application/gzip.", StatusCodes.Status415UnsupportedMediaType);
        }

        var sha = context.Request.Headers[ShaHeader].FirstOrDefault();
        try
        {
            await using var body = new CappedStream(context.Request.Body, MaxContextBytes);
            return await RunAsync(() => operations.UploadContextAsync(stackId, number, body, sha, CallerOf(context), context.RequestAborted));
        }
        catch (BodyTooLargeException)
        {
            return Refuse("The build context is larger than 300 MB.", StatusCodes.Status413PayloadTooLarge);
        }
        catch (InvalidDataException)
        {
            return Refuse("The build context is not a .tar.gz archive.", StatusCodes.Status400BadRequest);
        }
    }

    private static async Task<IResult> RunAsync(Func<Task<StackRevisionInfo>> work)
    {
        try
        {
            return TypedResults.Json(await work(), CoreJson.Options);
        }
        catch (StackRefusedException refused)
        {
            return Refuse(refused.Message, refused.Status);
        }
    }

    private static JsonHttpResult<StackUploadError> Refuse(string message, int status) =>
        TypedResults.Json(new StackUploadError(message), CoreJson.Options, statusCode: status);

    private static void LimitBody(HttpContext context, long bytes)
    {
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = bytes;
        }
    }

    private static StackCaller CallerOf(HttpContext context)
    {
        var user = context.User;
        return new StackCaller(
            Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!),
            user.FindFirstValue(ClaimTypes.Name) ?? string.Empty,
            Guid.TryParse(user.FindFirstValue(CoreAuthentication.DeviceClaim), out var device) ? device : null,
            PeerCredentials.UidOf(context));
    }

    private sealed class BodyTooLargeException : Exception;

    /// <summary>Counts what is read and stops past the cap, whether or not the client sent a length.</summary>
    private sealed class CappedStream(Stream inner, long cap) : Stream
    {
        private long _read;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            Count(await inner.ReadAsync(buffer, cancellationToken));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Count(int read)
        {
            _read += read;
            return _read > cap ? throw new BodyTooLargeException() : read;
        }
    }
}
