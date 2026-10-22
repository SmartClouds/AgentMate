using System.Globalization;
using System.Security.Claims;
using AgentMate.ServerCore.Assistant;
using AgentMate.ServerCore.Audit;
using AgentMate.ServerCore.Cloudflare;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Data;
using AgentMate.ServerCore.Docker;
using AgentMate.ServerCore.Firewall;
using AgentMate.ServerCore.Hardening;
using AgentMate.ServerCore.Registries;
using AgentMate.ServerCore.Security;
using AgentMate.ServerCore.Stacks;
using AgentMate.ServerCore.Web;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace AgentMate.ServerCore.Hubs;

/// <summary>
/// The one hub the app talks to. Each method carries its own policy, so tightening a role later
/// never depends on remembering the class-level default. Hub instances live for one invocation,
/// so the scoped services they take are fresh each time. The account and audit methods are here;
/// the server's (system, metrics, updates, jobs, alerts) are in CoreHub.Server.cs, and the
/// firewall's in CoreHub.Firewall.cs.
/// </summary>
[Authorize(Policy = CorePolicies.SignedIn)]
internal sealed partial class CoreHub(
    TimeProvider time,
    CoreDbContext db,
    UserManager<CoreUser> users,
    AuditLog audit,
    EnrollmentCodes enrollmentCodes,
    DeviceSessions sessions,
    HubConnections connections,
    ServerServices server,
    FirewallHubServices firewall,
    DockerOperations docker,
    WebServices web,
    StackOperations stacks,
    RegistryCredentials registries,
    CloudflareServices cloudflare,
    SecurityCenterServices security,
    Backups.BackupCenter backupCenter,
    Backups.BackupOperations backupOperations,
    DirectTls.DirectTlsManager directTls,
    ErrorReporting.ErrorReportingManager errorReporting,
    Notifications.TelegramManager telegram,
    AssistantHubServices assistant,
    Files.ContainerFilesService files) : Hub<ICoreHubReceiver>, ICoreHub
{
    public const string Path = "/hubs/core";

    private const int RecoveryCodeCount = 10;
    private const int MaxAuditPage = 200;

    private ClaimsPrincipal User => Context.User ?? throw new HubException("Not signed in.");

    private Guid UserId => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    private Guid SessionId => Guid.Parse(User.FindFirstValue(CoreAuthentication.SessionClaim)!);

    private Guid DeviceId => Guid.Parse(User.FindFirstValue(CoreAuthentication.DeviceClaim)!);

    private bool IsAdmin => User.IsInRole(CoreRoles.Admin) || User.IsInRole(CoreRoles.Owner);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public override Task OnConnectedAsync()
    {
        connections.Add(Context, SessionId, DeviceId);
        return base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        connections.Remove(Context.ConnectionId);
        server.Streams.Forget(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<PingResponse> Ping() => Task.FromResult(new PingResponse(Now));

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<AccountInfo> GetAccount()
    {
        var user = await CurrentUserAsync();
        var session = await db.DeviceSessions.AsNoTracking().FirstAsync(s => s.Id == SessionId);
        var twoFactor = await users.GetTwoFactorEnabledAsync(user);
        return new AccountInfo(
            user.Id,
            user.UserName ?? string.Empty,
            [.. (await users.GetRolesAsync(user)).Order(StringComparer.Ordinal)],
            twoFactor,
            twoFactor ? await users.CountRecoveryCodesAsync(user) : 0,
            session.Id,
            session.DeviceId,
            session.StepUpUntil > Now ? session.StepUpUntil : null);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task SignOut()
    {
        await db.DeviceSessions
            .Where(s => s.Id == SessionId && s.RevokedAt == null)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.RevokedAt, Now));
        await AuditAsync("auth.sign-out", AuditResult.Success);
        connections.CloseSession(SessionId, Context.ConnectionId);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<StepUpResponse> StepUp(StepUpRequest request)
    {
        var user = await CurrentUserAsync();
        if (await users.IsLockedOutAsync(user))
        {
            throw new HubException("Too many wrong attempts. This account is locked for 15 minutes.");
        }

        bool confirmed;
        if (!string.IsNullOrWhiteSpace(request?.TotpCode) && await users.GetTwoFactorEnabledAsync(user))
        {
            confirmed = await users.VerifyTwoFactorTokenAsync(
                user,
                TokenOptions.DefaultAuthenticatorProvider,
                request.TotpCode.Replace(" ", string.Empty, StringComparison.Ordinal));
        }
        else if (!string.IsNullOrEmpty(request?.Password) && request.Password.Length <= 1024)
        {
            confirmed = await users.CheckPasswordAsync(user, request.Password);
        }
        else
        {
            throw new HubException("Enter your password, or a code from your authenticator app.");
        }

        if (!confirmed)
        {
            await users.AccessFailedAsync(user);
            await AuditAsync("auth.step-up", AuditResult.Failed);
            throw new HubException("That is not right.");
        }

        await users.ResetAccessFailedCountAsync(user);
        var until = Now + (long)CorePolicies.StepUpWindow.TotalMilliseconds;
        await db.DeviceSessions
            .Where(s => s.Id == SessionId)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.StepUpUntil, until));
        await AuditAsync("auth.step-up", AuditResult.Success);
        return new StepUpResponse(until);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<DeviceInfo[]> ListDevices()
    {
        var devices = await (IsAdmin ? db.Devices : db.Devices.Where(d => d.UserId == UserId))
            .AsNoTracking()
            .OrderBy(d => d.CreatedAt)
            .ToListAsync();
        var owners = devices.Select(d => d.UserId).Distinct().ToList();
        var names = await users.Users
            .Where(u => owners.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.UserName ?? string.Empty);
        return [.. devices.Select(d => new DeviceInfo(
            d.Id,
            names.GetValueOrDefault(d.UserId, string.Empty),
            d.Name,
            d.CreatedAt,
            d.LastSeenAt,
            d.RevokedAt is not null,
            d.Id == DeviceId))];
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task RevokeDevice(Guid deviceId)
    {
        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId)
            ?? throw new HubException("There is no such device.");
        if (device.UserId != UserId && !IsAdmin)
        {
            await AuditAsync("device.revoke", AuditResult.Denied, deviceId.ToString("D"));
            throw new HubException("You can only revoke your own devices.");
        }

        var now = Now;
        device.RevokedAt ??= now;
        await db.SaveChangesAsync();
        await db.DeviceSessions
            .Where(s => s.DeviceId == deviceId && s.RevokedAt == null)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.RevokedAt, now));
        await AuditAsync("device.revoke", AuditResult.Success, deviceId.ToString("D"));
        connections.CloseDevice(deviceId, Context.ConnectionId);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<SessionInfo[]> ListSessions()
    {
        var now = Now;
        var sessions = await db.DeviceSessions
            .AsNoTracking()
            .Where(s => s.UserId == UserId && s.RevokedAt == null && s.ExpiresAt > now)
            .OrderByDescending(s => s.LastRenewedAt)
            .ToListAsync();
        var deviceIds = sessions.Select(s => s.DeviceId).Distinct().ToList();
        var names = await db.Devices
            .Where(d => deviceIds.Contains(d.Id))
            .ToDictionaryAsync(d => d.Id, d => d.Name);
        return [.. sessions.Select(s => new SessionInfo(
            s.Id,
            s.DeviceId,
            names.GetValueOrDefault(s.DeviceId, string.Empty),
            s.CreatedAt,
            s.LastRenewedAt,
            s.ExpiresAt,
            s.Id == SessionId))];
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task RevokeSession(Guid sessionId)
    {
        var session = await db.DeviceSessions.FirstOrDefaultAsync(s => s.Id == sessionId)
            ?? throw new HubException("There is no such session.");
        if (session.UserId != UserId && !IsAdmin)
        {
            await AuditAsync("session.revoke", AuditResult.Denied, sessionId.ToString("D"));
            throw new HubException("You can only end your own sessions.");
        }

        session.RevokedAt ??= Now;
        await db.SaveChangesAsync();
        await AuditAsync("session.revoke", AuditResult.Success, sessionId.ToString("D"));
        connections.CloseSession(sessionId, Context.ConnectionId);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<TotpSetup> BeginTotpSetup()
    {
        var user = await CurrentUserAsync();
        if (await users.GetTwoFactorEnabledAsync(user))
        {
            throw new HubException("Two-factor is already on. Turn it off first to move to a new authenticator.");
        }

        var stamp = user.SecurityStamp;
        await users.ResetAuthenticatorKeyAsync(user);
        // Identity renews the security stamp with the key; the key is not in use yet, so no session ends.
        await sessions.KeepAllAsync(user.Id, stamp, user.SecurityStamp, Context.ConnectionAborted);
        var key = await users.GetAuthenticatorKeyAsync(user) ?? throw new HubException("No authenticator key was made.");
        await AuditAsync("auth.totp-begin", AuditResult.Success);
        var label = Uri.EscapeDataString($"AgentMate:{user.UserName}");
        return new TotpSetup(
            string.Join(' ', key.Chunk(4).Select(chunk => new string(chunk))),
            $"otpauth://totp/{label}?secret={key}&issuer=AgentMate&digits=6&period=30");
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<RecoveryCodes> ConfirmTotp(string code)
    {
        var user = await CurrentUserAsync();
        if (await users.GetAuthenticatorKeyAsync(user) is null)
        {
            throw new HubException("Start the setup first.");
        }

        if (!await VerifyTotpAsync(user, code))
        {
            await AuditAsync("auth.totp-enable", AuditResult.Failed);
            throw new HubException("That code is not right, or it was used already. Codes change every 30 seconds.");
        }

        await users.SetTwoFactorEnabledAsync(user, true);
        var codes = await users.GenerateNewTwoFactorRecoveryCodesAsync(user, RecoveryCodeCount);
        await EndOtherSessionsAsync(user);
        await AuditAsync("auth.totp-enable", AuditResult.Success);
        return new RecoveryCodes([.. codes ?? []]);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task DisableTotp(string code)
    {
        var user = await CurrentUserAsync();
        if (!await users.GetTwoFactorEnabledAsync(user))
        {
            return;
        }

        if (!await VerifyTotpAsync(user, code))
        {
            await AuditAsync("auth.totp-disable", AuditResult.Failed);
            throw new HubException("That code is not right, or it was used already. Codes change every 30 seconds.");
        }

        await users.SetTwoFactorEnabledAsync(user, false);
        await users.ResetAuthenticatorKeyAsync(user);
        await EndOtherSessionsAsync(user);
        await AuditAsync("auth.totp-disable", AuditResult.Success);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<RecoveryCodes> NewRecoveryCodes()
    {
        var user = await CurrentUserAsync();
        if (!await users.GetTwoFactorEnabledAsync(user))
        {
            throw new HubException("Recovery codes come with two-factor. Turn it on first.");
        }

        var codes = await users.GenerateNewTwoFactorRecoveryCodesAsync(user, RecoveryCodeCount);
        await AuditAsync("auth.recovery-codes", AuditResult.Success);
        return new RecoveryCodes([.. codes ?? []]);
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<EnrollmentCodeInfo> CreateEnrollmentCode(CreateEnrollmentCodeRequest request)
    {
        var target = string.IsNullOrWhiteSpace(request?.UserName)
            ? await CurrentUserAsync()
            : await users.FindByNameAsync(request.UserName) ?? throw new HubException($"There is no user called {request.UserName}.");
        var minutes = Math.Clamp(
            request?.ValidMinutes ?? (int)EnrollmentCodes.DefaultValidity.TotalMinutes,
            1,
            (int)EnrollmentCodes.MaxValidity.TotalMinutes);
        var (code, expiresAt) = await enrollmentCodes.CreateAsync(
            target.Id,
            UserId,
            TimeSpan.FromMinutes(minutes),
            Context.ConnectionAborted);
        await AuditAsync(
            "device.enrollment-code",
            AuditResult.Success,
            target.UserName,
            new Dictionary<string, string?> { ["validMinutes"] = minutes.ToString(CultureInfo.InvariantCulture) });
        return new EnrollmentCodeInfo(code, target.UserName ?? string.Empty, expiresAt);
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<AuditPage> QueryAudit(AuditQuery query)
    {
        var limit = Math.Clamp(query?.Limit ?? 50, 1, MaxAuditPage);
        var events = db.AuditEvents.AsNoTracking();
        if (query?.BeforeId is long before)
        {
            events = events.Where(e => e.Id < before);
        }

        if (!string.IsNullOrWhiteSpace(query?.Action))
        {
            var action = query.Action.Trim();
            events = action.EndsWith('.')
                ? events.Where(e => e.Action.StartsWith(action))
                : events.Where(e => e.Action == action);
        }

        if (!string.IsNullOrWhiteSpace(query?.Result))
        {
            var result = AuditResult.All.FirstOrDefault(known => known == query.Result.Trim())
                ?? throw new HubException("A result is success, denied, failed or cancelled.");
            events = events.Where(e => e.Result == result);
        }

        if (!string.IsNullOrWhiteSpace(query?.Actor))
        {
            var actor = query.Actor.Trim();
            var actorId = Guid.TryParse(actor, out var id) ? id : (await users.FindByNameAsync(actor))?.Id;
            if (actorId is null)
            {
                return new AuditPage([]);
            }

            events = events.Where(e => e.ActorUserId == actorId);
        }

        if (query?.FromUnixMs is long from)
        {
            events = events.Where(e => e.At >= from);
        }

        if (query?.ToUnixMs is long to)
        {
            events = events.Where(e => e.At <= to);
        }

        var page = await events.OrderByDescending(e => e.Id).Take(limit + 1).ToListAsync();
        var more = page.Count > limit;
        var shown = page.Take(limit).ToList();
        // Names as they are now, for reading; the ids stay what the chain recorded.
        var actorIds = shown.Where(e => e.ActorUserId is not null).Select(e => e.ActorUserId!.Value).Distinct().ToList();
        var actorNames = await users.Users
            .Where(u => actorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.UserName ?? string.Empty);
        var deviceIds = shown.Where(e => e.DeviceId is not null).Select(e => e.DeviceId!.Value).Distinct().ToList();
        var deviceNames = await db.Devices
            .Where(d => deviceIds.Contains(d.Id))
            .ToDictionaryAsync(d => d.Id, d => d.Name);
        return new AuditPage(
            [.. shown.Select(e => new AuditEventInfo(
                e.Id,
                e.At,
                e.ActorUserId,
                e.DeviceId,
                e.PeerUid,
                e.Action,
                e.Target,
                e.Parameters,
                e.Result,
                e.ActorUserId is Guid actor ? actorNames.GetValueOrDefault(actor) : null,
                e.DeviceId is Guid device ? deviceNames.GetValueOrDefault(device) : null))],
            more ? shown[^1].Id : null);
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<AuditVerificationInfo> VerifyAudit()
    {
        var verification = await audit.VerifyAsync(Context.ConnectionAborted);
        return new AuditVerificationInfo(verification.Intact, verification.Checked, verification.BrokenAt);
    }

    /// <summary>
    /// Two-factor changed: the sessions that never proved the new state end, live connections
    /// included, and this one carries on (it just stepped up and gave a code).
    /// </summary>
    private async Task EndOtherSessionsAsync(CoreUser user)
    {
        foreach (var ended in await sessions.KeepOnlyAsync(SessionId, user, Context.ConnectionAborted))
        {
            connections.CloseSession(ended, Context.ConnectionId);
        }
    }

    private async Task<CoreUser> CurrentUserAsync() =>
        await users.FindByIdAsync(UserId.ToString("D")) ?? throw new HubException("This account no longer exists.");

    private async Task<bool> VerifyTotpAsync(CoreUser user, string? code) =>
        !string.IsNullOrWhiteSpace(code)
        && code.Length <= 16
        && await users.VerifyTwoFactorTokenAsync(
            user,
            TokenOptions.DefaultAuthenticatorProvider,
            code.Replace(" ", string.Empty, StringComparison.Ordinal));

    private async Task AuditAsync(
        string action,
        string result,
        string? target = null,
        Dictionary<string, string?>? parameters = null) =>
        await audit.AppendAsync(new AuditEntry(
            action,
            result,
            UserId,
            DeviceId,
            PeerCredentials.UidOf(Context.GetHttpContext()),
            target,
            parameters));
}
