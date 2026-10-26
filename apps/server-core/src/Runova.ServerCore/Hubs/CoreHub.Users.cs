using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Users, for Owners: who can sign in, and with which role. Every change needs a step-up and runs
/// in one write transaction that checks again that the caller is still an Owner and that the core
/// keeps one, so two Owners demoting each other at the same moment cannot leave it with none. A
/// change that takes rights away closes the user's open connections, so it counts at once.
/// Passwords go to Identity and nowhere else: not into the audit trail, not into an answer.
/// </summary>
internal sealed partial class CoreHub
{
    private const int MaxUserNameLength = 64;
    private const int MaxPasswordLength = 1024;
    private const string RoleRule = "A role is one of owner, admin, operator or viewer.";

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<UserInfo[]> ListUsers()
    {
        var all = await users.Users.AsNoTracking().OrderBy(u => u.UserName).ToListAsync(Context.ConnectionAborted);
        return [.. await DescribeAsync(all)];
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<UserInfo> CreateUser(CreateUserRequest request)
    {
        var userName = request?.UserName?.Trim() ?? string.Empty;
        var role = KnownRole(request?.Role);
        var parameters = new Dictionary<string, string?> { ["role"] = request?.Role };
        var problem = userName.Length is 0 or > MaxUserNameLength
            ? "A user name has 1 to 64 letters, digits, dots, dashes, underscores or @."
            : role is null
                ? RoleRule
                : string.IsNullOrEmpty(request?.Password) || request.Password.Length > MaxPasswordLength
                    ? "Give the new user a first password."
                    : null;
        if (problem is not null)
        {
            await AuditAsync("user.create", AuditResult.Failed, userName, parameters);
            throw new HubException(problem);
        }

        var user = new CoreUser { UserName = userName, CreatedAt = Now };
        var refusal = await InWriteTransactionAsync(async () =>
            !await CallerIsOwnerAsync()
                ? _notOwner
                : Failed(await users.CreateAsync(user, request!.Password)) ?? Failed(await users.AddToRoleAsync(user, role!)));
        if (refusal is not null)
        {
            await AuditAsync("user.create", refusal.Result, userName, parameters);
            throw new HubException(refusal.Message);
        }

        await AuditAsync("user.create", AuditResult.Success, userName, parameters);
        return (await DescribeAsync([user]))[0];
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<UserInfo> SetUserRole(Guid userId, string role)
    {
        var wanted = KnownRole(role);
        var parameters = new Dictionary<string, string?> { ["role"] = role };
        if (wanted is null)
        {
            await AuditAsync("user.set-role", AuditResult.Failed, userId.ToString("D"), parameters);
            throw new HubException(RoleRule);
        }

        var target = await ChangeUserAsync("user.set-role", userId, parameters, async user =>
        {
            var held = await users.GetRolesAsync(user);
            parameters["previousRole"] = CoreRoles.Highest(held);
            if (wanted != CoreRoles.Owner && held.Contains(CoreRoles.Owner) && await OwnerCountAsync() == 1)
            {
                return LastOwner(user);
            }

            var dropped = held.Where(name => name != wanted).ToList();
            var failure = dropped.Count > 0 ? Failed(await users.RemoveFromRolesAsync(user, dropped)) : null;
            return failure ?? (held.Contains(wanted) ? null : Failed(await users.AddToRoleAsync(user, wanted)));
        });
        connections.CloseUser(target.Id, Context.ConnectionId);
        return (await DescribeAsync([target]))[0];
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<UserInfo> SetUserDisabled(Guid userId, bool disabled)
    {
        var action = disabled ? "user.disable" : "user.enable";
        if (disabled && userId == UserId)
        {
            await AuditAsync(action, AuditResult.Denied, User.Identity?.Name);
            throw new HubException("You cannot disable your own account.");
        }

        var target = await ChangeUserAsync(action, userId, null, async user =>
        {
            if (!disabled)
            {
                // Clears a lockout for wrong passwords too: the Owner vouched for the account.
                user.LockoutEnd = null;
                user.AccessFailedCount = 0;
                return Failed(await users.UpdateAsync(user));
            }

            if (await users.IsInRoleAsync(user, CoreRoles.Owner) && await OwnerCountAsync() == 1)
            {
                return LastOwner(user);
            }

            user.LockoutEnabled = true;
            user.LockoutEnd = CoreIdentity.DisabledUntil;
            // A new security stamp ends every session signed in before it, and revoking them says so.
            var failure = Failed(await users.UpdateSecurityStampAsync(user));
            await RevokeSessionsOfAsync(user.Id);
            return failure;
        });
        if (disabled)
        {
            connections.CloseUser(target.Id, Context.ConnectionId);
        }

        return (await DescribeAsync([target]))[0];
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task ResetUserPassword(ResetUserPasswordRequest request)
    {
        var userId = request?.UserId ?? Guid.Empty;
        if (userId == UserId)
        {
            await AuditAsync("user.reset-password", AuditResult.Denied, User.Identity?.Name);
            throw new HubException("You cannot reset your own password here.");
        }

        if (string.IsNullOrEmpty(request?.Password) || request.Password.Length > MaxPasswordLength)
        {
            await AuditAsync("user.reset-password", AuditResult.Failed, userId.ToString("D"));
            throw new HubException("Give the new password.");
        }

        var target = await ChangeUserAsync("user.reset-password", userId, null, async user =>
        {
            var token = await users.GeneratePasswordResetTokenAsync(user);
            var failure = Failed(await users.ResetPasswordAsync(user, token, request.Password));
            if (failure is not null)
            {
                return failure;
            }

            // The new password is a fresh start, unless the account was turned off on purpose.
            if (!CoreIdentity.IsDisabled(user))
            {
                user.LockoutEnd = null;
                user.AccessFailedCount = 0;
                failure = Failed(await users.UpdateAsync(user));
            }

            await RevokeSessionsOfAsync(user.Id);
            return failure;
        });
        connections.CloseUser(target.Id, Context.ConnectionId);
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task DeleteUser(Guid userId)
    {
        if (userId == UserId)
        {
            await AuditAsync("user.delete", AuditResult.Denied, User.Identity?.Name);
            throw new HubException("You cannot remove your own account.");
        }

        var target = await ChangeUserAsync("user.delete", userId, null, async user =>
        {
            if (await users.IsInRoleAsync(user, CoreRoles.Owner) && await OwnerCountAsync() == 1)
            {
                return LastOwner(user);
            }

            // Spelled out rather than left to the cascades, so nothing of theirs can sign in again.
            var ct = Context.ConnectionAborted;
            await db.DeviceSessions.Where(s => s.UserId == user.Id).ExecuteDeleteAsync(ct);
            await db.EnrollmentCodes.Where(c => c.UserId == user.Id).ExecuteDeleteAsync(ct);
            await db.Devices.Where(d => d.UserId == user.Id).ExecuteDeleteAsync(ct);
            return Failed(await users.DeleteAsync(user));
        });
        connections.CloseUser(target.Id, Context.ConnectionId);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<int> RevokeOtherSessions()
    {
        var now = Now;
        var ended = await db.DeviceSessions
            .Where(s => s.UserId == UserId && s.Id != SessionId && s.RevokedAt == null && s.ExpiresAt > now)
            .Select(s => s.Id)
            .ToListAsync(Context.ConnectionAborted);
        if (ended.Count > 0)
        {
            await db.DeviceSessions
                .Where(s => ended.Contains(s.Id))
                .ExecuteUpdateAsync(update => update.SetProperty(s => s.RevokedAt, now), Context.ConnectionAborted);
        }

        await AuditAsync(
            "session.revoke-others",
            AuditResult.Success,
            null,
            new Dictionary<string, string?> { ["sessions"] = ended.Count.ToString(CultureInfo.InvariantCulture) });
        foreach (var sessionId in ended)
        {
            connections.CloseSession(sessionId, Context.ConnectionId);
        }

        return ended.Count;
    }

    /// <summary>Why a change was turned down: a rule said no (denied) or the input did not hold up (failed).</summary>
    private sealed record Refusal(string Result, string Message);

    private static readonly Refusal _notOwner = new(AuditResult.Denied, "Only an Owner can manage users.");

    private static Refusal LastOwner(CoreUser user) =>
        new(AuditResult.Denied, $"{user.UserName} is the only Owner. Make someone else an Owner first.");

    private static Refusal? Failed(IdentityResult result) =>
        result.Succeeded ? null : new(AuditResult.Failed, string.Join(' ', result.Errors.Select(e => e.Description)));

    private static string? KnownRole(string? role) =>
        CoreRoles.All.FirstOrDefault(known => string.Equals(known, role?.Trim(), StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Changes one user inside a write transaction, after checking the caller is still an Owner and
    /// the user exists. A refusal rolls everything back, then goes into the audit trail (which takes
    /// the write lock of its own) and back to the caller.
    /// </summary>
    private async Task<CoreUser> ChangeUserAsync(
        string action,
        Guid userId,
        Dictionary<string, string?>? parameters,
        Func<CoreUser, Task<Refusal?>> change)
    {
        CoreUser? target = null;
        var refusal = await InWriteTransactionAsync(async () =>
        {
            if (!await CallerIsOwnerAsync())
            {
                return _notOwner;
            }

            target = await users.FindByIdAsync(userId.ToString("D"));
            return target is null ? new Refusal(AuditResult.Failed, "There is no such user.") : await change(target);
        });
        if (refusal is not null)
        {
            await AuditAsync(action, refusal.Result, target?.UserName ?? userId.ToString("D"), parameters);
            throw new HubException(refusal.Message);
        }

        await AuditAsync(action, AuditResult.Success, target!.UserName, parameters);
        return target;
    }

    /// <summary>
    /// Runs <paramref name="work"/> in one BEGIN IMMEDIATE transaction: committed when it raises no
    /// refusal, rolled back otherwise. The rollback is explicit because EF was handed the
    /// transaction from outside, and disposing its wrapper would leave the write lock held until
    /// the connection closes, keeping the audit append that follows waiting.
    /// </summary>
    private async Task<Refusal?> InWriteTransactionAsync(Func<Task<Refusal?>> work)
    {
        await using var transaction = await CoreDatabase.BeginWriteAsync(db, Context.ConnectionAborted);
        Refusal? refusal;
        try
        {
            refusal = await work();
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }

        if (refusal is null)
        {
            await transaction.CommitAsync(Context.ConnectionAborted);
        }
        else
        {
            await transaction.RollbackAsync(Context.ConnectionAborted);
        }

        return refusal;
    }

    private async Task<bool> CallerIsOwnerAsync() =>
        await users.FindByIdAsync(UserId.ToString("D")) is { } caller && await users.IsInRoleAsync(caller, CoreRoles.Owner);

    private async Task<int> OwnerCountAsync() => (await users.GetUsersInRoleAsync(CoreRoles.Owner)).Count;

    /// <summary>Ends every live session of the user; returns how many there were.</summary>
    private Task<int> RevokeSessionsOfAsync(Guid userId)
    {
        var now = Now;
        return db.DeviceSessions
            .Where(s => s.UserId == userId && s.RevokedAt == null)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.RevokedAt, now), Context.ConnectionAborted);
    }

    private async Task<List<UserInfo>> DescribeAsync(IReadOnlyCollection<CoreUser> listed)
    {
        var ct = Context.ConnectionAborted;
        var ids = listed.Select(u => u.Id).ToList();
        var roles = await (
                from link in db.UserRoles
                join role in db.Roles on link.RoleId equals role.Id
                where ids.Contains(link.UserId)
                select new { link.UserId, role.Name })
            .ToListAsync(ct);
        var signIns = await db.DeviceSessions
            .Where(s => ids.Contains(s.UserId))
            .GroupBy(s => s.UserId)
            .Select(group => new { UserId = group.Key, Last = group.Max(s => s.CreatedAt) })
            .ToDictionaryAsync(row => row.UserId, row => row.Last, ct);
        var devices = await db.Devices
            .Where(d => ids.Contains(d.UserId) && d.RevokedAt == null)
            .GroupBy(d => d.UserId)
            .Select(group => new { UserId = group.Key, Count = group.Count() })
            .ToDictionaryAsync(row => row.UserId, row => row.Count, ct);
        var now = time.GetUtcNow();
        return [.. listed.Select(user =>
        {
            var disabled = CoreIdentity.IsDisabled(user);
            long? lockedUntil = !disabled && user.LockoutEnabled && user.LockoutEnd is { } end && end > now
                ? end.ToUnixTimeMilliseconds()
                : null;
            return new UserInfo(
                user.Id,
                user.UserName ?? string.Empty,
                CoreRoles.Highest(roles.Where(r => r.UserId == user.Id).Select(r => r.Name)),
                user.TwoFactorEnabled,
                disabled,
                lockedUntil,
                signIns.TryGetValue(user.Id, out var last) ? last : null,
                user.CreatedAt,
                devices.GetValueOrDefault(user.Id),
                user.Id == UserId);
        })];
    }
}
