using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>Who the account is for: contact addresses and the operator's answer to the terms of service.</summary>
internal sealed record AcmeAccountSettings(IReadOnlyList<string> ContactEmails, bool TermsOfServiceAgreed);

/// <summary>What to issue.</summary>
internal sealed record AcmeIssueRequest
{
    /// <summary>The store key, normally the site the certificate is for.</summary>
    public required string Name { get; init; }

    public required IReadOnlyList<string> Domains { get; init; }

    public AcmeCertificateKeyType KeyType { get; init; } = AcmeCertificateKeyType.EcdsaP256;

    /// <summary>The issuer common name of the topmost certificate of the chain to prefer, if the CA offers several.</summary>
    public string? PreferredChain { get; init; }

    /// <summary>Answer DNS-01 where HTTP-01 would also do. Wildcards always use DNS-01.</summary>
    public bool PreferDns01 { get; init; }

    /// <summary>The ARI identifier of the certificate this one renews (sent as "replaces").</summary>
    public string? Replaces { get; init; }

    /// <summary>A certificate profile the CA offers, or null for its default.</summary>
    public string? Profile { get; init; }
}

/// <summary>The steps of an issuance, for the job's progress (E11 T3).</summary>
internal enum AcmeIssueStep
{
    Ordering,
    PublishingChallenge,
    Validating,
    Finalizing,
    Downloading,
    Saving,
}

internal sealed record AcmeIssueProgress(AcmeIssueStep Step, string? Domain = null);

/// <summary>
/// The CA could not validate a domain. <see cref="ErrorType"/> says what it saw: dns (no record,
/// or the name does not resolve), connection (port 80 closed or filtered), incorrectResponse (a
/// different answer, usually another server), unauthorized, caa or tls.
/// </summary>
internal sealed class AcmeValidationException(string message, string domain, string? challengeType, AcmeProblem? problem)
    : AcmeException(message)
{
    public string Domain { get; } = domain;

    public string? ChallengeType { get; } = challengeType;

    /// <summary>The challenge's error as the CA reported it, if it reported one.</summary>
    public AcmeProblem? Problem { get; } = problem;

    public AcmeErrorType ErrorType => Problem?.ErrorType ?? AcmeErrorType.Unknown;

    public static AcmeValidationException Create(string domain, string? challengeType, AcmeProblem? problem)
    {
        var over = challengeType is null ? string.Empty : $" over {challengeType}";
        var type = problem?.ShortType is { } shortType ? $" ({shortType})" : string.Empty;
        var detail = problem?.Describe() ?? "the CA gave no reason";
        return new AcmeValidationException($"Validating {domain}{over} failed{type}: {detail}", domain, challengeType, problem);
    }
}

/// <summary>
/// Issues, renews and revokes certificates with one CA: the account comes from the account store,
/// challenges go to the HTTP-01 publisher or the DNS-01 hook and are always removed again, every
/// certificate gets a fresh key, and the result (key included) goes to the certificate store.
/// Renewals send "replaces" (RFC 9773), and fall back to a plain order when the CA already
/// replaced the certificate.
/// </summary>
internal sealed partial class AcmeIssuer(
    AcmeClient client,
    IAcmeAccountStore accounts,
    IAcmeCertificateStore certificates,
    IHttp01ChallengePublisher? http01,
    IDns01ChallengeHook? dns01,
    TimeProvider time,
    ILogger<AcmeIssuer> logger)
{
    /// <summary>Cleanup runs even after a cancellation, so it gets its own time limit.</summary>
    private static readonly TimeSpan _cleanupTimeout = TimeSpan.FromSeconds(30);

    /// <summary>The stored account for this CA, or a new one registered and stored. The caller disposes it.</summary>
    public async Task<AcmeAccount> EnsureAccountAsync(AcmeAccountSettings settings, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (await accounts.FindAsync(client.DirectoryUrl, cancellationToken) is { } stored)
        {
            return stored;
        }

        var key = AcmeAccountKey.Generate();
        AcmeAccount account;
        try
        {
            account = await client.CreateAccountAsync(key, settings.ContactEmails, settings.TermsOfServiceAgreed, cancellationToken);
        }
        catch
        {
            key.Dispose();
            throw;
        }

        try
        {
            await accounts.SaveAsync(account, cancellationToken);
            return account;
        }
        catch
        {
            account.Dispose();
            throw;
        }
    }

    /// <summary>Orders, validates, finalizes, downloads and stores a certificate.</summary>
    /// <exception cref="ArgumentException">A domain is not a DNS name.</exception>
    /// <exception cref="AcmeValidationException">The CA could not validate a domain.</exception>
    /// <exception cref="AcmeRateLimitedException">A rate limit of the CA was hit.</exception>
    /// <exception cref="AcmeException">Anything else went wrong with the CA.</exception>
    public async Task<AcmeCertificateRecord> IssueAsync(
        AcmeIssueRequest request,
        IProgress<AcmeIssueProgress>? progress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Name);
        var identifiers = AcmeIdentifier.ForDomains(request.Domains);
        var names = identifiers.Select(identifier => identifier.Value).ToList();
        using var account = await LoadAccountAsync(cancellationToken);

        progress?.Report(new AcmeIssueProgress(AcmeIssueStep.Ordering));
        LogOrdering(logger, request.Name, names);
        var order = await OrderAsync(account, identifiers, request, cancellationToken);
        await AuthorizeAsync(account, order, request.PreferDns01, progress, cancellationToken);

        order = await client.WaitForOrderAsync(account, order.Url, cancellationToken);
        if (order.Status != AcmeStatus.Ready)
        {
            throw OrderFailed(order, "was not ready to be finalized");
        }

        using var key = AcmeCsr.CreateKey(request.KeyType);
        progress?.Report(new AcmeIssueProgress(AcmeIssueStep.Finalizing));
        order = await client.FinalizeAsync(account, order, AcmeCsr.Create(names, key), cancellationToken);
        if (order.Status != AcmeStatus.Valid)
        {
            order = await client.WaitForOrderAsync(account, order.Url, cancellationToken);
        }

        if (order.Status != AcmeStatus.Valid || order.Certificate is null)
        {
            throw OrderFailed(order, "did not produce a certificate");
        }

        progress?.Report(new AcmeIssueProgress(AcmeIssueStep.Downloading));
        var chain = await client.DownloadCertificateAsync(account, order.Certificate, cancellationToken);
        chain = await ChooseChainAsync(account, chain, request.PreferredChain, cancellationToken);
        using var leaf = chain.LoadLeaf();
        CheckMatches(leaf, key, names);

        var record = new AcmeCertificateRecord
        {
            Name = request.Name,
            DirectoryUrl = client.DirectoryUrl,
            Domains = names,
            KeyType = request.KeyType,
            ChainPem = chain.Pem,
            PrivateKeyPkcs8 = key.ExportPkcs8PrivateKey(),
            CertificateId = AcmeCertificateId.FromCertificate(leaf),
            NotBefore = new DateTimeOffset(leaf.NotBefore.ToUniversalTime()),
            NotAfter = new DateTimeOffset(leaf.NotAfter.ToUniversalTime()),
            IssuedAt = time.GetUtcNow(),
            Replaced = order.Replaces,
            PreferredChain = request.PreferredChain,
        };
        progress?.Report(new AcmeIssueProgress(AcmeIssueStep.Saving));
        await certificates.SaveAsync(record, cancellationToken);
        LogIssued(logger, request.Name, record.NotAfter);
        return record;
    }

    /// <summary>
    /// Issues the stored certificate again for the same names and key type, as a replacement of
    /// the stored one when the CA supports ARI.
    /// </summary>
    public async Task<AcmeCertificateRecord> RenewAsync(string name, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken)
    {
        var existing = await LoadCertificateAsync(name, cancellationToken);
        return await IssueAsync(
            new AcmeIssueRequest
            {
                Name = existing.Name,
                Domains = existing.Domains,
                KeyType = existing.KeyType,
                PreferredChain = existing.PreferredChain,

                // A certificate from another CA (staging, say) is not this CA's to replace.
                Replaces = existing.DirectoryUrl == client.DirectoryUrl ? existing.CertificateId : null,
            },
            progress,
            cancellationToken);
    }

    /// <summary>The CA's suggested renewal window for the stored certificate (RFC 9773).</summary>
    public async Task<AcmeRenewalInfo> GetRenewalInfoAsync(string name, CancellationToken cancellationToken)
    {
        var existing = await LoadCertificateAsync(name, cancellationToken);
        return await client.GetRenewalInfoAsync(existing.CertificateId, cancellationToken);
    }

    /// <summary>Revokes the stored certificate and records when.</summary>
    public async Task RevokeAsync(string name, AcmeRevocationReason reason, CancellationToken cancellationToken)
    {
        var existing = await LoadCertificateAsync(name, cancellationToken);
        using var account = await LoadAccountAsync(cancellationToken);
        using var leaf = X509Certificate2.CreateFromPem(existing.ChainPem);
        await client.RevokeCertificateAsync(account, leaf, reason, cancellationToken);
        await certificates.SaveAsync(existing with { RevokedAt = time.GetUtcNow() }, cancellationToken);
        LogRevoked(logger, name, reason);
    }

    /// <summary>Moves the account to a fresh key and stores it.</summary>
    /// <remarks>
    /// If storing fails after the CA accepted the change, the stored key no longer works and a new
    /// account has to be registered; the log says so.
    /// </remarks>
    public async Task RollOverAccountKeyAsync(CancellationToken cancellationToken)
    {
        using var account = await LoadAccountAsync(cancellationToken);
        var newKey = AcmeAccountKey.Generate();
        AcmeAccount rolled;
        try
        {
            rolled = await client.ChangeKeyAsync(account, newKey, cancellationToken);
        }
        catch
        {
            newKey.Dispose();
            throw;
        }

        using (rolled)
        {
            try
            {
                await accounts.SaveAsync(rolled, cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogRolloverNotSaved(logger, error);
                throw;
            }
        }
    }

    private static void CheckMatches(X509Certificate2 leaf, AsymmetricAlgorithm key, IReadOnlyList<string> names)
    {
        var sameKey = leaf.PublicKey.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(key.ExportSubjectPublicKeyInfo());
        var covered = leaf.Extensions.OfType<X509SubjectAlternativeNameExtension>()
            .SelectMany(extension => extension.EnumerateDnsNames())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!sameKey || !names.All(covered.Contains))
        {
            throw new AcmeException("The CA returned a certificate that does not match the request (key or names).");
        }
    }

    private static AcmeException OrderFailed(AcmeOrder order, string what) =>
        order.Error is { } error
            ? new AcmeException($"The order {what}: {error.Describe()} ({error.ShortType ?? "no type"})")
            : new AcmeException($"The order {what}; the CA reports it as {AcmeStatuses.Name(order.Status)}.");

    private async Task<AcmeAccount> LoadAccountAsync(CancellationToken cancellationToken) =>
        await accounts.FindAsync(client.DirectoryUrl, cancellationToken)
        ?? throw new AcmeException($"No ACME account is set up for {client.DirectoryUrl.Host} yet.");

    private async Task<AcmeCertificateRecord> LoadCertificateAsync(string name, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        return await certificates.FindAsync(name, cancellationToken)
            ?? throw new AcmeException($"No certificate named \"{AcmeText.Clean(name, 80)}\" is stored.");
    }

    private async Task<AcmeOrder> OrderAsync(
        AcmeAccount account,
        IReadOnlyList<AcmeIdentifier> identifiers,
        AcmeIssueRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            return await client.NewOrderAsync(account, identifiers, request.Replaces, request.Profile, cancellationToken);
        }
        catch (AcmeProblemException error) when (request.Replaces is not null && error.ErrorType == AcmeErrorType.AlreadyReplaced)
        {
            // The CA already holds a replacement (perhaps one this side failed to store), so this
            // order cannot claim to be it. An ordinary order still renews the certificate.
            LogAlreadyReplaced(logger, request.Name);
            return await client.NewOrderAsync(account, identifiers, replaces: null, request.Profile, cancellationToken);
        }
    }

    private async Task AuthorizeAsync(
        AcmeAccount account,
        AcmeOrder order,
        bool preferDns01,
        IProgress<AcmeIssueProgress>? progress,
        CancellationToken cancellationToken)
    {
        var pending = new List<(AcmeAuthorization Authorization, AcmeChallenge Challenge)>();
        foreach (var url in order.Authorizations)
        {
            var authorization = await client.GetAuthorizationAsync(account, url, cancellationToken);
            if (authorization.Status == AcmeStatus.Valid)
            {
                // The CA still holds a valid authorization for this name (RFC 8555 section 7.1.3).
                continue;
            }

            if (authorization.Status != AcmeStatus.Pending)
            {
                // Invalid, expired or deactivated before anything was answered: nothing to retry here.
                var reason = authorization.Challenges.FirstOrDefault(challenge => challenge.Error is not null)?.Error
                    ?? new AcmeProblem(string.Empty) { Detail = $"The CA's authorization for it is {AcmeStatuses.Name(authorization.Status)}." };
                throw AcmeValidationException.Create(authorization.Domain, challengeType: null, reason);
            }

            var challenge = ChooseChallenge(authorization, preferDns01)
                ?? throw new AcmeException(
                    $"The CA offers no challenge for {authorization.Domain} that this server can answer"
                    + (authorization.Wildcard ? " (a wildcard needs DNS-01)." : "."));
            pending.Add((authorization, challenge));
        }

        var cleanups = new List<Func<CancellationToken, Task>>();
        try
        {
            foreach (var (authorization, challenge) in pending)
            {
                progress?.Report(new AcmeIssueProgress(AcmeIssueStep.PublishingChallenge, authorization.Domain));
                await PublishAsync(account, authorization, challenge, cleanups, cancellationToken);
            }

            foreach (var (_, challenge) in pending)
            {
                await client.RespondToChallengeAsync(account, challenge, cancellationToken);
            }

            foreach (var (authorization, challenge) in pending)
            {
                progress?.Report(new AcmeIssueProgress(AcmeIssueStep.Validating, authorization.Domain));
                var result = await client.WaitForAuthorizationAsync(account, authorization.Url, cancellationToken);
                if (result.Status != AcmeStatus.Valid)
                {
                    var failed = result.FindChallenge(challenge.Type) ?? result.Challenges.FirstOrDefault(item => item.Error is not null);
                    throw AcmeValidationException.Create(authorization.Domain, challenge.Type, failed?.Error);
                }

                LogValidated(logger, authorization.Domain, challenge.Type);
            }
        }
        finally
        {
            await CleanUpAsync(cleanups);
        }
    }

    private AcmeChallenge? ChooseChallenge(AcmeAuthorization authorization, bool preferDns01)
    {
        var http = http01 is not null && !authorization.Wildcard ? authorization.FindChallenge(AcmeChallengeTypes.Http01) : null;
        var dns = dns01 is not null ? authorization.FindChallenge(AcmeChallengeTypes.Dns01) : null;
        return preferDns01 ? dns ?? http : http ?? dns;
    }

    private async Task PublishAsync(
        AcmeAccount account,
        AcmeAuthorization authorization,
        AcmeChallenge challenge,
        List<Func<CancellationToken, Task>> cleanups,
        CancellationToken cancellationToken)
    {
        var domain = authorization.Identifier.Value;
        if (challenge.Type == AcmeChallengeTypes.Http01)
        {
            var publisher = http01!;
            var token = challenge.Token ?? throw new AcmeException($"The CA's HTTP-01 challenge for {domain} has no token.");
            var keyAuthorization = challenge.KeyAuthorization(account.Key);
            cleanups.Add(cleanupToken => publisher.RemoveAsync(domain, token, cleanupToken));
            await publisher.PublishAsync(domain, token, keyAuthorization, cancellationToken);
        }
        else
        {
            var hook = dns01!;
            var recordName = $"_acme-challenge.{domain}";
            var value = challenge.DnsTxtValue(account.Key);
            cleanups.Add(cleanupToken => hook.RemoveAsync(domain, recordName, value, cleanupToken));
            await hook.PublishAsync(domain, recordName, value, cancellationToken);
        }
    }

    private async Task CleanUpAsync(List<Func<CancellationToken, Task>> cleanups)
    {
        using var timeout = new CancellationTokenSource(_cleanupTimeout, time);
        foreach (var cleanup in cleanups)
        {
            try
            {
                await cleanup(timeout.Token);
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                // A leftover challenge answer is harmless; the error that ended issuance matters more.
                LogCleanupFailed(logger, error);
            }
        }
    }

    private async Task<AcmeCertificateChain> ChooseChainAsync(
        AcmeAccount account,
        AcmeCertificateChain chain,
        string? preferred,
        CancellationToken cancellationToken)
    {
        if (preferred is null || Matches(chain, preferred))
        {
            return chain;
        }

        foreach (var url in chain.Alternates)
        {
            var alternate = await client.DownloadCertificateAsync(account, url, cancellationToken);
            if (Matches(alternate, preferred) && alternate.Certificates[0].AsSpan().SequenceEqual(chain.Certificates[0]))
            {
                return alternate;
            }
        }

        // A preference, not a requirement: without a match the CA's default chain is used.
        LogPreferredChainMissing(logger, preferred);
        return chain;

        static bool Matches(AcmeCertificateChain candidate, string name) =>
            string.Equals(candidate.TopIssuerName(), name, StringComparison.OrdinalIgnoreCase);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Ordering a certificate {Name} for {Domains}.")]
    private static partial void LogOrdering(ILogger logger, string name, IEnumerable<string> domains);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Validated {Domain} over {ChallengeType}.")]
    private static partial void LogValidated(ILogger logger, string domain, string challengeType);

    [LoggerMessage(Level = LogLevel.Information, Message = "Issued certificate {Name}, valid until {NotAfter}.")]
    private static partial void LogIssued(ILogger logger, string name, DateTimeOffset notAfter);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The CA already holds a replacement for certificate {Name}; ordering without replaces.")]
    private static partial void LogAlreadyReplaced(ILogger logger, string name);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The CA offers no chain issued by {Preferred}; keeping its default chain.")]
    private static partial void LogPreferredChainMissing(ILogger logger, string preferred);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Removing a challenge answer failed; it is left in place.")]
    private static partial void LogCleanupFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Information, Message = "Revoked certificate {Name} ({Reason}).")]
    private static partial void LogRevoked(ILogger logger, string name, AcmeRevocationReason reason);

    [LoggerMessage(
        Level = LogLevel.Error,
        Message = "The CA moved the ACME account to a new key, but storing it failed; the account has to be registered again.")]
    private static partial void LogRolloverNotSaved(ILogger logger, Exception error);
}
