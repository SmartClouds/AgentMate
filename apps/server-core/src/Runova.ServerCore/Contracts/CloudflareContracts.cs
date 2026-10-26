using Tapper;

namespace Runova.ServerCore.Contracts;

// Cloudflare on the server side (E14). The account token stays in the desktop app; the core only
// ever holds a zone-scoped DNS token a person sent it for DNS-01, which it never sends back. It
// fetches Cloudflare's published address ranges itself (no token needed) to lock the origin.

/// <summary>Cloudflare's published edge ranges, as the core last fetched them.</summary>
[TranspilationSource]
public sealed record CloudflareRanges(string[] Ipv4, string[] Ipv6, long FetchedAtUnixMs);

[TranspilationSource]
public enum OriginLockState
{
    /// <summary>Ports 80 and 443 are not limited to Cloudflare.</summary>
    Off,

    /// <summary>The firewall change is applied and waits for its confirmation.</summary>
    Pending,

    /// <summary>The firewall matches the ranges for IPv4 and IPv6.</summary>
    On,

    /// <summary>The lock is meant to be on, but the firewall does not match the ranges (see the lists).</summary>
    Drifted,
}

/// <summary>
/// The origin lock: ports 80 and 443 open to Cloudflare's ranges only, nginx taking the visitor's
/// address from CF-Connecting-IP when a request comes from one of them, and optionally only
/// accepting TLS from Cloudflare's client certificate (Authenticated Origin Pulls).
/// MissingRules, OpenRules and StaleRules say how the firewall differs from what the lock needs:
/// a range not allowed yet, a rule that still lets everyone in, a Cloudflare rule for a range
/// Cloudflare no longer lists.
/// </summary>
[TranspilationSource]
public sealed record OriginLockStatus(
    bool Enabled,
    bool AuthenticatedOriginPulls,
    OriginLockState State,
    int[] Ports,
    string[] MissingRules,
    string[] OpenRules,
    string[] StaleRules,
    string[] Warnings,
    CloudflareRanges? Ranges = null,
    long? LastRefreshAtUnixMs = null,
    string? LastRefreshError = null,
    Guid? ChangeSetId = null,
    FirewallChangeState? ChangeState = null);

/// <summary>
/// Turn the lock on or off. SshConnection is `$SSH_CONNECTION` as for any firewall change, so the
/// lockout guard knows what to keep open; the change then waits for its confirmation like any other.
/// </summary>
[TranspilationSource]
public sealed record OriginLockRequest(bool Enabled, bool AuthenticatedOriginPulls = false, string? SshConnection = null);

/// <summary>
/// What turning the lock on or off would do. Firewall is null when the firewall already matches
/// (only nginx changes then); Changes are the firewall changes it would apply.
/// </summary>
[TranspilationSource]
public sealed record OriginLockPreview(FirewallChange[] Changes, string[] Notes, CloudflareRanges Ranges, FirewallChangePreview? Firewall = null);

/// <summary>The lock as it now stands, the firewall change waiting for its confirmation (if any), and how nginx took it.</summary>
[TranspilationSource]
public sealed record OriginLockResult(OriginLockStatus Status, NginxApplyResult Nginx, FirewallChangeSetInfo? ChangeSet = null);

/// <summary>
/// A key made on this server for a Cloudflare Origin CA certificate, and its signing request. The
/// app sends the request to Cloudflare and brings the certificate back with InstallOriginCertificate.
/// </summary>
[TranspilationSource]
public sealed record OriginCertificateRequestInfo(string SiteId, string CsrPem, string[] Hostnames, string RequestType, long CreatedAtUnixMs);

/// <summary>The certificate Cloudflare signed for the request this server made (PEM, the leaf alone is fine).</summary>
[TranspilationSource]
public sealed record OriginCertificateInstall(string SiteId, string CertificatePem);

/// <summary>
/// A zone-scoped Cloudflare token with DNS edit rights, for DNS-01. Token is write-only: the core
/// seals it and never returns it. TokenId is Cloudflare's id for it, when the app made the token,
/// so the app can delete it at Cloudflare again later.
/// </summary>
[TranspilationSource]
public sealed record DnsCredentialRequest(string Zone, string ZoneId, string Token, string? TokenId = null);

/// <summary>A stored DNS token, without the token.</summary>
[TranspilationSource]
public sealed record DnsCredentialInfo(
    string Zone,
    string ZoneId,
    string Provider,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    string? TokenId = null,
    string? CreatedBy = null,
    long? LastUsedAtUnixMs = null,
    string? LastError = null);

/// <summary>Saved when Problems is empty; otherwise nothing was saved.</summary>
[TranspilationSource]
public sealed record DnsCredentialSaveResult(string[] Problems, DnsCredentialInfo? Credential = null);
