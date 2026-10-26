using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Cli;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The admin commands the installer runs over SSH as root: create the owner, enroll this device,
/// and the break-glass commands for when the app cannot sign in. Secrets (the owner's password,
/// the device's public key) only ever arrive on stdin, never as arguments, and every command
/// lands in the audit trail.
/// </summary>
public sealed class AdminCliTests : IDisposable
{
    private const string Password = "correct horse battery staple";

    private readonly string _data = Path.Combine(Path.GetTempPath(), $"core-admin-{Guid.NewGuid():N}");

    private AdminEnvironment Environment => new(_data, TimeProvider.System, SudoUid: 1000, SudoUser: "deployer");

    private async Task<(int Code, string Output, string Error)> Run(string stdin, params string[] command)
    {
        using var input = new StringReader(stdin);
        using var output = new StringWriter();
        using var error = new StringWriter();
        var code = await AdminCli.RunAsync(command, input, output, error, () => Environment);
        return (code, output.ToString(), error.ToString());
    }

    private static string NewPublicKey(ECCurve? curve = null)
    {
        using var key = ECDsa.Create(curve ?? ECCurve.NamedCurves.nistP256);
        return Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());
    }

    private async Task<T> WithServices<T>(Func<IServiceProvider, Task<T>> work)
    {
        await using var services = AdminCli.BuildServices(Environment);
        await using var scope = services.CreateAsyncScope();
        return await work(scope.ServiceProvider);
    }

    [Fact]
    public async Task Status_on_a_fresh_core_says_nobody_owns_it_yet()
    {
        var (code, output, _) = await Run("", "status");

        Assert.Equal(0, code);
        using var json = JsonDocument.Parse(output);
        Assert.False(json.RootElement.GetProperty("initialized").GetBoolean());
        Assert.Equal(0, json.RootElement.GetProperty("users").GetArrayLength());
    }

    [Fact]
    public async Task Create_owner_takes_the_password_from_stdin_and_makes_an_owner()
    {
        var (code, output, error) = await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");

        Assert.True(code == 0, error);
        using var created = JsonDocument.Parse(output);
        Assert.True(Guid.TryParse(created.RootElement.GetProperty("userId").GetString(), out _));

        var (_, statusOutput, _) = await Run("", "status");
        using var status = JsonDocument.Parse(statusOutput);
        Assert.True(status.RootElement.GetProperty("initialized").GetBoolean());
        var user = status.RootElement.GetProperty("users")[0];
        Assert.Equal("maria", user.GetProperty("userName").GetString());
        Assert.Equal("owner", user.GetProperty("roles")[0].GetString());

        Assert.True(await WithServices(async services =>
        {
            var users = services.GetRequiredService<UserManager<CoreUser>>();
            var maria = await users.FindByNameAsync("maria");
            return maria is not null && await users.CheckPasswordAsync(maria, Password);
        }));
    }

    [Fact]
    public async Task There_is_only_ever_one_owner_made_this_way()
    {
        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");

        var (code, _, error) = await Run($"{Password}\n", "create-owner", "--username", "sam", "--password-stdin");

        Assert.Equal(1, code);
        Assert.Contains("already has an owner", error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("short pw", "at least 12")]
    [InlineData("qwertyuiop123", "too common")]
    [InlineData("QwertyUiop123", "too common")]
    [InlineData("maria-is-the-best", "user name")]
    public async Task Weak_passwords_are_refused_with_the_reason(string password, string reason)
    {
        var (code, _, error) = await Run($"{password}\n", "create-owner", "--username", "maria", "--password-stdin");

        Assert.Equal(1, code);
        Assert.Contains(reason, error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_password_is_never_accepted_as_an_argument()
    {
        var (code, _, error) = await Run("", "create-owner", "--username", "maria", "--password", Password);

        Assert.Equal(2, code);
        Assert.Contains("Usage", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Enroll_device_takes_a_P256_public_key_from_stdin()
    {
        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");
        var publicKey = NewPublicKey();

        var (code, output, error) = await Run($"{publicKey}\n", "enroll-device", "--user", "maria", "--name", "Maria's laptop");

        Assert.True(code == 0, error);
        using var json = JsonDocument.Parse(output);
        var deviceId = Guid.Parse(json.RootElement.GetProperty("deviceId").GetString()!);
        var stored = await WithServices(async services =>
            await services.GetRequiredService<CoreDbContext>().Devices.SingleAsync(d => d.Id == deviceId));
        Assert.Equal("Maria's laptop", stored.Name);
        Assert.Equal(Convert.FromBase64String(publicKey), stored.PublicKey);
        Assert.Null(stored.RevokedAt);
    }

    [Fact]
    public async Task Enroll_device_refuses_any_key_but_P256()
    {
        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");
        using var rsa = RSA.Create(2048);

        foreach (var key in new[]
        {
            NewPublicKey(ECCurve.NamedCurves.nistP384),
            Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo()),
            "not base64 at all",
        })
        {
            var (code, _, error) = await Run($"{key}\n", "enroll-device", "--user", "maria", "--name", "laptop");

            Assert.Equal(1, code);
            Assert.Contains("P-256", error, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Enroll_device_needs_a_user_that_exists()
    {
        var (code, _, error) = await Run($"{NewPublicKey()}\n", "enroll-device", "--user", "nobody", "--name", "laptop");

        Assert.Equal(1, code);
        Assert.Contains("nobody", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Revoke_all_ends_every_device_and_session()
    {
        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");
        await Run($"{NewPublicKey()}\n", "enroll-device", "--user", "maria", "--name", "one");
        await Run($"{NewPublicKey()}\n", "enroll-device", "--user", "maria", "--name", "two");
        await WithServices(async services =>
        {
            var db = services.GetRequiredService<CoreDbContext>();
            var device = await db.Devices.FirstAsync();
            db.DeviceSessions.Add(new DeviceSession
            {
                Id = Guid.NewGuid(),
                DeviceId = device.Id,
                UserId = device.UserId,
                SecurityStamp = "stamp",
                ExpiresAt = long.MaxValue,
            });
            return await db.SaveChangesAsync();
        });

        var (code, output, _) = await Run("", "revoke-all");

        Assert.Equal(0, code);
        using var json = JsonDocument.Parse(output);
        Assert.Equal(2, json.RootElement.GetProperty("devices").GetInt32());
        Assert.Equal(1, json.RootElement.GetProperty("sessions").GetInt32());
        Assert.True(await WithServices(async services =>
        {
            var db = services.GetRequiredService<CoreDbContext>();
            return await db.Devices.AllAsync(d => d.RevokedAt != null)
                && await db.DeviceSessions.AllAsync(s => s.RevokedAt != null);
        }));
    }

    [Fact]
    public async Task Reset_password_changes_it_and_signs_everyone_out()
    {
        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");
        var stampBefore = await WithServices(async services =>
            (await services.GetRequiredService<UserManager<CoreUser>>().FindByNameAsync("maria"))!.SecurityStamp);

        var (code, _, error) = await Run("a much newer passphrase\n", "reset-password", "--user", "maria", "--password-stdin");

        Assert.True(code == 0, error);
        Assert.True(await WithServices(async services =>
        {
            var users = services.GetRequiredService<UserManager<CoreUser>>();
            var maria = (await users.FindByNameAsync("maria"))!;
            return await users.CheckPasswordAsync(maria, "a much newer passphrase")
                && !await users.CheckPasswordAsync(maria, Password)
                && maria.SecurityStamp != stampBefore
                && !await users.IsLockedOutAsync(maria);
        }));
    }

    [Fact]
    public async Task Every_admin_command_lands_in_the_audit_trail()
    {
        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");
        await Run($"{NewPublicKey()}\n", "enroll-device", "--user", "maria", "--name", "laptop");
        await Run("", "revoke-all");

        var (events, verification) = await WithServices(async services =>
        {
            var db = services.GetRequiredService<CoreDbContext>();
            var stored = await db.AuditEvents.OrderBy(e => e.Id).ToListAsync();
            return (stored, await services.GetRequiredService<AuditLog>().VerifyAsync());
        });

        Assert.Equal(["admin.create-owner", "admin.enroll-device", "admin.revoke-all"], events.Select(e => e.Action));
        Assert.All(events, e => Assert.Equal(1000, e.PeerUid));
        Assert.All(events, e => Assert.Contains("deployer", e.Parameters ?? "", StringComparison.Ordinal));
        Assert.DoesNotContain(events, e => (e.Parameters ?? "").Contains(Password, StringComparison.Ordinal));
        Assert.True(verification.Intact);
    }

    [Fact]
    public async Task The_database_stays_private_after_an_admin_command()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes");
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        await Run($"{Password}\n", "create-owner", "--username", "maria", "--password-stdin");

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(CoreDatabase.PathIn(_data)));
    }

    public void Dispose()
    {
        TestFolders.Delete(_data);
    }
}
