using System.ComponentModel;
using System.Diagnostics;

namespace Runova.ServerCore.SystemTests.Acme;

/// <summary>
/// The docker CLI, run with an argument list (never a shell string) and a time limit. Tests that
/// only need a container on a published port use this rather than <see cref="SystemTestEnvironment"/>,
/// so they also run on a desktop with Docker Desktop and Linux containers.
/// </summary>
internal static class DockerCli
{
    private static readonly TimeSpan _probeTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Whether a Docker engine for Linux containers answers.</summary>
    public static async Task<bool> HasLinuxEngineAsync(CancellationToken cancellationToken)
    {
        try
        {
            var (exitCode, output, _) = await RunAsync(["info", "--format", "{{.OSType}}"], _probeTimeout, cancellationToken);
            return exitCode == 0 && output == "linux";
        }
        catch (TimeoutException)
        {
            return false;
        }
    }

    /// <summary>Runs docker and returns its trimmed standard output, or throws with its error output.</summary>
    public static async Task<string> RunCheckedAsync(IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var (exitCode, output, error) = await RunAsync(arguments, timeout, cancellationToken);
        return exitCode == 0
            ? output
            : throw new InvalidOperationException($"docker {string.Join(' ', arguments)} exited with {exitCode}: {error}");
    }

    public static async Task<(int ExitCode, string Output, string Error)> RunAsync(
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo("docker")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = start };
        try
        {
            process.Start();
        }
        catch (Win32Exception)
        {
            return (-1, string.Empty, "The docker command is not installed.");
        }

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        var output = process.StandardOutput.ReadToEndAsync(limit.Token);
        var error = process.StandardError.ReadToEndAsync(limit.Token);
        try
        {
            await process.WaitForExitAsync(limit.Token);
            return (process.ExitCode, (await output).Trim(), (await error).Trim());
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            Kill(process);
            throw new TimeoutException($"docker {string.Join(' ', arguments)} took longer than {timeout}.");
        }
        catch (OperationCanceledException)
        {
            Kill(process);
            throw;
        }
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // It ended on its own in the meantime.
        }
    }
}
