using Hangfire;
using Hangfire.PostgreSql;
using Npgsql;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Identity;
using Runova.Website.Api.News;
using Runova.Website.Api.Users;
using Runova.Website.Data;

namespace Runova.Website.Api.Jobs;

internal static partial class JobsSetup
{
    public const string Schema = "hangfire";
    public const string DashboardPath = "/hangfire";

    /// <summary>
    /// Hangfire on PostgreSQL in its own schema, prepared on start, with a server and the
    /// recurring jobs. A database that is down at start leaves Hangfire waiting for it rather than
    /// stopping the API.
    /// </summary>
    public static IServiceCollection AddWebsiteJobs(this IServiceCollection services)
    {
        services.AddHangfire((provider, hangfire) => hangfire
            .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
            .UseSimpleAssemblyNameTypeSerializer()
            .UseRecommendedSerializerSettings()
            .UsePostgreSqlStorage(
                storage => storage.UseNpgsqlConnection(
                    provider.GetRequiredService<IConfiguration>().GetConnectionString(DataServiceCollectionExtensions.ConnectionStringName)),
                new PostgreSqlStorageOptions
                {
                    SchemaName = Schema,
                    PrepareSchemaIfNecessary = true,
                    StartupConnectionMaxRetries = 1,
                    StartupConnectionBaseDelay = TimeSpan.FromSeconds(1),
                    AllowDegradedModeWithoutStorage = true,
                }));
        services.AddHangfireServer();
        services.AddScoped<InvitationsCleanupJob>();
        services.AddScoped<NewsPublishJob>();
        services.AddScoped<SignatureNoncesPurgeJob>();
        services.AddScoped<IdempotencyPurgeJob>();
        services.AddHostedService<RegisterRecurringJobs>();
        return services;
    }

    /// <summary>
    /// The dashboard, for Admins only. ASP.NET Core authorization answers 401 and 403, so Hangfire
    /// gets no authorization filters of its own (its default would allow local requests only).
    /// </summary>
    public static IEndpointRouteBuilder MapJobsDashboard(this IEndpointRouteBuilder app)
    {
        app.MapHangfireDashboard(DashboardPath, new DashboardOptions
        {
            Authorization = [],
            DashboardTitle = "Runova jobs",
            DisplayStorageConnectionString = false,
            AppPath = null,
        }).RequireAuthorization(Policies.Admin);
        return app;
    }

    /// <summary>
    /// Writes <see cref="RecurringJobRegistry"/> to storage on start. When the database cannot be
    /// reached the jobs keep the schedules stored on the last start.
    /// </summary>
    private sealed partial class RegisterRecurringJobs(IRecurringJobManager jobs, ILogger<RegisterRecurringJobs> logger) : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken)
        {
            try
            {
                RecurringJobRegistry.Register(jobs);
            }
            catch (NpgsqlException e)
            {
                LogNotRegistered(logger, e);
            }

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        [LoggerMessage(Level = LogLevel.Warning, Message = "Could not register the recurring jobs: the database did not answer")]
        private static partial void LogNotRegistered(ILogger logger, Exception exception);
    }
}
