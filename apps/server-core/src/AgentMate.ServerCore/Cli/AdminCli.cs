using System.Runtime.InteropServices;
using System.Text.Json;
using AgentMate.ServerCore.Audit;
using AgentMate.ServerCore.Backups;
using AgentMate.ServerCore.Data;
using AgentMate.ServerCore.Hosting;
using AgentMate.ServerCore.Security;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace AgentMate.ServerCore.Cli;

/// <summary>Where an admin command finds the core's state, and who ran it.</summary>
internal sealed record AdminEnvironment(string DataDirectory, TimeProvider Time, int? SudoUid, string? SudoUser)
{
    /// <summary>The installed core's settings, and sudo's record of who asked.</summary>
    public static AdminEnvironment FromSystem()
    {
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(CoreApplication.ConfigFile, optional: true, reloadOnChange: false)
            .Build();
        return new AdminEnvironment(
            CorePaths.DataDirectory(configuration, OperatingSystem.IsLinux()),
            TimeProvider.System,
            int.TryParse(Environment.GetEnvironmentVariable("SUDO_UID"), out var uid) ? uid : null,
            Environment.GetEnvironmentVariable("SUDO_USER"));
    }
}

/// <summary>
/// Commands the desktop runs over SSH as root. They print JSON on success so the installer can
/// read them, and never start the web host. Secrets only ever come in on stdin: a command line
/// shows up in `ps` and in shell history on the server.
/// </summary>
internal static class AdminCli
{
    private const string Usage = """
        Usage: agentmate-core admin <command>

        Commands:
          version                                           Version, API version, runtime and architecture.
          status                                            Whether an owner exists, and the users.
          create-owner --username <name> --password-stdin   The first user. The password is read from stdin.
          enroll-device --user <name> --name <device>       A device for a user. Its P-256 public key
                                                            (SubjectPublicKeyInfo, base64) is read from stdin.
          revoke-all                                        Revokes every device and session.
          reset-password --user <name> --password-stdin     A new password from stdin; signs the user out everywhere.
          restore-stage --file <backup> --into <folder> --passphrase-stdin
                                                            Decrypts and checks a backup into a new folder,
                                                            ready to take the state folder's place.
        """;

    private enum Exit
    {
        Done = 0,
        Refused = 1,
        Usage = 2,
    }

    public static Task<int> RunAsync(string[] command, TextWriter output, TextWriter error) =>
        RunAsync(command, Console.In, output, error, AdminEnvironment.FromSystem);

    public static async Task<int> RunAsync(
        string[] command,
        TextReader input,
        TextWriter output,
        TextWriter error,
        Func<AdminEnvironment> environment)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(error);
        ArgumentNullException.ThrowIfNull(environment);

        if (command is ["version"])
        {
            await output.WriteLineAsync(JsonSerializer.Serialize(CurrentVersion(), CoreJson.Options));
            return (int)Exit.Done;
        }

        var parsed = Parse(command);
        if (parsed is null)
        {
            await error.WriteLineAsync(Usage);
            return (int)Exit.Usage;
        }

        var env = environment();
        var path = CoreDatabase.PathIn(env.DataDirectory);
        await CoreDatabase.PrepareAsync(path, CancellationToken.None);
        try
        {
            await using var services = BuildServices(env);
            await using var scope = services.CreateAsyncScope();
            await CoreServices.EnsureRolesAsync(scope.ServiceProvider.GetRequiredService<RoleManager<CoreRole>>());
            var context = new Context(scope.ServiceProvider, env, input, output, error);
            var exit = parsed.Value.Name switch
            {
                "status" => await StatusAsync(context),
                "create-owner" => await CreateOwnerAsync(context, parsed.Value.Options["--username"]),
                "enroll-device" => await EnrollDeviceAsync(
                    context,
                    parsed.Value.Options["--user"],
                    parsed.Value.Options["--name"]),
                "revoke-all" => await RevokeAllAsync(context),
                "reset-password" => await ResetPasswordAsync(context, parsed.Value.Options["--user"]),
                "restore-stage" => await RestoreStageAsync(context, parsed.Value.Options["--file"], parsed.Value.Options["--into"]),
                _ => Exit.Usage,
            };
            return (int)exit;
        }
        finally
        {
            CoreDatabase.ReleasePool(path);
            CoreDatabase.RestrictFiles(path);
        }
    }

    /// <summary>The same services the web host uses, over the same state folder.</summary>
    public static ServiceProvider BuildServices(AdminEnvironment environment)
    {
        ArgumentNullException.ThrowIfNull(environment);
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(environment.Time);
        services.AddCoreData(_ => environment.DataDirectory);
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
    }

    private sealed record Context(
        IServiceProvider Services,
        AdminEnvironment Environment,
        TextReader Input,
        TextWriter Output,
        TextWriter Error)
    {
        public UserManager<CoreUser> Users => Services.GetRequiredService<UserManager<CoreUser>>();

        public CoreDbContext Db => Services.GetRequiredService<CoreDbContext>();

        public long Now => Environment.Time.GetUtcNow().ToUnixTimeMilliseconds();

        public async Task AuditAsync(string action, string result, string? target, Dictionary<string, string?>? details = null)
        {
            var parameters = new Dictionary<string, string?>(details ?? [])
            {
                ["via"] = "admin-cli",
                ["sudoUser"] = Environment.SudoUser,
            };
            await Services.GetRequiredService<AuditLog>().AppendAsync(
                new AuditEntry(action, result, PeerUid: Environment.SudoUid, Target: target, Parameters: parameters));
        }

        public Task WriteAsync(object value) => Output.WriteLineAsync(JsonSerializer.Serialize(value, CoreJson.Options));
    }

    private static readonly Dictionary<string, (string[] Values, string[] Flags)> _commands = new(StringComparer.Ordinal)
    {
        ["status"] = ([], []),
        ["create-owner"] = (["--username"], ["--password-stdin"]),
        ["enroll-device"] = (["--user", "--name"], []),
        ["revoke-all"] = ([], []),
        ["reset-password"] = (["--user"], ["--password-stdin"]),
        ["restore-stage"] = (["--file", "--into"], ["--passphrase-stdin"]),
    };

    /// <summary>Every listed option exactly once, nothing else.</summary>
    private static (string Name, Dictionary<string, string> Options)? Parse(string[] command)
    {
        if (command.Length == 0 || !_commands.TryGetValue(command[0], out var shape))
        {
            return null;
        }

        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 1; i < command.Length; i++)
        {
            var option = command[i];
            if (shape.Values.Contains(option) && i + 1 < command.Length && !options.ContainsKey(option))
            {
                options[option] = command[++i];
            }
            else if (shape.Flags.Contains(option) && !options.ContainsKey(option))
            {
                options[option] = "true";
            }
            else
            {
                return null;
            }
        }

        return shape.Values.Concat(shape.Flags).All(options.ContainsKey) ? (command[0], options) : null;
    }

    private static async Task<Exit> StatusAsync(Context context)
    {
        var users = await context.Users.Users.OrderBy(u => u.UserName).ToListAsync();
        var summaries = new List<object>();
        var ownerExists = false;
        foreach (var user in users)
        {
            var roles = await context.Users.GetRolesAsync(user);
            ownerExists |= roles.Contains(CoreRoles.Owner);
            var devices = await context.Db.Devices.CountAsync(d => d.UserId == user.Id && d.RevokedAt == null);
            summaries.Add(new { user.UserName, Roles = roles.Order(StringComparer.Ordinal).ToArray(), Devices = devices });
        }

        await context.WriteAsync(new { Initialized = ownerExists, Users = summaries });
        return Exit.Done;
    }

    private static async Task<Exit> CreateOwnerAsync(Context context, string userName)
    {
        if ((await context.Users.GetUsersInRoleAsync(CoreRoles.Owner)).Count > 0)
        {
            await context.Error.WriteLineAsync("This core already has an owner. Sign in as them to add more people.");
            return Exit.Refused;
        }

        var password = await ReadSecretLineAsync(context);
        if (password is null)
        {
            return Exit.Refused;
        }

        var user = new CoreUser { UserName = userName, CreatedAt = context.Now };
        var created = await context.Users.CreateAsync(user, password);
        if (!created.Succeeded)
        {
            await ReportAsync(context, created);
            await context.AuditAsync("admin.create-owner", AuditResult.Failed, userName);
            return Exit.Refused;
        }

        var promoted = await context.Users.AddToRoleAsync(user, CoreRoles.Owner);
        if (!promoted.Succeeded)
        {
            await context.Users.DeleteAsync(user);
            await ReportAsync(context, promoted);
            return Exit.Refused;
        }

        await context.AuditAsync("admin.create-owner", AuditResult.Success, userName);
        await context.WriteAsync(new { UserId = user.Id });
        return Exit.Done;
    }

    private static async Task<Exit> EnrollDeviceAsync(Context context, string userName, string deviceName)
    {
        var user = await context.Users.FindByNameAsync(userName);
        if (user is null)
        {
            await context.Error.WriteLineAsync($"There is no user called {userName} on this core.");
            return Exit.Refused;
        }

        var name = deviceName.Trim();
        if (name.Length is 0 or > 100)
        {
            await context.Error.WriteLineAsync("A device name has 1 to 100 characters.");
            return Exit.Refused;
        }

        var publicKey = DeviceKeys.ParsePublicKey(await context.Input.ReadLineAsync());
        if (publicKey is null)
        {
            await context.Error.WriteLineAsync("stdin must hold a P-256 public key (SubjectPublicKeyInfo, base64).");
            return Exit.Refused;
        }

        var device = new Device
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = name,
            PublicKey = publicKey,
            CreatedAt = context.Now,
        };
        context.Db.Devices.Add(device);
        await context.Db.SaveChangesAsync();
        await context.AuditAsync(
            "admin.enroll-device",
            AuditResult.Success,
            userName,
            new Dictionary<string, string?> { ["deviceId"] = device.Id.ToString("D"), ["deviceName"] = name });
        await context.WriteAsync(new { DeviceId = device.Id });
        return Exit.Done;
    }

    private static async Task<Exit> RevokeAllAsync(Context context)
    {
        var now = context.Now;
        var devices = await context.Db.Devices
            .Where(d => d.RevokedAt == null)
            .ExecuteUpdateAsync(update => update.SetProperty(d => d.RevokedAt, now));
        var sessions = await context.Db.DeviceSessions
            .Where(s => s.RevokedAt == null)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.RevokedAt, now));
        await context.AuditAsync(
            "admin.revoke-all",
            AuditResult.Success,
            target: null,
            new Dictionary<string, string?>
            {
                ["devices"] = devices.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["sessions"] = sessions.ToString(System.Globalization.CultureInfo.InvariantCulture),
            });
        await context.WriteAsync(new { Devices = devices, Sessions = sessions });
        return Exit.Done;
    }

    private static async Task<Exit> ResetPasswordAsync(Context context, string userName)
    {
        var user = await context.Users.FindByNameAsync(userName);
        if (user is null)
        {
            await context.Error.WriteLineAsync($"There is no user called {userName} on this core.");
            return Exit.Refused;
        }

        var password = await ReadSecretLineAsync(context);
        if (password is null)
        {
            return Exit.Refused;
        }

        // Resetting changes the security stamp, which ends every session signed in before it.
        var token = await context.Users.GeneratePasswordResetTokenAsync(user);
        var reset = await context.Users.ResetPasswordAsync(user, token, password);
        if (!reset.Succeeded)
        {
            await ReportAsync(context, reset);
            await context.AuditAsync("admin.reset-password", AuditResult.Failed, userName);
            return Exit.Refused;
        }

        await context.Users.SetLockoutEndDateAsync(user, null);
        await context.Users.ResetAccessFailedCountAsync(user);
        var now = context.Now;
        await context.Db.DeviceSessions
            .Where(s => s.UserId == user.Id && s.RevokedAt == null)
            .ExecuteUpdateAsync(update => update.SetProperty(s => s.RevokedAt, now));
        await context.AuditAsync("admin.reset-password", AuditResult.Success, userName);
        await context.WriteAsync(new { UserId = user.Id });
        return Exit.Done;
    }

    /// <summary>
    /// Decrypts the backup to a scratch file beside the target folder, then unpacks and checks it
    /// into the folder; nothing outside those two is touched, so the running core carries on. The
    /// installer stops the core and swaps the folders afterwards.
    /// </summary>
    private static async Task<Exit> RestoreStageAsync(Context context, string file, string into)
    {
        if (!Path.IsPathFullyQualified(file) || !Path.IsPathFullyQualified(into))
        {
            await context.Error.WriteLineAsync("--file and --into take absolute paths.");
            return Exit.Usage;
        }

        if (Directory.Exists(into) || File.Exists(into))
        {
            await context.Error.WriteLineAsync($"{into} already exists. A backup only unpacks into a new folder.");
            return Exit.Refused;
        }

        var pending = await RestoreGuard.PendingAsync(context.Environment.DataDirectory, context.Db, CancellationToken.None);
        if (pending.Count > 0)
        {
            var refusal = RestoreGuard.Refusal(pending);
            await context.Error.WriteLineAsync(refusal);
            await context.AuditAsync("admin.restore-stage", AuditResult.Denied, null, new Dictionary<string, string?> { ["reason"] = refusal });
            return Exit.Refused;
        }

        var passphrase = await context.Input.ReadLineAsync();
        if (string.IsNullOrEmpty(passphrase))
        {
            await context.Error.WriteLineAsync("The passphrase must come on stdin, followed by a newline.");
            return Exit.Refused;
        }

        var payload = into + ".payload";
        try
        {
            await using (var input = File.OpenRead(file))
            await using (var output = PrivateFile(payload))
            {
                await BackupCrypto.DecryptAsync(input, output, passphrase, CancellationToken.None);
            }

            BackupManifest manifest;
            await using (var staged = File.OpenRead(payload))
            {
                var free = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(into))!).AvailableFreeSpace;
                manifest = await BackupArchive.StageAsync(
                    staged,
                    into,
                    [.. context.Db.Database.GetMigrations()],
                    context.Now,
                    CancellationToken.None,
                    BackupArchive.RestoreLimitsFor(staged.Length, free));
            }

            var owners = await BackupArchive.OwnersAsync(into, CancellationToken.None);
            await RecordRestoreAsync(context.Environment with { DataDirectory = into }, manifest);
            await context.AuditAsync("admin.restore-stage", AuditResult.Success, manifest.HostName, new Dictionary<string, string?>
            {
                ["coreVersion"] = manifest.CoreVersion,
                ["createdAtUnixMs"] = manifest.CreatedAtUnixMs.ToString(System.Globalization.CultureInfo.InvariantCulture),
            });
            await context.WriteAsync(new { manifest.CoreVersion, manifest.CreatedAtUnixMs, manifest.HostName, manifest.Contents, Owners = owners });
            return Exit.Done;
        }
        catch (Exception error) when (error is BackupRefusedException or IOException or UnauthorizedAccessException)
        {
            await context.Error.WriteLineAsync(error is BackupRefusedException ? error.Message : $"The backup could not be read: {error.Message}");
            await context.AuditAsync("admin.restore-stage", AuditResult.Failed, null, new Dictionary<string, string?> { ["reason"] = error.Message });
            return Exit.Refused;
        }
        finally
        {
            BackupArchive.TryDelete(payload);
        }
    }

    /// <summary>The restored core's own trail starts its new life with the restore.</summary>
    private static async Task RecordRestoreAsync(AdminEnvironment staged, BackupManifest manifest)
    {
        await using (var services = BuildServices(staged))
        {
            await services.GetRequiredService<AuditLog>().AppendAsync(new AuditEntry(
                "admin.restore",
                AuditResult.Success,
                PeerUid: staged.SudoUid,
                Target: manifest.HostName,
                Parameters: new Dictionary<string, string?>
                {
                    ["via"] = "admin-cli",
                    ["sudoUser"] = staged.SudoUser,
                    ["backupCoreVersion"] = manifest.CoreVersion,
                    ["backupCreatedAtUnixMs"] = manifest.CreatedAtUnixMs.ToString(System.Globalization.CultureInfo.InvariantCulture),
                }));
        }

        CoreDatabase.ReleasePool(CoreDatabase.PathIn(staged.DataDirectory));
        BackupArchive.Restrict(staged.DataDirectory);
    }

    private static FileStream PrivateFile(string path)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.ReadWrite, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return new FileStream(path, options);
    }

    private static async Task<string?> ReadSecretLineAsync(Context context)
    {
        var line = await context.Input.ReadLineAsync();
        if (string.IsNullOrEmpty(line))
        {
            await context.Error.WriteLineAsync("The password must come on stdin, followed by a newline.");
            return null;
        }

        return line;
    }

    private static async Task ReportAsync(Context context, IdentityResult result)
    {
        foreach (var failure in result.Errors)
        {
            await context.Error.WriteLineAsync(failure.Description);
        }
    }

    private static VersionInfo CurrentVersion() => new(
        CoreVersion.Current,
        CoreVersion.ApiVersion,
        RuntimeInformation.FrameworkDescription,
        RuntimeInformation.OSDescription,
        RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant());

    private sealed record VersionInfo(
        string Version,
        int ApiVersion,
        string Runtime,
        string Os,
        string Architecture);
}
