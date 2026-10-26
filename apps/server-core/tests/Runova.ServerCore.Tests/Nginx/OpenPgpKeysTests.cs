using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// nginx.org's repository key is only trusted when it carries exactly the fingerprints nginx.org
/// publishes. The fixture is the real key file, as downloaded from nginx.org/keys.
/// </summary>
public sealed class OpenPgpKeysTests
{
    private static string RealKey => Fixtures.Read("nginx/nginx_signing.key");

    [Fact]
    public void The_real_nginx_key_has_the_published_fingerprints()
    {
        var keyring = OpenPgpKeys.Dearmor(RealKey);

        Assert.Equal(
            NginxRepository.SigningKeyFingerprints.Order(StringComparer.Ordinal),
            OpenPgpKeys.PrimaryFingerprints(keyring).Order(StringComparer.Ordinal));
        Assert.Null(NginxRepository.CheckSigningKey(RealKey, out var binary));
        Assert.Equal(keyring, binary);
    }

    [Fact]
    public void A_key_file_with_a_block_missing_or_changed_is_refused()
    {
        var blocks = RealKey.Split("-----END PGP PUBLIC KEY BLOCK-----", StringSplitOptions.RemoveEmptyEntries);
        var twoOfThree = string.Join("-----END PGP PUBLIC KEY BLOCK-----", blocks.Take(2)) + "-----END PGP PUBLIC KEY BLOCK-----\n";

        Assert.Contains("fingerprints", NginxRepository.CheckSigningKey(twoOfThree, out _), StringComparison.Ordinal);

        // One base64 character changed: the checksum or the packets no longer hold.
        var index = RealKey.IndexOf("mQINBGZ", StringComparison.Ordinal) + 10;
        var flipped = RealKey[..index] + (RealKey[index] == 'A' ? 'B' : 'A') + RealKey[(index + 1)..];
        Assert.NotNull(NginxRepository.CheckSigningKey(flipped, out _));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not a key at all")]
    [InlineData("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n!!!!\n-----END PGP PUBLIC KEY BLOCK-----\n")]
    public void Text_that_is_no_key_is_refused(string text) =>
        Assert.NotNull(NginxRepository.CheckSigningKey(text, out _));
}
