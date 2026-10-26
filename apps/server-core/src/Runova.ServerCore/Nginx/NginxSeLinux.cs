using System.Globalization;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// What SELinux (RHEL family) needs before nginx can do its job: the httpd_can_network_connect
/// boolean (nginx connecting to upstreams), http_port_t on every port a stream proxy listens on,
/// and the httpd content label on the ACME webroot and site folders. Only runs where SELinux is on;
/// anything it cannot do comes back as a warning rather than stopping the apply, since nginx -t and
/// the reload check show whether nginx still works.
/// </summary>
internal sealed class NginxSeLinux(INginxMachine machine)
{
    public const string NetworkBoolean = "httpd_can_network_connect";

    /// <summary>Ports the targeted policy already labels http_port_t.</summary>
    private static readonly HashSet<int> _httpPorts = [80, 81, 443, 488, 8008, 8009, 8443, 9000];

    private static readonly TimeSpan _timeout = TimeSpan.FromMinutes(2);

    private readonly Lock _gate = new();
    private readonly HashSet<(NginxStreamProtocol, int)> _labelled = [];
    private bool _booleanSet;

    /// <summary>The boolean and the file labels, at setup. Returns warnings.</summary>
    public async Task<IReadOnlyList<string>> PrepareAsync(NginxLayout layout, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        var warnings = new List<string>();
        await EnsureBooleanAsync(warnings, cancellationToken);
        var webroot = layout.AcmeWebroot[..layout.AcmeWebroot.LastIndexOf('/')];
        var label = await RunAsync("semanage", ["fcontext", "-a", "-t", "httpd_sys_content_t", webroot + "(/.*)?"], cancellationToken);
        if (!label.Succeeded && !label.StandardError.Contains("already defined", StringComparison.Ordinal))
        {
            warnings.Add($"SELinux: could not label {webroot} for nginx ({Reason(label)}).");
        }

        var restore = await RunAsync("restorecon", ["-R", webroot, layout.ConfigRoot], cancellationToken);
        if (!restore.Succeeded)
        {
            warnings.Add($"SELinux: restorecon failed on {webroot} ({Reason(restore)}).");
        }

        return warnings;
    }

    /// <summary>The boolean, and http_port_t on each stream proxy's port. Returns warnings.</summary>
    public async Task<IReadOnlyList<string>> PrepareForApplyAsync(NginxConfiguration configuration, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var warnings = new List<string>();
        if (configuration.Sites.Count > 0 || configuration.Streams.Count > 0)
        {
            await EnsureBooleanAsync(warnings, cancellationToken);
        }

        foreach (var stream in configuration.Streams)
        {
            var key = (stream.Protocol, stream.ListenPort);
            lock (_gate)
            {
                if (_httpPorts.Contains(stream.ListenPort) || _labelled.Contains(key))
                {
                    continue;
                }
            }

            var protocol = stream.Protocol == NginxStreamProtocol.Udp ? "udp" : "tcp";
            var port = stream.ListenPort.ToString(CultureInfo.InvariantCulture);
            var added = await RunAsync("semanage", ["port", "-a", "-t", "http_port_t", "-p", protocol, port], cancellationToken);
            if (!added.Succeeded && added.StandardError.Contains("already defined", StringComparison.Ordinal))
            {
                added = await RunAsync("semanage", ["port", "-m", "-t", "http_port_t", "-p", protocol, port], cancellationToken);
            }

            if (added.Succeeded)
            {
                lock (_gate)
                {
                    _labelled.Add(key);
                }
            }
            else
            {
                warnings.Add($"SELinux: could not let nginx listen on {protocol} port {port} ({Reason(added)}).");
            }
        }

        return warnings;
    }

    private async Task EnsureBooleanAsync(List<string> warnings, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_booleanSet)
            {
                return;
            }
        }

        var current = await RunAsync("getsebool", [NetworkBoolean], cancellationToken);
        var on = current.Succeeded && current.StandardOutput.Contains("--> on", StringComparison.Ordinal);
        if (!on)
        {
            var set = await RunAsync("setsebool", ["-P", NetworkBoolean, "1"], cancellationToken);
            if (!set.Succeeded)
            {
                warnings.Add($"SELinux: could not turn on {NetworkBoolean}, so nginx may not reach its upstreams ({Reason(set)}).");
                return;
            }
        }

        lock (_gate)
        {
            _booleanSet = true;
        }
    }

    private async Task<ProcessResult> RunAsync(string program, string[] arguments, CancellationToken cancellationToken)
    {
        try
        {
            return await machine.RunAsync(new ProcessSpec { Program = program, Arguments = arguments, Timeout = _timeout }, cancellationToken);
        }
        catch (ProcessStartException error)
        {
            return new ProcessResult(-1, string.Empty, error.Message, TimedOut: false, OutputTruncated: false);
        }
    }

    private static string Reason(ProcessResult result) =>
        result.StandardError.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault()
        ?? $"exit code {result.ExitCode}";
}
