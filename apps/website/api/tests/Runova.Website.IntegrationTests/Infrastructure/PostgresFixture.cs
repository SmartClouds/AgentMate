using DotNet.Testcontainers.Builders;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Runova.Website.Data;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(Runova.Website.IntegrationTests.Infrastructure.PostgresFixture))]

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// One PostgreSQL container for the whole test assembly. Its default database is migrated once
/// and shared; a test that needs a database to itself asks <see cref="CreateDatabaseAsync"/>.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    /// <summary>The official image at the major version compose runs.</summary>
    public const string Image = "postgres:18";

    private readonly PostgreSqlContainer _container = Create();

    public string ConnectionString => _container.GetConnectionString();

    public static PostgreSqlContainer Create() => new PostgreSqlBuilder(Image).Build();

    public async ValueTask InitializeAsync()
    {
        await StartAsync(_container);
        await MigrateAsync(ConnectionString);
    }

    public ValueTask DisposeAsync() => _container.DisposeAsync();

    /// <summary>A new database in the shared container, migrated unless asked not to.</summary>
    public async Task<string> CreateDatabaseAsync(bool migrate = true)
    {
        var cancel = TestContext.Current.CancellationToken;
        var name = "test_" + Guid.NewGuid().ToString("N");
        await using (var connection = new NpgsqlConnection(ConnectionString))
        {
            await connection.OpenAsync(cancel);
            await using var command = new NpgsqlCommand($"CREATE DATABASE \"{name}\"", connection);
            await command.ExecuteNonQueryAsync(cancel);
        }

        var connectionString = new NpgsqlConnectionStringBuilder(ConnectionString) { Database = name }.ConnectionString;
        if (migrate)
        {
            await MigrateAsync(connectionString);
        }

        return connectionString;
    }

    /// <summary>Starts a container, or fails with a message that says Docker is needed.</summary>
    public static async Task StartAsync(PostgreSqlContainer container)
    {
        try
        {
            await container.StartAsync(TestContext.Current.CancellationToken);
        }
        catch (DockerUnavailableException e)
        {
            throw new InvalidOperationException(
                "The website API integration tests need Docker to run PostgreSQL. Start Docker and run them again.", e);
        }
    }

    private static async Task MigrateAsync(string connectionString)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(connectionString).Options;
        await using var db = new AppDbContext(options);
        await db.Database.MigrateAsync(TestContext.Current.CancellationToken);
    }
}
