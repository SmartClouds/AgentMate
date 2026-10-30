using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Content;
using Runova.Website.Core.Json;
using Runova.Website.Core.News;
using Runova.Website.Core.Posts;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Posts;

/// <summary>
/// Writing posts, for Editors, Admins and API clients with <c>posts:write</c>, by the same rules
/// as news: create, replace, merge patch and archive by id, <c>If-Match</c> on every change, an
/// audit entry with every write, and <c>Idempotency-Key</c> on a create.
/// </summary>
internal static class PostWriteEndpoints
{
    private const string MergePatchJson = "application/merge-patch+json";

    public static RouteGroupBuilder MapPostWrites(this RouteGroupBuilder api)
    {
        var posts = api.MapGroup("/posts").RequireAuthorization(Policies.PostsWrite);
        posts.MapGet("/{id:long}", GetAsync).Produces(StatusCodes.Status304NotModified);
        posts.MapPost("", CreateAsync).Accepts<PostWriteDto>("application/json").WithMetadata(Idempotent.Instance);
        posts.MapPut("/{id:long}", ReplaceAsync).Accepts<PostWriteDto>("application/json");
        posts.MapPatch("/{id:long}", PatchAsync).Accepts<PostWriteDto>(MergePatchJson, "application/json");
        posts.MapDelete("/{id:long}", ArchiveAsync);
        return api;
    }

    private static async Task<Results<Ok<PostAdminDto>, StatusCodeHttpResult, ProblemHttpResult>> GetAsync(
        long id, AppDbContext db, IConfiguration configuration, HttpContext http)
    {
        if (await db.Posts.AsNoTracking().Include(p => p.Tags).SingleOrDefaultAsync(p => p.Id == id) is not { } post)
        {
            return NotFound();
        }

        if (HttpCaching.IsNotModified(http, Versions.ETag(post.Version), HttpCaching.Private))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(await ToAdminDtoAsync(db, configuration, post));
    }

    private static async Task<Results<Created<PostAdminDto>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json)
    {
        var errors = new Dictionary<string, string[]>();
        var dto = await ReadAsync(http, db, json.Value.SerializerOptions, current: null, errors);
        if (dto is null)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await db.Posts.AnyAsync(p => p.Slug == dto.Slug))
        {
            return SlugTaken();
        }

        var now = time.GetUtcNow();
        var (creatorKind, creatorId) = AuditLog.Actor(http.User);
        var post = new Post
        {
            CreatedAt = now,
            UpdatedAt = now,
            CreatedByKind = creatorKind,
            CreatedById = creatorId,
            AuthorName = (await Writes.CreatorAsync(db, creatorKind, creatorId))?.Name ?? "",
        };
        await ApplyAsync(dto, post, db, renderer, now);

        await using var transaction = await db.Database.BeginTransactionAsync();
        db.Posts.Add(post);
        if (!await Writes.TrySaveAsync(db))
        {
            return SlugTaken();
        }

        audit.Add(AuditActions.PostCreate, AuditTargetTypes.Post, post.Id, new { slug = post.Slug, status = post.Status });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        SetHeaders(http.Response, post);
        return TypedResults.Created($"{ApiV1.Prefix}/posts/{post.Id}", await ToAdminDtoAsync(db, configuration, post));
    }

    private static Task<Results<Ok<PostAdminDto>, ValidationProblem, ProblemHttpResult>> ReplaceAsync(
        long id,
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json) =>
        UpdateAsync(id, merge: false, http, db, audit, renderer, time, configuration, json.Value.SerializerOptions);

    /// <summary>A JSON merge patch, validated as the whole post it makes.</summary>
    private static Task<Results<Ok<PostAdminDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id,
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json) =>
        UpdateAsync(id, merge: true, http, db, audit, renderer, time, configuration, json.Value.SerializerOptions);

    private static async Task<Results<Ok<PostAdminDto>, ValidationProblem, ProblemHttpResult>> UpdateAsync(
        long id,
        bool merge,
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        JsonSerializerOptions json)
    {
        if (await db.Posts.Include(p => p.Tags).SingleOrDefaultAsync(p => p.Id == id) is not { } post)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, post.Version) is { } precondition)
        {
            return precondition;
        }

        var before = JsonSerializer.SerializeToNode(ToWriteDto(post), json)!.AsObject();
        var errors = new Dictionary<string, string[]>();
        var dto = await ReadAsync(http, db, json, merge ? before : null, errors);
        if (dto is null)
        {
            return ApiProblems.Invalid(errors);
        }

        if (dto.Slug != post.Slug && await db.Posts.AnyAsync(p => p.Slug == dto.Slug && p.Id != id))
        {
            return SlugTaken();
        }

        var now = time.GetUtcNow();
        await ApplyAsync(dto, post, db, renderer, now);
        var after = JsonSerializer.SerializeToNode(ToWriteDto(post), json)!.AsObject();
        var changed = after.Where(p => !JsonNode.DeepEquals(p.Value, before[p.Key])).Select(p => p.Key).ToList();

        // A write that changes nothing saves nothing, so the version and the audit log stay as they are.
        if (changed.Count > 0)
        {
            post.UpdatedAt = now;
            audit.Add(AuditActions.PostUpdate, AuditTargetTypes.Post, post.Id, new { slug = post.Slug, fields = changed });
            try
            {
                if (!await Writes.TrySaveAsync(db))
                {
                    return SlugTaken();
                }
            }
            catch (DbUpdateConcurrencyException)
            {
                return await ChangedMeanwhileAsync(db, id);
            }
        }

        SetHeaders(http.Response, post);
        return TypedResults.Ok(await ToAdminDtoAsync(db, configuration, post));
    }

    /// <summary>Archives the post: it leaves the public site but stays, slug and all.</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> ArchiveAsync(
        long id, HttpRequest request, AppDbContext db, AuditLog audit, TimeProvider time)
    {
        if (await db.Posts.SingleOrDefaultAsync(p => p.Id == id) is not { } post)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(request, post.Version) is { } precondition)
        {
            return precondition;
        }

        if (post.Status == NewsStatus.Archived)
        {
            return TypedResults.NoContent();
        }

        audit.Add(AuditActions.PostArchive, AuditTargetTypes.Post, post.Id, new { from = post.Status });
        post.Status = NewsStatus.Archived;
        post.UpdatedAt = time.GetUtcNow();
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            return await ChangedMeanwhileAsync(db, id);
        }

        return TypedResults.NoContent();
    }

    /// <summary>
    /// Reads the body, merged into <paramref name="current"/> when there is one, and validates the
    /// result, the cover included. Null when anything is wrong, with the reasons in <paramref name="errors"/>.
    /// </summary>
    private static async Task<PostWriteDto?> ReadAsync(
        HttpContext http, AppDbContext db, JsonSerializerOptions json, JsonObject? current, Dictionary<string, string[]> errors)
    {
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body)
        {
            return null;
        }

        var node = current is null ? body : MergePatch.Apply(current, body)!;
        if (RequestBodies.Deserialize<PostWriteDto>(node, json, errors) is not { } dto)
        {
            return null;
        }

        foreach (var (key, messages) in await RequestBodies.ValidateAsync(dto, http))
        {
            errors[key] = messages;
        }

        if (dto.CoverMediaId is { } coverId && !await db.Media.AnyAsync(m => m.Id == coverId))
        {
            errors["coverMediaId"] = ["There is no uploaded media with this id."];
        }

        return errors.Count > 0 ? null : dto;
    }

    /// <summary>
    /// Copies a valid write onto the post. The tags are replaced only when their slugs differ, and
    /// a name no tag has yet makes a new one; the HTML is rendered again only when the Markdown changed.
    /// </summary>
    private static async Task ApplyAsync(PostWriteDto dto, Post post, AppDbContext db, MarkdownRenderer renderer, DateTimeOffset now)
    {
        post.Slug = dto.Slug!;
        post.Title = dto.Title!;
        post.Excerpt = dto.Excerpt!;
        var body = dto.BodyMarkdown ?? "";
        if (body != post.BodyMarkdown)
        {
            post.BodyMarkdown = body;
            post.BodyHtml = renderer.Render(body);
        }

        post.ReadingTimeMinutes = ReadingTime.Minutes(post.BodyMarkdown);
        post.CoverMediaId = dto.CoverMediaId;

        // Publishing with no date means now, but a post already public keeps the date it went out.
        var wasPublished = post.Status == NewsStatus.Published && post.PublishedAt is not null;
        post.Status = dto.Status!.Value;
        post.PublishedAt = dto.PublishedAt
            ?? (post.Status != NewsStatus.Published ? null : wasPublished ? post.PublishedAt : now);

        var names = (dto.Tags ?? []).Select(t => t.Trim()).DistinctBy(Tag.SlugFor).ToList();
        var slugs = names.Select(Tag.SlugFor).ToList();
        if (!slugs.Order(StringComparer.Ordinal).SequenceEqual(post.Tags.Select(t => t.Slug).Order(StringComparer.Ordinal)))
        {
            var known = await db.Tags.Where(t => slugs.Contains(t.Slug)).ToDictionaryAsync(t => t.Slug);
            post.Tags = [.. names.Select(name => known.GetValueOrDefault(Tag.SlugFor(name)) ?? new Tag { Slug = Tag.SlugFor(name), Name = name })];
        }
    }

    private static PostWriteDto ToWriteDto(Post post) => new()
    {
        Slug = post.Slug,
        Title = post.Title,
        Excerpt = post.Excerpt,
        BodyMarkdown = post.BodyMarkdown,
        CoverMediaId = post.CoverMediaId,
        Tags = [.. post.Tags.OrderBy(t => t.Slug, StringComparer.Ordinal).Select(t => t.Name)],
        Status = post.Status,
        PublishedAt = post.PublishedAt,
    };

    private static async Task<PostAdminDto> ToAdminDtoAsync(AppDbContext db, IConfiguration configuration, Post post)
    {
        var siteUrl = SiteUrl.From(configuration);
        var cover = post.CoverMediaId is { } coverId ? await db.Media.AsNoTracking().SingleOrDefaultAsync(m => m.Id == coverId) : null;
        var createdBy = await Writes.CreatorAsync(db, post.CreatedByKind, post.CreatedById);
        var dto = PostMapper.ToAdminDto(post, PostEndpoints.PostUrl(siteUrl, post), PostEndpoints.CoverImage(siteUrl, cover), createdBy);
        return dto with { Tags = [.. dto.Tags.OrderBy(t => t.Slug, StringComparer.Ordinal)] };
    }

    private static async Task<ProblemHttpResult> ChangedMeanwhileAsync(AppDbContext db, long id)
    {
        var version = await db.Posts.AsNoTracking().Where(p => p.Id == id).Select(p => p.Version).SingleAsync();
        return Versions.Stale(version);
    }

    private static void SetHeaders(HttpResponse response, Post post)
    {
        Versions.SetETag(response, post.Version);
        response.Headers.CacheControl = HttpCaching.Private;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no post with this id.");

    private static ProblemHttpResult SlugTaken() =>
        ApiProblems.Of(ProblemTypes.Conflict, "Another post, maybe an archived one, already has this slug.");
}
