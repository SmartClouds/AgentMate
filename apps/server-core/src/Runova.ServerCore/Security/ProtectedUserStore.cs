using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

/// <summary>
/// Identity's store, except that the authenticator (TOTP) key and the recovery codes are
/// encrypted with the core's Data Protection keys before they reach the database. Identity keeps
/// both in plain text by default; the database is root-only, so this is defense in depth.
/// </summary>
internal sealed class ProtectedUserStore(
    CoreDbContext context,
    IDataProtectionProvider protection,
    IdentityErrorDescriber? describer = null)
    : UserStore<CoreUser, CoreRole, CoreDbContext, Guid>(context, describer)
{
    // The names Identity's own store uses for these tokens.
    private const string InternalLoginProvider = "[AspNetUserStore]";
    private const string AuthenticatorKeyName = "AuthenticatorKey";
    private const string RecoveryCodesName = "RecoveryCodes";

    private readonly IDataProtector _protector = protection.CreateProtector(FrozenIdentifiers.SecondFactorPurpose);

    public override Task SetAuthenticatorKeyAsync(CoreUser user, string key, CancellationToken cancellationToken) =>
        SetTokenAsync(user, InternalLoginProvider, AuthenticatorKeyName, _protector.Protect(key), cancellationToken);

    public override async Task<string?> GetAuthenticatorKeyAsync(CoreUser user, CancellationToken cancellationToken)
    {
        var stored = await GetTokenAsync(user, InternalLoginProvider, AuthenticatorKeyName, cancellationToken);
        return stored is null ? null : _protector.Unprotect(stored);
    }

    public override Task ReplaceCodesAsync(
        CoreUser user,
        IEnumerable<string> recoveryCodes,
        CancellationToken cancellationToken) =>
        SetTokenAsync(
            user,
            InternalLoginProvider,
            RecoveryCodesName,
            _protector.Protect(string.Join(';', recoveryCodes)),
            cancellationToken);

    public override async Task<bool> RedeemCodeAsync(CoreUser user, string code, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(code);
        var codes = await ReadCodesAsync(user, cancellationToken);
        var offered = Encoding.UTF8.GetBytes(code);
        var match = codes.FirstOrDefault(candidate =>
            CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(candidate), offered));
        if (match is null)
        {
            return false;
        }

        await ReplaceCodesAsync(user, codes.Where(candidate => candidate != match), cancellationToken);
        return true;
    }

    public override async Task<int> CountCodesAsync(CoreUser user, CancellationToken cancellationToken) =>
        (await ReadCodesAsync(user, cancellationToken)).Count;

    private async Task<List<string>> ReadCodesAsync(CoreUser user, CancellationToken cancellationToken)
    {
        var stored = await GetTokenAsync(user, InternalLoginProvider, RecoveryCodesName, cancellationToken);
        return string.IsNullOrEmpty(stored)
            ? []
            : [.. _protector.Unprotect(stored).Split(';', StringSplitOptions.RemoveEmptyEntries)];
    }
}
