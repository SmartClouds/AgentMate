using Tapper;

namespace Runova.ServerCore.Contracts;

// TLS certificates for sites (E11): Let's Encrypt over ACME, or uploaded by hand. Private keys
// never leave the core; they are sealed in its database and written for nginx as root-only files.

[TranspilationSource]
public enum CertificateSource
{
    Acme,
    Uploaded,

    /// <summary>
    /// Signed by Cloudflare's Origin CA (E14): trusted by Cloudflare's edge only, so the site has
    /// to stay proxied. The key was made on this server and never left it.
    /// </summary>
    CloudflareOrigin,
}

[TranspilationSource]
public enum CertificateState
{
    Valid,

    /// <summary>Less than 14 days left.</summary>
    ExpiringSoon,

    Expired,
    Revoked,
}

/// <summary>
/// A site's certificate and where its renewal stands. RenewAtUnixMs is when the core plans to
/// renew (inside the CA's ARI window, or two thirds into the lifetime when the CA has none).
/// After a failed attempt, NextAttemptAtUnixMs is when it tries again.
/// </summary>
[TranspilationSource]
public sealed record CertificateInfo(
    string SiteId,
    CertificateSource Source,
    CertificateState State,
    string[] Domains,
    string Issuer,
    long NotBeforeUnixMs,
    long NotAfterUnixMs,
    bool AutoRenew,
    bool Staging = false,
    long? RenewAtUnixMs = null,
    long? LastAttemptAtUnixMs = null,
    string? LastError = null,
    Guid? LastJobId = null,
    int FailedAttempts = 0,
    long? NextAttemptAtUnixMs = null,
    long? RevokedAtUnixMs = null,
    string? ExplanationUrl = null);

/// <summary>
/// Issue a certificate for every domain of the site. The account for the CA is made on first use,
/// which needs the CA's terms of service accepted. Staging is Let's Encrypt's test CA (untrusted
/// certificates, high limits).
/// </summary>
[TranspilationSource]
public sealed record CertificateIssueRequest(
    string SiteId,
    bool AcceptTermsOfService = false,
    string? ContactEmail = null,
    bool Staging = false,
    bool PreferDns01 = false);

/// <summary>PEM text: the certificate with its chain (any order), and its unencrypted private key.</summary>
[TranspilationSource]
public sealed record CertificateUploadRequest(string SiteId, string CertificatePem, string PrivateKeyPem);

[TranspilationSource]
public enum CertificateRevocationReason
{
    Unspecified,
    KeyCompromise,
    Superseded,
    CessationOfOperation,
}

/// <summary>
/// Takes the certificate off the site (it serves plain HTTP again). Revoke also asks the CA to
/// revoke a Let's Encrypt certificate; an uploaded one is only removed.
/// </summary>
[TranspilationSource]
public sealed record CertificateRemoveRequest(
    string SiteId,
    bool Revoke = false,
    CertificateRevocationReason Reason = CertificateRevocationReason.Unspecified);

/// <summary>Problems with the upload, or the stored certificate and how applying it went.</summary>
[TranspilationSource]
public sealed record CertificateUploadResult(string[] Problems, CertificateInfo? Certificate = null, NginxApplyResult? Apply = null);
