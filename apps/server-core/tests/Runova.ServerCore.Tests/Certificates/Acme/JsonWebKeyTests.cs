using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>JWK thumbprints (RFC 7638) name the account key inside every HTTP-01 and DNS-01 answer.</summary>
public sealed class JsonWebKeyTests
{
    [Fact]
    public void The_thumbprint_matches_the_worked_example_of_rfc_7638()
    {
        // Section 3.1: only the required members (e, kty, n) count, not alg or kid.
        var key = JsonWebKey.FromRequiredMembers(new Dictionary<string, string>
        {
            ["kty"] = "RSA",
            ["n"] = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
            ["e"] = "AQAB",
        });

        Assert.Equal("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", key.Thumbprint);
    }

    [Fact]
    public void The_canonical_form_puts_the_members_in_lexicographic_order_without_whitespace()
    {
        var key = JsonWebKey.FromRequiredMembers(new Dictionary<string, string>
        {
            ["kty"] = "RSA",
            ["n"] = "abc",
            ["e"] = "AQAB",
        });

        Assert.Equal("{\"e\":\"AQAB\",\"kty\":\"RSA\",\"n\":\"abc\"}", Encoding.UTF8.GetString(key.ToCanonicalJson()));
    }

    [Fact]
    public void A_p256_key_is_described_by_crv_kty_x_and_y()
    {
        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var point = ecdsa.ExportParameters(includePrivateParameters: false).Q;

        var key = JsonWebKey.FromEcdsa(ecdsa);

        var expected = "{\"crv\":\"P-256\",\"kty\":\"EC\","
            + $"\"x\":\"{Base64Url.EncodeToString(point.X)}\",\"y\":\"{Base64Url.EncodeToString(point.Y)}\"}}";
        Assert.Equal(expected, Encoding.UTF8.GetString(key.ToCanonicalJson()));
        Assert.Equal(Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(expected))), key.Thumbprint);
        Assert.Equal(32, point.X!.Length);
    }

    [Fact]
    public void Only_p256_keys_are_accepted()
    {
        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP384);

        Assert.Throws<ArgumentException>(() => JsonWebKey.FromEcdsa(ecdsa));
    }
}
