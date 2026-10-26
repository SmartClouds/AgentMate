using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>Every ACME POST is a flattened JWS signed with the account key (RFC 8555 section 6.2).</summary>
public sealed class AcmeJwsTests
{
    private static readonly Uri _newAccount = new("https://acme.test/new-account");
    private static readonly Uri _account = new("https://acme.test/account/17");

    [Fact]
    public void A_request_with_a_new_key_carries_the_jwk_and_verifies_as_es256()
    {
        using var key = AcmeAccountKey.Generate();

        var jws = JwsReader.Parse(AcmeJws.Sign(key, _newAccount, "nonce-1", keyId: null, "{\"a\":1}"u8));

        Assert.Equal("ES256", jws.Algorithm);
        Assert.Equal("nonce-1", jws.Nonce);
        Assert.Equal("https://acme.test/new-account", jws.Url);
        Assert.Null(jws.KeyId);
        Assert.Equal(Encoding.UTF8.GetString(key.Jwk.ToCanonicalJson()), jws.Jwk!.Value.GetRawText());
        Assert.Equal("{\"a\":1}", Encoding.UTF8.GetString(jws.Payload));
        using var publicKey = JwsReader.ImportJwk(jws.Jwk.Value);
        Assert.True(jws.VerifyWith(publicKey));
    }

    [Fact]
    public void A_request_for_an_existing_account_names_it_by_kid_instead_of_jwk()
    {
        using var key = AcmeAccountKey.Generate();

        var jws = JwsReader.Parse(AcmeJws.Sign(key, _newAccount, "nonce-2", _account, "{}"u8));

        Assert.Equal("https://acme.test/account/17", jws.KeyId);
        Assert.Null(jws.Jwk);
        using var publicKey = PublicKeyOf(key);
        Assert.True(jws.VerifyWith(publicKey));
    }

    [Fact]
    public void A_post_as_get_has_an_empty_payload()
    {
        using var key = AcmeAccountKey.Generate();

        var jws = JwsReader.Parse(AcmeJws.Sign(key, _account, "nonce-3", _account, ReadOnlySpan<byte>.Empty));

        Assert.Equal(string.Empty, jws.PayloadPart);
        using var publicKey = PublicKeyOf(key);
        Assert.True(jws.VerifyWith(publicKey));
    }

    [Fact]
    public void The_inner_jws_of_a_key_change_has_no_nonce()
    {
        using var key = AcmeAccountKey.Generate();

        var jws = JwsReader.Parse(AcmeJws.Sign(key, _newAccount, nonce: null, keyId: null, "{}"u8));

        Assert.False(jws.Header.TryGetProperty("nonce", out _));
        Assert.NotNull(jws.Jwk);
    }

    [Fact]
    public void Signatures_are_the_64_byte_ieee_p1363_form_rather_than_der()
    {
        using var key = AcmeAccountKey.Generate();

        for (var i = 0; i < 20; i++)
        {
            var jws = JwsReader.Parse(AcmeJws.Sign(key, _account, $"nonce-{i}", _account, "{}"u8));
            Assert.Equal(64, jws.Signature.Length);
        }
    }

    [Fact]
    public void A_changed_payload_no_longer_verifies()
    {
        using var key = AcmeAccountKey.Generate();
        var jws = JwsReader.Parse(AcmeJws.Sign(key, _account, "nonce-4", _account, "{\"status\":\"valid\"}"u8));
        using var other = AcmeAccountKey.Generate();
        using var otherPublic = PublicKeyOf(other);
        using var publicKey = PublicKeyOf(key);

        Assert.False(jws.VerifyWith(otherPublic));
        var forged = JwsReader.Parse(Encoding.UTF8.GetBytes(
            $"{{\"protected\":\"{jws.ProtectedPart}\",\"payload\":\"e30\",\"signature\":\"{Convert.ToBase64String(jws.Signature).TrimEnd('=').Replace('+', '-').Replace('/', '_')}\"}}"));
        Assert.False(forged.VerifyWith(publicKey));
    }

    [Fact]
    public void An_account_key_survives_a_pkcs8_round_trip()
    {
        using var key = AcmeAccountKey.Generate();

        using var restored = AcmeAccountKey.FromPkcs8(key.ExportPkcs8());

        Assert.Equal(key.Thumbprint, restored.Thumbprint);
        var jws = JwsReader.Parse(AcmeJws.Sign(restored, _account, "nonce-5", _account, "{}"u8));
        using var publicKey = PublicKeyOf(key);
        Assert.True(jws.VerifyWith(publicKey));
    }

    [Fact]
    public void Only_p256_account_keys_can_be_loaded()
    {
        using var p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);

        Assert.Throws<ArgumentException>(() => AcmeAccountKey.FromPkcs8(p384.ExportPkcs8PrivateKey()));
    }

    private static ECDsa PublicKeyOf(AcmeAccountKey key)
    {
        using var document = System.Text.Json.JsonDocument.Parse(key.Jwk.ToCanonicalJson());
        return JwsReader.ImportJwk(document.RootElement);
    }
}
