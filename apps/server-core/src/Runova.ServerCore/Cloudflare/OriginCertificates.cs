using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Cloudflare;

/// <summary>
/// Cloudflare Origin CA certificates (E14 T5). The key is made here and sealed at once; only its
/// signing request leaves, for the app to send to Cloudflare with the account token (which never
/// reaches this server). The signed certificate comes back and goes through the same checks as an
/// upload (it must belong to the key, cover every domain and be valid now), then nginx applies it.
/// </summary>
internal sealed class OriginCertificates(
    IDbContextFactory<CoreDbContext> contexts,
    WebSites sites,
    CertificateService certificates,
    CertificateKeys keys,
    TimeProvider time)
{
    /// <summary>What Cloudflare's API calls an ECDSA request.</summary>
    public const string RequestType = "origin-ecc";

    /// <summary>A request older than this is refused: the app sends it to Cloudflare at once.</summary>
    public static readonly TimeSpan RequestLifetime = TimeSpan.FromHours(1);

    public async Task<OriginCertificateRequestInfo> CreateRequestAsync(string? siteId, CancellationToken cancellationToken)
    {
        var site = await RequireSiteAsync(siteId, cancellationToken);
        var hostnames = site.Settings.Domains.Select(domain => domain.ToLowerInvariant()).Distinct(StringComparer.Ordinal).ToArray();
        if (hostnames.Length == 0)
        {
            throw new ArgumentException("The site has no domains to put on a certificate.", nameof(siteId));
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest(new X500DistinguishedName($"CN={hostnames[0].TrimStart('*', '.')}"), key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();
        foreach (var hostname in hostnames)
        {
            names.AddDnsName(hostname);
        }

        request.CertificateExtensions.Add(names.Build());
        var csr = request.CreateSigningRequestPem();
        var pkcs8 = key.ExportPkcs8PrivateKey();
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await db.OriginCertificateKeys.Where(k => k.SiteId == site.Settings.Id).ExecuteDeleteAsync(cancellationToken);
            db.OriginCertificateKeys.Add(new OriginCertificateKey
            {
                SiteId = site.Settings.Id,
                ProtectedKey = keys.ProtectCertificateKey(pkcs8),
                Hostnames = JsonSerializer.Serialize(hostnames, CoreJson.Options),
                CreatedAt = now,
            });
            await db.SaveChangesAsync(cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pkcs8);
        }

        return new OriginCertificateRequestInfo(site.Settings.Id, csr, hostnames, RequestType, now);
    }

    public async Task<CertificateUploadResult> InstallAsync(OriginCertificateInstall? request, Requester who, CancellationToken cancellationToken)
    {
        var site = await RequireSiteAsync(request?.SiteId, cancellationToken);
        OriginCertificateKey? pending;
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            pending = await db.OriginCertificateKeys.AsNoTracking().FirstOrDefaultAsync(k => k.SiteId == site.Settings.Id, cancellationToken);
        }

        if (pending is null)
        {
            return new CertificateUploadResult(["This server has no key waiting for an Origin CA certificate for this site. Start again from the SSL tab."]);
        }

        if (time.GetUtcNow() - DateTimeOffset.FromUnixTimeMilliseconds(pending.CreatedAt) > RequestLifetime)
        {
            return new CertificateUploadResult(["The signing request is more than an hour old. Start again from the SSL tab."]);
        }

        var result = await certificates.UploadAsync(
            new CertificateUploadRequest(site.Settings.Id, request!.CertificatePem, keys.CertificateKeyPem(pending.ProtectedKey)),
            who,
            cancellationToken,
            CertificateViews.CloudflareOriginSource);
        if (result.Problems.Length == 0)
        {
            await using var db = await contexts.CreateDbContextAsync(CancellationToken.None);
            await db.OriginCertificateKeys.Where(k => k.SiteId == site.Settings.Id).ExecuteDeleteAsync(CancellationToken.None);
        }

        return result;
    }

    private async Task<SiteInfo> RequireSiteAsync(string? siteId, CancellationToken cancellationToken) =>
        NginxValidator.IsId(siteId) && await sites.GetSiteAsync(siteId!, cancellationToken) is { } site
            ? site
            : throw new ArgumentException("There is no such site.", nameof(siteId));
}
