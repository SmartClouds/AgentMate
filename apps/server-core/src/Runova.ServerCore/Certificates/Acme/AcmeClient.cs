using System.Buffers.Text;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// An ACME v2 client (RFC 8555) for one CA directory, on BCL crypto only: accounts and key
/// changes, orders, authorizations, challenges, finalization, chain download and revocation,
/// plus renewal information (ARI, RFC 9773). Every request is signed ES256 with the account key
/// and runs under a time limit on the given clock; polling honors Retry-After.
/// </summary>
/// <remarks>
/// The HttpClient should come from <see cref="AcmeTransport.CreateHandler"/> (no redirects) with
/// an infinite timeout. This client is safe to share; it caches the directory and a few nonces.
/// </remarks>
internal sealed partial class AcmeClient
{
    private const string JsonMediaType = "application/json";
    private const string PemChainMediaType = "application/pem-certificate-chain";
    private const int MaxAlternateChains = 5;

    private static readonly TimeSpan _renewalInfoDefaultRecheck = TimeSpan.FromHours(6);
    private static readonly TimeSpan _renewalInfoMinRecheck = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan _renewalInfoMaxRecheck = TimeSpan.FromDays(1);

    private readonly AcmeTransport _transport;
    private readonly AcmeClientOptions _options;
    private readonly TimeProvider _time;
    private readonly ILogger<AcmeClient> _logger;
    private AcmeDirectory? _directory;

    public AcmeClient(HttpClient http, AcmeClientOptions options, TimeProvider time, ILogger<AcmeClient> logger)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(time);
        ArgumentNullException.ThrowIfNull(logger);
        _options = options.Validate();
        _time = time;
        _logger = logger;
        _transport = new AcmeTransport(http, _options, time, logger);
    }

    public Uri DirectoryUrl => _options.DirectoryUrl;

    /// <summary>The CA's directory, read on first use and then kept.</summary>
    public async Task<AcmeDirectory> GetDirectoryAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _directory) is { } cached)
        {
            return cached;
        }

        const string Operation = "Reading the ACME directory";
        var response = await _transport.GetAsync(_options.DirectoryUrl, JsonMediaType, Operation, cancellationToken);
        using var json = response.ReadJson(Operation);
        var directory = AcmeDirectory.Parse(_options.DirectoryUrl, json.RootElement);
        LogDirectoryRead(_logger, _options.DirectoryUrl.Host, directory.RenewalInfo is not null);
        return Interlocked.CompareExchange(ref _directory, directory, null) ?? directory;
    }

    /// <summary>Registers a new account (RFC 8555 section 7.3). The account takes over the key.</summary>
    /// <param name="key">The new account's key.</param>
    /// <param name="contactEmails">Addresses the CA may write to about expiring certificates; may be empty.</param>
    /// <param name="termsOfServiceAgreed">Whether the operator accepted the CA's terms of service.</param>
    /// <param name="cancellationToken">Stops the request.</param>
    /// <exception cref="ArgumentException">A contact is not a plain email address.</exception>
    /// <exception cref="AcmeException">The terms are not accepted, or the CA refused.</exception>
    public async Task<AcmeAccount> CreateAccountAsync(
        AcmeAccountKey key,
        IReadOnlyCollection<string> contactEmails,
        bool termsOfServiceAgreed,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(contactEmails);
        const string Operation = "Creating the ACME account";
        var contact = contactEmails.Select(ToMailto).ToArray();
        var directory = await GetDirectoryAsync(cancellationToken);
        if (directory.ExternalAccountRequired)
        {
            throw new AcmeException($"{Operation} failed: this CA needs an external account binding, which is not supported.");
        }

        if (directory.TermsOfService is { } terms && !termsOfServiceAgreed)
        {
            throw new AcmeException($"{Operation} needs the CA's terms of service to be accepted first: {terms.AbsoluteUri}");
        }

        var payload = AcmeJson.Write(writer =>
        {
            if (contact.Length > 0)
            {
                writer.WriteStartArray("contact");
                foreach (var address in contact)
                {
                    writer.WriteStringValue(address);
                }

                writer.WriteEndArray();
            }

            if (termsOfServiceAgreed)
            {
                writer.WriteBoolean("termsOfServiceAgreed", true);
            }
        });
        var response = await _transport.PostAsync(
            directory.NewAccount, key, keyId: null, payload, directory.NewNonce, JsonMediaType, Operation, cancellationToken);
        var account = ReadAccount(directory, key, response, Operation);
        LogAccountCreated(_logger, directory.Url.Host);
        return account;
    }

    /// <summary>The account registered with this key, or null (onlyReturnExisting). The account takes over the key.</summary>
    public async Task<AcmeAccount?> FindAccountAsync(AcmeAccountKey key, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(key);
        const string Operation = "Looking up the ACME account";
        var directory = await GetDirectoryAsync(cancellationToken);
        var payload = AcmeJson.Write(writer => writer.WriteBoolean("onlyReturnExisting", true));
        try
        {
            var response = await _transport.PostAsync(
                directory.NewAccount, key, keyId: null, payload, directory.NewNonce, JsonMediaType, Operation, cancellationToken);
            return ReadAccount(directory, key, response, Operation);
        }
        catch (AcmeProblemException error) when (error.ErrorType == AcmeErrorType.AccountDoesNotExist)
        {
            return null;
        }
    }

    /// <summary>
    /// Moves the account to a new key (RFC 8555 section 7.3.5) and returns it with that key. The
    /// old account object keeps the old key, which the CA no longer accepts.
    /// </summary>
    public async Task<AcmeAccount> ChangeKeyAsync(AcmeAccount account, AcmeAccountKey newKey, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(newKey);
        const string Operation = "Changing the account key";
        var directory = await GetDirectoryAsync(cancellationToken);
        var url = directory.KeyChange ?? throw new AcmeException($"{Operation} failed: this CA does not offer key changes.");

        // The new key signs the account URL and the old key (without a nonce); the old key signs
        // that as the payload of an ordinary request.
        var inner = AcmeJws.Sign(
            newKey,
            url,
            nonce: null,
            keyId: null,
            AcmeJson.Write(writer =>
            {
                writer.WriteString("account", account.Url.AbsoluteUri);
                writer.WritePropertyName("oldKey");
                account.Key.Jwk.WriteTo(writer);
            }));
        await PostAsync(account, directory, url, inner, Operation, cancellationToken);
        LogKeyChanged(_logger, directory.Url.Host);
        return new AcmeAccount(account.DirectoryUrl, account.Url, newKey) { Status = account.Status, Contact = account.Contact };
    }

    /// <inheritdoc cref="NewOrderAsync(AcmeAccount, IReadOnlyList{AcmeIdentifier}, string?, string?, CancellationToken)"/>
    public Task<AcmeOrder> NewOrderAsync(
        AcmeAccount account,
        IReadOnlyList<AcmeIdentifier> identifiers,
        string? replaces,
        CancellationToken cancellationToken) =>
        NewOrderAsync(account, identifiers, replaces, profile: null, cancellationToken);

    /// <summary>Orders a certificate (RFC 8555 section 7.4).</summary>
    /// <param name="account">The account that orders.</param>
    /// <param name="identifiers">What the certificate is for.</param>
    /// <param name="replaces">
    /// The ARI identifier of the certificate this one renews (RFC 9773 section 5). Only sent when
    /// the CA advertises renewalInfo, as the RFC asks.
    /// </param>
    /// <param name="profile">A certificate profile the CA offers, or null for its default.</param>
    /// <param name="cancellationToken">Stops the request.</param>
    public async Task<AcmeOrder> NewOrderAsync(
        AcmeAccount account,
        IReadOnlyList<AcmeIdentifier> identifiers,
        string? replaces,
        string? profile,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(identifiers);
        if (identifiers.Count == 0)
        {
            throw new ArgumentException("An order needs at least one identifier.", nameof(identifiers));
        }

        if (replaces is not null && !AcmeCertificateId.IsWellFormed(replaces))
        {
            throw new ArgumentException("That is not an ARI certificate identifier.", nameof(replaces));
        }

        if (profile is not null && (profile.Length is 0 or > 64 || !profile.All(char.IsAsciiLetterOrDigit)))
        {
            throw new ArgumentException("That is not a profile name.", nameof(profile));
        }

        const string Operation = "Ordering the certificate";
        var directory = await GetDirectoryAsync(cancellationToken);
        var sendReplaces = replaces is not null && directory.RenewalInfo is not null;
        var payload = AcmeJson.Write(writer =>
        {
            writer.WriteStartArray("identifiers");
            foreach (var identifier in identifiers)
            {
                writer.WriteStartObject();
                writer.WriteString("type", identifier.Type);
                writer.WriteString("value", identifier.Value);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            if (sendReplaces)
            {
                writer.WriteString("replaces", replaces);
            }

            if (profile is not null)
            {
                writer.WriteString("profile", profile);
            }
        });
        var response = await PostAsync(account, directory, directory.NewOrder, payload, Operation, cancellationToken);
        var url = response.Location is { } location
            ? AcmeUrls.RequireHttps(location, Operation)
            : throw new AcmeException($"{Operation} failed: the CA did not say where the order is.");
        using var json = response.ReadJson(Operation);
        return AcmeOrder.Parse(url, json.RootElement, response.RetryAfter, Operation);
    }

    public async Task<AcmeOrder> GetOrderAsync(AcmeAccount account, Uri orderUrl, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(orderUrl);
        const string Operation = "Reading the order";
        var directory = await GetDirectoryAsync(cancellationToken);
        var response = await PostAsync(account, directory, orderUrl, ReadOnlyMemory<byte>.Empty, Operation, cancellationToken);
        using var json = response.ReadJson(Operation);
        return AcmeOrder.Parse(orderUrl, json.RootElement, response.RetryAfter, Operation);
    }

    public async Task<AcmeAuthorization> GetAuthorizationAsync(AcmeAccount account, Uri authorizationUrl, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(authorizationUrl);
        const string Operation = "Reading the authorization";
        var directory = await GetDirectoryAsync(cancellationToken);
        var response = await PostAsync(account, directory, authorizationUrl, ReadOnlyMemory<byte>.Empty, Operation, cancellationToken);
        using var json = response.ReadJson(Operation);
        return AcmeAuthorization.Parse(authorizationUrl, json.RootElement, response.RetryAfter, Operation);
    }

    /// <summary>Tells the CA the challenge is ready to be checked (RFC 8555 section 7.5.1).</summary>
    public async Task<AcmeChallenge> RespondToChallengeAsync(AcmeAccount account, AcmeChallenge challenge, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(challenge);
        const string Operation = "Answering the challenge";
        var directory = await GetDirectoryAsync(cancellationToken);
        var response = await PostAsync(account, directory, challenge.Url, "{}"u8.ToArray(), Operation, cancellationToken);
        using var json = response.ReadJson(Operation);
        return AcmeChallenge.Parse(json.RootElement, challenge.Url, Operation);
    }

    /// <summary>Polls the authorization until it is no longer pending, as Retry-After paces it.</summary>
    public Task<AcmeAuthorization> WaitForAuthorizationAsync(AcmeAccount account, Uri authorizationUrl, CancellationToken cancellationToken) =>
        PollAsync(
            token => GetAuthorizationAsync(account, authorizationUrl, token),
            authorization => authorization.Status != AcmeStatus.Pending,
            authorization => authorization.RetryAfter,
            authorization => $"Validating {authorization.Domain}",
            cancellationToken);

    /// <summary>
    /// Polls the order until it is neither pending nor processing: ready once every authorization
    /// is valid, valid once the certificate is issued, or invalid.
    /// </summary>
    public Task<AcmeOrder> WaitForOrderAsync(AcmeAccount account, Uri orderUrl, CancellationToken cancellationToken) =>
        PollAsync(
            token => GetOrderAsync(account, orderUrl, token),
            order => order.Status is not (AcmeStatus.Pending or AcmeStatus.Processing),
            order => order.RetryAfter,
            order => order.Status == AcmeStatus.Processing ? "Issuing the certificate" : "Getting the order ready",
            cancellationToken);

    /// <summary>Sends the CSR (DER) of a ready order (RFC 8555 section 7.4).</summary>
    public async Task<AcmeOrder> FinalizeAsync(AcmeAccount account, AcmeOrder order, ReadOnlyMemory<byte> csr, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(order);
        const string Operation = "Finalizing the order";
        var directory = await GetDirectoryAsync(cancellationToken);
        var payload = AcmeJson.Write(writer => writer.WriteString("csr", Base64Url.EncodeToString(csr.Span)));
        var response = await PostAsync(account, directory, order.Finalize, payload, Operation, cancellationToken);
        using var json = response.ReadJson(Operation);
        return AcmeOrder.Parse(order.Url, json.RootElement, response.RetryAfter, Operation);
    }

    /// <summary>Downloads the chain (RFC 8555 section 7.4.2), with the URLs of any alternate chains.</summary>
    public async Task<AcmeCertificateChain> DownloadCertificateAsync(AcmeAccount account, Uri certificateUrl, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(certificateUrl);
        const string Operation = "Downloading the certificate";
        var directory = await GetDirectoryAsync(cancellationToken);
        var response = await PostAsync(
            account, directory, certificateUrl, ReadOnlyMemory<byte>.Empty, Operation, cancellationToken, PemChainMediaType);
        var alternates = response.LinksTo("alternate")
            .Where(url => url.Scheme == Uri.UriSchemeHttps && url != certificateUrl)
            .Distinct()
            .Take(MaxAlternateChains)
            .ToList();
        return AcmeCertificateChain.Parse(Encoding.ASCII.GetString(response.Body.Span), alternates, Operation);
    }

    /// <summary>Revokes a certificate of this account (RFC 8555 section 7.6).</summary>
    public async Task RevokeCertificateAsync(
        AcmeAccount account,
        X509Certificate2 certificate,
        AcmeRevocationReason? reason,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(certificate);
        const string Operation = "Revoking the certificate";
        var directory = await GetDirectoryAsync(cancellationToken);
        var payload = AcmeJson.Write(writer =>
        {
            writer.WriteString("certificate", Base64Url.EncodeToString(certificate.RawData));
            if (reason is { } code)
            {
                writer.WriteNumber("reason", (int)code);
            }
        });
        await PostAsync(account, directory, directory.RevokeCert, payload, Operation, cancellationToken);
        LogRevoked(_logger, directory.Url.Host);
    }

    /// <inheritdoc cref="GetRenewalInfoAsync(string, CancellationToken)"/>
    public Task<AcmeRenewalInfo> GetRenewalInfoAsync(X509Certificate2 certificate, CancellationToken cancellationToken) =>
        GetRenewalInfoAsync(AcmeCertificateId.FromCertificate(certificate), cancellationToken);

    /// <summary>
    /// The CA's suggested renewal window (RFC 9773 section 4), from an unauthenticated GET. Not to
    /// be asked once the certificate has expired or been replaced.
    /// </summary>
    /// <exception cref="AcmeException">The CA offers no ARI, or its answer is not a usable window.</exception>
    public async Task<AcmeRenewalInfo> GetRenewalInfoAsync(string certificateId, CancellationToken cancellationToken)
    {
        if (!AcmeCertificateId.IsWellFormed(certificateId))
        {
            throw new ArgumentException("That is not an ARI certificate identifier.", nameof(certificateId));
        }

        const string Operation = "Reading the renewal window";
        var directory = await GetDirectoryAsync(cancellationToken);
        var baseUrl = directory.RenewalInfo
            ?? throw new AcmeException($"{Operation} failed: this CA does not offer renewal information (ARI).");
        var url = new Uri($"{baseUrl.AbsoluteUri.TrimEnd('/')}/{certificateId}");
        var response = await _transport.GetAsync(url, JsonMediaType, Operation, cancellationToken);
        using var json = response.ReadJson(Operation);
        var window = json.RootElement.ReadObject("suggestedWindow");
        var start = window?.ReadTimestamp("start");
        var end = window?.ReadTimestamp("end");
        if (start is not { } windowStart || end is not { } windowEnd)
        {
            throw new AcmeException($"{Operation} failed: the CA's answer has no suggested window.");
        }

        // RFC 9773 section 4.2: such a window is to be treated as no answer at all.
        if (windowEnd <= windowStart)
        {
            throw new AcmeException($"{Operation} failed: the CA's window ends before it starts.");
        }

        return new AcmeRenewalInfo
        {
            CertificateId = certificateId,
            WindowStart = windowStart,
            WindowEnd = windowEnd,
            ExplanationUrl = AcmeUrls.OptionalAnyScheme(json.RootElement, "explanationURL", url),
            RetryAfter = Clamp(response.RetryAfter ?? _renewalInfoDefaultRecheck, _renewalInfoMinRecheck, _renewalInfoMaxRecheck),
            CheckedAt = response.ReceivedAt,
        };
    }

    /// <summary>"mailto:" plus the address, for a plain address without parameters or a second address.</summary>
    /// <exception cref="ArgumentException">The address is not one the CA can use.</exception>
    internal static string ToMailto(string email)
    {
        ArgumentNullException.ThrowIfNull(email);
        var at = email.IndexOf('@', StringComparison.Ordinal);
        var valid = email.Length is > 4 and <= 254
            && at > 0
            && at == email.LastIndexOf('@')
            && email.IndexOf('.', at) > at + 1
            && !email.EndsWith('.')
            && email.All(character => character is > ' ' and < '\u007f'
                && character is not (',' or '?' or '#' or '<' or '>' or '"' or '\\' or '(' or ')' or ';' or ':' or '[' or ']' or '%'));
        return valid
            ? "mailto:" + email
            : throw new ArgumentException($"\"{AcmeText.Clean(email, 80)}\" is not an email address the CA can use.", nameof(email));
    }

    private static AcmeAccount ReadAccount(AcmeDirectory directory, AcmeAccountKey key, AcmeResponse response, string operation)
    {
        var url = response.Location is { } location
            ? AcmeUrls.RequireHttps(location, operation)
            : throw new AcmeException($"{operation} failed: the CA did not say where the account is.");
        using var json = response.ReadJson(operation);
        return new AcmeAccount(directory.Url, url, key)
        {
            Status = AcmeStatuses.Parse(json.RootElement.ReadString("status")),
            Contact = json.RootElement.ReadStrings("contact"),
        };
    }

    private Task<AcmeResponse> PostAsync(
        AcmeAccount account,
        AcmeDirectory directory,
        Uri url,
        ReadOnlyMemory<byte> payload,
        string operation,
        CancellationToken cancellationToken,
        string accept = JsonMediaType) =>
        _transport.PostAsync(url, account.Key, account.Url, payload, directory.NewNonce, accept, operation, cancellationToken);

    private async Task<T> PollAsync<T>(
        Func<CancellationToken, Task<T>> read,
        Func<T, bool> done,
        Func<T, TimeSpan?> retryAfter,
        Func<T, string> describe,
        CancellationToken cancellationToken)
    {
        var deadline = _time.GetUtcNow() + _options.PollTimeout;
        var backoff = _options.PollInterval;
        while (true)
        {
            var current = await read(cancellationToken);
            if (done(current))
            {
                return current;
            }

            var delay = Clamp(retryAfter(current) ?? backoff, _options.PollInterval, _options.MaxPollInterval);
            backoff = Clamp(backoff * 2, _options.PollInterval, _options.MaxPollInterval);
            if (_time.GetUtcNow() + delay > deadline)
            {
                throw new AcmeException(
                    $"{describe(current)} took longer than {AcmeDurations.Describe(_options.PollTimeout)}.",
                    new TimeoutException());
            }

            await Task.Delay(delay, _time, cancellationToken);
        }
    }

    private static TimeSpan Clamp(TimeSpan value, TimeSpan min, TimeSpan max) =>
        value < min ? min : value > max ? max : value;

    [LoggerMessage(Level = LogLevel.Debug, Message = "Read the ACME directory of {Host} (renewal information: {HasRenewalInfo}).")]
    private static partial void LogDirectoryRead(ILogger logger, string host, bool hasRenewalInfo);

    [LoggerMessage(Level = LogLevel.Information, Message = "Created an ACME account at {Host}.")]
    private static partial void LogAccountCreated(ILogger logger, string host);

    [LoggerMessage(Level = LogLevel.Information, Message = "Moved the ACME account at {Host} to a new key.")]
    private static partial void LogKeyChanged(ILogger logger, string host);

    [LoggerMessage(Level = LogLevel.Information, Message = "Revoked a certificate at {Host}.")]
    private static partial void LogRevoked(ILogger logger, string host);
}
