using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

internal enum SessionState
{
    Active,
    Expired,
    Revoked,
    DeviceRevoked,
}

internal sealed record SessionCheck(SessionState State, DeviceSession? Session, Device? Device, CoreUser? User);

/// <summary>
/// The rules a device session lives by: at most 30 days without a renewal, never more than 180
/// days in all, over as soon as its device is revoked or the user's password changes.
/// </summary>
internal sealed class DeviceSessions(CoreDbContext db, UserManager<CoreUser> users, TimeProvider time)
{
    public static readonly TimeSpan IdleLimit = TimeSpan.FromDays(30);
    public static readonly TimeSpan AbsoluteLimit = TimeSpan.FromDays(180);

    public long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<DeviceSession> StartAsync(CoreUser user, Device device, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(device);
        var now = Now;
        var session = new DeviceSession
        {
            Id = Guid.NewGuid(),
            DeviceId = device.Id,
            UserId = user.Id,
            CreatedAt = now,
            LastRenewedAt = now,
            ExpiresAt = now + (long)AbsoluteLimit.TotalMilliseconds,
            SecurityStamp = user.SecurityStamp ?? string.Empty,
        };
        db.DeviceSessions.Add(session);
        device.LastSeenAt = now;
        await db.SaveChangesAsync(cancellationToken);
        return session;
    }

    /// <param name="forRenewal">Renewals also enforce the idle limit; an access token's 15 minutes cannot outlast it.</param>
    public async Task<SessionCheck> CheckAsync(Guid sessionId, bool forRenewal, CancellationToken cancellationToken)
    {
        var session = await db.DeviceSessions.FirstOrDefaultAsync(s => s.Id == sessionId, cancellationToken);
        if (session is null)
        {
            return new SessionCheck(SessionState.Expired, null, null, null);
        }

        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == session.DeviceId, cancellationToken);
        if (device is null || device.RevokedAt is not null)
        {
            return new SessionCheck(SessionState.DeviceRevoked, session, device, null);
        }

        var now = Now;
        if (session.RevokedAt is not null)
        {
            return new SessionCheck(SessionState.Revoked, session, device, null);
        }

        if (now >= session.ExpiresAt || (forRenewal && now - session.LastRenewedAt > (long)IdleLimit.TotalMilliseconds))
        {
            return new SessionCheck(SessionState.Expired, session, device, null);
        }

        var user = await users.FindByIdAsync(session.UserId.ToString("D"));
        if (user is null || user.SecurityStamp != session.SecurityStamp)
        {
            return new SessionCheck(SessionState.Revoked, session, device, user);
        }

        return new SessionCheck(SessionState.Active, session, device, user);
    }

    /// <summary>
    /// Identity renews a user's security stamp on changes that should end no session (a new
    /// authenticator key that is not in use yet): every session on the old stamp moves to the new one.
    /// </summary>
    public Task KeepAllAsync(Guid userId, string? before, string? after, CancellationToken cancellationToken) =>
        db.DeviceSessions
            .Where(s => s.UserId == userId && s.SecurityStamp == (before ?? string.Empty))
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.SecurityStamp, after ?? string.Empty), cancellationToken);

    /// <summary>
    /// After a change that the user's other sessions never proved (two-factor turned on or off),
    /// only this session carries on; the others end. Returns the ones that ended.
    /// </summary>
    public async Task<Guid[]> KeepOnlyAsync(Guid sessionId, CoreUser user, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        var stamp = user.SecurityStamp ?? string.Empty;
        await db.DeviceSessions
            .Where(s => s.Id == sessionId && s.UserId == user.Id)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.SecurityStamp, stamp), cancellationToken);
        return await db.DeviceSessions
            .Where(s => s.UserId == user.Id && s.Id != sessionId && s.RevokedAt == null && s.SecurityStamp != stamp)
            .Select(s => s.Id)
            .ToArrayAsync(cancellationToken);
    }

    public async Task RenewedAsync(DeviceSession session, Device device, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(device);
        session.LastRenewedAt = Now;
        device.LastSeenAt = session.LastRenewedAt;
        await db.SaveChangesAsync(cancellationToken);
    }
}
