using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Media;
using Runova.Website.Core.Problems;
using Runova.Website.Data;

namespace Runova.Website.Api.Media;

/// <summary>
/// Uploading images for posts, for Editors, Admins and API clients with <c>posts:write</c>. The
/// type comes from the file's leading bytes, never its name or part type, and what is stored is
/// re-encoded without metadata (see <see cref="MediaImages"/>).
/// </summary>
internal static class MediaEndpoints
{
    // Room for the multipart boundaries and the alt text around a file at the limit.
    private const long FormOverhead = 64 * 1024;

    public static IServiceCollection AddWebsiteMedia(this IServiceCollection services) => services.AddSingleton<MediaStorage>();

    public static RouteGroupBuilder MapMedia(this RouteGroupBuilder api)
    {
        api.MapPost("/media", UploadAsync)
            .RequireAuthorization(Policies.PostsWrite)
            .Accepts<IFormFile>("multipart/form-data")
            .WithMetadata(Idempotent.Instance, new RequestSizeLimitAttribute(MediaImages.MaxBytes + FormOverhead));
        return api;
    }

    private static async Task<Results<Created<MediaDto>, ValidationProblem, ProblemHttpResult>> UploadAsync(
        HttpContext http, AppDbContext db, AuditLog audit, MediaStorage storage, TimeProvider time, IConfiguration configuration)
    {
        var errors = new Dictionary<string, string[]>();
        if (!http.Request.HasFormContentType)
        {
            errors["file"] = ["Send the image as multipart/form-data, in a part named file."];
            return ApiProblems.Invalid(errors);
        }

        IFormCollection form;
        try
        {
            form = await http.Request.ReadFormAsync(http.RequestAborted);
        }
        catch (BadHttpRequestException e) when (e.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return TooLarge();
        }
        catch (InvalidDataException)
        {
            errors["file"] = ["The multipart body could not be read."];
            return ApiProblems.Invalid(errors);
        }

        var file = form.Files.GetFile("file");
        if (file?.Length > MediaImages.MaxBytes)
        {
            return TooLarge();
        }

        if (file is null)
        {
            errors["file"] = ["Send the image in a part named file."];
        }

        var alt = form["alt"].ToString().Trim();
        if (alt.Length is < 1 or > 200)
        {
            errors["alt"] = ["Describe the image in 1 to 200 characters."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        using var buffer = new MemoryStream();
        await file!.CopyToAsync(buffer, http.RequestAborted);
        if (MediaImages.Process(buffer.ToArray(), out var error) is not { } image)
        {
            errors["file"] = [error!];
            return ApiProblems.Invalid(errors);
        }

        var now = time.GetUtcNow();
        var (creatorKind, creatorId) = AuditLog.Actor(http.User);
        var media = new MediaFile
        {
            Path = await storage.SaveAsync(image, now, http.RequestAborted),
            ContentType = image.ContentType,
            Width = image.Width,
            Height = image.Height,
            Size = image.Bytes.Length,
            Alt = alt,
            CreatedAt = now,
            CreatedByKind = creatorKind,
            CreatedById = creatorId,
        };

        try
        {
            await using var transaction = await db.Database.BeginTransactionAsync();
            db.Media.Add(media);
            await db.SaveChangesAsync();
            audit.Add(AuditActions.MediaUpload, AuditTargetTypes.Media, media.Id, new { path = media.Path, contentType = media.ContentType });
            await db.SaveChangesAsync();
            await transaction.CommitAsync();
        }
        catch
        {
            storage.Delete(media.Path);
            throw;
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created($"{ApiV1.Prefix}/media/{media.Id}", MediaMapper.ToDto(media, MediaStorage.Url(SiteUrl.From(configuration), media)));
    }

    private static ProblemHttpResult TooLarge() =>
        ApiProblems.Of(ProblemTypes.PayloadTooLarge, $"An upload is at most {MediaImages.MaxBytes / 1024 / 1024} MB.");
}
