using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Hardening;

/// <summary>What changing sshd needs of the machine, so tests and the DevHost can stand in for it.</summary>
internal interface ISshMachine
{
    /// <summary>The unit that reloads sshd: ssh on the Debian family, sshd on the RHEL family.</summary>
    string ReloadUnit { get; }

    /// <summary>sshd's effective settings, with whether Runova's drop-in is there.</summary>
    Task<SshPolicyInfo> ReadAsync(CancellationToken cancellationToken);

    /// <summary>The drop-in's text, or null when there is none.</summary>
    string? ReadDropIn();

    void WriteDropIn(string content);

    void DeleteDropIn();

    /// <summary>`sshd -t`: null when the configuration is valid, sshd's complaint otherwise.</summary>
    Task<string?> TestAsync(CancellationToken cancellationToken);

    /// <summary>`systemctl reload &lt;unit&gt;`: running connections stay, new ones get the new settings.</summary>
    Task ReloadAsync(string unit, CancellationToken cancellationToken);
}

/// <summary>sshd on the server. The core runs as root, so it reads and writes /etc/ssh itself.</summary>
internal sealed class LinuxSshMachine(IProcessRunner runner, OsFamily family) : ISshMachine
{
    private const UnixFileMode ConfigMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private const UnixFileMode FolderMode = ConfigMode | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    public string ReloadUnit => family == OsFamily.Rhel ? "sshd" : "ssh";

    public async Task<SshPolicyInfo> ReadAsync(CancellationToken cancellationToken)
    {
        var managed = File.Exists(SshdPolicy.DropInPath);
        ProcessResult result;
        try
        {
            result = await Sshd(["-T"], cancellationToken);
        }
        catch (ProcessStartException missing)
        {
            return new SshPolicyInfo(null, null, null, null, managed, $"sshd could not be asked: {missing.Message}");
        }

        return result.Succeeded
            ? SshdPolicy.Parse(result.StandardOutput, managed)
            : new SshPolicyInfo(null, null, null, null, managed, $"sshd -T failed: {Complaint(result)}");
    }

    public string? ReadDropIn()
    {
        try
        {
            return File.ReadAllText(SshdPolicy.DropInPath);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    public void WriteDropIn(string content)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("sshd's settings are only changed on Linux.");
        }

        var folder = Path.GetDirectoryName(SshdPolicy.DropInPath)!;
        Directory.CreateDirectory(folder, FolderMode);
        var temporary = $"{SshdPolicy.DropInPath}.runova-{Guid.NewGuid():N}";
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = ConfigMode };
        using (var stream = new FileStream(temporary, options))
        using (var writer = new StreamWriter(stream))
        {
            writer.Write(content);
            writer.Flush();
            stream.Flush(flushToDisk: true);
        }

        File.Move(temporary, SshdPolicy.DropInPath, overwrite: true);
    }

    public void DeleteDropIn() => File.Delete(SshdPolicy.DropInPath);

    public async Task<string?> TestAsync(CancellationToken cancellationToken)
    {
        var result = await Sshd(["-t"], cancellationToken);
        return result.Succeeded ? null : Complaint(result);
    }

    public async Task ReloadAsync(string unit, CancellationToken cancellationToken)
    {
        if (unit is not ("ssh" or "sshd"))
        {
            throw new ArgumentException("sshd reloads through the ssh or sshd unit.", nameof(unit));
        }

        var result = await runner.RunAsync(
            new ProcessSpec { Program = "systemctl", Arguments = ["reload", unit], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        if (!result.Succeeded)
        {
            throw new ProcessFailedException($"systemctl reload {unit} failed: {Complaint(result)}");
        }
    }

    private Task<ProcessResult> Sshd(string[] arguments, CancellationToken cancellationToken) =>
        runner.RunAsync(
            new ProcessSpec { Program = "sshd", Arguments = arguments, Timeout = TimeSpan.FromSeconds(15), MaxOutputBytes = 256 * 1024 },
            onLine: null,
            cancellationToken);

    private static string Complaint(ProcessResult result)
    {
        var text = (result.StandardError.Trim().Length > 0 ? result.StandardError : result.StandardOutput).Trim();
        if (result.TimedOut)
        {
            return "no answer in time";
        }

        return text.Length == 0 ? $"exit code {result.ExitCode}" : text.Length > 500 ? text[..500] : text;
    }
}
