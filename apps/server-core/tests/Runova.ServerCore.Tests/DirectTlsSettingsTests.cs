using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.DirectTls;

namespace Runova.ServerCore.Tests;

public sealed class DirectTlsSettingsTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"runova-tls-settings-{Guid.NewGuid():N}");

    public void Dispose() => TestFolders.Delete(_directory);

    [Fact]
    public void Sources_are_normalized_and_deduplicated()
    {
        var problem = DirectTlsSettings.Validate(8443, [" 10.0.0.0/8", "2001:db8::/32", "10.0.0.0/8"], [22], out var sources);

        Assert.Null(problem);
        Assert.Equal(["10.0.0.0/8", "2001:db8::/32"], sources);
    }

    [Fact]
    public void Too_many_sources_are_refused()
    {
        var many = Enumerable.Range(1, DirectTlsSettings.MaxSources + 1).Select(i => $"192.0.2.{i}").ToArray();

        Assert.Contains("At most", DirectTlsSettings.Validate(8443, many, [22], out _), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("203.0.113.7", true)]
    [InlineData("::ffff:203.0.113.7", true)]
    [InlineData("203.0.113.8", false)]
    [InlineData("2001:db8::1", true)]
    public void Only_the_listed_networks_may_connect(string remote, bool allowed)
    {
        Assert.Null(DirectTlsSettings.Validate(8443, ["203.0.113.7", "2001:db8::/32"], [22], out var sources));
        var settings = new DirectTlsSettings(true, 8443, sources);

        Assert.Equal(allowed, DirectTlsSettings.Allows(settings.Networks(), IPAddress.Parse(remote)));
    }

    [Fact]
    public void No_sources_means_every_address_and_an_unknown_peer_is_refused_otherwise()
    {
        Assert.True(DirectTlsSettings.Allows([], IPAddress.Parse("198.51.100.1")));
        Assert.False(DirectTlsSettings.Allows([IPNetwork.Parse("10.0.0.0/8")], null));
    }

    [Fact]
    public void Settings_round_trip_and_an_unreadable_file_means_off()
    {
        var path = Path.Combine(_directory, "direct-tls.json");
        new DirectTlsSettings(true, 9443, ["10.0.0.0/8"], 42, "maria").Write(path);

        var read = DirectTlsSettings.Read(path);
        File.WriteAllText(path, "{ not json");

        Assert.True(read.Enabled);
        Assert.Equal(9443, read.Port);
        Assert.Equal(["10.0.0.0/8"], read.Sources);
        Assert.Equal("maria", read.ChangedBy);
        Assert.Equal(DirectTlsSettings.Off, DirectTlsSettings.Read(path));
        Assert.False(DirectTlsSettings.Read(Path.Combine(_directory, "missing.json")).Enabled);
    }

    [Fact]
    public void The_certificate_is_p256_made_once_and_its_key_is_private()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);

        var first = DirectTlsCertificate.LoadOrCreate(_directory, time);
        var second = DirectTlsCertificate.LoadOrCreate(_directory, time);

        Assert.Equal(first.Pin, second.Pin);
        Assert.True(second.Certificate.HasPrivateKey);
        using var key = second.Certificate.GetECDsaPublicKey();
        Assert.Equal(ECCurve.NamedCurves.nistP256.Oid.Value, key!.ExportParameters(false).Curve.Oid.Value);
        Assert.True(second.Certificate.NotAfter > time.GetUtcNow().AddYears(19).UtcDateTime);
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(Path.Combine(_directory, DirectTlsCertificate.FolderName, "server.key")));
        }
    }

    [Fact]
    public void An_unreadable_certificate_is_replaced_with_a_new_key()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var first = DirectTlsCertificate.LoadOrCreate(_directory, time);
        File.WriteAllText(Path.Combine(_directory, DirectTlsCertificate.FolderName, "server.crt"), "garbage");

        var replaced = DirectTlsCertificate.LoadOrCreate(_directory, time);

        Assert.NotEqual(first.Pin, replaced.Pin);
    }
}
