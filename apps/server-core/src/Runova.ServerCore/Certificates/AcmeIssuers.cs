using System.Collections.Concurrent;
using System.Text;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Certificates;

/// <summary>
/// Answers HTTP-01 from the nginx webroot every site serves at /.well-known/acme-challenge/. The
/// answer is world-readable (nginx's workers serve it) and holds nothing secret: the token and the
/// account key's thumbprint. Where SELinux is on, the file gets the webroot's label.
/// </summary>
internal sealed class WebrootChallengePublisher(INginxMachine machine, NginxLayout layout) : IHttp01ChallengePublisher
{
    private const UnixFileMode Readable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    public async Task PublishAsync(string domain, string token, string keyAuthorization, CancellationToken cancellationToken)
    {
        var path = PathOf(token);
        await machine.WriteAsync(path, Encoding.ASCII.GetBytes(keyAuthorization), Readable, cancellationToken);
        if (await machine.ExistsAsync("/sys/fs/selinux/enforce", cancellationToken))
        {
            try
            {
                await machine.RunAsync(new ProcessSpec { Program = "restorecon", Arguments = [path], Timeout = TimeSpan.FromSeconds(30) }, cancellationToken);
            }
            catch (ProcessStartException)
            {
                // Files inherit the folder's label anyway; restorecon is the safety net.
            }
        }
    }

    public Task RemoveAsync(string domain, string token, CancellationToken cancellationToken) =>
        machine.DeleteAsync(PathOf(token), cancellationToken);

    /// <summary>Tokens are base64url (RFC 8555 section 8.1), so they can never name another folder.</summary>
    private string PathOf(string token)
    {
        if (token is not { Length: > 0 and <= 256 } || !token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
        {
            throw new AcmeException("The CA sent a challenge token that is not base64url.");
        }

        return $"{layout.AcmeChallengeDirectory}/{token}";
    }
}

/// <summary>The HTTP client ACME requests go through; tests put a fake CA behind it.</summary>
internal interface IAcmeHttp
{
    HttpClient Client { get; }
}

internal sealed class AcmeHttp : IAcmeHttp, IDisposable
{
    public HttpClient Client { get; } = new(AcmeTransport.CreateHandler()) { Timeout = Timeout.InfiniteTimeSpan };

    public void Dispose() => Client.Dispose();
}

/// <summary>Which ACME directories "production" and "staging" mean. Configurable for tests against Pebble.</summary>
internal sealed record AcmeDirectoryChoice(Uri Production, Uri Staging)
{
    public static AcmeDirectoryChoice From(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new AcmeDirectoryChoice(
            Configured(configuration["Core:Acme:ProductionDirectory"]) ?? AcmeDirectories.LetsEncryptProduction,
            Configured(configuration["Core:Acme:StagingDirectory"]) ?? AcmeDirectories.LetsEncryptStaging);
    }

    private static Uri? Configured(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps ? uri : null;
}

/// <summary>One CA directory as the certificate service uses it.</summary>
internal interface ICertificateAuthority
{
    /// <summary>Registers the account on first use (which needs the terms accepted) and stores it.</summary>
    Task EnsureAccountAsync(AcmeAccountSettings settings, CancellationToken cancellationToken);

    Task<AcmeCertificateRecord> IssueAsync(AcmeIssueRequest request, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken);

    Task<AcmeCertificateRecord> RenewAsync(string name, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken);

    Task<AcmeRenewalInfo> GetRenewalInfoAsync(string name, CancellationToken cancellationToken);

    Task RevokeAsync(string name, AcmeRevocationReason reason, CancellationToken cancellationToken);
}

/// <summary>The CAs certificates come from: ACME on a real server, a simulation in the DevHost.</summary>
internal interface ICertificateAuthorities
{
    /// <summary>Whether DNS-01 can be answered for every one of these names (E14's hook needs the zone's token).</summary>
    Task<bool> CanAnswerDns01Async(IReadOnlyList<string> domains, CancellationToken cancellationToken);

    ICertificateAuthority For(Uri directory);
}

/// <summary>One ACME issuer per CA directory, sharing the stores, the challenge handlers and the client.</summary>
internal sealed class AcmeIssuers(
    IAcmeHttp http,
    IAcmeAccountStore accounts,
    IAcmeCertificateStore certificates,
    IHttp01ChallengePublisher http01,
    IEnumerable<IDns01ChallengeHook> dns01,
    TimeProvider time,
    ILoggerFactory loggers) : ICertificateAuthorities
{
    private readonly ConcurrentDictionary<string, Authority> _issuers = new(StringComparer.Ordinal);

    /// <summary>A hook that answers for every name (a test's) wins over one that needs a token per zone (Cloudflare's).</summary>
    private IDns01ChallengeHook? Dns01Hook => dns01.FirstOrDefault(hook => hook is not IDns01Coverage) ?? dns01.FirstOrDefault();

    public async Task<bool> CanAnswerDns01Async(IReadOnlyList<string> domains, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(domains);
        if (Dns01Hook is not { } hook)
        {
            return false;
        }

        if (hook is not IDns01Coverage coverage)
        {
            return true;
        }

        foreach (var domain in domains)
        {
            if (!await coverage.CoversAsync(domain, cancellationToken))
            {
                return false;
            }
        }

        return true;
    }

    public ICertificateAuthority For(Uri directory)
    {
        ArgumentNullException.ThrowIfNull(directory);
        return _issuers.GetOrAdd(directory.AbsoluteUri, _ => new Authority(new AcmeIssuer(
            new AcmeClient(http.Client, new AcmeClientOptions { DirectoryUrl = directory }, time, loggers.CreateLogger<AcmeClient>()),
            accounts,
            certificates,
            http01,
            Dns01Hook,
            time,
            loggers.CreateLogger<AcmeIssuer>())));
    }

    private sealed class Authority(AcmeIssuer issuer) : ICertificateAuthority
    {
        public async Task EnsureAccountAsync(AcmeAccountSettings settings, CancellationToken cancellationToken) =>
            (await issuer.EnsureAccountAsync(settings, cancellationToken)).Dispose();

        public Task<AcmeCertificateRecord> IssueAsync(AcmeIssueRequest request, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken) =>
            issuer.IssueAsync(request, progress, cancellationToken);

        public Task<AcmeCertificateRecord> RenewAsync(string name, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken) =>
            issuer.RenewAsync(name, progress, cancellationToken);

        public Task<AcmeRenewalInfo> GetRenewalInfoAsync(string name, CancellationToken cancellationToken) =>
            issuer.GetRenewalInfoAsync(name, cancellationToken);

        public Task RevokeAsync(string name, AcmeRevocationReason reason, CancellationToken cancellationToken) =>
            issuer.RevokeAsync(name, reason, cancellationToken);
    }
}
