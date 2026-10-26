using System.Net;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;

namespace Runova.ServerCore.Tests.Hardening;

/// <summary>
/// What the Security center reads from sshd and writes for it: the effective settings from
/// `sshd -T`, the one drop-in file Runova owns, and sshd's "Accepted" log lines, which say how
/// one SSH connection signed in (lines as Ubuntu 24.04's sshd and Rocky 9's sshd-session wrote them).
/// </summary>
public sealed class SshdPolicyTests
{
    private const string UbuntuDefaults = """
        port 22
        usepam yes
        permitrootlogin yes
        pubkeyauthentication yes
        passwordauthentication yes
        kbdinteractiveauthentication no
        """;

    [Fact]
    public void Effective_settings_are_read_from_sshd_T()
    {
        var policy = SshdPolicy.Parse(UbuntuDefaults, managed: false);

        Assert.True(policy.PasswordLogin);
        Assert.False(policy.KeyboardInteractiveLogin);
        Assert.True(policy.KeyLogin);
        Assert.Equal("yes", policy.RootLogin);
        Assert.False(policy.ManagedByRunova);
        Assert.Null(policy.Error);
    }

    [Fact]
    public void Settings_sshd_did_not_print_stay_unknown()
    {
        var policy = SshdPolicy.Parse("port 22\nPermitRootLogin Prohibit-Password\n", managed: true);

        Assert.Null(policy.PasswordLogin);
        Assert.Null(policy.KeyboardInteractiveLogin);
        Assert.Equal("prohibit-password", policy.RootLogin);
        Assert.True(policy.ManagedByRunova);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(null, false, true)]
    public void Passwords_count_as_on_when_either_way_in_is_open(bool? password, bool? keyboard, bool open) =>
        Assert.Equal(open, SshdPolicy.PasswordsOpen(new(password, keyboard, true, "no", false)));

    [Theory]
    [InlineData("no", true)]
    [InlineData("prohibit-password", true)]
    [InlineData("without-password", true)]
    [InlineData("forced-commands-only", true)]
    [InlineData("yes", false)]
    [InlineData(null, false)]
    public void Root_login_is_restricted_unless_a_password_gets_root_in(string? value, bool restricted) =>
        Assert.Equal(restricted, SshdPolicy.RootRestricted(new(false, false, true, value, false)));

    [Fact]
    public void The_drop_in_holds_what_was_asked_and_what_it_held_before()
    {
        var first = SshdPolicy.Render(SshdPolicy.Merge(null, new(DisablePasswordLogin: true, RestrictRootLogin: false)));
        var both = SshdPolicy.Render(SshdPolicy.Merge(first, new(DisablePasswordLogin: false, RestrictRootLogin: true)));

        Assert.Contains("PasswordAuthentication no\n", first, StringComparison.Ordinal);
        Assert.Contains("KbdInteractiveAuthentication no\n", first, StringComparison.Ordinal);
        Assert.DoesNotContain("PermitRootLogin", first, StringComparison.Ordinal);
        Assert.StartsWith("# ", first, StringComparison.Ordinal);
        Assert.Contains("PasswordAuthentication no\n", both, StringComparison.Ordinal);
        Assert.Contains("PermitRootLogin prohibit-password\n", both, StringComparison.Ordinal);
    }

    [Fact]
    public void A_drop_in_someone_edited_is_read_for_the_settings_it_still_has()
    {
        var managed = SshdPolicy.ReadManaged("# mine\n  passwordauthentication   NO\nPermitRootLogin yes\n");

        Assert.True(managed.DisablePasswordLogin);
        Assert.False(managed.RestrictRootLogin);
        Assert.False(SshdPolicy.ReadManaged(null).DisablePasswordLogin);
    }

    [Theory]
    [InlineData(
        "Accepted publickey for root from 172.17.0.1 port 39852 ssh2: ED25519 SHA256:EXcCnv3tgoJ+7A86ecAvusMNynsDDZfq4OLesIUu4aA",
        "publickey", "root", "172.17.0.1", 39852)]
    [InlineData("Accepted password for deployer from 203.0.113.50 port 51234 ssh2", "password", "deployer", "203.0.113.50", 51234)]
    [InlineData("Accepted keyboard-interactive/pam for maria from 2001:db8::7 port 40022 ssh2", "keyboard-interactive/pam", "maria", "2001:db8::7", 40022)]
    [InlineData("Accepted publickey for root from ::ffff:203.0.113.50 port 22000 ssh2: RSA SHA256:abc", "publickey", "root", "203.0.113.50", 22000)]
    public void An_accepted_line_names_the_method_user_and_connection(string line, string method, string user, string client, int port)
    {
        var login = SshLoginLines.Parse(line, atUnixMs: 42);

        Assert.NotNull(login);
        Assert.Equal(method, login.Method);
        Assert.Equal(user, login.UserName);
        Assert.Equal(IPAddress.Parse(client), login.Client);
        Assert.Equal(port, login.ClientPort);
        Assert.Equal(42, login.AtUnixMs);
    }

    [Theory]
    [InlineData("Failed password for root from 172.17.0.1 port 39844 ssh2")]
    [InlineData("Accepted publickey for root from not-an-address port 1 ssh2")]
    [InlineData("Accepted publickey for root from 172.17.0.1 port 0 ssh2")]
    [InlineData("Accepted publickey for root from 172.17.0.1 ssh2")]
    [InlineData("Connection closed by 172.17.0.1 port 39844")]
    [InlineData("")]
    public void Anything_else_is_not_a_sign_in(string line) => Assert.Null(SshLoginLines.Parse(line, null));

    [Fact]
    public void The_latest_sign_in_of_the_connection_is_the_one_that_counts()
    {
        var connection = new SshEndpoint(IPAddress.Parse("172.17.0.1"), 39852, IPAddress.Parse("172.17.0.4"), 22);
        var lines = new[]
        {
            SshLoginLines.Parse("Accepted password for root from 172.17.0.1 port 39852 ssh2", 1),
            SshLoginLines.Parse("Accepted publickey for root from 172.17.0.1 port 39853 ssh2: ED25519 SHA256:x", 2),
            SshLoginLines.Parse("Accepted publickey for root from 172.17.0.1 port 39852 ssh2: ED25519 SHA256:y", 3),
        };

        var found = SshLoginLines.Latest(lines!, connection);

        Assert.Equal("publickey", found?.Method);
        Assert.Equal(3, found?.AtUnixMs);
    }
}
