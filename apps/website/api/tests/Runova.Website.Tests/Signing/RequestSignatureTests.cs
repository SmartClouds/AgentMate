using System.Text;
using Runova.Website.Core.Signing;

namespace Runova.Website.Tests.Signing;

/// <summary>The canonical string and the signature, checked against the contract's test vectors.</summary>
public class RequestSignatureTests
{
    public const string Secret = "rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    public const string Body1 =
        """{"slug":"openssh-10-3-fixes-a-pre-auth-crash","title":"OpenSSH 10.3 fixes a pre-auth crash","category":"security","severity":"high"}""";

    public const string Signature1 = "v1=ff628625fe8c31a13fda3a8c74b3e4864249c0a36c266b8698de7a89e43d4284";
    public const string Signature2 = "v1=5e21809896d8ca8d6aa37226007ad4c786b61f5ac3756ed364e69fdee515e20e";

    private const string EmptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    private const string Body1Sha256 = "8e4afa4190017c2893f9af2cd4dce8f52e69c22490083ce787849a95bb922147";

    private const string Canonical1 =
        "RUNOVA-HMAC-SHA256\nPOST\n/api/v1/news\n\n1793361600\nAAECAwQFBgcICQoLDA0ODw\n" + Body1Sha256;

    private const string Canonical2 =
        "RUNOVA-HMAC-SHA256\nGET\n/api/v1/news\n"
        + "category=security&page=2&q=open%20ssh&technology=nodejs&technology=openssh\n"
        + "1793361600\nEBESExQVFhcYGRobHB0eHw\n" + EmptySha256;

    [Fact]
    public void The_signing_key_is_the_sha256_of_the_whole_secret()
    {
        Assert.Equal(
            "78bc032006bcf9367830b2d91c2abf86ea4d334972e2ad6a9fd8c0e646f583bb",
            Convert.ToHexStringLower(RequestSignature.SigningKey(Secret)));
    }

    [Fact]
    public void The_content_hash_is_lowercase_hex_of_the_body_or_of_nothing()
    {
        Assert.Equal(Body1Sha256, RequestSignature.ContentSha256(Encoding.UTF8.GetBytes(Body1)));
        Assert.Equal(EmptySha256, RequestSignature.ContentSha256([]));
    }

    [Fact]
    public void Vector_1_gives_the_contract_canonical_string_and_signature()
    {
        var canonical = RequestSignature.CanonicalString("post", "/api/v1/news", "", "1793361600", "AAECAwQFBgcICQoLDA0ODw", Body1Sha256);

        Assert.Equal(Canonical1, canonical);
        Assert.Equal(Signature1, RequestSignature.Sign(RequestSignature.SigningKey(Secret), canonical));
    }

    [Fact]
    public void Vector_2_gives_the_contract_canonical_string_and_signature()
    {
        var canonical = RequestSignature.CanonicalString(
            "GET",
            "/api/v1/news",
            "?technology=openssh&q=open+ssh&category=security&technology=nodejs&page=2",
            "1793361600",
            "EBESExQVFhcYGRobHB0eHw",
            EmptySha256);

        Assert.Equal(Canonical2, canonical);
        Assert.Equal(Signature2, RequestSignature.Sign(RequestSignature.SigningKey(Secret), canonical));
    }

    [Fact]
    public void The_vectors_here_are_the_ones_in_the_contract()
    {
        var contract = Contract.Read().ReplaceLineEndings("\n");

        Assert.Contains(Canonical1, contract, StringComparison.Ordinal);
        Assert.Contains(Canonical2, contract, StringComparison.Ordinal);
        Assert.Contains(Signature1, contract, StringComparison.Ordinal);
        Assert.Contains(Signature2, contract, StringComparison.Ordinal);
        Assert.Contains(Secret, contract, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("?", "")]
    [InlineData("flag", "flag=")]
    [InlineData("b=2&a=1&a=0", "a=0&a=1&b=2")]
    [InlineData("x=a=b", "x=a%3Db")]
    [InlineData("x=%2f%7E-._", "x=%2F~-._")]
    [InlineData("q=caf%C3%A9+au+lait", "q=caf%C3%A9%20au%20lait")]
    [InlineData("q=open%20ssh", "q=open%20ssh")]
    [InlineData("B=1&a=1", "B=1&a=1")]
    [InlineData("a=1&&b=2", "=&a=1&b=2")]
    public void The_canonical_query_decodes_encodes_and_sorts(string raw, string expected)
    {
        Assert.Equal(expected, RequestSignature.CanonicalQuery(raw));
    }

    [Fact]
    public void A_signature_matches_only_when_every_character_is_the_same()
    {
        var key = RequestSignature.SigningKey(Secret);

        Assert.True(RequestSignature.Matches(key, Canonical1, Signature1));
        Assert.False(RequestSignature.Matches(key, Canonical1, Signature2));
        Assert.False(RequestSignature.Matches(key, Canonical1, Signature1.ToUpperInvariant()));
        Assert.False(RequestSignature.Matches(key, Canonical1, Signature1[..^1]));
        Assert.False(RequestSignature.Matches(key, Canonical1, Signature1[3..]));
        Assert.False(RequestSignature.Matches(RequestSignature.SigningKey(Secret + "x"), Canonical1, Signature1));
    }

    [Theory]
    [InlineData("rk_00000000000000a1", true)]
    [InlineData("rk_00000000000000A1", false)]
    [InlineData("rk_00000000000000a", false)]
    [InlineData("rk_00000000000000a1f", false)]
    [InlineData("sk_00000000000000a1", false)]
    public void A_key_id_is_rk_and_16_lowercase_hex(string keyId, bool valid)
    {
        Assert.Equal(valid, RequestSignature.IsKeyId(keyId));
    }

    [Theory]
    [InlineData("AAECAwQFBgcICQoLDA0ODw", true)]
    [InlineData("AAECAwQFBgcICQoLDA0OD", false)]
    [InlineData("AAECAwQFBgcICQoLDA0OD_-", true)]
    [InlineData("AAECAwQFBgcICQoLDA0OD+/", false)]
    [InlineData("AAECAwQFBgcICQoLDA0ODw==", false)]
    public void A_nonce_is_22_to_64_base64url_characters(string nonce, bool valid)
    {
        Assert.Equal(valid, RequestSignature.IsNonce(nonce));
        Assert.False(RequestSignature.IsNonce(new string('A', 65)));
        Assert.True(RequestSignature.IsNonce(new string('A', 64)));
    }

    [Theory]
    [InlineData("1793361600", 1793361600L)]
    [InlineData("0", 0L)]
    [InlineData("-1", null)]
    [InlineData("+1793361600", null)]
    [InlineData("1793361600.5", null)]
    [InlineData("", null)]
    [InlineData("99999999999999999999", null)]
    public void A_timestamp_is_whole_unix_seconds(string value, long? expected)
    {
        Assert.Equal(expected, RequestSignature.ParseTimestamp(value));
    }

    [Fact]
    public void New_key_ids_and_secrets_have_the_contract_shape_and_differ()
    {
        var keyId = RequestSignature.NewKeyId();
        var secret = RequestSignature.NewSecret();

        Assert.True(RequestSignature.IsKeyId(keyId));
        Assert.Matches("^rnv_sk_[A-Za-z0-9_-]{43}$", secret);
        Assert.NotEqual(keyId, RequestSignature.NewKeyId());
        Assert.NotEqual(secret, RequestSignature.NewSecret());
    }
}
