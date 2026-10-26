using System.Globalization;
using System.Text;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.SystemTests.Nginx;

/// <summary>
/// The core's view of a server (<see cref="INginxMachine"/>) over docker exec into the harness's
/// nginx container, so the apply, rollback and recovery code runs unchanged against real nginx.
/// Paths and arguments go to sh as positional parameters, never into the script text.
/// </summary>
internal sealed class DockerNginxMachine(string container) : INginxMachine
{
    private static readonly TimeSpan _timeout = TimeSpan.FromMinutes(2);

    public async Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken)
    {
        var result = await ExecAsync(["cat", path], cancellationToken);
        return result.Succeeded ? result.Output : null;
    }

    public async Task WriteAsync(string path, ReadOnlyMemory<byte> content, UnixFileMode mode, CancellationToken cancellationToken)
    {
        var result = await DockerCli.RunAsync(
            ["exec", "-i", container, "sh", "-c", "mkdir -p \"$(dirname \"$1\")\" && cat > \"$1.tmp\" && chmod \"$2\" \"$1.tmp\" && mv -f \"$1.tmp\" \"$1\"", "sh", path, Octal(mode)],
            _timeout,
            cancellationToken,
            content.ToArray());
        Check(result, "write " + path);
    }

    public async Task<bool> ExistsAsync(string path, CancellationToken cancellationToken) =>
        (await ShellAsync("test -e \"$1\" || test -L \"$1\"", cancellationToken, path)).Succeeded;

    public async Task DeleteAsync(string path, CancellationToken cancellationToken) =>
        Check(await ExecAsync(["rm", "-rf", path], cancellationToken), "delete " + path);

    public async Task CreateDirectoryAsync(string path, UnixFileMode mode, CancellationToken cancellationToken) =>
        Check(await ShellAsync("mkdir -p \"$1\" && chmod \"$2\" \"$1\"", cancellationToken, path, Octal(mode)), "mkdir " + path);

    public async Task<IReadOnlyList<string>> ListAsync(string path, CancellationToken cancellationToken)
    {
        var result = await ShellAsync("test -d \"$1\" && ls -A \"$1\" || true", cancellationToken, path);
        return result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    public async Task<string?> ReadLinkAsync(string path, CancellationToken cancellationToken)
    {
        var result = await ExecAsync(["readlink", path], cancellationToken);
        return result.Succeeded ? result.Output.Trim() : null;
    }

    public async Task ReplaceLinkAsync(string path, string target, CancellationToken cancellationToken) =>
        Check(await ShellAsync("ln -sfn \"$2\" \"$1.next\" && mv -T \"$1.next\" \"$1\"", cancellationToken, path, target), "link " + path);

    public async Task MoveAsync(string from, string to, CancellationToken cancellationToken) =>
        Check(await ShellAsync("test ! -e \"$2\" && test ! -L \"$2\" && mv -T \"$1\" \"$2\"", cancellationToken, from, to), "move " + from);

    public async Task<long?> LengthAsync(string path, CancellationToken cancellationToken)
    {
        var result = await ExecAsync(["stat", "-c", "%s", path], cancellationToken);
        return result.Succeeded ? long.Parse(result.Output.Trim(), CultureInfo.InvariantCulture) : null;
    }

    public async Task<byte[]> ReadRangeAsync(string path, long offset, int maxBytes, CancellationToken cancellationToken)
    {
        var result = await ShellAsync(
            "tail -c +\"$2\" \"$1\" | head -c \"$3\"",
            cancellationToken,
            path,
            (offset + 1).ToString(CultureInfo.InvariantCulture),
            maxBytes.ToString(CultureInfo.InvariantCulture));
        Check(result, "read " + path);
        return Encoding.UTF8.GetBytes(result.Output);
    }

    public async Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        List<string> arguments = ["exec"];
        foreach (var (name, value) in spec.Environment)
        {
            arguments.AddRange(["-e", $"{name}={value}"]);
        }

        arguments.AddRange([container, spec.Program, .. spec.Arguments]);
        var result = await DockerCli.RunAsync(arguments, spec.Timeout, cancellationToken);
        if (result.ExitCode == 127 || result.Error.Contains("executable file not found", StringComparison.Ordinal))
        {
            throw new ProcessStartException($"{spec.Program} is not installed in the container.");
        }

        return new ProcessResult(result.ExitCode, result.Output, result.Error, TimedOut: false, OutputTruncated: false);
    }

    public Task<ProcessResult> RunInUnitAsync(JobContext job, string step, string description, ProcessSpec spec, CancellationToken cancellationToken) =>
        RunAsync(spec, cancellationToken);

    private Task<DockerResult> ExecAsync(string[] command, CancellationToken cancellationToken) =>
        DockerCli.RunAsync(["exec", container, .. command], _timeout, cancellationToken);

    private Task<DockerResult> ShellAsync(string script, CancellationToken cancellationToken, params string[] arguments) =>
        DockerCli.RunAsync(["exec", container, "sh", "-c", script, "sh", .. arguments], _timeout, cancellationToken);

    private static string Octal(UnixFileMode mode) => Convert.ToString((int)mode, 8);

    private static void Check(DockerResult result, string what)
    {
        if (!result.Succeeded)
        {
            throw new IOException($"{what} failed in the container: {result.Describe()}");
        }
    }
}
