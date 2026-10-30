using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Content;
using Runova.Website.Core.Json;
using Runova.Website.Core.News;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.News;

/// <summary>
/// Writing news, for Editors, Admins and API clients with <c>news:write</c>: create, replace,
/// merge patch and archive by id. Every change to an item needs <c>If-Match</c>, every write leaves
/// an audit entry with it, and a create honours <c>Idempotency-Key</c>.
/// </summary>
internal static class NewsWriteEndpoints
{
    private const string MergePatchJson = "application/merge-patch+json";

    public static RouteGroupBuilder MapNewsWrites(this RouteGroupBuilder api)
    {
        var news = api.MapGroup("/news").RequireAuthorization(Policies.NewsWrite);
        news.MapGet("/{id:long}", GetAsync).Produces(StatusCodes.Status304NotModified);
        news.MapPost("", CreateAsync).Accepts<NewsItemWriteDto>("application/json").WithMetadata(Idempotent.Instance);
        news.MapPut("/{id:long}", ReplaceAsync).Accepts<NewsItemWriteDto>("application/json");
        news.MapPatch("/{id:long}", PatchAsync).Accepts<NewsItemWriteDto>(MergePatchJson, "application/json");
        news.MapDelete("/{id:long}", ArchiveAsync);
        return api;
    }

    private static async Task<Results<Ok<NewsItemAdminDto>, StatusCodeHttpResult, ProblemHttpResult>> GetAsync(
        long id, AppDbContext db, IConfiguration configuration, HttpContext http)
    {
        if (await db.NewsItems.AsNoTracking().SingleOrDefaultAsync(i => i.Id == id) is not { } item)
        {
            return NotFound();
        }

        if (HttpCaching.IsNotModified(http, Versions.ETag(item.Version), HttpCaching.Private))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(await ToAdminDtoAsync(db, configuration, item));
    }

    private static async Task<Results<Created<NewsItemAdminDto>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json)
    {
        var errors = new Dictionary<string, string[]>();
        var dto = await ReadAsync(http, json.Value.SerializerOptions, current: null, errors);
        if (dto is null)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await db.NewsItems.AnyAsync(i => i.Slug == dto.Slug))
        {
            return SlugTaken();
        }

        var now = time.GetUtcNow();
        var (creatorKind, creatorId) = AuditLog.Actor(http.User);
        var item = new NewsItem
        {
            CreatedAt = now,
            UpdatedAt = now,
            CreatedByKind = creatorKind,
            CreatedById = creatorId,
        };
        Apply(dto, item, renderer, now);

        await using var transaction = await db.Database.BeginTransactionAsync();
        db.NewsItems.Add(item);
        if (!await TrySaveAsync(db))
        {
            return SlugTaken();
        }

        audit.Add(AuditActions.NewsCreate, AuditTargetTypes.News, item.Id, new { slug = item.Slug, status = item.Status });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        SetHeaders(http.Response, item);
        return TypedResults.Created($"{ApiV1.Prefix}/news/{item.Id}", await ToAdminDtoAsync(db, configuration, item));
    }

    private static Task<Results<Ok<NewsItemAdminDto>, ValidationProblem, ProblemHttpResult>> ReplaceAsync(
        long id,
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json) =>
        UpdateAsync(id, merge: false, http, db, audit, renderer, time, configuration, json.Value.SerializerOptions);

    /// <summary>A JSON merge patch, validated as the whole item it makes.</summary>
    private static Task<Results<Ok<NewsItemAdminDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id,
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        MarkdownRenderer renderer,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json) =>
        UpdateAsync(id, merge: true, http, db, audit, renderer, time, configuration, json.Value.SerializerOptions);

    private static async Task<Results<Ok<NewsItemAdminDto>, ValidationProblem, ProblemHttpResult>> UpdateAsync(
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
        if (await db.NewsItems.SingleOrDefaultAsync(i => i.Id == id) is not { } item)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, item.Version) is { } precondition)
        {
            return precondition;
        }

        var before = JsonSerializer.SerializeToNode(ToWriteDto(item), json)!.AsObject();
        var errors = new Dictionary<string, string[]>();
        var dto = await ReadAsync(http, json, merge ? before : null, errors);
        if (dto is null)
        {
            return ApiProblems.Invalid(errors);
        }

        if (dto.Slug != item.Slug && await db.NewsItems.AnyAsync(i => i.Slug == dto.Slug && i.Id != id))
        {
            return SlugTaken();
        }

        var now = time.GetUtcNow();
        Apply(dto, item, renderer, now);
        var after = JsonSerializer.SerializeToNode(ToWriteDto(item), json)!.AsObject();
        var changed = after.Where(p => !JsonNode.DeepEquals(p.Value, before[p.Key])).Select(p => p.Key).ToList();

        // A write that changes nothing saves nothing, so the version and the audit log stay as they are.
        if (changed.Count > 0)
        {
            item.UpdatedAt = now;
            audit.Add(AuditActions.NewsUpdate, AuditTargetTypes.News, item.Id, new { slug = item.Slug, fields = changed });
            try
            {
                if (!await TrySaveAsync(db))
                {
                    return SlugTaken();
                }
            }
            catch (DbUpdateConcurrencyException)
            {
                return await ChangedMeanwhileAsync(db, id);
            }
        }

        SetHeaders(http.Response, item);
        return TypedResults.Ok(await ToAdminDtoAsync(db, configuration, item));
    }

    /// <summary>Archives the item: it leaves the public site but stays, slug and all.</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> ArchiveAsync(
        long id, HttpRequest request, AppDbContext db, AuditLog audit, TimeProvider time)
    {
        if (await db.NewsItems.SingleOrDefaultAsync(i => i.Id == id) is not { } item)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(request, item.Version) is { } precondition)
        {
            return precondition;
        }

        if (item.Status == NewsStatus.Archived)
        {
            return TypedResults.NoContent();
        }

        audit.Add(AuditActions.NewsArchive, AuditTargetTypes.News, item.Id, new { from = item.Status });
        item.Status = NewsStatus.Archived;
        item.UpdatedAt = time.GetUtcNow();
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
    /// result. Null when anything is wrong, with the reasons in <paramref name="errors"/>.
    /// </summary>
    private static async Task<NewsItemWriteDto?> ReadAsync(
        HttpContext http, JsonSerializerOptions json, JsonObject? current, Dictionary<string, string[]> errors)
    {
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body)
        {
            return null;
        }

        var node = current is null ? body : MergePatch.Apply(current, body)!;
        if (RequestBodies.Deserialize<NewsItemWriteDto>(node, json, errors) is not { } dto)
        {
            return null;
        }

        foreach (var (key, messages) in await RequestBodies.ValidateAsync(dto, http))
        {
            errors[key] = messages;
        }

        return errors.Count > 0 ? null : dto;
    }

    /// <summary>
    /// Copies a valid write onto the item. A list is replaced only when it differs, so saving an
    /// unchanged item touches no rows; the HTML is rendered again only when the Markdown changed.
    /// </summary>
    private static void Apply(NewsItemWriteDto dto, NewsItem item, MarkdownRenderer renderer, DateTimeOffset now)
    {
        item.Slug = dto.Slug!;
        item.Title = dto.Title!;
        item.Summary = dto.Summary!;
        var body = dto.BodyMarkdown ?? "";
        if (body != item.BodyMarkdown)
        {
            item.BodyMarkdown = body;
            item.BodyHtml = renderer.Render(body);
        }

        item.Category = dto.Category!.Value;
        item.Severity = dto.Severity!.Value;
        item.CvssScore = dto.CvssScore;

        // Publishing with no date means now, but an item already public keeps the date it went out.
        var wasPublished = item.Status == NewsStatus.Published && item.PublishedAt is not null;
        item.Status = dto.Status!.Value;
        item.PublishedAt = dto.PublishedAt
            ?? (item.Status != NewsStatus.Published ? null : wasPublished ? item.PublishedAt : now);

        var technologies = (dto.Technologies ?? []).Select(t => (t.Technology!, t.VersionRange!, t.FixedIn)).ToList();
        if (!technologies.SequenceEqual(item.Technologies.Select(t => (t.Technology, t.VersionRange, t.FixedIn))))
        {
            item.Technologies = [.. technologies.Select(t => new AffectedTechnology { Technology = t.Item1, VersionRange = t.Item2, FixedIn = t.FixedIn })];
        }

        var links = (dto.SourceLinks ?? []).Select(l => (l.Title!, l.Url!)).ToList();
        if (!links.SequenceEqual(item.SourceLinks.Select(l => (l.Title, l.Url))))
        {
            item.SourceLinks = [.. links.Select(l => new SourceLink { Title = l.Item1, Url = l.Item2 })];
        }

        if (!item.CveIds.SequenceEqual(dto.CveIds ?? []))
        {
            item.CveIds = [.. dto.CveIds ?? []];
        }

        if (!item.Tags.SequenceEqual(dto.Tags ?? []))
        {
            item.Tags = [.. dto.Tags ?? []];
        }
    }

    private static NewsItemWriteDto ToWriteDto(NewsItem item) => new()
    {
        Slug = item.Slug,
        Title = item.Title,
        Summary = item.Summary,
        BodyMarkdown = item.BodyMarkdown,
        Category = item.Category,
        Severity = item.Severity,
        Technologies = [.. item.Technologies.Select(t => new AffectedTechnologyWriteDto { Technology = t.Technology, VersionRange = t.VersionRange, FixedIn = t.FixedIn })],
        CveIds = [.. item.CveIds],
        CvssScore = item.CvssScore,
        SourceLinks = [.. item.SourceLinks.Select(l => new SourceLinkWriteDto { Title = l.Title, Url = l.Url })],
        Tags = [.. item.Tags],
        Status = item.Status,
        PublishedAt = item.PublishedAt,
    };

    private static async Task<NewsItemAdminDto> ToAdminDtoAsync(AppDbContext db, IConfiguration configuration, NewsItem item)
    {
        var name = item switch
        {
            { CreatedByKind: AuditActorKinds.User, CreatedById: { } userId } =>
                await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DisplayName).SingleOrDefaultAsync(),
            { CreatedByKind: AuditActorKinds.ApiClient, CreatedById: { } clientId } =>
                await db.ApiClients.AsNoTracking().Where(c => c.Id == clientId).Select(c => c.Name).SingleOrDefaultAsync(),
            _ => null,
        };
        var createdBy = name is null ? null : new NewsCreatorDto(item.CreatedByKind, item.CreatedById!.Value, name);

        return NewsMapper.ToAdminDto(item, NewsEndpoints.ItemUrl(SiteUrl.From(configuration), item), createdBy);
    }

    /// <summary>Saves, or answers false when the slug was taken by a write that won the race.</summary>
    private static async Task<bool> TrySaveAsync(AppDbContext db)
    {
        try
        {
            await db.SaveChangesAsync();
            return true;
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return false;
        }
    }

    private static async Task<ProblemHttpResult> ChangedMeanwhileAsync(AppDbContext db, long id)
    {
        var version = await db.NewsItems.AsNoTracking().Where(i => i.Id == id).Select(i => i.Version).SingleAsync();
        return Versions.Stale(version);
    }

    private static void SetHeaders(HttpResponse response, NewsItem item)
    {
        Versions.SetETag(response, item.Version);
        response.Headers.CacheControl = HttpCaching.Private;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no news item with this id.");

    private static ProblemHttpResult SlugTaken() =>
        ApiProblems.Of(ProblemTypes.Conflict, "Another news item, maybe an archived one, already has this slug.");
}
