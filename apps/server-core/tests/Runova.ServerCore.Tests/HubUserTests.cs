using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Users, from the Owner's side: who can sign in, with which role, and what happens to their
/// sessions when that changes. Every change needs a step-up, lands in the audit trail without the
/// password, and none of them can leave the core without an Owner.
/// </summary>
public sealed class HubUserTests
{
    private const string SamPassword = "another long passphrase";
    private const string NewPassword = "a brand new passphrase";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness, bool stepUp = true)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        if (stepUp)
        {
            await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        }

        return hub;
    }

    private static async Task<Guid> AddUserAsync(AuthHarness harness, string userName, string role, string password = SamPassword)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        var user = new CoreUser { UserName = userName };
        Assert.True((await users.CreateAsync(user, password)).Succeeded);
        Assert.True((await users.AddToRoleAsync(user, role)).Succeeded);
        return user.Id;
    }

    /// <summary>Someone else at their own computer: a device of theirs, and a sign-in with it.</summary>
    private sealed class OtherUser(AuthHarness harness, string userName, Guid deviceId, ECDsa key) : IDisposable
    {
        public Guid DeviceId => deviceId;

        public async Task<HttpResponseMessage> LoginAsync(string password = SamPassword)
        {
            var challenge = await harness.ChallengeAsync(AuthPurpose.Login, deviceId: deviceId);
            return await harness.Client.PostAsJsonAsync(
                "/api/v1/auth/login",
                new LoginRequest(
                    challenge.ChallengeId,
                    deviceId,
                    harness.Sign(challenge, AuthPurpose.Login, key: key, deviceId: deviceId),
                    userName,
                    password),
                CoreJson.Options,
                Cancel);
        }

        public async Task<SignedInResponse> SignInAsync(string password = SamPassword)
        {
            var response = await LoginAsync(password);
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(Cancel));
            return (await response.Content.ReadFromJsonAsync<SignedInResponse>(CoreJson.Options, Cancel))!;
        }

        public async Task<HttpResponseMessage> RenewAsync(Guid sessionId)
        {
            var challenge = await harness.ChallengeAsync(AuthPurpose.Renew, sessionId, deviceId);
            return await harness.Client.PostAsJsonAsync(
                "/api/v1/auth/renew",
                new RenewRequest(challenge.ChallengeId, sessionId, harness.Sign(challenge, AuthPurpose.Renew, sessionId, key, deviceId)),
                CoreJson.Options,
                Cancel);
        }

        public async Task<HubConnection> ConnectAsync()
        {
            var hub = harness.Hub((await SignInAsync()).AccessToken);
            await hub.StartAsync(Cancel);
            return hub;
        }

        public void Dispose() => key.Dispose();
    }

    private static async Task<OtherUser> WithDeviceAsync(AuthHarness harness, Guid userId, string userName)
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = new Device { Id = Guid.NewGuid(), UserId = userId, Name = $"{userName}'s laptop", PublicKey = key.ExportSubjectPublicKeyInfo() };
        db.Devices.Add(device);
        await db.SaveChangesAsync(Cancel);
        return new OtherUser(harness, userName, device.Id, key);
    }

    private static Task ClosedAsync(HubConnection hub)
    {
        var closed = new TaskCompletionSource();
        hub.Closed += _ =>
        {
            closed.TrySetResult();
            return Task.CompletedTask;
        };
        return closed.Task.WaitAsync(TimeSpan.FromSeconds(10), Cancel);
    }

    private static async Task<List<AuditEvent>> AuditAsync(AuthHarness harness, string actionPrefix)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action.StartsWith(actionPrefix))
            .OrderBy(e => e.Id)
            .ToListAsync(Cancel);
    }

    [Fact]
    public async Task An_owner_sees_every_user_with_role_two_factor_lockout_and_last_sign_in()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Operator);
        var leeId = await AddUserAsync(harness, "lee", CoreRoles.Viewer);
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
            var locked = (await users.FindByIdAsync(leeId.ToString("D")))!;
            for (var attempt = 0; attempt < CoreIdentity.MaxFailedAttempts; attempt++)
            {
                await users.AccessFailedAsync(locked);
            }
        }

        await using var hub = await ConnectAsync(harness, stepUp: false);

        var listed = await hub.InvokeAsync<UserInfo[]>(nameof(ICoreHub.ListUsers), Cancel);

        Assert.Equal(["lee", "maria", "sam"], listed.Select(u => u.UserName));
        var maria = listed.Single(u => u.UserName == "maria");
        Assert.Equal(CoreRoles.Owner, maria.Role);
        Assert.True(maria.Current);
        Assert.NotNull(maria.LastSignInAtUnixMs);
        Assert.Equal(1, maria.Devices);
        var sam = listed.Single(u => u.Id == samId);
        Assert.Equal(CoreRoles.Operator, sam.Role);
        Assert.False(sam.Current);
        Assert.Null(sam.LastSignInAtUnixMs);
        Assert.False(sam.TwoFactorEnabled);
        var lee = listed.Single(u => u.Id == leeId);
        Assert.False(lee.Disabled);
        Assert.NotNull(lee.LockedOutUntilUnixMs);
    }

    [Fact]
    public async Task Changing_users_needs_a_step_up_but_listing_them_does_not()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness, stepUp: false);

        await hub.InvokeAsync<UserInfo[]>(nameof(ICoreHub.ListUsers), Cancel);
        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.CreateUser),
            new CreateUserRequest("sam", SamPassword, CoreRoles.Operator),
            Cancel));

        Assert.Contains("unauthorized", refusal.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Only_an_owner_manages_users()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);

        var list = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo[]>(nameof(ICoreHub.ListUsers), Cancel));
        var create = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.CreateUser),
            new CreateUserRequest("sam", SamPassword, CoreRoles.Owner),
            Cancel));

        Assert.Contains("unauthorized", list.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", create.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_new_user_can_enroll_with_a_code_and_sign_in()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        var created = await hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.CreateUser),
            new CreateUserRequest(" sam ", SamPassword, CoreRoles.Operator),
            Cancel);
        var code = await hub.InvokeAsync<EnrollmentCodeInfo>(
            nameof(ICoreHub.CreateEnrollmentCode),
            new CreateEnrollmentCodeRequest("sam"),
            Cancel);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var enrolled = await harness.Client.PostAsJsonAsync(
            "/api/v1/auth/enroll",
            new EnrollRequest(code.Code, "sam", SamPassword, Convert.ToBase64String(key.ExportSubjectPublicKeyInfo()), "sam's desk"),
            CoreJson.Options,
            Cancel);

        Assert.Equal("sam", created.UserName);
        Assert.Equal(CoreRoles.Operator, created.Role);
        Assert.Equal(0, created.Devices);
        Assert.True(created.CreatedAtUnixMs > 0);
        Assert.True(enrolled.IsSuccessStatusCode, await enrolled.Content.ReadAsStringAsync(Cancel));
        var deviceId = (await enrolled.Content.ReadFromJsonAsync<EnrollResponse>(CoreJson.Options, Cancel))!.DeviceId;
        using var sam = new OtherUser(harness, "sam", deviceId, ECDsa.Create(key.ExportParameters(true)));
        var signedIn = await sam.SignInAsync();
        Assert.Equal(["operator"], signedIn.User.Roles);
    }

    [Theory]
    [InlineData("password1234", "too common")]
    [InlineData("short pass", "at least 12")]
    [InlineData("sam-the-operator", "user name")]
    public async Task A_first_password_has_to_pass_the_cores_rules(string password, string reason)
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.CreateUser),
            new CreateUserRequest("sam", password, CoreRoles.Viewer),
            Cancel));

        Assert.Contains(reason, refusal.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(await hub.InvokeAsync<UserInfo[]>(nameof(ICoreHub.ListUsers), Cancel), u => u.UserName == "sam");
        var recorded = Assert.Single(await AuditAsync(harness, "user.create"));
        Assert.Equal("failed", recorded.Result);
        Assert.DoesNotContain(password, recorded.Parameters ?? string.Empty, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("superuser")]
    [InlineData("")]
    public async Task A_role_is_one_of_the_four(string role)
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);

        var create = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.CreateUser),
            new CreateUserRequest("lee", SamPassword, role),
            Cancel));
        var change = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.SetUserRole), samId, role, Cancel));

        Assert.Contains("owner, admin, operator or viewer", create.Message, StringComparison.Ordinal);
        Assert.Contains("owner, admin, operator or viewer", change.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_taken_user_name_is_refused()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.CreateUser),
            new CreateUserRequest("MARIA", SamPassword, CoreRoles.Viewer),
            Cancel));

        Assert.Contains("already taken", refusal.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_new_role_reaches_the_users_open_connection_at_once()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Viewer);
        using var sam = await WithDeviceAsync(harness, samId, "sam");
        await using var samHub = await sam.ConnectAsync();
        var samClosed = ClosedAsync(samHub);
        await using var hub = await ConnectAsync(harness);

        var changed = await hub.InvokeAsync<UserInfo>(nameof(ICoreHub.SetUserRole), samId, CoreRoles.Operator, Cancel);

        Assert.Equal(CoreRoles.Operator, changed.Role);
        await samClosed;
        await using var again = await sam.ConnectAsync();
        Assert.Equal(["operator"], (await again.InvokeAsync<AccountInfo>(nameof(ICoreHub.GetAccount), Cancel)).Roles);
        var recorded = Assert.Single(await AuditAsync(harness, "user.set-role"));
        Assert.Equal("sam", recorded.Target);
        Assert.Contains("operator", recorded.Parameters, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_only_owner_cannot_give_up_the_role()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.SetUserRole), harness.UserId, CoreRoles.Admin, Cancel));

        Assert.Contains("only Owner", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(CoreRoles.Owner, (await hub.InvokeAsync<UserInfo[]>(nameof(ICoreHub.ListUsers), Cancel)).Single().Role);
        Assert.Equal("denied", Assert.Single(await AuditAsync(harness, "user.set-role")).Result);
    }

    [Fact]
    public async Task With_a_second_owner_either_can_step_down_but_not_both()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);

        await hub.InvokeAsync<UserInfo>(nameof(ICoreHub.SetUserRole), samId, CoreRoles.Admin, Cancel);
        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.SetUserRole), harness.UserId, CoreRoles.Admin, Cancel));

        Assert.Contains("only Owner", refusal.Message, StringComparison.Ordinal);
        await hub.InvokeAsync<UserInfo>(nameof(ICoreHub.SetUserRole), samId, CoreRoles.Owner, Cancel);
        var steppedDown = await hub.InvokeAsync<UserInfo>(nameof(ICoreHub.SetUserRole), harness.UserId, CoreRoles.Admin, Cancel);
        Assert.Equal(CoreRoles.Admin, steppedDown.Role);
    }

    [Fact]
    public async Task Disabling_a_user_ends_their_sessions_and_keeps_them_out_until_enabled()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Operator);
        using var sam = await WithDeviceAsync(harness, samId, "sam");
        var samSession = await sam.SignInAsync();
        await using var samHub = harness.Hub(samSession.AccessToken);
        await samHub.StartAsync(Cancel);
        var samClosed = ClosedAsync(samHub);
        await using var hub = await ConnectAsync(harness);

        var disabled = await hub.InvokeAsync<UserInfo>(nameof(ICoreHub.SetUserDisabled), samId, true, Cancel);

        Assert.True(disabled.Disabled);
        Assert.Null(disabled.LockedOutUntilUnixMs);
        await samClosed;
        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(await sam.RenewAsync(samSession.SessionId)));
        var refused = await sam.LoginAsync();
        var error = (await refused.Content.ReadFromJsonAsync<AuthError>(CoreJson.Options, Cancel))!;
        Assert.Equal(AuthErrorCode.LockedOut, error.Code);
        Assert.Contains("disabled", error.Message, StringComparison.Ordinal);
        Assert.Null(error.LockedOutUntilUnixMs);

        var enabled = await hub.InvokeAsync<UserInfo>(nameof(ICoreHub.SetUserDisabled), samId, false, Cancel);

        Assert.False(enabled.Disabled);
        await sam.SignInAsync();
        Assert.Equal(["user.disable", "user.enable"], (await AuditAsync(harness, "user.")).Select(e => e.Action));
    }

    [Fact]
    public async Task An_owner_cannot_disable_remove_or_reset_their_own_account()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await AddUserAsync(harness, "sam", CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);

        var disable = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<UserInfo>(
            nameof(ICoreHub.SetUserDisabled), harness.UserId, true, Cancel));
        var delete = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(
            nameof(ICoreHub.DeleteUser), harness.UserId, Cancel));
        var reset = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(
            nameof(ICoreHub.ResetUserPassword), new ResetUserPasswordRequest(harness.UserId, NewPassword), Cancel));

        Assert.Contains("your own account", disable.Message, StringComparison.Ordinal);
        Assert.Contains("your own account", delete.Message, StringComparison.Ordinal);
        Assert.Contains("your own password", reset.Message, StringComparison.Ordinal);
        Assert.Equal(AuthErrorCode.InvalidCredentials, await AuthHarness.ErrorOf(await harness.LoginAsync(password: NewPassword)));
    }

    [Fact]
    public async Task A_reset_password_ends_the_users_sessions_and_the_new_one_works()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Viewer);
        using var sam = await WithDeviceAsync(harness, samId, "sam");
        var samSession = await sam.SignInAsync();
        await using var hub = await ConnectAsync(harness);

        var weak = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(
            nameof(ICoreHub.ResetUserPassword), new ResetUserPasswordRequest(samId, "password1234"), Cancel));
        await hub.InvokeAsync(nameof(ICoreHub.ResetUserPassword), new ResetUserPasswordRequest(samId, NewPassword), Cancel);

        Assert.Contains("too common", weak.Message, StringComparison.Ordinal);
        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(await sam.RenewAsync(samSession.SessionId)));
        Assert.Equal(AuthErrorCode.InvalidCredentials, await AuthHarness.ErrorOf(await sam.LoginAsync()));
        await sam.SignInAsync(NewPassword);
        var recorded = await AuditAsync(harness, "user.reset-password");
        Assert.Equal(["failed", "success"], recorded.Select(e => e.Result));
        Assert.All(recorded, e => Assert.DoesNotContain("passphrase", e.Parameters ?? string.Empty, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_removed_user_goes_with_their_devices_sessions_and_codes()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Operator);
        using var sam = await WithDeviceAsync(harness, samId, "sam");
        await using var samHub = await sam.ConnectAsync();
        var samClosed = ClosedAsync(samHub);
        await using var hub = await ConnectAsync(harness);
        await hub.InvokeAsync<EnrollmentCodeInfo>(nameof(ICoreHub.CreateEnrollmentCode), new CreateEnrollmentCodeRequest("sam"), Cancel);

        await hub.InvokeAsync(nameof(ICoreHub.DeleteUser), samId, Cancel);

        await samClosed;
        Assert.DoesNotContain(await hub.InvokeAsync<UserInfo[]>(nameof(ICoreHub.ListUsers), Cancel), u => u.Id == samId);
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        Assert.False(await db.Devices.AnyAsync(d => d.UserId == samId, Cancel));
        Assert.False(await db.DeviceSessions.AnyAsync(s => s.UserId == samId, Cancel));
        Assert.False(await db.EnrollmentCodes.AnyAsync(c => c.UserId == samId, Cancel));
        Assert.False(await db.UserRoles.AnyAsync(r => r.UserId == samId, Cancel));
        Assert.Equal(AuthErrorCode.DeviceUnknown, await AuthHarness.ErrorOf((await harness.TryChallengeAsync(AuthPurpose.Login, deviceId: sam.DeviceId)).Response));
        var recorded = Assert.Single(await AuditAsync(harness, "user.delete"));
        Assert.Equal(("sam", "success"), (recorded.Target, recorded.Result));
    }

    [Fact]
    public async Task Acting_on_a_user_that_is_not_there_says_so()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(
            nameof(ICoreHub.DeleteUser), Guid.NewGuid(), Cancel));

        Assert.EndsWith("HubException: There is no such user.", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Ending_every_other_session_keeps_this_one()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var other = await harness.SignInAsync();
        await using var otherHub = harness.Hub(other.AccessToken);
        await otherHub.StartAsync(Cancel);
        var otherClosed = ClosedAsync(otherHub);
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);

        var ended = await hub.InvokeAsync<int>(nameof(ICoreHub.RevokeOtherSessions), Cancel);

        Assert.Equal(1, ended);
        await otherClosed;
        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(await harness.RenewAsync(other.SessionId)));
        Assert.True((await harness.RenewAsync(signedIn.SessionId)).IsSuccessStatusCode);
        Assert.Equal([signedIn.SessionId], (await hub.InvokeAsync<SessionInfo[]>(nameof(ICoreHub.ListSessions), Cancel)).Select(s => s.Id));
        Assert.Equal("success", Assert.Single(await AuditAsync(harness, "session.revoke-others")).Result);
    }

    [Fact]
    public async Task The_audit_trail_filters_by_actor_action_result_and_time()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var samId = await AddUserAsync(harness, "sam", CoreRoles.Viewer);
        using var sam = await WithDeviceAsync(harness, samId, "sam");
        await harness.LoginAsync(password: "not the password at all");
        harness.Clock!.Advance(TimeSpan.FromMinutes(10));
        var since = harness.Clock.GetUtcNow().ToUnixTimeMilliseconds();
        await sam.SignInAsync();
        await using var hub = await ConnectAsync(harness);

        async Task<AuditEventInfo[]> QueryAsync(AuditQuery query) =>
            (await hub.InvokeAsync<AuditPage>(nameof(ICoreHub.QueryAudit), query, Cancel)).Events;

        var failed = await QueryAsync(new AuditQuery(Result: "failed"));
        var bySam = await QueryAsync(new AuditQuery(Actor: "sam"));
        var bySamId = await QueryAsync(new AuditQuery(Actor: samId.ToString("D")));
        var auth = await QueryAsync(new AuditQuery(Action: "auth."));
        var stepUps = await QueryAsync(new AuditQuery(Action: "auth.step-up"));
        var recent = await QueryAsync(new AuditQuery(FromUnixMs: since));
        var early = await QueryAsync(new AuditQuery(ToUnixMs: since - 1));
        var nobody = await QueryAsync(new AuditQuery(Actor: "nobody-here"));

        Assert.Equal(["auth.login"], failed.Select(e => e.Action));
        Assert.Equal("maria", failed.Single().Target);
        var samLogin = Assert.Single(bySam);
        Assert.Equal(("auth.login", "success", "sam", "sam's laptop"), (samLogin.Action, samLogin.Result, samLogin.ActorUserName, samLogin.DeviceName));
        Assert.Equal(bySam.Select(e => e.Id), bySamId.Select(e => e.Id));
        Assert.All(auth, e => Assert.StartsWith("auth.", e.Action, StringComparison.Ordinal));
        Assert.Equal(4, auth.Length);
        Assert.Equal(["auth.step-up"], stepUps.Select(e => e.Action));
        Assert.Equal("maria", stepUps.Single().ActorUserName);
        Assert.Equal(3, recent.Length);
        Assert.Equal(["auth.login"], early.Select(e => e.Action));
        Assert.Empty(nobody);
    }

    [Fact]
    public async Task An_audit_result_filter_has_to_be_a_known_result()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness, stepUp: false);

        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<AuditPage>(
            nameof(ICoreHub.QueryAudit), new AuditQuery(Result: "maybe"), Cancel));

        Assert.Contains("success, denied, failed or cancelled", refusal.Message, StringComparison.Ordinal);
    }
}
