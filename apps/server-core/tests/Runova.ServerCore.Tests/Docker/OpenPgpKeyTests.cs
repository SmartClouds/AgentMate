using Runova.ServerCore.Docker;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// The repository key is trusted only when its fingerprint is the pinned one: computed here from
/// the key packet (RFC 4880 12.2), on the real keys download.docker.com serves.
/// </summary>
public sealed class OpenPgpKeyTests
{
    private static string Key(string name) => Fixtures.Read($"docker/keys/{name}.asc");

    [Theory]
    [InlineData("ubuntu", "9DC858229FC7DD38854AE2D88D81803C0EBFCD88")]
    [InlineData("rhel", "060A61C51B558A7F742B77AAC52FEB6B621E9F35")]
    public void The_fingerprint_of_docker_s_keys_is_the_one_docker_publishes(string key, string fingerprint)
    {
        Assert.Equal([fingerprint], OpenPgpKey.PrimaryFingerprints(Key(key)));
        Assert.True(OpenPgpKey.HasOnly(Key(key), fingerprint));
    }

    [Fact]
    public void A_different_key_or_a_second_key_beside_the_right_one_is_refused()
    {
        var ubuntu = Key("ubuntu");
        var both = ubuntu + "\n" + Key("rhel");

        Assert.False(OpenPgpKey.HasOnly(Key("rhel"), DockerRepository.DebianFingerprint));
        Assert.False(OpenPgpKey.HasOnly(both, DockerRepository.DebianFingerprint));
        Assert.Equal(2, OpenPgpKey.PrimaryFingerprints(both).Count);
    }

    [Fact]
    public void A_changed_byte_or_something_that_is_no_key_has_no_trusted_fingerprint()
    {
        var ubuntu = Key("ubuntu");
        var at = ubuntu.IndexOf("mQINB", StringComparison.Ordinal) + 40;
        var tampered = ubuntu[..at] + (ubuntu[at] == 'A' ? 'B' : 'A') + ubuntu[(at + 1)..];

        Assert.False(OpenPgpKey.HasOnly(tampered, DockerRepository.DebianFingerprint));
        Assert.Empty(OpenPgpKey.PrimaryFingerprints("<html>Service Unavailable</html>"));
        Assert.Empty(OpenPgpKey.PrimaryFingerprints("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n!!!!\n-----END PGP PUBLIC KEY BLOCK-----\n"));
    }
}
