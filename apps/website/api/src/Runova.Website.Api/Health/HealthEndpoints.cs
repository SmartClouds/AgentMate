using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Runova.Website.Data;

namespace Runova.Website.Api.Health;

/// <summary><c>/health/live</c> runs no checks; <c>/health/ready</c> asks PostgreSQL.</summary>
internal static class HealthEndpoints
{
    private const string ReadyTag = "ready";

    public static IServiceCollection AddWebsiteHealthChecks(this IServiceCollection services)
    {
        // A real query rather than the default open-and-close: a pooled connection to a stopped
        // server opens without touching the network.
        services.AddHealthChecks().AddDbContextCheck<AppDbContext>(
            "postgresql",
            tags: [ReadyTag],
            customTestQuery: async (db, cancel) =>
            {
                await db.Database.ExecuteSqlRawAsync("SELECT 1", cancel);
                return true;
            });
        return services;
    }

    public static IEndpointRouteBuilder MapHealth(this IEndpointRouteBuilder app)
    {
        app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
        app.MapHealthChecks("/health/ready", new HealthCheckOptions
        {
            Predicate = check => check.Tags.Contains(ReadyTag),
            ResponseWriter = WriteReadyAsync,
        });
        return app;
    }

    private static Task WriteReadyAsync(HttpContext http, HealthReport report)
    {
        if (report.Status != HealthStatus.Unhealthy)
        {
            http.Response.ContentType = "text/plain";
            return http.Response.WriteAsync(report.Status.ToString(), http.RequestAborted);
        }

        // The health check middleware has set 503 already. What failed goes to the log, not here.
        return http.RequestServices.GetRequiredService<IProblemDetailsService>().WriteAsync(new ProblemDetailsContext
        {
            HttpContext = http,
            ProblemDetails = { Detail = "The database does not answer." },
        }).AsTask();
    }
}
