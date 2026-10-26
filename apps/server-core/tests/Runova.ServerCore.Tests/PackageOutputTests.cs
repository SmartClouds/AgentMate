using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests;

/// <summary>
/// What apt and dnf say is waiting to be upgraded, and which of it is a security fix. The apt
/// fixtures were captured from Ubuntu 24.04 and Debian 12 images; the dnf ones follow what dnf 4
/// prints on Rocky, RHEL and Alma, including its quirks: long names wrap onto their own line, and
/// an "Obsoleting Packages" section follows the list.
/// </summary>
public sealed class PackageOutputTests
{
    [Fact]
    public void Apt_lists_every_upgradable_package_with_its_versions()
    {
        var packages = AptOutput.ParseUpgradable(Fixtures.Read("apt/list-upgradable-ubuntu-24.04.txt"));

        Assert.Equal(7, packages.Count);
        var libc = Assert.Single(packages, p => p.Name == "libc6");
        Assert.Equal("amd64", libc.Architecture);
        Assert.Equal("2.39-0ubuntu8.8", libc.CurrentVersion);
        Assert.Equal("2.39-0ubuntu8.9", libc.NewVersion);
        Assert.Equal("noble-updates,noble-security", libc.Source);
    }

    [Fact]
    public void Apt_marks_what_the_security_pocket_carries()
    {
        var packages = AptOutput.ParseUpgradable(Fixtures.Read("apt/list-upgradable-ubuntu-24.04.txt"));

        Assert.Equal(
            ["libc-bin", "libc6", "libssl3t64", "perl-base"],
            packages.Where(p => p.Security).Select(p => p.Name).Order(StringComparer.Ordinal));
        Assert.False(Assert.Single(packages, p => p.Name == "base-files").Security);
    }

    [Fact]
    public void Apt_on_debian_names_its_security_suite_by_archive()
    {
        var package = Assert.Single(AptOutput.ParseUpgradable(Fixtures.Read("apt/list-upgradable-debian-12.txt")));

        Assert.Equal("tzdata", package.Name);
        Assert.Equal("all", package.Architecture);
        Assert.Equal("2026b-0+deb12u1", package.CurrentVersion);
        Assert.True(package.Security);
    }

    [Fact]
    public void Apt_with_nothing_to_upgrade_lists_nothing()
    {
        Assert.Empty(AptOutput.ParseUpgradable(Fixtures.Read("apt/list-upgradable-none.txt")));
    }

    [Theory]
    [InlineData("libssl3t64")]
    [InlineData("linux-image-6.8.0-47-generic")]
    [InlineData("g++-13")]
    [InlineData("libstdc++6:i386")]
    public void Package_names_that_apt_and_dnf_use_are_accepted(string name)
    {
        Assert.True(PackageNames.IsValid(name));
    }

    [Theory]
    [InlineData("-o")]
    [InlineData("--allow-downgrades")]
    [InlineData("pkg name")]
    [InlineData("pkg;reboot")]
    [InlineData("")]
    [InlineData("../etc/passwd")]
    public void Anything_else_is_refused_before_it_reaches_a_command_line(string name)
    {
        Assert.False(PackageNames.IsValid(name));
    }

    [Fact]
    public void Dnf_lists_updates_with_their_architecture_and_repository()
    {
        var updates = DnfOutput.ParseCheckUpdate(Fixtures.Read("dnf/check-update-rocky-9.txt"));

        var openssl = Assert.Single(updates, u => u.Name == "openssl-libs");
        Assert.Equal("x86_64", openssl.Architecture);
        Assert.Equal("1:3.2.2-6.el9_5.1", openssl.NewVersion);
        Assert.Equal("baseos", openssl.Source);
    }

    [Fact]
    public void Dnf_names_that_wrap_onto_their_own_line_are_joined_again()
    {
        var updates = DnfOutput.ParseCheckUpdate(Fixtures.Read("dnf/check-update-rocky-9.txt"));

        var wrapped = Assert.Single(updates, u => u.Name == "python3-setuptools-wheel-with-a-very-long-name");
        Assert.Equal("noarch", wrapped.Architecture);
        Assert.Equal("53.0.0-13.el9", wrapped.NewVersion);
        Assert.Equal("appstream", wrapped.Source);
    }

    [Fact]
    public void Dnf_stops_before_the_obsoleting_section_and_skips_its_notes()
    {
        var updates = DnfOutput.ParseCheckUpdate(Fixtures.Read("dnf/check-update-rocky-9.txt"));

        Assert.DoesNotContain(updates, u => u.Name.Contains("Obsoleting", StringComparison.Ordinal));
        Assert.DoesNotContain(updates, u => u.Name == "grub2-tools-efi");
        Assert.DoesNotContain(updates, u => u.Name.StartsWith("Security", StringComparison.Ordinal));
        Assert.Equal(6, updates.Count);
    }

    [Fact]
    public void Dnf_names_with_dots_split_at_the_architecture()
    {
        var update = Assert.Single(DnfOutput.ParseCheckUpdate("python3.11-libs.x86_64    3.11.9-7.el9_5.1    appstream\n"));

        Assert.Equal("python3.11-libs", update.Name);
        Assert.Equal("x86_64", update.Architecture);
    }

    [Fact]
    public void Dnf_security_updates_are_the_ones_its_security_listing_repeats()
    {
        var all = DnfOutput.ParseCheckUpdate(Fixtures.Read("dnf/check-update-rocky-9.txt"));
        var security = DnfOutput.ParseCheckUpdate(Fixtures.Read("dnf/check-update-security-rocky-9.txt"));

        var marked = DnfOutput.MarkSecurity(all, security);

        Assert.Equal(
            ["kernel-core", "openssl-libs"],
            marked.Where(p => p.Security).Select(p => p.Name).Order(StringComparer.Ordinal));
        Assert.Equal(all.Count, marked.Count);
    }

    [Fact]
    public void Dnf_with_nothing_to_upgrade_lists_nothing()
    {
        Assert.Empty(DnfOutput.ParseCheckUpdate(string.Empty));
        Assert.Empty(DnfOutput.ParseCheckUpdate("Last metadata expiration check: 0:02:11 ago on Tue 29 Sep 2026 10:12:03 AM UTC.\n"));
    }
}
