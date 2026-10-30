using Microsoft.AspNetCore.Identity;
using Runova.Website.Core.Identity;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Identity;

/// <summary>
/// Identity's authenticator provider, except that each code works once: the time step of the last
/// accepted code is stored on the user, and a code from that step or an earlier one is refused.
/// Time comes from the injected <see cref="TimeProvider"/>.
/// </summary>
internal sealed class OneTimeAuthenticatorTokenProvider(TimeProvider time) : IUserTwoFactorTokenProvider<AppUser>
{
    public async Task<bool> CanGenerateTwoFactorTokenAsync(UserManager<AppUser> manager, AppUser user) =>
        !string.IsNullOrEmpty(await manager.GetAuthenticatorKeyAsync(user));

    // The code comes from the user's authenticator app; the server never makes one.
    public Task<string> GenerateAsync(string purpose, UserManager<AppUser> manager, AppUser user) => Task.FromResult("");

    public async Task<bool> ValidateAsync(string purpose, string token, UserManager<AppUser> manager, AppUser user)
    {
        var key = await manager.GetAuthenticatorKeyAsync(user);
        if (string.IsNullOrEmpty(key))
        {
            return false;
        }

        var step = Totp.FindStep(Base32.Decode(key), token, time.GetUtcNow());
        if (step is null || step <= user.LastTotpTimeStep)
        {
            return false;
        }

        // The concurrency check makes two requests racing with the same code fail one of them.
        user.LastTotpTimeStep = step;
        return (await manager.UpdateAsync(user)).Succeeded;
    }
}
