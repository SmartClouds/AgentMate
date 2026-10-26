using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Metrics;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The account side of the hub: stepping up for sensitive changes, two-factor, devices, sessions,
/// enrollment codes for another device, and the audit trail. Roles decide who may do what: a Viewer
/// may read the server but can never change anything beyond their own account.
/// </summary>
public sealed class HubAccountTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return hub;
    }

    [Fact]
    public async Task The_account_says_who_is_signed_in_and_from_where()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        var account = await hub.InvokeAsync<AccountInfo>(nameof(ICoreHub.GetAccount), Cancel);

        Assert.Equal("maria", account.UserName);
        Assert.Equal(["owner"], account.Roles);
        Assert.Equal(harness.DeviceId, account.DeviceId);
        Assert.Null(account.StepUpUntilUnixMs);
    }

    [Fact]
    public async Task A_step_up_counts_at_once_on_the_open_connection()
    {
        await using var harness = await AuthHarness.CreateAsync(fakeClock: false);
        await using var hub = await ConnectAsync(harness);

        var before = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<TotpSetup>(nameof(ICoreHub.BeginTotpSetup), Cancel));
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var setup = await hub.InvokeAsync<TotpSetup>(nameof(ICoreHub.BeginTotpSetup), Cancel);

        Assert.Contains("unauthorized", before.Message, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith("otpauth://totp/Runova%3Amaria?secret=", setup.AuthenticatorUri, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_wrong_step_up_password_is_refused_and_counted()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);

        await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest("not the password at all"), Cancel));

        await using var scope = harness.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        Assert.Equal(1, await users.GetAccessFailedCountAsync((await users.FindByNameAsync("maria"))!));
    }

    [Fact]
    public async Task Two_factor_goes_on_with_a_confirmed_code_and_is_then_asked_for()
    {
        await using var harness = await AuthHarness.CreateAsync(fakeClock: false);
        await using var hub = await ConnectAsync(harness);
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var setup = await hub.InvokeAsync<TotpSetup>(nameof(ICoreHub.BeginTotpSetup), Cancel);
        var key = setup.SharedKey.Replace(" ", string.Empty, StringComparison.Ordinal);

        await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<RecoveryCodes>(nameof(ICoreHub.ConfirmTotp), "000000", Cancel));
        var recovery = await hub.InvokeAsync<RecoveryCodes>(nameof(ICoreHub.ConfirmTotp), AuthHarness.TotpCode(key), Cancel);
        var account = await hub.InvokeAsync<AccountInfo>(nameof(ICoreHub.GetAccount), Cancel);

        Assert.Equal(10, recovery.Codes.Length);
        Assert.True(account.TwoFactorEnabled);
        Assert.Equal(10, account.RecoveryCodesLeft);
        Assert.Equal(AuthErrorCode.TotpRequired, await AuthHarness.ErrorOf(await harness.LoginAsync()));
        // The code that confirmed the setup is spent; the next one the app shows signs in.
        Assert.True((await harness.LoginAsync(totpCode: harness.TotpCodeNow(key, stepsAway: 1))).IsSuccessStatusCode);
    }

    [Fact]
    public async Task Two_factor_can_be_set_up_over_a_new_connection_for_each_call_as_the_app_makes_them()
    {
        await using var harness = await AuthHarness.CreateAsync(fakeClock: false);
        var signedIn = await harness.SignInAsync();
        async Task<T> CallAsync<T>(string method, params object?[] arguments)
        {
            await using var hub = harness.Hub(signedIn.AccessToken);
            await hub.StartAsync(Cancel);
            return await hub.InvokeCoreAsync<T>(method, arguments, Cancel);
        }

        await CallAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password));
        var setup = await CallAsync<TotpSetup>(nameof(ICoreHub.BeginTotpSetup));
        var key = setup.SharedKey.Replace(" ", string.Empty, StringComparison.Ordinal);
        var recovery = await CallAsync<RecoveryCodes>(nameof(ICoreHub.ConfirmTotp), AuthHarness.TotpCode(key));
        var account = await CallAsync<AccountInfo>(nameof(ICoreHub.GetAccount));

        Assert.Equal(10, recovery.Codes.Length);
        Assert.True(account.TwoFactorEnabled);
        Assert.True((await harness.RenewAsync(signedIn.SessionId)).IsSuccessStatusCode);
    }

    [Fact]
    public async Task Turning_two_factor_on_or_off_ends_the_other_sessions_and_keeps_this_one()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var other = await harness.SignInAsync();
        await using var otherHub = harness.Hub(other.AccessToken);
        await otherHub.StartAsync(Cancel);
        var otherClosed = new TaskCompletionSource();
        otherHub.Closed += _ =>
        {
            otherClosed.TrySetResult();
            return Task.CompletedTask;
        };
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);

        var setup = await hub.InvokeAsync<TotpSetup>(nameof(ICoreHub.BeginTotpSetup), Cancel);
        // A new key is not in use until it is confirmed, so starting ends nothing.
        Assert.Equal(System.Net.HttpStatusCode.OK, (await harness.RenewAsync(other.SessionId)).StatusCode);
        var key = setup.SharedKey.Replace(" ", string.Empty, StringComparison.Ordinal);
        await hub.InvokeAsync<RecoveryCodes>(nameof(ICoreHub.ConfirmTotp), harness.TotpCodeNow(key), Cancel);

        await otherClosed.Task.WaitAsync(TimeSpan.FromSeconds(10), Cancel);
        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(await harness.RenewAsync(other.SessionId)));
        Assert.True((await harness.RenewAsync(signedIn.SessionId)).IsSuccessStatusCode);

        var third = await harness.SignInAsync(harness.TotpCodeNow(key, stepsAway: 1));
        // Both codes so far are spent; turning it off takes one the app shows a minute later.
        harness.Clock!.Advance(TimeSpan.FromMinutes(1));
        await hub.InvokeAsync(nameof(ICoreHub.DisableTotp), harness.TotpCodeNow(key), Cancel);

        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(await harness.RenewAsync(third.SessionId)));
        Assert.True((await harness.RenewAsync(signedIn.SessionId)).IsSuccessStatusCode);
        Assert.False((await hub.InvokeAsync<AccountInfo>(nameof(ICoreHub.GetAccount), Cancel)).TwoFactorEnabled);
    }

    [Fact]
    public async Task Signing_out_ends_the_session_and_closes_the_connection()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        var closed = new TaskCompletionSource();
        hub.Closed += _ =>
        {
            closed.TrySetResult();
            return Task.CompletedTask;
        };

        await hub.InvokeAsync(nameof(ICoreHub.SignOut), Cancel);
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10), Cancel);

        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(await harness.RenewAsync(signedIn.SessionId)));
    }

    [Fact]
    public async Task Revoking_this_device_ends_its_sessions_and_it_must_enroll_again()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);

        var devices = await hub.InvokeAsync<DeviceInfo[]>(nameof(ICoreHub.ListDevices), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.RevokeDevice), harness.DeviceId, Cancel);

        Assert.True(Assert.Single(devices).Current);
        Assert.Equal(AuthErrorCode.DeviceRevoked, await AuthHarness.ErrorOf(await harness.RenewAsync(signedIn.SessionId)));
        await using var again = harness.Hub(signedIn.AccessToken);
        await Assert.ThrowsAnyAsync<Exception>(() => again.StartAsync(Cancel));
    }

    [Fact]
    public async Task A_viewer_cannot_revoke_someone_elses_device()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        Guid otherDevice;
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
            var sam = new CoreUser { UserName = "sam" };
            Assert.True((await users.CreateAsync(sam, "another long passphrase")).Succeeded);
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var device = new Device { Id = Guid.NewGuid(), UserId = sam.Id, Name = "sam's", PublicKey = key.ExportSubjectPublicKeyInfo() };
            db.Devices.Add(device);
            await db.SaveChangesAsync(Cancel);
            otherDevice = device.Id;
        }

        await using var hub = await ConnectAsync(harness);

        await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.RevokeDevice), otherDevice, Cancel));
        Assert.Single(await hub.InvokeAsync<DeviceInfo[]>(nameof(ICoreHub.ListDevices), Cancel));
    }

    [Fact]
    public async Task An_enrollment_code_lets_another_device_in_once()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var code = await hub.InvokeAsync<EnrollmentCodeInfo>(
            nameof(ICoreHub.CreateEnrollmentCode),
            new CreateEnrollmentCodeRequest(),
            Cancel);
        using var newKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = Convert.ToBase64String(newKey.ExportSubjectPublicKeyInfo());

        var typo = await Enroll(harness, code.Code, "not the password at all", publicKey);
        var enrolled = await Enroll(harness, code.Code.ToLowerInvariant(), AuthHarness.Password, publicKey);
        var reused = await Enroll(harness, code.Code, AuthHarness.Password, publicKey);

        Assert.Equal(AuthErrorCode.InvalidCredentials, await AuthHarness.ErrorOf(typo));
        Assert.True(enrolled.IsSuccessStatusCode, await enrolled.Content.ReadAsStringAsync(Cancel));
        Assert.Equal(AuthErrorCode.EnrollmentCodeInvalid, await AuthHarness.ErrorOf(reused));
        var deviceId = (await enrolled.Content.ReadFromJsonAsync<EnrollResponse>(CoreJson.Options, Cancel))!.DeviceId;
        var challenge = await harness.ChallengeAsync(AuthPurpose.Login, deviceId: deviceId);
        var login = await harness.Client.PostAsJsonAsync(
            "/api/v1/auth/login",
            new LoginRequest(
                challenge.ChallengeId,
                deviceId,
                harness.Sign(challenge, AuthPurpose.Login, key: newKey, deviceId: deviceId),
                "maria",
                AuthHarness.Password),
            CoreJson.Options,
            Cancel);
        Assert.True(login.IsSuccessStatusCode, await login.Content.ReadAsStringAsync(Cancel));
    }

    [Fact]
    public async Task An_enrollment_code_expires()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await using var hub = await ConnectAsync(harness);
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var code = await hub.InvokeAsync<EnrollmentCodeInfo>(
            nameof(ICoreHub.CreateEnrollmentCode),
            new CreateEnrollmentCodeRequest(ValidMinutes: 5),
            Cancel);
        using var newKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        harness.Clock!.Advance(TimeSpan.FromMinutes(6));
        var late = await Enroll(harness, code.Code, AuthHarness.Password, Convert.ToBase64String(newKey.ExportSubjectPublicKeyInfo()));

        Assert.Equal(AuthErrorCode.EnrollmentCodeInvalid, await AuthHarness.ErrorOf(late));
    }

    [Fact]
    public async Task Admins_read_the_audit_trail_and_can_check_it()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await harness.LoginAsync(password: "not the password at all");
        await using var hub = await ConnectAsync(harness);

        var page = await hub.InvokeAsync<AuditPage>(nameof(ICoreHub.QueryAudit), new AuditQuery(Limit: 1), Cancel);
        var verification = await hub.InvokeAsync<AuditVerificationInfo>(nameof(ICoreHub.VerifyAudit), Cancel);

        var newest = Assert.Single(page.Events);
        Assert.Equal("auth.login", newest.Action);
        Assert.Equal("success", newest.Result);
        Assert.NotNull(page.NextBeforeId);
        Assert.True(verification.Intact);
        Assert.Equal(2, verification.Checked);
    }

    /// <summary>
    /// AC2: every hub method guarded by a policy above Viewer, found by reflection so that methods
    /// added in later epics are covered without touching this test, is refused to a Viewer.
    /// </summary>
    [Fact]
    public async Task A_viewer_is_refused_every_method_above_viewer()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);
        var guarded = typeof(CoreHub).GetInterfaceMap(typeof(ICoreHub)).TargetMethods
            .Where(method => method.GetCustomAttributes<AuthorizeAttribute>()
                .Any(attribute => CorePolicies.AboveViewer.Contains(attribute.Policy)))
            .ToList();

        Assert.NotEmpty(guarded);
        foreach (var method in guarded)
        {
            // The cancellation token is the server's own; a client stream parameter (the console's
            // input) gets an empty stream; a streaming method is called as a stream.
            var arguments = method.GetParameters()
                .Where(parameter => parameter.ParameterType != typeof(CancellationToken))
                .Select(parameter => IsStream(parameter.ParameterType)
                    ? EmptyStream(parameter.ParameterType.GetGenericArguments()[0])
                    : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null)
                .ToArray();
            var refusal = await Assert.ThrowsAsync<HubException>(async () =>
            {
                if (IsStream(method.ReturnType))
                {
                    await foreach (var _ in hub.StreamAsyncCore<object>(method.Name, arguments, Cancel))
                    {
                    }
                }
                else
                {
                    await hub.InvokeCoreAsync(method.Name, typeof(object), arguments, Cancel);
                }
            });
            Assert.Contains("unauthorized", refusal.Message, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static bool IsStream(Type type) => type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IAsyncEnumerable<>);

    private static object EmptyStream(Type item) =>
        typeof(HubAccountTests).GetMethod(nameof(Empty), BindingFlags.NonPublic | BindingFlags.Static)!.MakeGenericMethod(item).Invoke(null, null)!;

    private static async IAsyncEnumerable<T> Empty<T>()
    {
        await Task.CompletedTask;
        yield break;
    }

    /// <summary>
    /// What a Viewer may call, pinned: their own account, and reading the server (its firewall and
    /// exposure included). Any method added later without a policy above Viewer shows up here and
    /// has to be decided on.
    /// </summary>
    [Fact]
    public void Every_method_a_viewer_may_call_reads_or_is_account_self_service()
    {
        var open = typeof(CoreHub).GetInterfaceMap(typeof(ICoreHub)).TargetMethods
            .Where(method => !method.GetCustomAttributes<AuthorizeAttribute>()
                .Any(attribute => CorePolicies.AboveViewer.Contains(attribute.Policy)))
            .Select(method => method.Name)
            .ToHashSet(StringComparer.Ordinal);

        // RevokeOtherSessions (E15) ends only the caller's own sessions, like RevokeSession.
        string[] account =
        [
            "BeginTotpSetup", "ConfirmTotp", "DisableTotp", "GetAccount", "ListDevices", "ListSessions",
            "NewRecoveryCodes", "Ping", "RevokeDevice", "RevokeOtherSessions", "RevokeSession", "SignOut", "StepUp",
        ];
        string[] reads =
        [
            "GetJob", "GetMetricsHistory", "GetSystemInfo", "GetUpdates", "ListAlerts", "ListJobs",
            "ListServices", "StreamAlerts", "StreamJob", "StreamMetrics",
            "GetNginxStatus", "ListCertificates", "ListSites", "ListStreamProxies", "StreamSiteLog",
        ];
        string[] firewallReads = ["GetExposure", "GetFirewallPresets", "GetFirewallStatus", "ListFirewallChangeSets"];
        // Docker (E06): lists, inspect without environment values, stats, logs and events.
        string[] docker =
        [
            "GetDockerDiskUsage", "GetDockerStatus", "InspectContainer", "ListContainers", "ListImages", "ListNetworks",
            "ListVolumes", "StreamContainerLogs", "StreamContainerStats", "StreamDockerEvents",
        ];
        // Compose stacks (E07): the apps, their revisions and the uploaded files (never env values).
        string[] stacks = ["GetStack", "GetStackRevisionFiles", "ListStacks"];
        // Cloudflare (E14): the origin lock and which zones have a DNS token (never the tokens).
        string[] cloudflare = ["GetOriginLock", "ListDnsCredentials"];
        // Direct TLS (E16): how the listener stands and the pin of its certificate.
        string[] directTls = ["GetDirectTls"];
        // The layout migration's status: the health route says as much to anyone.
        string[] layout = ["MigrationStatus"];
        reads = [.. reads, .. docker, .. stacks, .. cloudflare, .. directTls, .. layout];
        Assert.Equal(account.Concat(reads).Concat(firewallReads).Order(StringComparer.Ordinal), open.Order(StringComparer.Ordinal));
    }

    /// <summary>
    /// AC2 for the server's methods: a Viewer calls every read it may (streams included) and nothing
    /// on the server changes: no job, no call to the platform that would change it, no acknowledged
    /// alert, and nothing new in the audit trail, which records every change.
    /// </summary>
    [Fact]
    public async Task A_viewer_calling_every_read_it_may_changes_nothing()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        var engine = harness.Services.GetRequiredService<JobEngine>();
        var finished = await engine.StartAsync(
            new JobRequest(JobKind.PackagesRefresh, "Check for updates", ["packages"]),
            (_, _) => Task.CompletedTask,
            Cancel);
        await engine.WhenFinishedAsync(finished.Id, Cancel);
        var alert = await harness.Services.GetRequiredService<AlertCenter>()
            .RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 91% full", Cancel);
        var sampler = harness.Services.GetRequiredService<MetricsSampler>();
        await sampler.SampleOnceAsync(Cancel);
        await Task.Delay(MetricsSampler.MinimumGap * 2, Cancel);
        await sampler.SampleOnceAsync(Cancel);
        await using var hub = await ConnectAsync(harness);
        var auditBefore = await AuditCountAsync(harness);
        var mutations = harness.Services.GetRequiredService<MutationLog>();

        await hub.InvokeAsync<SystemInfo>(nameof(ICoreHub.GetSystemInfo), Cancel);
        await hub.InvokeAsync<ServiceInfo[]>(nameof(ICoreHub.ListServices), Cancel);
        await hub.InvokeAsync<UpdatesInfo>(nameof(ICoreHub.GetUpdates), Cancel);
        await hub.InvokeAsync<JobPage>(nameof(ICoreHub.ListJobs), new JobQuery(), Cancel);
        await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.GetJob), finished.Id, Cancel);
        await hub.InvokeAsync<AlertInfo[]>(nameof(ICoreHub.ListAlerts), new AlertQuery(IncludeResolved: true), Cancel);
        await hub.InvokeAsync<MetricsHistory>(nameof(ICoreHub.GetMetricsHistory), new MetricsHistoryRequest(MetricsResolution.Live), Cancel);
        await FirstAsync(hub.StreamAsync<JobStreamItem>(nameof(ICoreHub.StreamJob), finished.Id, 0L, Cancel));
        await FirstAsync(hub.StreamAsync<AlertInfo>(nameof(ICoreHub.StreamAlerts), new AlertStreamRequest(), Cancel));
        await FirstAsync(hub.StreamAsync<MetricsSample>(nameof(ICoreHub.StreamMetrics), new MetricsStreamRequest(SinceUnixMs: 0), Cancel));
        await hub.InvokeAsync<FirewallStatus>(nameof(ICoreHub.GetFirewallStatus), Cancel);
        await hub.InvokeAsync<FirewallPreset[]>(nameof(ICoreHub.GetFirewallPresets), Cancel);
        await hub.InvokeAsync<FirewallChangeSetInfo[]>(nameof(ICoreHub.ListFirewallChangeSets), new FirewallChangeSetQuery(), Cancel);
        await hub.InvokeAsync<ExposureInventory>(nameof(ICoreHub.GetExposure), Cancel);
        await hub.InvokeAsync<DockerStatus>(nameof(ICoreHub.GetDockerStatus), Cancel);
        await hub.InvokeAsync<ContainerList>(nameof(ICoreHub.ListContainers), Cancel);
        await hub.InvokeAsync<ContainerDetails>(nameof(ICoreHub.InspectContainer), "shop-api-1", Cancel);
        await hub.InvokeAsync<ImageInfo[]>(nameof(ICoreHub.ListImages), Cancel);
        await hub.InvokeAsync<VolumeInfo[]>(nameof(ICoreHub.ListVolumes), Cancel);
        await hub.InvokeAsync<NetworkInfo[]>(nameof(ICoreHub.ListNetworks), Cancel);
        await hub.InvokeAsync<DockerDiskUsage>(nameof(ICoreHub.GetDockerDiskUsage), Cancel);
        await FirstAsync(hub.StreamAsync<ContainerLogBatch>(nameof(ICoreHub.StreamContainerLogs), new ContainerLogsRequest("shop-api-1", Tail: 5, Follow: false), Cancel));
        await FirstAsync(hub.StreamAsync<ContainerStatsBatch>(nameof(ICoreHub.StreamContainerStats), new ContainerStatsRequest(IntervalMs: 1_000), Cancel));
        await hub.InvokeAsync<NginxStatus>(nameof(ICoreHub.GetNginxStatus), Cancel);
        await hub.InvokeAsync<SiteInfo[]>(nameof(ICoreHub.ListSites), Cancel);
        await hub.InvokeAsync<StreamProxyInfo[]>(nameof(ICoreHub.ListStreamProxies), Cancel);
        await hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel);
        await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.GetOriginLock), Cancel);
        await hub.InvokeAsync<DnsCredentialInfo[]>(nameof(ICoreHub.ListDnsCredentials), Cancel);

        Assert.Empty(harness.Services.GetRequiredService<InMemoryDockerEngine>().Changes);
        Assert.Empty(mutations.Entries);
        Assert.Single((await engine.ListAsync(new JobQuery(), Cancel)).Jobs);
        Assert.Null((await harness.Services.GetRequiredService<AlertCenter>().ListAsync(new AlertQuery(), Cancel))
            .Single(a => a.Id == alert.Id).AcknowledgedAtUnixMs);
        Assert.Equal(auditBefore, await AuditCountAsync(harness));
    }

    private static async Task FirstAsync<T>(IAsyncEnumerable<T> stream)
    {
        await using var items = stream.GetAsyncEnumerator(Cancel);
        Assert.True(await items.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10), Cancel));
    }

    private static async Task<int> AuditCountAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents.CountAsync(Cancel);
    }

    private static Task<HttpResponseMessage> Enroll(AuthHarness harness, string code, string password, string publicKey) =>
        harness.Client.PostAsJsonAsync(
            "/api/v1/auth/enroll",
            new EnrollRequest(code, "maria", password, publicKey, "desk"),
            CoreJson.Options,
            Cancel);
}
