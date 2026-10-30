using DotNet.Testcontainers.Builders;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(Runova.Website.IntegrationTests.Infrastructure.PostgresFixture))]

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>One PostgreSQL container for the whole test assembly.</summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    /// <summary>The official image at the major version compose runs.</summary>
    public const string Image = "postgres:18";

    private readonly PostgreSqlContainer _container = Create();

    public string ConnectionString => _container.GetConnectionString();

    public static PostgreSqlContainer Create() => new PostgreSqlBuilder(Image).Build();

    public async ValueTask InitializeAsync() => await StartAsync(_container);

    public ValueTask DisposeAsync() => _container.DisposeAsync();

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
}
