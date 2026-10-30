using System.Net;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Cli;
using Runova.Website.Core.Identity;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

// Each test gets a database of its own: create-owner looks at every Admin there is.
public sealed class AdminCliTests(PostgresFixture postgres)
{
    private const string OwnerPassword = "a long owner password";

    [Fact]
    public async Task Create_owner_makes_an_admin_with_the_password_from_stdin()
    {
        using var factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

        var (exitCode, output, _) = await RunAsync(factory, OwnerPassword + "\n", "create-owner", "--email", "owner@runovahq.com", "--name", "Olive Owner");

        Assert.Equal(0, exitCode);
        Assert.Contains("owner@runovahq.com", output, StringComparison.Ordinal);
        using (var scope = factory.Services.CreateScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
            var owner = await users.FindByEmailAsync("owner@runovahq.com");
            Assert.NotNull(owner);
            Assert.Equal("Olive Owner", owner.DisplayName);
            Assert.True(owner.EmailConfirmed);
            Assert.Equal([Roles.Admin], await users.GetRolesAsync(owner));
        }

        var signIn = await factory.CreateApiClient().SignInAsync("owner@runovahq.com", OwnerPassword);
        Assert.Equal(HttpStatusCode.NoContent, signIn.StatusCode);
    }

    [Fact]
    public async Task Create_owner_refuses_when_an_admin_exists()
    {
        using var factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());
        await TestUsers.CreateAsync(factory.Services, Roles.Admin);

        var (exitCode, _, error) = await RunAsync(factory, OwnerPassword + "\n", "create-owner", "--email", "owner@runovahq.com", "--name", "Olive Owner");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("Admin", error, StringComparison.Ordinal);
        using var scope = factory.Services.CreateScope();
        Assert.Null(await scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>().FindByEmailAsync("owner@runovahq.com"));
    }

    [Fact]
    public async Task Create_owner_refuses_a_password_under_12_characters()
    {
        using var factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

        var (exitCode, _, error) = await RunAsync(factory, "short pass1\n", "create-owner", "--email", "owner@runovahq.com", "--name", "Olive Owner");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("12", error, StringComparison.Ordinal);
        using var scope = factory.Services.CreateScope();
        Assert.Null(await scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>().FindByEmailAsync("owner@runovahq.com"));
    }

    [Theory]
    [InlineData("create-owner", "--name", "Olive Owner")]
    [InlineData("create-owner", "--email", "owner@runovahq.com")]
    [InlineData("no-such-verb")]
    public async Task A_missing_option_or_unknown_verb_prints_usage(params string[] args)
    {
        using var factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

        var (exitCode, _, error) = await RunAsync(factory, OwnerPassword + "\n", args);

        Assert.Equal(2, exitCode);
        Assert.Contains("Usage", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_empty_stdin_is_refused()
    {
        using var factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

        var (exitCode, _, _) = await RunAsync(factory, "", "create-owner", "--email", "owner@runovahq.com", "--name", "Olive Owner");

        Assert.NotEqual(0, exitCode);
    }

    [Fact]
    public void Only_arguments_that_start_with_admin_are_a_cli_command()
    {
        Assert.True(AdminCli.IsCommand(["admin", "create-owner"]));
        Assert.False(AdminCli.IsCommand([]));
        Assert.False(AdminCli.IsCommand(["--urls", "http://+:8080"]));
    }

    private static async Task<(int ExitCode, string Output, string Error)> RunAsync(WebsiteApiFactory factory, string stdin, params string[] args)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var exitCode = await AdminCli.RunAsync(["admin", .. args], factory.Services, new StringReader(stdin), output, error);
        return (exitCode, output.ToString(), error.ToString());
    }
}
