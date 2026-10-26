using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Registries;

/// <summary>A registry request the core turns down, with the words to show.</summary>
internal sealed class RegistryRefusedException(string message) : Exception(message);

/// <summary>
/// Credentials stored on the server (E08 T4), for pulls nobody is there to sign in for. The secret
/// is sealed with Data Protection before it reaches the database and unsealed only by the jobs that
/// pull; it is write-only through the API. Every save, removal and refusal is audited, without the
/// secret.
/// </summary>
internal sealed class RegistryCredentials(
    IDbContextFactory<CoreDbContext> contexts,
    IDataProtectionProvider protection,
    AuditLog audit,
    TimeProvider time)
{
    public const string Purpose = FrozenIdentifiers.RegistryCredentialPurpose;

    /// <summary>A handful per server is plenty; this keeps a script from filling the table.</summary>
    public const int MaxStored = 50;

    private readonly IDataProtector _protector = protection.CreateProtector(Purpose);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<RegistryCredentialInfo[]> ListAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.RegistryCredentials.AsNoTracking().ToListAsync(cancellationToken);
        return [.. rows.OrderBy(r => r.Registry, StringComparer.Ordinal).Select(ToInfo)];
    }

    public async Task<RegistryCredentialInfo> SaveAsync(SaveRegistryCredentialRequest? request, StackCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        var login = Check(request?.Registry, request?.Username, request?.Secret, RegistryLoginSource.Stored);
        if (login is null)
        {
            await AuditAsync("registry.credential-save", AuditResult.Denied, caller, Clip(request?.Registry), null, cancellationToken);
            throw new RegistryRefusedException("Give a registry host (such as ghcr.io), a user name without a colon and a token on one line.");
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.RegistryCredentials.FirstOrDefaultAsync(r => r.Registry == login.Registry, cancellationToken);
        var replaced = row is not null;
        if (row is null)
        {
            if (await db.RegistryCredentials.CountAsync(cancellationToken) >= MaxStored)
            {
                await AuditAsync("registry.credential-save", AuditResult.Denied, caller, login.Registry, null, cancellationToken);
                throw new RegistryRefusedException($"This server already stores {MaxStored} registry credentials. Remove one first.");
            }

            row = new RegistryCredentialRecord
            {
                Id = Guid.NewGuid(),
                Registry = login.Registry,
                Username = login.Username,
                SealedSecret = Seal(login.Secret),
                CreatedAt = Now,
                UpdatedAt = Now,
                CreatedBy = caller.UserName,
            };
            db.RegistryCredentials.Add(row);
        }
        else
        {
            row.Username = login.Username;
            row.SealedSecret = Seal(login.Secret);
            row.UpdatedAt = Now;
            row.LastUsedAt = null;
        }

        await db.SaveChangesAsync(cancellationToken);
        await AuditAsync(
            "registry.credential-save",
            AuditResult.Success,
            caller,
            login.Registry,
            new Dictionary<string, string?> { ["username"] = login.Username, ["replaced"] = replaced ? "true" : "false" },
            cancellationToken);
        return ToInfo(row);
    }

    public async Task DeleteAsync(Guid id, StackCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.RegistryCredentials.FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
        if (row is null)
        {
            throw new RegistryRefusedException("There is no such credential on this server.");
        }

        db.RegistryCredentials.Remove(row);
        await db.SaveChangesAsync(cancellationToken);
        await AuditAsync("registry.credential-delete", AuditResult.Success, caller, row.Registry, null, cancellationToken);
    }

    /// <summary>
    /// The stored sign-ins for these registries, unsealed, for a job about to pull. A row whose
    /// keys are gone (a restored database without its key ring) is skipped, not fatal.
    /// </summary>
    public async Task<List<RegistryLogin>> UnsealAsync(IReadOnlyCollection<string>? registries, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var query = db.RegistryCredentials.AsQueryable();
        if (registries is not null)
        {
            query = query.Where(r => registries.Contains(r.Registry));
        }

        var rows = await query.ToListAsync(cancellationToken);
        var logins = new List<RegistryLogin>();
        foreach (var row in rows)
        {
            try
            {
                logins.Add(new RegistryLogin(row.Registry, row.Username, Unseal(row.SealedSecret), RegistryLoginSource.Stored));
            }
            catch (System.Security.Cryptography.CryptographicException)
            {
                // Sealed under keys this core no longer has.
            }
        }

        if (logins.Count > 0)
        {
            var used = logins.Select(l => l.Registry).ToList();
            await db.RegistryCredentials
                .Where(r => used.Contains(r.Registry))
                .ExecuteUpdateAsync(u => u.SetProperty(r => r.LastUsedAt, Now), CancellationToken.None);
        }

        return logins;
    }

    /// <summary>A sign-in from a request, checked, or null when any part of it is not acceptable.</summary>
    public static RegistryLogin? Check(string? registry, string? username, string? secret, RegistryLoginSource source) =>
        RegistryNames.TryNormalizeRegistry(registry, out var host) && RegistryNames.IsUsername(username) && RegistryNames.IsSecret(secret)
            ? new RegistryLogin(host, username!, secret!, source)
            : null;

    /// <summary>
    /// The sign-ins a request carries, checked: at most <see cref="RegistryNames.MaxLoginsPerRequest"/>,
    /// one per registry. Throws with the words to show when one is not acceptable.
    /// </summary>
    public static List<RegistryLogin> CheckRequest(RegistryAuth[]? auths)
    {
        if (auths is null || auths.Length == 0)
        {
            return [];
        }

        if (auths.Length > RegistryNames.MaxLoginsPerRequest)
        {
            throw new RegistryRefusedException($"Send at most {RegistryNames.MaxLoginsPerRequest} registry sign-ins with a deploy.");
        }

        var logins = new List<RegistryLogin>();
        foreach (var auth in auths)
        {
            var login = Check(auth?.Registry, auth?.Username, auth?.Secret, RegistryLoginSource.Request)
                ?? throw new RegistryRefusedException("One of the registry sign-ins is not valid: a host such as ghcr.io, a user name without a colon and a token on one line.");
            if (logins.Any(l => l.Registry == login.Registry))
            {
                throw new RegistryRefusedException($"Send one sign-in per registry ({login.Registry} came twice).");
            }

            logins.Add(login);
        }

        return logins;
    }

    /// <summary>The request's sign-ins first, then stored ones for every other registry.</summary>
    public static List<RegistryLogin> Merge(IReadOnlyList<RegistryLogin> requested, IReadOnlyList<RegistryLogin> stored)
    {
        ArgumentNullException.ThrowIfNull(requested);
        ArgumentNullException.ThrowIfNull(stored);
        var merged = new List<RegistryLogin>(requested);
        merged.AddRange(stored.Where(s => !requested.Any(r => r.Registry == s.Registry)));
        return merged;
    }

    private string Seal(string secret) => Convert.ToBase64String(_protector.Protect(Encoding.UTF8.GetBytes(secret)));

    private string Unseal(string sealedSecret) => Encoding.UTF8.GetString(_protector.Unprotect(Convert.FromBase64String(sealedSecret)));

    private static RegistryCredentialInfo ToInfo(RegistryCredentialRecord row) =>
        new(row.Id, row.Registry, row.Username, row.CreatedAt, row.UpdatedAt, row.CreatedBy, row.LastUsedAt);

    private static string? Clip(string? value) => value is null ? null : value.Length > 100 ? value[..100] : value;

    private Task<AuditEvent> AuditAsync(string action, string result, StackCaller caller, string? target, Dictionary<string, string?>? parameters, CancellationToken cancellationToken) =>
        audit.AppendAsync(new AuditEntry(action, result, caller.UserId, caller.DeviceId, caller.PeerUid, target, parameters), cancellationToken);
}
