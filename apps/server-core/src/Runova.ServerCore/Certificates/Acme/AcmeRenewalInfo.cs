using System.Buffers.Text;
using System.Formats.Asn1;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// The ARI identifier of a certificate (RFC 9773 section 4.1): base64url of the AKI keyIdentifier,
/// a period, base64url of the serial number's DER content (leading zero byte included).
/// </summary>
internal static class AcmeCertificateId
{
    private const string AuthorityKeyIdentifierOid = "2.5.29.35";
    private const int MaxLength = 256;

    private static readonly Asn1Tag _version = new(TagClass.ContextSpecific, 0, isConstructed: true);
    private static readonly Asn1Tag _extensions = new(TagClass.ContextSpecific, 3, isConstructed: true);
    private static readonly Asn1Tag _keyIdentifier = new(TagClass.ContextSpecific, 0);

    /// <exception cref="AcmeException">The certificate has no authority key identifier.</exception>
    public static string FromCertificate(X509Certificate2 certificate)
    {
        ArgumentNullException.ThrowIfNull(certificate);
        return FromDer(certificate.RawData);
    }

    /// <summary>
    /// Reads the identifier straight from the DER, so the serial keeps its exact encoding and
    /// certificates the platform parser dislikes (odd validity dates) still work.
    /// </summary>
    /// <exception cref="AcmeException">The bytes are not a certificate, or it has no authority key identifier.</exception>
    public static string FromDer(ReadOnlyMemory<byte> der)
    {
        try
        {
            var certificate = new AsnReader(der, AsnEncodingRules.DER).ReadSequence();
            var tbs = certificate.ReadSequence();
            if (tbs.PeekTag().HasSameClassAndValue(_version))
            {
                tbs.ReadEncodedValue();
            }

            var serial = tbs.ReadIntegerBytes();

            // signature, issuer, validity, subject, subjectPublicKeyInfo
            for (var field = 0; field < 5; field++)
            {
                tbs.ReadEncodedValue();
            }

            byte[]? keyIdentifier = null;
            while (tbs.HasData)
            {
                if (!tbs.PeekTag().HasSameClassAndValue(_extensions))
                {
                    tbs.ReadEncodedValue();
                    continue;
                }

                var extensions = tbs.ReadSequence(_extensions).ReadSequence();
                while (extensions.HasData)
                {
                    var extension = extensions.ReadSequence();
                    var oid = extension.ReadObjectIdentifier();
                    if (extension.PeekTag().HasSameClassAndValue(Asn1Tag.Boolean))
                    {
                        extension.ReadBoolean();
                    }

                    var value = extension.ReadOctetString();
                    if (oid == AuthorityKeyIdentifierOid)
                    {
                        var authority = new AsnReader(value, AsnEncodingRules.DER).ReadSequence();
                        if (authority.HasData && authority.PeekTag().HasSameClassAndValue(_keyIdentifier))
                        {
                            keyIdentifier = authority.ReadOctetString(_keyIdentifier);
                        }
                    }
                }
            }

            return keyIdentifier is { Length: > 0 }
                ? $"{Base64Url.EncodeToString(keyIdentifier)}.{Base64Url.EncodeToString(serial.Span)}"
                : throw new AcmeException("The certificate names no authority key identifier, so ARI cannot identify it.");
        }
        catch (AsnContentException error)
        {
            throw new AcmeException("The certificate could not be read.", error);
        }
    }

    /// <summary>Two non-empty base64url parts without padding, joined by one period.</summary>
    public static bool IsWellFormed(string id)
    {
        if (id is null || id.Length is 0 or > MaxLength)
        {
            return false;
        }

        var dot = id.IndexOf('.', StringComparison.Ordinal);
        return dot > 0
            && dot < id.Length - 1
            && id.IndexOf('.', dot + 1) < 0
            && id.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.');
    }
}

/// <summary>
/// A CA's suggested renewal window for one certificate (RFC 9773 section 4.2), and when to ask
/// again. The renewal service picks a time inside the window; past it, it renews at once.
/// </summary>
internal sealed class AcmeRenewalInfo
{
    public required string CertificateId { get; init; }

    public required DateTimeOffset WindowStart { get; init; }

    public required DateTimeOffset WindowEnd { get; init; }

    /// <summary>A page explaining the window (a mass revocation, say), to show the operator.</summary>
    public Uri? ExplanationUrl { get; init; }

    /// <summary>
    /// How long until the next check: the CA's Retry-After kept between a minute and a day, and
    /// six hours when it sent none (RFC 9773 sections 4.3.2 and 4.3.3).
    /// </summary>
    public required TimeSpan RetryAfter { get; init; }

    /// <summary>When the answer arrived.</summary>
    public required DateTimeOffset CheckedAt { get; init; }

    public DateTimeOffset NextCheckAt => CheckedAt + RetryAfter;

    /// <summary>The time a fraction of the way into the window.</summary>
    /// <param name="fraction">From 0 (the start) up to, but not including, 1 (the end).</param>
    public DateTimeOffset PickRenewalTime(double fraction)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(fraction, 0);
        ArgumentOutOfRangeException.ThrowIfGreaterThanOrEqual(fraction, 1);
        return WindowStart + ((WindowEnd - WindowStart) * fraction);
    }

    /// <summary>A uniformly random time inside the window, as RFC 9773 section 4.2 recommends.</summary>
    public DateTimeOffset PickRenewalTime() =>
        PickRenewalTime(RandomNumberGenerator.GetInt32(int.MaxValue) / (double)int.MaxValue);
}
