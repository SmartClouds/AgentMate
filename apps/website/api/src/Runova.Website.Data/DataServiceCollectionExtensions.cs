using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Runova.Website.Data;

public static class DataServiceCollectionExtensions
{
    public const string ConnectionStringName = "Default";

    /// <summary>
    /// Registers <see cref="AppDbContext"/> on Npgsql with <c>ConnectionStrings__Default</c>. The
    /// connection string is read when a context is first made, not at startup, so a host that
    /// sets it late (tests, for one) is still seen.
    /// </summary>
    public static IServiceCollection AddWebsiteData(this IServiceCollection services) =>
        services.AddDbContext<AppDbContext>((provider, options) =>
        {
            var connectionString = provider.GetRequiredService<IConfiguration>().GetConnectionString(ConnectionStringName)
                ?? throw new InvalidOperationException($"Set ConnectionStrings__{ConnectionStringName} to the PostgreSQL connection string.");
            options.UseNpgsql(connectionString);
        });
}
