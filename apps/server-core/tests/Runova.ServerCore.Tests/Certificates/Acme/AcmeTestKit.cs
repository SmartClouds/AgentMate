using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>A fake CA, the in-memory challenge handlers and stores, and a client wired to them.</summary>
internal sealed class AcmeTestKit : IDisposable
{
    public AcmeTestKit(AcmeClientOptions? options = null)
    {
        Server = new FakeAcmeServer(Clock, Http01, Dns01);
        Http = new HttpClient(Server);
        Options = options ?? new AcmeClientOptions { DirectoryUrl = FakeAcmeServer.DirectoryUrl };
        Client = new AcmeClient(Http, Options, Clock, NullLogger<AcmeClient>.Instance);
    }

    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero));

    public InMemoryHttp01ChallengePublisher Http01 { get; } = new();

    public InMemoryDns01ChallengeHook Dns01 { get; } = new();

    public InMemoryAcmeAccountStore Accounts { get; } = new();

    public InMemoryAcmeCertificateStore Certificates { get; } = new();

    public FakeAcmeServer Server { get; }

    public HttpClient Http { get; }

    public AcmeClientOptions Options { get; }

    public AcmeClient Client { get; }

    public AcmeIssuer CreateIssuer(bool withHttp01 = true, bool withDns01 = true) =>
        new(
            Client,
            Accounts,
            Certificates,
            withHttp01 ? Http01 : null,
            withDns01 ? Dns01 : null,
            Clock,
            NullLogger<AcmeIssuer>.Instance);

    public async Task<AcmeAccount> CreateAccountAsync()
    {
        var key = AcmeAccountKey.Generate();
        try
        {
            return await Client.CreateAccountAsync(key, ["admin@example.test"], termsOfServiceAgreed: true, TestContext.Current.CancellationToken);
        }
        catch
        {
            key.Dispose();
            throw;
        }
    }

    /// <summary>Runs one order through the low-level client with HTTP-01 and returns the chain.</summary>
    public async Task<AcmeCertificateChain> IssueWithClientAsync(AcmeAccount account, params string[] domains)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var order = await Client.NewOrderAsync(account, AcmeIdentifier.ForDomains(domains), replaces: null, cancellationToken);
        foreach (var url in order.Authorizations)
        {
            var authorization = await Client.GetAuthorizationAsync(account, url, cancellationToken);
            var challenge = authorization.FindChallenge(AcmeChallengeTypes.Http01)!;
            await Http01.PublishAsync(authorization.Domain, challenge.Token!, challenge.KeyAuthorization(account.Key), cancellationToken);
            await Client.RespondToChallengeAsync(account, challenge, cancellationToken);
            await Client.WaitForAuthorizationAsync(account, url, cancellationToken);
        }

        using var key = AcmeCsr.CreateKey(AcmeCertificateKeyType.EcdsaP256);
        order = await Client.FinalizeAsync(account, await Client.WaitForOrderAsync(account, order.Url, cancellationToken), AcmeCsr.Create(domains, key), cancellationToken);
        order = await Client.WaitForOrderAsync(account, order.Url, cancellationToken);
        return await Client.DownloadCertificateAsync(account, order.Certificate!, cancellationToken);
    }

    /// <summary>
    /// Moves the fake clock forward in small steps, pausing for real after each, until the task is
    /// done. The client waits on this clock, so minutes of polling pass in a moment.
    /// </summary>
    public async Task<T> RunAsync<T>(Task<T> task, TimeSpan? step = null)
    {
        var giveUp = DateTime.UtcNow.AddSeconds(30);
        while (!task.IsCompleted)
        {
            if (DateTime.UtcNow > giveUp)
            {
                throw new TimeoutException("The operation did not finish on the fake clock.");
            }

            Clock.Advance(step ?? TimeSpan.FromMilliseconds(500));
            await Task.WhenAny(task, Task.Delay(5, TestContext.Current.CancellationToken));
        }

        return await task;
    }

    public async Task RunAsync(Task task, TimeSpan? step = null) =>
        await RunAsync(RunToBool(task), step);

    public void Dispose()
    {
        Http.Dispose();
        Server.Dispose();
    }

    private static async Task<bool> RunToBool(Task task)
    {
        await task;
        return true;
    }
}
