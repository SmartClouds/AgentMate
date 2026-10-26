using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Cli;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// A backup from the hub to the file the app saves, and back into a core with the admin command the
/// installer runs: Owners only, after a step-up; downloaded over REST and then deleted; restorable
/// only with its passphrase; and the restored state still opens what the old core sealed. The
/// passphrase appears nowhere: not in the audit trail, not in an answer.
/// </summary>
public sealed class HubBackupTests : IDisposable
{
    private const string Passphrase = "orange tractor bicycle lamp";

    private readonly string _newServer = Path.Combine(Path.GetTempPath(), $"core-restore-{Guid.NewGuid():N}");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public void Dispose() => TestFolders.Delete(_newServer);

    private static async Task<(HubConnection Hub, string Token)> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return (hub, signedIn.AccessToken);
    }

    private static async Task<HttpResponseMessage> DownloadAsync(AuthHarness harness, string token, Guid id)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/backups/{id:D}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return await harness.Client.SendAsync(request, Cancel);
    }

    private async Task<(int Code, string Output, string Error)> RestoreAsync(string file, string into, string passphrase)
    {
        using var input = new StringReader(passphrase + "\n");
        using var output = new StringWriter();
        using var error = new StringWriter();
        var code = await AdminCli.RunAsync(
            ["restore-stage", "--file", file, "--into", into, "--passphrase-stdin"],
            input,
            output,
            error,
            () => new AdminEnvironment(_newServer, TimeProvider.System, 1000, "deployer"));
        return (code, output.ToString(), error.ToString());
    }

    [Fact]
    public async Task Below_owner_or_without_a_step_up_there_is_no_backup()
    {
        await using var admin = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (adminHub, _) = await ConnectAsync(admin);
        await using (adminHub)
        {
            await adminHub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
            var refused = await Assert.ThrowsAsync<HubException>(() =>
                adminHub.InvokeAsync<BackupInfo>(nameof(ICoreHub.CreateBackup), new BackupRequest(Passphrase), Cancel));
            Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        }

        await using var owner = await AuthHarness.CreateAsync(CoreRoles.Owner);
        var (ownerHub, _) = await ConnectAsync(owner);
        await using (ownerHub)
        {
            var noStepUp = await Assert.ThrowsAsync<HubException>(() =>
                ownerHub.InvokeAsync<BackupInfo>(nameof(ICoreHub.CreateBackup), new BackupRequest(Passphrase), Cancel));
            await ownerHub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
            var weak = await Assert.ThrowsAsync<HubException>(() =>
                ownerHub.InvokeAsync<BackupInfo>(nameof(ICoreHub.CreateBackup), new BackupRequest("short"), Cancel));

            Assert.Contains("unauthorized", noStepUp.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("at least 12 characters", weak.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_backup_downloads_once_and_restores_with_its_passphrase_only()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        var sealedSecret = harness.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("test").Protect("registry password");
        var (hub, token) = await ConnectAsync(harness);
        await using var _ = hub;
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);

        var backup = await hub.InvokeAsync<BackupInfo>(nameof(ICoreHub.CreateBackup), new BackupRequest(Passphrase), Cancel);
        using var download = await DownloadAsync(harness, token, backup.Id);
        var bytes = await download.Content.ReadAsByteArrayAsync(Cancel);
        var deleted = await hub.InvokeAsync<bool>(nameof(ICoreHub.DeleteBackup), backup.Id, Cancel);
        using var again = await DownloadAsync(harness, token, backup.Id);

        Assert.Equal(HttpStatusCode.OK, download.StatusCode);
        Assert.Equal(backup.SizeBytes, bytes.Length);
        Assert.Equal(backup.Sha256, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)));
        Assert.True(bytes.AsSpan(0, 8).SequenceEqual("AMBACKUP"u8));
        Assert.Equal(1, backup.Contents.Users);
        Assert.Equal(1, backup.Contents.Devices);
        Assert.EndsWith(".rnbackup", backup.FileName, StringComparison.Ordinal);
        Assert.True(deleted);
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);

        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var events = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents.ToListAsync(Cancel);
            Assert.Contains(events, e => e.Action == "backup.create" && e.Result == "success");
            Assert.Contains(events, e => e.Action == "backup.download" && e.Result == "success");
            Assert.DoesNotContain(events, e => (e.Parameters ?? string.Empty).Contains("tractor", StringComparison.Ordinal));
        }

        // The new server: the file goes there, and only its passphrase opens it.
        Directory.CreateDirectory(_newServer);
        var file = Path.Combine(_newServer, "upload.ambackup");
        await File.WriteAllBytesAsync(file, bytes, Cancel);
        var into = Path.Combine(_newServer, "stage");

        var wrong = await RestoreAsync(file, into, "lemon tractor bicycle lamp");
        Assert.Equal(1, wrong.Code);
        Assert.Contains("passphrase is wrong", wrong.Error, StringComparison.Ordinal);
        Assert.False(Directory.Exists(into));

        var (code, output, error) = await RestoreAsync(file, into, Passphrase);
        Assert.True(code == 0, error);
        using (var summary = JsonDocument.Parse(output))
        {
            Assert.Equal(["maria"], summary.RootElement.GetProperty("owners").EnumerateArray().Select(owner => owner.GetString()));
        }

        // The restored state works: the account and its password, sessions ended, devices kept,
        // what the old core sealed opens with the keys that came along, and the trail is intact.
        await using var restored = AdminCli.BuildServices(new AdminEnvironment(into, TimeProvider.System, null, null));
        await using var restoredScope = restored.CreateAsyncScope();
        var users = restoredScope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        var maria = await users.FindByNameAsync("maria");
        var db = restoredScope.ServiceProvider.GetRequiredService<CoreDbContext>();
        Assert.NotNull(maria);
        Assert.True(await users.CheckPasswordAsync(maria, AuthHarness.Password));
        Assert.Equal(1, await db.Devices.CountAsync(Cancel));
        Assert.All(await db.DeviceSessions.ToListAsync(Cancel), session => Assert.NotNull(session.RevokedAt));
        Assert.Equal("registry password", restored.GetRequiredService<IDataProtectionProvider>().CreateProtector("test").Unprotect(sealedSecret));
        Assert.Contains(await db.AuditEvents.Select(e => e.Action).ToListAsync(Cancel), action => action == "admin.restore");
        Assert.True((await restoredScope.ServiceProvider.GetRequiredService<Audit.AuditLog>().VerifyAsync(Cancel)).Intact);
    }

    [Fact]
    public async Task Restore_refuses_relative_paths_and_a_folder_that_exists()
    {
        Directory.CreateDirectory(_newServer);
        var exists = Path.Combine(_newServer, "exists");
        Directory.CreateDirectory(exists);

        var relative = await RestoreAsync("backup.ambackup", Path.Combine(_newServer, "stage"), Passphrase);
        var taken = await RestoreAsync(Path.Combine(_newServer, "backup.ambackup"), exists, Passphrase);

        Assert.Equal(2, relative.Code);
        Assert.Equal(1, taken.Code);
        Assert.Contains("already exists", taken.Error, StringComparison.Ordinal);
    }
}
