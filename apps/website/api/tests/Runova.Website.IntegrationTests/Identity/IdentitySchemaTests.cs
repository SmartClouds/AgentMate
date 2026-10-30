using Npgsql;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

public sealed class IdentitySchemaTests(PostgresFixture postgres)
{
    [Fact]
    public async Task Migrating_on_start_gives_users_and_roles_bigint_identity_keys()
    {
        var connectionString = await postgres.CreateDatabaseAsync(migrate: false);
        using (var factory = new WebsiteApiFactory(connectionString, migrateOnStart: true))
        {
            // Starting the host runs the migration.
            factory.CreateClient();
        }

        var columns = await KeyColumnsAsync(connectionString);

        Assert.Equal(("bigint", "YES"), columns[("AspNetUsers", "Id")]);
        Assert.Equal(("bigint", "YES"), columns[("AspNetRoles", "Id")]);
    }

    [Fact]
    public async Task Every_identity_key_and_foreign_key_is_bigint()
    {
        var columns = await KeyColumnsAsync(postgres.ConnectionString);

        Assert.Equal(
            [
                ("AspNetRoleClaims", "Id"), ("AspNetRoleClaims", "RoleId"), ("AspNetRoles", "Id"),
                ("AspNetUserClaims", "Id"), ("AspNetUserClaims", "UserId"), ("AspNetUserLogins", "UserId"),
                ("AspNetUserRoles", "RoleId"), ("AspNetUserRoles", "UserId"), ("AspNetUserTokens", "UserId"),
                ("AspNetUsers", "Id"),
            ],
            columns.Keys.Order());
        Assert.All(columns.Values, column => Assert.Equal("bigint", column.Type));
    }

    [Fact]
    public async Task The_roles_admin_and_editor_are_seeded()
    {
        await using var connection = new NpgsqlConnection(postgres.ConnectionString);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand("""SELECT "Name", "NormalizedName" FROM "AspNetRoles" ORDER BY "Name" """, connection);
        await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
        var roles = new List<(string, string)>();
        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
        {
            roles.Add((reader.GetString(0), reader.GetString(1)));
        }

        Assert.Equal([("Admin", "ADMIN"), ("Editor", "EDITOR")], roles);
    }

    private static async Task<Dictionary<(string Table, string Column), (string Type, string Identity)>> KeyColumnsAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand(
            """
            SELECT table_name, column_name, data_type, is_identity
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name LIKE 'AspNet%' AND column_name IN ('Id', 'UserId', 'RoleId')
            """,
            connection);
        await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
        var columns = new Dictionary<(string, string), (string, string)>();
        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
        {
            columns[(reader.GetString(0), reader.GetString(1))] = (reader.GetString(2), reader.GetString(3));
        }

        return columns;
    }
}
