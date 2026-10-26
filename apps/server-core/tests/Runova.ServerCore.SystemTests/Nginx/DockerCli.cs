using System.Diagnostics;
using System.Text;

namespace Runova.ServerCore.SystemTests.Nginx;

/// <summary>What a docker command printed and how it ended.</summary>
internal sealed record DockerResult(int ExitCode, string Output, string Error)
{
    public bool Succeeded => ExitCode == 0;

    public string Describe() => $"exit {ExitCode}\nstdout:\n{Output}\nstderr:\n{Error}";
}

/// <summary>
/// The docker command line, used by tests that only need containers. Unlike
/// <see cref="SystemTestEnvironment"/> it does not need a Linux host, so these tests also run
/// against Docker Desktop on Windows and macOS, as long as it runs Linux containers.
/// </summary>
internal static class DockerCli
{
    private static readonly Lazy<string?> _unavailable = new(Probe);

    /// <summary>Null when docker answers with a Linux daemon, otherwise why not.</summary>
    public static string? Unavailable => _unavailable.Value;

    public static void RequireAvailable() =>
        Assert.SkipWhen(Unavailable is not null, $"These tests need Docker running Linux containers: {Unavailable}");

    public static async Task<DockerResult> RunAsync(
        IEnumerable<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        byte[]? input = null)
    {
        var start = new ProcessStartInfo("docker")
        {
            RedirectStandardInput = input is not null,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
        };
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using var process = Process.Start(start) ?? throw new InvalidOperationException("docker did not start.");
        using var timer = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timer.CancelAfter(timeout);
        var output = process.StandardOutput.ReadToEndAsync(timer.Token);
        var error = process.StandardError.ReadToEndAsync(timer.Token);
        try
        {
            if (input is not null)
            {
                await process.StandardInput.BaseStream.WriteAsync(input, timer.Token);
                process.StandardInput.Close();
            }

            await process.WaitForExitAsync(timer.Token);
            return new DockerResult(process.ExitCode, await output, await error);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"docker {string.Join(' ', start.ArgumentList)} took longer than {timeout}.");
        }
    }

    /// <summary>Runs a docker command that has to work, failing the test with its output when it does not.</summary>
    public static async Task<string> CheckedAsync(IEnumerable<string> arguments, TimeSpan timeout, CancellationToken cancellationToken, byte[]? input = null)
    {
        var list = arguments.ToList();
        var result = await RunAsync(list, timeout, cancellationToken, input);
        Assert.True(result.Succeeded, $"docker {string.Join(' ', list)} failed: {result.Describe()}");
        return result.Output;
    }

    private static string? Probe()
    {
        try
        {
            var result = RunAsync(["version", "--format", "{{.Server.Os}}"], TimeSpan.FromSeconds(20), CancellationToken.None)
                .GetAwaiter().GetResult();
            if (!result.Succeeded)
            {
                return "docker version failed: " + result.Error.Trim();
            }

            var os = result.Output.Trim();
            return os == "linux" ? null : $"the daemon runs {os} containers.";
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or TimeoutException or InvalidOperationException)
        {
            return "the docker command is not available: " + error.Message;
        }
    }
}
