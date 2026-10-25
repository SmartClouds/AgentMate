using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using AgentMate.ServerCore.Execution;

namespace AgentMate.ServerCore.Updates;

/// <summary>
/// Where the running core was installed, and the root work of switching it to another release.
/// The core uses the systemd one; the DevHost and the tests have no installed core, so a fake (or
/// the real one finding nothing) stands in.
/// </summary>
internal interface ICoreInstallation
{
    /// <summary>
    /// The release folder this core runs from (under /opt/agentmate-core/releases), or null when
    /// the app did not install it, so there is nothing it could switch from.
    /// </summary>
    string? CurrentRelease { get; }

    /// <summary>The release build for this processor: linux-x64 or linux-arm64; null elsewhere.</summary>
    string? Rid { get; }

    /// <summary>A folder only root can write to, for the tarball while it is checked.</summary>
    string StagingDirectory { get; }

    /// <summary>The folder a release of this version and checksum unpacks to.</summary>
    string ReleaseDirectory(string version, string sha256);

    /// <summary>
    /// Unpacks the checked tarball into <paramref name="release"/> and schedules the switch to it
    /// from a transient unit of its own, which outlives the core it restarts and goes back to the
    /// release that runs now if the new one does not stay up.
    /// </summary>
    Task UnpackAndScheduleAsync(string tarball, string release, string version, CancellationToken cancellationToken);
}

/// <summary>The core as the app installs it: /opt/agentmate-core, its releases and the systemd unit.</summary>
internal sealed partial class SystemdCoreInstallation(IProcessRunner runner, SystemdRunner units) : ICoreInstallation
{
    public const string Root = "/opt/agentmate-core";

    /// <summary>Between the core's answer and the switch: long enough for the app to hear it.</summary>
    public static readonly TimeSpan SwitchDelay = TimeSpan.FromSeconds(3);

    private const string Releases = Root + "/releases";

    private const UnixFileMode Executable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    public string? CurrentRelease { get; } = FindCurrentRelease();

    public string? Rid { get; } = RidOf(OperatingSystem.IsLinux(), RuntimeInformation.OSArchitecture);

    public string StagingDirectory => Root + "/update";

    public string ReleaseDirectory(string version, string sha256) => ReleaseDirectoryIn(Releases, version, sha256);

    /// <summary>The same naming as the installer's, so either one can switch back to the other's releases.</summary>
    public static string ReleaseDirectoryIn(string releases, string version, string sha256) =>
        $"{releases}/{version}-{sha256[..12]}";

    public static string? RidOf(bool linux, Architecture architecture) => !linux
        ? null
        : architecture switch
        {
            Architecture.X64 => "linux-x64",
            Architecture.Arm64 => "linux-arm64",
            _ => null,
        };

    /// <summary>Whether <paramref name="path"/> is a release folder the app makes, and so safe to name in a script.</summary>
    public static bool IsReleasePath(string? path) => path is not null && ReleasePath().IsMatch(path);

    public async Task UnpackAndScheduleAsync(string tarball, string release, string version, CancellationToken cancellationToken)
    {
        var previous = CurrentRelease ?? throw new CoreUpdateException(CoreUpdateError.Unsupported, "This core was not installed by the app.");
        if (!IsReleasePath(release) || release == previous)
        {
            throw new CoreUpdateException(CoreUpdateError.Invalid, "That is the release this server already runs.");
        }

        var unpack = release + ".new";
        try
        {
            if (Directory.Exists(unpack))
            {
                Directory.Delete(unpack, recursive: true);
            }

            Directory.CreateDirectory(Releases);
            Directory.CreateDirectory(unpack);
            await RunAsync("tar", ["-xzf", tarball, "-C", unpack, "--no-same-owner", "--no-same-permissions"], "Unpacking the release", cancellationToken);
            var binary = Path.Combine(unpack, "agentmate-core");
            var unit = Path.Combine(unpack, "agentmate-core.service");
            if (!File.Exists(binary) || !File.Exists(unit))
            {
                throw new CoreUpdateException(CoreUpdateError.Failed, "The release has no agentmate-core program or service file in it.");
            }

            // The core's UMask leaves what tar makes private to root, which is all the release needs
            // apart from these modes: root runs the program, systemd reads the unit.
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(unpack, Executable);
                File.SetUnixFileMode(binary, Executable);
                File.SetUnixFileMode(unit, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
            }

            if (Directory.Exists(release))
            {
                Directory.Delete(release, recursive: true);
            }

            Directory.Move(unpack, release);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            TryDelete(unpack);
            throw new CoreUpdateException(CoreUpdateError.Failed, $"The release could not be unpacked: {error.Message}");
        }
        catch
        {
            TryDelete(unpack);
            throw;
        }

        // SELinux labels what restorecon is told about; a release with the wrong label cannot start.
        if (await SelinuxEnabledAsync(cancellationToken))
        {
            await RunAsync("restorecon", ["-R", Root], "Labelling the files for SELinux", cancellationToken);
        }

        try
        {
            await units.ScheduleAsync(
                SystemdRunner.UnitName("coreupdate", Guid.NewGuid()),
                $"Switch the server core to release {version}",
                new ProcessSpec { Program = "/bin/sh", Arguments = ["-c", SwitchScript(release, previous, StagingDirectory)] },
                SwitchDelay,
                cancellationToken);
        }
        catch (ProcessFailedException error)
        {
            TryDelete(release);
            throw new CoreUpdateException(CoreUpdateError.Failed, error.Message);
        }
    }

    /// <summary>
    /// What the transient unit runs, as root, once the core has answered: the release's unit file,
    /// an atomic symlink swap and a restart, which only returns once the new core is listening
    /// (Type=notify). It must still be up a few seconds later; otherwise the server goes back to
    /// <paramref name="previous"/> and the new release is removed. Kept: the new and the previous
    /// release, as the installer keeps them.
    /// </summary>
    public static string SwitchScript(string release, string previous, string staging)
    {
        if (!IsReleasePath(release) || !IsReleasePath(previous))
        {
            throw new ArgumentException("Only release folders the app makes can be switched between.");
        }

        if (staging != Root + "/update")
        {
            throw new ArgumentException("The staging folder is the core's own.", nameof(staging));
        }

        var keep = string.Join('|', new[] { release, previous }.Distinct().Select(path => Quote(path[(Releases.Length + 1)..])));
        return string.Join(
            '\n',
            "set -u",
            $"root={Root}",
            $"new={Quote(release)}",
            $"old={Quote(previous)}",
            "unit=/etc/systemd/system/agentmate-core.service",
            "use() {",
            "  install -m 0644 -o root -g root \"$1/agentmate-core.service\" \"$unit\" && systemctl daemon-reload &&",
            "  ln -sfn \"$1\" \"$root/current.new\" && mv -Tf \"$root/current.new\" \"$root/current\"",
            "}",
            "if use \"$new\" && systemctl restart agentmate-core && sleep 5 && systemctl is-active --quiet agentmate-core; then",
            $"  cd {Releases} && for release in *; do case \"$release\" in {keep}) ;; *) rm -rf -- \"$release\" ;; esac; done",
            $"  rm -rf -- {Quote(staging)}",
            "  exit 0",
            "fi",
            "echo 'The new server core did not stay up; going back to the release before.' >&2",
            "use \"$old\"",
            "systemctl reset-failed agentmate-core",
            "systemctl restart agentmate-core",
            $"rm -rf -- \"$new\" {Quote(staging)}",
            "exit 1");
    }

    private static string Quote(string value) => "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    private async Task<bool> SelinuxEnabledAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await runner.RunAsync(
                new ProcessSpec { Program = "selinuxenabled", Timeout = TimeSpan.FromSeconds(10) },
                onLine: null,
                cancellationToken);
            return result.Succeeded;
        }
        catch (ProcessStartException)
        {
            // No SELinux tools, so no SELinux to label for.
            return false;
        }
    }

    private async Task RunAsync(string program, string[] arguments, string what, CancellationToken cancellationToken)
    {
        ProcessResult result;
        try
        {
            result = await runner.RunAsync(
                new ProcessSpec { Program = program, Arguments = arguments, Timeout = TimeSpan.FromMinutes(3) },
                onLine: null,
                cancellationToken);
        }
        catch (ProcessStartException error)
        {
            throw new CoreUpdateException(CoreUpdateError.Failed, $"{what} failed: {error.Message}");
        }

        if (!result.Succeeded)
        {
            var reason = result.TimedOut
                ? "it took too long"
                : result.StandardError.Trim() is { Length: > 0 } error
                    ? error
                    : string.Create(CultureInfo.InvariantCulture, $"exit code {result.ExitCode}");
            throw new CoreUpdateException(CoreUpdateError.Failed, $"{what} failed: {reason}");
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Left for the next update or install, which clears it before unpacking.
        }
    }

    /// <summary>
    /// The release `current` points at, when this process runs from it. A core started any other
    /// way (from a build folder, the DevHost) has no release to switch from.
    /// </summary>
    private static string? FindCurrentRelease()
    {
        if (!OperatingSystem.IsLinux() || Environment.ProcessPath is not { } process)
        {
            return null;
        }

        try
        {
            var target = new FileInfo(Root + "/current").ResolveLinkTarget(returnFinalTarget: true)?.FullName;
            var running = Path.GetDirectoryName(new FileInfo(process).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? process);
            return IsReleasePath(target) && target == running ? target : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    [GeneratedRegex("^/opt/agentmate-core/releases/[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex ReleasePath();
}
