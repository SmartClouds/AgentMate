using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Runova.ServerCore.Certificates;

/// <summary>A checked upload: the chain in the order nginx needs (leaf first) and the key as PKCS#8.</summary>
internal sealed record UploadedCertificate(
    string ChainPem,
    byte[] PrivateKeyPkcs8,
    string KeyType,
    string Issuer,
    DateTimeOffset NotBefore,
    DateTimeOffset NotAfter,
    IReadOnlyList<string> Names);

/// <summary>
/// Checks a certificate someone uploads before nginx is given it: PEM that parses, an unencrypted
/// key of a sound type that belongs to one of the certificates, a chain that runs from that leaf
/// through its issuers (put in order whatever order it came in), a validity period that covers
/// now, and names that cover every domain of the site.
/// </summary>
internal static class CertificateUpload
{
    public const int MaxPemLength = 32 * 1024;
    public const int MaxCertificates = 10;

    public static UploadedCertificate Check(string? certificatePem, string? privateKeyPem, IReadOnlyList<string> domains, DateTimeOffset now, List<string> problems)
    {
        ArgumentNullException.ThrowIfNull(domains);
        ArgumentNullException.ThrowIfNull(problems);
        if (string.IsNullOrWhiteSpace(certificatePem) || string.IsNullOrWhiteSpace(privateKeyPem))
        {
            problems.Add("Paste both the certificate (with its chain) and its private key, as PEM.");
            return _empty;
        }

        if (certificatePem.Length > MaxPemLength || privateKeyPem.Length > MaxPemLength)
        {
            problems.Add($"Each PEM text is at most {MaxPemLength / 1024} KB.");
            return _empty;
        }

        // Files joined with cat (or pasted one after another) may run one END line into the next BEGIN.
        certificatePem = certificatePem.Replace("----------BEGIN", "-----\n-----BEGIN", StringComparison.Ordinal);
        var certificates = new List<X509Certificate2>();
        try
        {
            if (!ReadCertificates(certificatePem, certificates, problems) || ReadKey(privateKeyPem, problems) is not { } key)
            {
                return _empty;
            }

            using (key)
            {
                return CheckChain(certificates, key, domains, now, problems);
            }
        }
        finally
        {
            foreach (var certificate in certificates)
            {
                certificate.Dispose();
            }
        }
    }

    private static readonly UploadedCertificate _empty = new(string.Empty, [], string.Empty, string.Empty, default, default, []);

    private static UploadedCertificate CheckChain(List<X509Certificate2> certificates, AsymmetricAlgorithm key, IReadOnlyList<string> domains, DateTimeOffset now, List<string> problems)
    {
        var publicKey = key switch
        {
            ECDsa ec => ec.ExportSubjectPublicKeyInfo(),
            RSA rsa => rsa.ExportSubjectPublicKeyInfo(),
            _ => [],
        };
        var leaf = certificates.FirstOrDefault(certificate => certificate.PublicKey.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(publicKey));
        if (leaf is null)
        {
            problems.Add("The private key does not belong to any of the certificates.");
            return _empty;
        }

        var chain = new List<X509Certificate2> { leaf };
        var rest = certificates.Where(certificate => !ReferenceEquals(certificate, leaf)).ToList();
        while (chain[^1].SubjectName.RawData.AsSpan().SequenceEqual(chain[^1].IssuerName.RawData) is false
            && rest.FirstOrDefault(candidate => candidate.SubjectName.RawData.AsSpan().SequenceEqual(chain[^1].IssuerName.RawData)) is { } issuer)
        {
            chain.Add(issuer);
            rest.Remove(issuer);
        }

        if (rest.Count > 0)
        {
            problems.Add($"{rest.Count} of the certificates are not part of the leaf's chain ({string.Join(", ", rest.Select(c => c.GetNameInfo(X509NameType.SimpleName, false)))}).");
        }

        var notBefore = new DateTimeOffset(leaf.NotBefore.ToUniversalTime());
        var notAfter = new DateTimeOffset(leaf.NotAfter.ToUniversalTime());
        if (notAfter <= now)
        {
            problems.Add($"The certificate expired on {notAfter:yyyy-MM-dd}.");
        }
        else if (notBefore > now.AddDays(1))
        {
            problems.Add($"The certificate is not valid until {notBefore:yyyy-MM-dd}.");
        }

        var names = leaf.Extensions.OfType<X509SubjectAlternativeNameExtension>().SelectMany(extension => extension.EnumerateDnsNames()).ToList();
        foreach (var domain in domains.Where(domain => !names.Any(name => Covers(name, domain))))
        {
            problems.Add($"The certificate does not cover {domain}.");
        }

        var keyType = key switch
        {
            ECDsa ec when ec.KeySize is 256 or 384 => $"EcdsaP{ec.KeySize}",
            RSA rsa when rsa.KeySize >= 2048 => $"Rsa{rsa.KeySize}",
            _ => null,
        };
        if (keyType is null)
        {
            problems.Add("The key must be ECDSA P-256 or P-384, or RSA of at least 2048 bits.");
        }

        if (problems.Count > 0)
        {
            return _empty;
        }

        var pem = new StringBuilder();
        foreach (var certificate in chain)
        {
            pem.Append(PemEncoding.WriteString("CERTIFICATE", certificate.RawData)).Append('\n');
        }

        return new UploadedCertificate(
            pem.ToString(),
            key.ExportPkcs8PrivateKey(),
            keyType!,
            leaf.GetNameInfo(X509NameType.SimpleName, forIssuer: true),
            notBefore,
            notAfter,
            names);
    }

    /// <summary>A name covers a domain exactly, or as a wildcard for one label (*.example.com covers a.example.com).</summary>
    public static bool Covers(string name, string domain)
    {
        if (string.Equals(name, domain, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!name.StartsWith("*.", StringComparison.Ordinal) || domain.StartsWith("*.", StringComparison.Ordinal))
        {
            return false;
        }

        var dot = domain.IndexOf('.', StringComparison.Ordinal);
        return dot > 0 && string.Equals(name[2..], domain[(dot + 1)..], StringComparison.OrdinalIgnoreCase);
    }

    private static bool ReadCertificates(string pem, List<X509Certificate2> certificates, List<string> problems)
    {
        var rest = pem.AsSpan();
        while (PemEncoding.TryFind(rest, out var fields))
        {
            if (rest[fields.Label].SequenceEqual("CERTIFICATE"))
            {
                if (certificates.Count == MaxCertificates)
                {
                    problems.Add($"A chain has at most {MaxCertificates} certificates.");
                    return false;
                }

                try
                {
                    var der = Convert.FromBase64String(rest[fields.Base64Data].ToString());
                    certificates.Add(X509CertificateLoader.LoadCertificate(der));
                }
                catch (Exception error) when (error is FormatException or CryptographicException)
                {
                    problems.Add($"Certificate {certificates.Count + 1} in the PEM does not parse.");
                    return false;
                }
            }

            rest = rest[fields.Location.End..];
        }

        if (certificates.Count == 0)
        {
            problems.Add("The certificate text holds no PEM certificate (-----BEGIN CERTIFICATE-----).");
            return false;
        }

        return true;
    }

    private static AsymmetricAlgorithm? ReadKey(string pem, List<string> problems)
    {
        if (pem.Contains("ENCRYPTED", StringComparison.Ordinal))
        {
            problems.Add("The private key is encrypted; nginx needs it without a passphrase.");
            return null;
        }

        foreach (var create in new Func<AsymmetricAlgorithm>[] { ECDsa.Create, RSA.Create })
        {
            var key = create();
            try
            {
                if (key is ECDsa ec)
                {
                    ec.ImportFromPem(pem);
                }
                else
                {
                    ((RSA)key).ImportFromPem(pem);
                }

                return key;
            }
            catch (Exception error) when (error is ArgumentException or CryptographicException)
            {
                key.Dispose();
            }
        }

        problems.Add("The private key does not parse as PEM (PKCS#8, or an EC or RSA key).");
        return null;
    }
}
