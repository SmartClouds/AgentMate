using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Certificates;

/// <summary>
/// Seals private keys (certificate keys and ACME account keys) with Data Protection before they
/// reach the database, each kind under its own purpose so one can never be read as the other.
/// </summary>
internal sealed class CertificateKeys(IDataProtectionProvider provider)
{
    private readonly IDataProtector _certificates = provider.CreateProtector(FrozenIdentifiers.CertificatePrivateKeyPurpose);
    private readonly IDataProtector _accounts = provider.CreateProtector(FrozenIdentifiers.AcmeAccountKeyPurpose);

    public string ProtectCertificateKey(ReadOnlySpan<byte> pkcs8) => Convert.ToBase64String(_certificates.Protect(pkcs8.ToArray()));

    public byte[] UnprotectCertificateKey(string sealedKey) => _certificates.Unprotect(Convert.FromBase64String(sealedKey));

    public string ProtectAccountKey(ReadOnlySpan<byte> pkcs8) => Convert.ToBase64String(_accounts.Protect(pkcs8.ToArray()));

    public byte[] UnprotectAccountKey(string sealedKey) => _accounts.Unprotect(Convert.FromBase64String(sealedKey));

    /// <summary>The key as nginx reads it: unencrypted PKCS#8 PEM, written root-only.</summary>
    public string CertificateKeyPem(string sealedKey)
    {
        var pkcs8 = UnprotectCertificateKey(sealedKey);
        try
        {
            return PemEncoding.WriteString("PRIVATE KEY", pkcs8) + "\n";
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pkcs8);
        }
    }
}

/// <summary>Certificate rows as the app sees them.</summary>
internal static class CertificateViews
{
    public const string AcmeSource = "acme";
    public const string UploadedSource = "uploaded";
    public const string CloudflareOriginSource = "cloudflare-origin";

    /// <summary>A certificate with less than this left shows as expiring.</summary>
    public static readonly TimeSpan ExpiringSoon = TimeSpan.FromDays(14);

    public static CertificateInfo ToInfo(SiteCertificate row, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(row);
        var nowMs = now.ToUnixTimeMilliseconds();
        var state = row.RevokedAt is not null ? CertificateState.Revoked
            : row.NotAfter <= nowMs ? CertificateState.Expired
            : row.NotAfter - nowMs < (long)ExpiringSoon.TotalMilliseconds ? CertificateState.ExpiringSoon
            : CertificateState.Valid;
        return new CertificateInfo(
            row.SiteId,
            row.Source switch
            {
                UploadedSource => CertificateSource.Uploaded,
                CloudflareOriginSource => CertificateSource.CloudflareOrigin,
                _ => CertificateSource.Acme,
            },
            state,
            DomainsOf(row),
            row.Issuer,
            row.NotBefore,
            row.NotAfter,
            row.AutoRenew,
            row.DirectoryUrl is { } directory && IsStaging(new Uri(directory)),
            row.RenewAt,
            row.LastAttemptAt,
            row.LastError,
            row.LastJobId,
            row.FailedAttempts,
            row.NextAttemptAt,
            row.RevokedAt,
            row.ExplanationUrl);
    }

    public static string[] DomainsOf(SiteCertificate row) => JsonSerializer.Deserialize<string[]>(row.Domains, CoreJson.Options) ?? [];

    public static bool IsStaging(Uri directory) =>
        directory == AcmeDirectories.LetsEncryptStaging || directory.Host.Contains("staging", StringComparison.OrdinalIgnoreCase);
}
