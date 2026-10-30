using System.Buffers.Text;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace Runova.Website.Api.ApiClients;

/// <summary>
/// Seals a key's signing key (the secret's SHA-256) with Data Protection for the database, and
/// opens it again to check a signature. The secret itself is never kept.
/// </summary>
internal sealed class SigningKeys(IDataProtectionProvider provider)
{
    public const string Purpose = "Runova.ApiClients.SigningKeys.v1";

    private readonly IDataProtector _protector = provider.CreateProtector(Purpose);

    public string Seal(byte[] signingKey) => Base64Url.EncodeToString(_protector.Protect(signingKey));

    /// <summary>The signing key, or null when the value was not sealed by this key ring.</summary>
    public byte[]? Unseal(string sealedKey)
    {
        try
        {
            return _protector.Unprotect(Base64Url.DecodeFromChars(sealedKey));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null;
        }
    }
}
