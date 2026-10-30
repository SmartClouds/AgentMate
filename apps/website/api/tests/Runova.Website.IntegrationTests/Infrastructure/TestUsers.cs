using System.Globalization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Identity;
using Runova.Website.Data.Identity;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Staff users made straight through Identity, each with an email of its own.</summary>
internal static class TestUsers
{
    public const string Password = "correct horse battery";

    public static async Task<AppUser> CreateAsync(
        IServiceProvider services, string role = Roles.Editor, string password = Password, string? displayName = null)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var email = $"{Guid.NewGuid():N}@test.runovahq.com";
        var user = new AppUser
        {
            UserName = email,
            Email = email,
            EmailConfirmed = true,
            DisplayName = displayName ?? "Test " + role,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        Succeeded(await users.CreateAsync(user, password));
        Succeeded(await users.AddToRoleAsync(user, role));
        return user;
    }

    /// <summary>A client signed in as the user with <see cref="Password"/>.</summary>
    public static async Task<ApiClient> SignedInClientAsync(WebsiteApiFactory factory, AppUser user)
    {
        var client = factory.CreateApiClient();
        var response = await client.SignInAsync(user.Email!, Password);
        Assert.Equal(System.Net.HttpStatusCode.NoContent, response.StatusCode);
        return client;
    }

    /// <summary>Turns two-factor on and returns the authenticator key.</summary>
    public static async Task<byte[]> EnableTwoFactorAsync(IServiceProvider services, AppUser user)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var stored = (await users.FindByIdAsync(user.Id.ToString(CultureInfo.InvariantCulture)))!;
        Succeeded(await users.ResetAuthenticatorKeyAsync(stored));
        Succeeded(await users.SetTwoFactorEnabledAsync(stored, true));
        return Base32.Decode((await users.GetAuthenticatorKeyAsync(stored))!);
    }

    public static async Task<IReadOnlyList<string>> GenerateRecoveryCodesAsync(IServiceProvider services, AppUser user)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var stored = (await users.FindByIdAsync(user.Id.ToString(CultureInfo.InvariantCulture)))!;
        return [.. (await users.GenerateNewTwoFactorRecoveryCodesAsync(stored, 10))!];
    }

    private static void Succeeded(IdentityResult result) =>
        Assert.True(result.Succeeded, string.Join("; ", result.Errors.Select(e => e.Description)));
}
