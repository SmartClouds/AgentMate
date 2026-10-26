using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.DirectTls;

/// <summary>Whether Kestrel has the direct TLS port bound right now. Tests on the in-memory server fake it.</summary>
internal interface IDirectTlsBinding
{
    bool IsListening(int port);
}

internal sealed class KestrelDirectTlsBinding(IServer server) : IDirectTlsBinding
{
    public bool IsListening(int port)
    {
        var suffix = string.Create(CultureInfo.InvariantCulture, $":{port}");
        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses ?? [];
        return addresses.Any(address =>
            address.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            && address.TrimEnd('/').EndsWith(suffix, StringComparison.Ordinal));
    }
}

/// <summary>Refused change: the message says why, in words for the person who asked.</summary>
internal sealed class DirectTlsRefusedException(string message) : Exception(message);

/// <summary>
/// Turns the direct TLS listener on and off and says how it stands. The setting survives a
/// restart; the certificate is made on the first start (the install) and kept.
/// </summary>
internal sealed partial class DirectTlsManager(
    IConfiguration configuration,
    DirectTlsEndpoint endpoint,
    IDirectTlsBinding binding,
    TimeProvider time,
    ILogger<DirectTlsManager> logger) : IDisposable
{
    private const string SettingsFile = "direct-tls.json";

    private static readonly TimeSpan _bindWait = TimeSpan.FromSeconds(5);

    private readonly SemaphoreSlim _gate = new(1, 1);

    private DirectTlsCertificate? _certificate;

    private string? _error;

    private bool LoopbackOnly => configuration.GetValue<bool>("Core:DirectTls:LoopbackOnly");

    private string DataDirectory => CorePaths.DataDirectory(configuration, OperatingSystem.IsLinux());

    private string SettingsPath => Path.Combine(DataDirectory, SettingsFile);

    public DirectTlsCertificate Certificate => _certificate ??= DirectTlsCertificate.LoadOrCreate(DataDirectory, time);

    /// <summary>Makes the certificate when there is none, and opens the port when the mode was left on.</summary>
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            _ = Certificate;
            var settings = DirectTlsSettings.Read(SettingsPath);
            if (settings.Enabled)
            {
                endpoint.Open(settings.Port, settings.Networks(), Certificate.Certificate, LoopbackOnly);
                LogOpened(logger, settings.Port);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();

    [LoggerMessage(Level = LogLevel.Information, Message = "Direct TLS is on, port {Port}.")]
    private static partial void LogOpened(ILogger logger, int port);

    public async Task<DirectTlsStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return Describe(DirectTlsSettings.Read(SettingsPath));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<DirectTlsStatus> EnableAsync(DirectTlsRequest request, string changedBy, IReadOnlyCollection<int> sshPorts, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (DirectTlsSettings.Validate(request.Port, request.Sources, sshPorts, out var sources) is { } problem)
        {
            throw new DirectTlsRefusedException(problem);
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var current = DirectTlsSettings.Read(SettingsPath);
            var moving = !current.Enabled || current.Port != request.Port;
            if (moving && !PortIsFree(request.Port))
            {
                throw new DirectTlsRefusedException($"Port {request.Port} is already in use on the server. Pick another one.");
            }

            var settings = new DirectTlsSettings(true, request.Port, sources, time.GetUtcNow().ToUnixTimeMilliseconds(), changedBy);
            settings.Write(SettingsPath);
            endpoint.Open(settings.Port, settings.Networks(), Certificate.Certificate, LoopbackOnly);
            _error = await WaitAsync(() => binding.IsListening(settings.Port), cancellationToken)
                ? null
                : $"The core could not open port {settings.Port}. Its journal says why (journalctl -u runova-core).";
            return Describe(settings);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<DirectTlsStatus> DisableAsync(string changedBy, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var current = DirectTlsSettings.Read(SettingsPath);
            var settings = current with { Enabled = false, ChangedAt = time.GetUtcNow().ToUnixTimeMilliseconds(), ChangedBy = changedBy };
            settings.Write(SettingsPath);
            endpoint.Close();
            _error = await WaitAsync(() => !binding.IsListening(current.Port), cancellationToken)
                ? null
                : $"Port {current.Port} still answers. Restart the core to close it (systemctl restart runova-core).";
            return Describe(settings);
        }
        finally
        {
            _gate.Release();
        }
    }

    private DirectTlsStatus Describe(DirectTlsSettings settings)
    {
        var listening = settings.Enabled && binding.IsListening(settings.Port);
        return new DirectTlsStatus(
            settings.Enabled,
            settings.Port,
            settings.Sources,
            listening,
            Certificate.Pin,
            new DateTimeOffset(Certificate.Certificate.NotAfter.ToUniversalTime()).ToUnixTimeMilliseconds(),
            DirectTlsSettings.DefaultPort,
            settings.ChangedAt,
            settings.ChangedBy,
            settings.Enabled && !listening ? _error ?? $"Port {settings.Port} is not open yet." : _error);
    }

    private bool PortIsFree(int port)
    {
        try
        {
            using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            probe.Bind(new IPEndPoint(LoopbackOnly ? IPAddress.Loopback : IPAddress.Any, port));
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    private static async Task<bool> WaitAsync(Func<bool> done, CancellationToken cancellationToken)
    {
        // Wall-clock time on purpose: Kestrel binds in real time even when a test fakes the clock.
        var deadline = Environment.TickCount64 + (long)_bindWait.TotalMilliseconds;
        while (!done())
        {
            if (Environment.TickCount64 >= deadline)
            {
                return false;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(50), cancellationToken);
        }

        return true;
    }
}

/// <summary>Runs <see cref="DirectTlsManager.StartAsync"/> with the host. A failure is logged, never fatal.</summary>
internal sealed partial class DirectTlsStartup(DirectTlsManager manager, ILogger<DirectTlsStartup> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await manager.StartAsync(cancellationToken);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        {
            LogStartFailed(logger, error);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Direct TLS could not start; the Unix socket is unaffected.")]
    private static partial void LogStartFailed(ILogger logger, Exception error);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
