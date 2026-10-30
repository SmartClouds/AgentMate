using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Cli;

/// <summary>
/// The <c>admin</c> verbs, run as <c>dotnet Runova.Website.Api.dll admin &lt;verb&gt;</c> instead of
/// starting the web host.
/// </summary>
internal static class AdminCli
{
    public const string Usage = """
        Usage: dotnet Runova.Website.Api.dll admin <verb>
          create-owner --email <email> --name <display name>
              Creates the first Admin. Reads the password from the first line of stdin.
          migrate
              Applies the database migrations.
        """;

    public static bool IsCommand(string[] args) => args is ["admin", ..];

    /// <summary>Runs a verb and returns the exit code: 0 done, 1 refused, 2 bad usage.</summary>
    public static async Task<int> RunAsync(string[] args, IServiceProvider services, TextReader input, TextWriter output, TextWriter error)
    {
        switch (args)
        {
            case ["admin", "create-owner", .. var options]
                when Option(options, "--email") is { } email && Option(options, "--name") is { } name:
                return await CreateOwnerAsync(services, email, name, input, output, error);
            case ["admin", "migrate"]:
                using (var scope = services.CreateScope())
                {
                    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
                }

                await output.WriteLineAsync("The database is up to date.");
                return 0;
            default:
                await error.WriteLineAsync(Usage);
                return 2;
        }
    }

    private static async Task<int> CreateOwnerAsync(
        IServiceProvider services, string email, string name, TextReader input, TextWriter output, TextWriter error)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        if ((await users.GetUsersInRoleAsync(Roles.Admin)).Count > 0)
        {
            await error.WriteLineAsync("An Admin exists already. create-owner only makes the first one; Admins add users from the site.");
            return 1;
        }

        var password = await input.ReadLineAsync();
        if (string.IsNullOrEmpty(password))
        {
            await error.WriteLineAsync("No password on stdin. Pipe it in, as in: echo \"$PASSWORD\" | dotnet Runova.Website.Api.dll admin create-owner ...");
            return 1;
        }

        var user = new AppUser
        {
            UserName = email,
            Email = email,
            EmailConfirmed = true,
            DisplayName = name,
            CreatedAt = scope.ServiceProvider.GetRequiredService<TimeProvider>().GetUtcNow(),
        };

        // The user and their role together, or neither.
        await using var transaction = await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.BeginTransactionAsync();
        var result = await users.CreateAsync(user, password);
        if (result.Succeeded)
        {
            result = await users.AddToRoleAsync(user, Roles.Admin);
        }

        if (!result.Succeeded)
        {
            foreach (var failure in result.Errors)
            {
                await error.WriteLineAsync(failure.Description);
            }

            return 1;
        }

        await transaction.CommitAsync();
        await output.WriteLineAsync($"Created the Admin {email} (id {user.Id}).");
        return 0;
    }

    private static string? Option(string[] options, string name)
    {
        var index = Array.IndexOf(options, name);
        return index >= 0 && index + 1 < options.Length && !string.IsNullOrWhiteSpace(options[index + 1]) ? options[index + 1] : null;
    }
}
