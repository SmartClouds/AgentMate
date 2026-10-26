using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Which system the core runs on, from /etc/os-release, and whether it is one the core is built
/// and tested for (the same matrix the installer checks before it installs anything).
/// </summary>
public sealed class OsReleaseTests
{
    [Theory]
    [InlineData("ubuntu-22.04", "ubuntu", "22.04", OsFamily.Debian)]
    [InlineData("ubuntu-24.04", "ubuntu", "24.04", OsFamily.Debian)]
    [InlineData("ubuntu-26.04", "ubuntu", "26.04", OsFamily.Debian)]
    [InlineData("debian-12", "debian", "12", OsFamily.Debian)]
    [InlineData("debian-13", "debian", "13", OsFamily.Debian)]
    [InlineData("rhel-9", "rhel", "9.4", OsFamily.Rhel)]
    [InlineData("rocky-9", "rocky", "9.8", OsFamily.Rhel)]
    [InlineData("rocky-10", "rocky", "10.0", OsFamily.Rhel)]
    [InlineData("almalinux-9", "almalinux", "9.5", OsFamily.Rhel)]
    [InlineData("centos-stream-9", "centos", "9", OsFamily.Rhel)]
    [InlineData("centos-stream-10", "centos", "10", OsFamily.Rhel)]
    public void Supported_systems_are_recognised(string fixture, string id, string version, OsFamily family)
    {
        var os = OsRelease.Describe(OsRelease.Parse(Fixtures.Read($"os-release/{fixture}")));

        Assert.True(os.Supported, os.UnsupportedReason);
        Assert.Equal(id, os.Id);
        Assert.Equal(version, os.VersionId);
        Assert.Equal(family, os.Family);
        Assert.Null(os.UnsupportedReason);
    }

    [Theory]
    [InlineData("ubuntu-20.04", OsFamily.Debian)]
    [InlineData("fedora-40", OsFamily.Rhel)]
    [InlineData("linuxmint-22", OsFamily.Debian)]
    public void Other_systems_are_unsupported_but_keep_their_family(string fixture, OsFamily family)
    {
        var os = OsRelease.Describe(OsRelease.Parse(Fixtures.Read($"os-release/{fixture}")));

        Assert.False(os.Supported);
        // The package manager still works on a release the matrix does not list, as best effort.
        Assert.Equal(family, os.Family);
        Assert.Contains("is not supported", os.UnsupportedReason, StringComparison.Ordinal);
    }

    [Fact]
    public void The_pretty_name_is_what_people_see()
    {
        var os = OsRelease.Describe(OsRelease.Parse(Fixtures.Read("os-release/debian-12")));

        Assert.Equal("Debian GNU/Linux 12 (bookworm)", os.Name);
    }

    [Fact]
    public void Quoting_follows_the_os_release_rules()
    {
        var fields = OsRelease.Parse("""
            # a comment
            ID=plain
            NAME="Double \"quoted\" \$HOME"
            VERSION='single'
            EMPTY=
            not a field
            """);

        Assert.Equal("plain", fields["ID"]);
        Assert.Equal("Double \"quoted\" $HOME", fields["NAME"]);
        Assert.Equal("single", fields["VERSION"]);
        Assert.Equal(string.Empty, fields["EMPTY"]);
        Assert.Equal(4, fields.Count);
    }

    [Fact]
    public void A_missing_file_is_an_unknown_system()
    {
        var os = OsRelease.Describe(OsRelease.Parse(string.Empty));

        Assert.False(os.Supported);
        Assert.Equal(OsFamily.Unknown, os.Family);
    }
}
