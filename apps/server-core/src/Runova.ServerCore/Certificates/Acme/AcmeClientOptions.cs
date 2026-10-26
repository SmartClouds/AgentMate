namespace Runova.ServerCore.Certificates.Acme;

/// <summary>Well-known ACME directories.</summary>
internal static class AcmeDirectories
{
    public static readonly Uri LetsEncryptProduction = new("https://acme-v02.api.letsencrypt.org/directory");

    /// <summary>Let's Encrypt's staging CA: untrusted certificates, far higher rate limits.</summary>
    public static readonly Uri LetsEncryptStaging = new("https://acme-staging-v02.api.letsencrypt.org/directory");
}

/// <summary>How a client talks to one CA, and how patient it is.</summary>
internal sealed record AcmeClientOptions
{
    public required Uri DirectoryUrl { get; init; }

    /// <summary>RFC 8555 section 6.1 asks every client to identify itself.</summary>
    public string UserAgent { get; init; } = $"runova-core/{CoreVersion.Current}";

    /// <summary>How long one request may take, answer body included.</summary>
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>How long validation or issuance may take in all before the client gives up.</summary>
    public TimeSpan PollTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>The first wait between polls when the CA sends no Retry-After; it doubles from there.</summary>
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>The longest wait between polls, whatever Retry-After says.</summary>
    public TimeSpan MaxPollInterval { get; init; } = TimeSpan.FromMinutes(1);

    /// <summary>Answers larger than this are refused. Real ones are a few kilobytes.</summary>
    public int MaxResponseBytes { get; init; } = 256 * 1024;

    /// <summary>How often a request is retried after badNonce before the error is passed on.</summary>
    public int BadNonceRetries { get; init; } = 5;

    /// <exception cref="ArgumentException">A value is out of range, or the directory is not HTTPS.</exception>
    public AcmeClientOptions Validate()
    {
        if (DirectoryUrl is not { IsAbsoluteUri: true } || DirectoryUrl.Scheme != Uri.UriSchemeHttps)
        {
            throw new ArgumentException("The ACME directory must be an absolute HTTPS URL.", nameof(DirectoryUrl));
        }

        if (string.IsNullOrWhiteSpace(UserAgent)
            || RequestTimeout <= TimeSpan.Zero
            || PollTimeout <= TimeSpan.Zero
            || PollInterval <= TimeSpan.Zero
            || MaxPollInterval < PollInterval
            || MaxResponseBytes < 1024
            || BadNonceRetries < 0)
        {
            throw new ArgumentException("The ACME client options are out of range.");
        }

        return this;
    }
}
