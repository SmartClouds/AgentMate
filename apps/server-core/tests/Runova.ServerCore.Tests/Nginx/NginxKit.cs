using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>Answers upstream names from a table; anything else does not resolve.</summary>
internal sealed class FakeResolver : IUpstreamResolver
{
    public Dictionary<string, IPAddress[]> Names { get; } = new(StringComparer.Ordinal);

    public Task<IPAddress[]> ResolveAsync(string host, CancellationToken cancellationToken) =>
        Names.TryGetValue(host, out var addresses)
            ? Task.FromResult(addresses)
            : Task.FromException<IPAddress[]>(new System.Net.Sockets.SocketException(11001));
}

internal sealed class FixedSigningKey(string armored) : INginxSigningKeySource
{
    public int Fetches { get; private set; }

    public Task<string> GetAsync(CancellationToken cancellationToken)
    {
        Fetches++;
        return Task.FromResult(armored);
    }
}

/// <summary>The nginx pieces over a simulated machine, with a real clock that never waits long.</summary>
internal sealed class NginxKit : IDisposable
{
    public static readonly OsInfo Ubuntu = new("ubuntu", "24.04", "Ubuntu 24.04.1 LTS", OsFamily.Debian, Supported: true);

    public NginxKit(bool installed = true, OsInfo? os = null, string? signingKey = null)
    {
        Machine = new SimulatedNginxMachine(installed);
        Machine.WriteText("/etc/os-release", "ID=ubuntu\nVERSION_ID=\"24.04\"\nVERSION_CODENAME=noble\n");
        Control = new NginxControl(Machine, Clock) { ReloadDeadline = TimeSpan.FromSeconds(2), PollInterval = TimeSpan.FromMilliseconds(10), SettleTime = TimeSpan.FromMilliseconds(250) };
        SeLinux = new NginxSeLinux(Machine);
        Applier = new NginxApplier(Control, SeLinux, Resolver, UpstreamPolicy.Default, Clock, NullLogger<NginxApplier>.Instance);
        SigningKey = new FixedSigningKey(signingKey ?? Fixtures.Read("nginx/nginx_signing.key"));
        Setup = new NginxSetup(Control, SeLinux, SigningKey, os ?? Ubuntu, Clock);
    }

    public TimeProvider Clock { get; } = TimeProvider.System;

    public SimulatedNginxMachine Machine { get; }

    public NginxControl Control { get; }

    public NginxSeLinux SeLinux { get; }

    public FakeResolver Resolver { get; } = new();

    public NginxApplier Applier { get; }

    public FixedSigningKey SigningKey { get; }

    public NginxSetup Setup { get; }

    public NginxLayout Layout { get; } = NginxLayout.Debian;

    public TestJob Job { get; } = new(JobKind.NginxInstall);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async Task SetUpAsync() => await Setup.InstallAsync(Layout, Job.Context, Cancel);

    public Task<NginxInspection> InspectAsync() => Control.InspectAsync(Layout, Cancel);

    public static NginxApplyPlan Plan(NginxConfiguration configuration, params NginxCertificateFiles[] certificates) =>
        new(configuration, certificates, new NginxAppliedState("hash", new Dictionary<string, string>(), new Dictionary<string, string>()));

    public async Task<NginxApplyOutcome> ApplyAsync(NginxConfiguration configuration, params NginxCertificateFiles[] certificates)
    {
        using var lease = await Applier.LockAsync(Cancel);
        var plan = Plan(configuration, certificates);
        var outcome = await Applier.ApplyAsync(plan, await InspectAsync(), Layout, Cancel);
        if (outcome.Applied)
        {
            await Applier.CompleteAsync(plan, Layout, outcome.Release!.Value, Cancel);
        }

        return outcome;
    }

    public void Dispose() => Job.Dispose();
}
