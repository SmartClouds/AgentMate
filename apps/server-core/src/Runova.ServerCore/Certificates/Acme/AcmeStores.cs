namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// Where ACME accounts live between runs, one per CA directory. The E11 implementation keeps them
/// in the database with the private key sealed by Data Protection; the key goes nowhere else.
/// </summary>
internal interface IAcmeAccountStore
{
    /// <summary>The account for this directory, with a key object the caller now owns, or null.</summary>
    Task<AcmeAccount?> FindAsync(Uri directoryUrl, CancellationToken cancellationToken);

    /// <summary>Saves the account (and its current key), replacing an earlier one for the same directory.</summary>
    Task SaveAsync(AcmeAccount account, CancellationToken cancellationToken);
}

/// <summary>
/// Issued certificates with their private keys, by name (the site they belong to). The E11
/// implementation keeps them in the database, sealed like the account key, and nginx gets its
/// copies as root-only files.
/// </summary>
internal interface IAcmeCertificateStore
{
    Task<AcmeCertificateRecord?> FindAsync(string name, CancellationToken cancellationToken);

    /// <summary>Saves the record, replacing an earlier one with the same name.</summary>
    Task SaveAsync(AcmeCertificateRecord record, CancellationToken cancellationToken);
}

/// <summary>The certificate key types on offer. P-256 is the default, as Let's Encrypt recommends.</summary>
internal enum AcmeCertificateKeyType
{
    EcdsaP256,
    EcdsaP384,
    Rsa2048,
}

/// <summary>
/// An issued certificate as stored. ToString names it and its domains only, so the private key
/// can never end up in a log by way of string formatting.
/// </summary>
internal sealed record AcmeCertificateRecord
{
    public required string Name { get; init; }

    /// <summary>The directory of the CA that issued it, where renewal and revocation go.</summary>
    public required Uri DirectoryUrl { get; init; }

    public required IReadOnlyList<string> Domains { get; init; }

    public required AcmeCertificateKeyType KeyType { get; init; }

    /// <summary>The chain as PEM, leaf first.</summary>
    public required string ChainPem { get; init; }

    /// <summary>The certificate's private key as PKCS#8. Sealed at rest by the store.</summary>
    public required ReadOnlyMemory<byte> PrivateKeyPkcs8 { get; init; }

    /// <summary>The ARI identifier (RFC 9773 section 4.1), which a renewal sends as "replaces".</summary>
    public required string CertificateId { get; init; }

    public required DateTimeOffset NotBefore { get; init; }

    public required DateTimeOffset NotAfter { get; init; }

    public required DateTimeOffset IssuedAt { get; init; }

    /// <summary>The ARI identifier of the certificate this one replaced, as the CA confirmed it.</summary>
    public string? Replaced { get; init; }

    /// <summary>The issuer name asked for when choosing among the CA's chains, kept for renewals.</summary>
    public string? PreferredChain { get; init; }

    public DateTimeOffset? RevokedAt { get; init; }

    public override string ToString() =>
        string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"Certificate {Name} for {string.Join(", ", Domains)}, valid until {NotAfter:u}");
}
