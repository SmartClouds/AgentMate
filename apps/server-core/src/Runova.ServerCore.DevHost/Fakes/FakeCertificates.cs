using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Cloudflare;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// A pretend CA for the DevHost: issuing and renewing take a moment and report every step, the
/// certificates chain to a throwaway in-memory root, and the renewal window sits two thirds into
/// the lifetime as Let's Encrypt's does. Nothing leaves the machine.
/// </summary>
internal sealed class FakeCertificateAuthorities(IAcmeCertificateStore store, TimeProvider time, DnsCredentials? credentials = null) : ICertificateAuthorities
{
    private readonly Lazy<(X509Certificate2 Root, ECDsa Key)> _root = new(CreateRoot);

    /// <summary>Like the real one: DNS-01 needs a DNS token for the zone of each name (E14).</summary>
    public async Task<bool> CanAnswerDns01Async(IReadOnlyList<string> domains, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(domains);
        foreach (var domain in domains)
        {
            if (credentials is null || await credentials.ForDomainAsync(domain, cancellationToken) is null)
            {
                return false;
            }
        }

        return true;
    }

    public ICertificateAuthority For(Uri directory) => new Authority(this, directory);

    private static (X509Certificate2, ECDsa) CreateRoot()
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Runova DevHost pretend CA", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        return (request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(5)), key);
    }

    private async Task<AcmeCertificateRecord> IssueAsync(Uri directory, AcmeIssueRequest request, string? replaces, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken)
    {
        foreach (var step in new[] { AcmeIssueStep.Ordering, AcmeIssueStep.PublishingChallenge, AcmeIssueStep.Validating, AcmeIssueStep.Finalizing, AcmeIssueStep.Downloading })
        {
            progress?.Report(new AcmeIssueProgress(step, step is AcmeIssueStep.PublishingChallenge or AcmeIssueStep.Validating ? request.Domains[0] : null));
            await Task.Delay(TimeSpan.FromMilliseconds(400), time, cancellationToken);
        }

        if (credentials is not null && (request.PreferDns01 || request.Domains.Any(domain => domain.StartsWith("*.", StringComparison.Ordinal))))
        {
            // Pretend DNS-01: the zone's token is "used", as the Cloudflare hook would use it.
            foreach (var domain in request.Domains)
            {
                if (await credentials.ForDomainAsync(domain, cancellationToken) is { } zone)
                {
                    await credentials.RecordUseAsync(zone.Zone, null);
                }
            }
        }

        var (root, rootKey) = _root.Value;
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var leafRequest = new CertificateRequest($"CN={request.Domains[0]}", key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();
        foreach (var domain in request.Domains)
        {
            names.AddDnsName(domain);
        }

        leafRequest.CertificateExtensions.Add(names.Build());
        leafRequest.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(root, includeKeyIdentifier: true, includeIssuerAndSerial: false));
        var now = time.GetUtcNow();
        var serial = RandomNumberGenerator.GetBytes(16);
        serial[0] &= 0x7f;
        using var leaf = leafRequest.Create(root.SubjectName, X509SignatureGenerator.CreateForECDsa(rootKey), now.AddMinutes(-1), now.AddDays(90), serial);
        var record = new AcmeCertificateRecord
        {
            Name = request.Name,
            DirectoryUrl = directory,
            Domains = request.Domains,
            KeyType = AcmeCertificateKeyType.EcdsaP256,
            ChainPem = leaf.ExportCertificatePem() + "\n" + root.ExportCertificatePem() + "\n",
            PrivateKeyPkcs8 = key.ExportPkcs8PrivateKey(),
            CertificateId = AcmeCertificateId.FromCertificate(leaf),
            NotBefore = now.AddMinutes(-1),
            NotAfter = now.AddDays(90),
            IssuedAt = now,
            Replaced = replaces,
        };
        progress?.Report(new AcmeIssueProgress(AcmeIssueStep.Saving));
        await store.SaveAsync(record, cancellationToken);
        return record;
    }

    private sealed class Authority(FakeCertificateAuthorities ca, Uri directory) : ICertificateAuthority
    {
        public Task EnsureAccountAsync(AcmeAccountSettings settings, CancellationToken cancellationToken) =>
            settings.TermsOfServiceAgreed ? Task.CompletedTask : throw new AcmeException("Accept the pretend CA's terms of service first.");

        public Task<AcmeCertificateRecord> IssueAsync(AcmeIssueRequest request, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken) =>
            ca.IssueAsync(directory, request, null, progress, cancellationToken);

        public async Task<AcmeCertificateRecord> RenewAsync(string name, IProgress<AcmeIssueProgress>? progress, CancellationToken cancellationToken)
        {
            var existing = await ca.FindAsync(name, cancellationToken);
            return await ca.IssueAsync(directory, new AcmeIssueRequest { Name = name, Domains = existing.Domains }, existing.CertificateId, progress, cancellationToken);
        }

        public async Task<AcmeRenewalInfo> GetRenewalInfoAsync(string name, CancellationToken cancellationToken)
        {
            var existing = await ca.FindAsync(name, cancellationToken);
            var ideal = existing.NotBefore + ((existing.NotAfter - existing.NotBefore) * 2 / 3);
            return new AcmeRenewalInfo
            {
                CertificateId = existing.CertificateId,
                WindowStart = ideal.AddDays(-1),
                WindowEnd = ideal.AddDays(1),
                RetryAfter = TimeSpan.FromHours(6),
                CheckedAt = ca.Now,
            };
        }

        public async Task RevokeAsync(string name, AcmeRevocationReason reason, CancellationToken cancellationToken)
        {
            var existing = await ca.FindAsync(name, cancellationToken);
            await ca.SaveAsync(existing with { RevokedAt = ca.Now }, cancellationToken);
        }
    }

    private DateTimeOffset Now => time.GetUtcNow();

    private async Task<AcmeCertificateRecord> FindAsync(string name, CancellationToken cancellationToken) =>
        await store.FindAsync(name, cancellationToken) ?? throw new AcmeException($"No certificate named {name} is stored.");

    private Task SaveAsync(AcmeCertificateRecord record, CancellationToken cancellationToken) => store.SaveAsync(record, cancellationToken);
}
