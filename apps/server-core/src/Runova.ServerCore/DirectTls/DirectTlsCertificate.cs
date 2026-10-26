using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Runova.ServerCore.DirectTls;

/// <summary>
/// The certificate the direct TLS listener presents: self-signed ECDSA P-256, made once when the core
/// first starts (during the install) and kept in the state folder, key readable by root only. Nobody
/// checks it against a CA. The app pins its public key, which it reads over SSH, so the dates and
/// names in it carry nothing; it is valid for 20 years so it never needs replacing.
/// </summary>
internal sealed class DirectTlsCertificate
{
    public const string FolderName = "tls";

    private const string CertificateFile = "server.crt";

    private const string KeyFile = "server.key";

    private DirectTlsCertificate(X509Certificate2 certificate)
    {
        Certificate = certificate;
        Pin = PinOf(certificate);
    }

    /// <summary>With its private key, for Kestrel.</summary>
    public X509Certificate2 Certificate { get; }

    /// <summary>base64 SHA-256 of the SubjectPublicKeyInfo.</summary>
    public string Pin { get; }

    public static string PinOf(X509Certificate2 certificate)
    {
        ArgumentNullException.ThrowIfNull(certificate);
        return Convert.ToBase64String(SHA256.HashData(certificate.PublicKey.ExportSubjectPublicKeyInfo()));
    }

    /// <summary>Loads the certificate, making it first when there is none (or what is there is unreadable).</summary>
    public static DirectTlsCertificate LoadOrCreate(string dataDirectory, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(dataDirectory);
        ArgumentNullException.ThrowIfNull(time);
        var folder = Path.Combine(dataDirectory, FolderName);
        var certificatePath = Path.Combine(folder, CertificateFile);
        var keyPath = Path.Combine(folder, KeyFile);
        if (File.Exists(certificatePath) && File.Exists(keyPath))
        {
            try
            {
                return new DirectTlsCertificate(Usable(X509Certificate2.CreateFromPemFile(certificatePath, keyPath)));
            }
            catch (CryptographicException)
            {
                // Replaced below. The app then reports a pin mismatch until it reads the new pin over SSH.
            }
        }

        Directory.CreateDirectory(folder);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=runova-core", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        var now = time.GetUtcNow();
        using var created = request.CreateSelfSigned(now.AddDays(-1), now.AddYears(20));

        WriteSecret(keyPath, key.ExportPkcs8PrivateKeyPem());
        File.WriteAllText(certificatePath, created.ExportCertificatePem());
        return new DirectTlsCertificate(Usable(X509Certificate2.CreateFromPemFile(certificatePath, keyPath)));
    }

    /// <summary>
    /// SslStream on Windows cannot use a key that lives only in memory (from PEM); a PKCS#12 round
    /// trip gives it one it can. Linux takes either.
    /// </summary>
    private static X509Certificate2 Usable(X509Certificate2 fromPem)
    {
        if (!OperatingSystem.IsWindows())
        {
            return fromPem;
        }

        using (fromPem)
        {
            return X509CertificateLoader.LoadPkcs12(fromPem.Export(X509ContentType.Pkcs12), password: null);
        }
    }

    private static void WriteSecret(string path, string text)
    {
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        if (OperatingSystem.IsWindows())
        {
            File.WriteAllText(temporary, text);
        }
        else
        {
            using var stream = new FileStream(temporary, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            });
            using var writer = new StreamWriter(stream);
            writer.Write(text);
        }

        File.Move(temporary, path, overwrite: true);
    }
}
