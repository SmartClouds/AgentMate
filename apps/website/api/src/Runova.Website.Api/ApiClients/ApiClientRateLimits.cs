using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;

namespace Runova.Website.Api.ApiClients;

/// <summary>
/// The token bucket each API client gets, bound from <c>RateLimits:ApiClients</c>. The defaults
/// are the contract's: a burst of 20, then 60 requests a minute.
/// </summary>
internal sealed class ApiClientRateLimitOptions
{
    public const string Section = "RateLimits:ApiClients";

    public int TokenLimit { get; set; } = 20;

    public int TokensPerPeriod { get; set; } = 1;

    public TimeSpan ReplenishmentPeriod { get; set; } = TimeSpan.FromSeconds(1);
}

internal static class ApiClientRateLimits
{
    /// <summary>
    /// A global limiter with a bucket per signed-in API client; anyone else passes through it.
    /// Over the limit answers 429 <c>rate-limited</c> with <c>Retry-After</c> in seconds.
    /// </summary>
    public static IServiceCollection AddApiClientRateLimits(this IServiceCollection services)
    {
        services.AddOptions<ApiClientRateLimitOptions>().BindConfiguration(ApiClientRateLimitOptions.Section);
        services.AddRateLimiter(_ => { });
        services.AddOptions<RateLimiterOptions>().Configure<IOptions<ApiClientRateLimitOptions>>((options, limits) =>
        {
            var bucket = new TokenBucketRateLimiterOptions
            {
                TokenLimit = limits.Value.TokenLimit,
                TokensPerPeriod = limits.Value.TokensPerPeriod,
                ReplenishmentPeriod = limits.Value.ReplenishmentPeriod,
                QueueLimit = 0,
                AutoReplenishment = true,
            };
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, long>(http =>
                ApiClientPrincipal.ClientId(http.User) is { } clientId
                    ? RateLimitPartition.GetTokenBucketLimiter(clientId, _ => bucket)
                    : RateLimitPartition.GetNoLimiter(0L));
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = async (context, _) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                {
                    context.HttpContext.Response.Headers.RetryAfter =
                        Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                }

                await ApiProblems.WriteAsync(context.HttpContext, ProblemTypes.RateLimited, "Too many requests from this client. Retry after the time in Retry-After.");
            };
        });
        return services;
    }
}
