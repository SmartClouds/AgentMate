using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Http;
using Runova.Website.Core.Caching;
using Runova.Website.Core.News;
using Runova.Website.Data;

namespace Runova.Website.Api.News;

/// <summary>The technologies news items can name, which the desktop app matches against what it detects.</summary>
internal static class TechnologyEndpoints
{
    public static RouteGroupBuilder MapTechnologies(this RouteGroupBuilder api)
    {
        api.MapGet("/technologies", ListAsync).AllowAnonymous().Produces(StatusCodes.Status304NotModified);
        return api;
    }

    private static async Task<Results<Ok<List<TechnologyDto>>, StatusCodeHttpResult>> ListAsync(
        AppDbContext db, IOptions<JsonOptions> json, HttpContext http)
    {
        var technologies = await db.Technologies.AsNoTracking().OrderBy(t => t.Id).ToListAsync();
        var dtos = technologies.Select(TechnologyMapper.ToDto).ToList();

        // The tag hashes the very JSON the body would hold.
        var etag = ETags.ForContent(JsonSerializer.Serialize(dtos, json.Value.SerializerOptions));
        if (HttpCaching.IsNotModified(http, etag, HttpCaching.PublicList))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(dtos);
    }
}
