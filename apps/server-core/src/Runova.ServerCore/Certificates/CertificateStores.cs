using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Certificates;

/// <summary>ACME accounts in the database, one per CA directory, the key sealed with Data Protection.</summary>
internal sealed class EfAcmeAccountStore(IDbContextFactory<CoreDbContext> contexts, CertificateKeys keys, TimeProvider time) : IAcmeAccountStore
{
    public async Task<AcmeAccount?> FindAsync(Uri directoryUrl, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(directoryUrl);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.AcmeAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.DirectoryUrl == directoryUrl.AbsoluteUri, cancellationToken);
        if (row is null)
        {
            return null;
        }

        var pkcs8 = keys.UnprotectAccountKey(row.ProtectedKey);
        try
        {
            return new AcmeAccount(new Uri(row.DirectoryUrl), new Uri(row.Url), AcmeAccountKey.FromPkcs8(pkcs8))
            {
                Status = AcmeStatuses.Parse(row.Status),
                Contact = JsonSerializer.Deserialize<string[]>(row.Contact, CoreJson.Options) ?? [],
            };
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pkcs8);
        }
    }

    public async Task SaveAsync(AcmeAccount account, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var directory = account.DirectoryUrl.AbsoluteUri;
        var row = await db.AcmeAccounts.FirstOrDefaultAsync(a => a.DirectoryUrl == directory, cancellationToken);
        if (row is null)
        {
            row = new AcmeAccountRecord
            {
                DirectoryUrl = directory,
                Url = string.Empty,
                ProtectedKey = string.Empty,
                Status = string.Empty,
                Contact = "[]",
                CreatedAt = time.GetUtcNow().ToUnixTimeMilliseconds(),
            };
            db.AcmeAccounts.Add(row);
        }

        var pkcs8 = account.Key.ExportPkcs8();
        try
        {
            row.ProtectedKey = keys.ProtectAccountKey(pkcs8);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pkcs8);
        }

        row.Url = account.Url.AbsoluteUri;
        row.Status = AcmeStatuses.Name(account.Status);
        row.Contact = JsonSerializer.Serialize(account.Contact, CoreJson.Options);
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>
/// Issued certificates in the Certificates table, keyed by site, the key sealed with Data
/// Protection. A newly issued certificate starts its renewal planning over.
/// </summary>
internal sealed class EfAcmeCertificateStore(IDbContextFactory<CoreDbContext> contexts, CertificateKeys keys) : IAcmeCertificateStore
{
    public async Task<AcmeCertificateRecord?> FindAsync(string name, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(name);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.Certificates.AsNoTracking()
            .FirstOrDefaultAsync(c => c.SiteId == name && c.Source == CertificateViews.AcmeSource, cancellationToken);
        if (row is null || row.DirectoryUrl is null || row.CertificateId is null)
        {
            return null;
        }

        return new AcmeCertificateRecord
        {
            Name = row.SiteId,
            DirectoryUrl = new Uri(row.DirectoryUrl),
            Domains = CertificateViews.DomainsOf(row),
            KeyType = Enum.Parse<AcmeCertificateKeyType>(row.KeyType),
            ChainPem = row.ChainPem,
            PrivateKeyPkcs8 = keys.UnprotectCertificateKey(row.ProtectedKey),
            CertificateId = row.CertificateId,
            NotBefore = DateTimeOffset.FromUnixTimeMilliseconds(row.NotBefore),
            NotAfter = DateTimeOffset.FromUnixTimeMilliseconds(row.NotAfter),
            IssuedAt = DateTimeOffset.FromUnixTimeMilliseconds(row.IssuedAt),
            Replaced = row.Replaced,
            PreferredChain = row.PreferredChain,
            RevokedAt = row.RevokedAt is { } revoked ? DateTimeOffset.FromUnixTimeMilliseconds(revoked) : null,
        };
    }

    public async Task SaveAsync(AcmeCertificateRecord record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.Certificates.FirstOrDefaultAsync(c => c.SiteId == record.Name, cancellationToken);
        var fresh = row is null || row.CertificateId != record.CertificateId;
        if (row is null)
        {
            row = new SiteCertificate
            {
                SiteId = record.Name,
                Source = CertificateViews.AcmeSource,
                Domains = "[]",
                KeyType = string.Empty,
                ChainPem = string.Empty,
                ProtectedKey = string.Empty,
                Issuer = string.Empty,
            };
            db.Certificates.Add(row);
        }

        using (var leaf = X509Certificate2.CreateFromPem(record.ChainPem))
        {
            row.Issuer = leaf.GetNameInfo(X509NameType.SimpleName, forIssuer: true);
        }

        row.Source = CertificateViews.AcmeSource;
        row.DirectoryUrl = record.DirectoryUrl.AbsoluteUri;
        row.Domains = JsonSerializer.Serialize(record.Domains, CoreJson.Options);
        row.KeyType = record.KeyType.ToString();
        row.ChainPem = record.ChainPem;
        row.ProtectedKey = keys.ProtectCertificateKey(record.PrivateKeyPkcs8.Span);
        row.CertificateId = record.CertificateId;
        row.NotBefore = record.NotBefore.ToUnixTimeMilliseconds();
        row.NotAfter = record.NotAfter.ToUnixTimeMilliseconds();
        row.IssuedAt = record.IssuedAt.ToUnixTimeMilliseconds();
        row.Replaced = record.Replaced;
        row.PreferredChain = record.PreferredChain;
        row.RevokedAt = record.RevokedAt?.ToUnixTimeMilliseconds();
        if (fresh)
        {
            row.AutoRenew = true;
            row.RenewAt = null;
            row.WindowStart = null;
            row.WindowEnd = null;
            row.NextCheckAt = null;
            row.ExplanationUrl = null;
            row.FailedAttempts = 0;
            row.NextAttemptAt = null;
            row.LastError = null;
        }

        await db.SaveChangesAsync(cancellationToken);
    }
}
