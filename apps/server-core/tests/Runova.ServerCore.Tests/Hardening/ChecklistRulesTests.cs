using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hardening;

namespace Runova.ServerCore.Tests.Hardening;

/// <summary>The checklist's rules one by one, and how they add up to the score.</summary>
public sealed class ChecklistRulesTests
{
    private const long Now = 1_800_000_000_000;
    private const long Day = 86_400_000;

    private static readonly SshPolicyInfo _openSsh = new(true, false, true, "yes", false);
    private static readonly SshPolicyInfo _closedSsh = new(false, false, true, "prohibit-password", true);

    private static FirewallStatus Firewall(bool active, FirewallBackendKind backend = FirewallBackendKind.Ufw, bool installed = true, string? error = null) =>
        new(backend, installed, active, FirewallPolicy.Deny, FirewallPolicy.Allow, true, [], [], new SshPortsInfo([22]), 60, Now, Error: error);

    private static CertificateInfo Certificate(string site, long notAfter, int failures = 0, CertificateSource source = CertificateSource.Acme, CertificateState state = CertificateState.Valid) =>
        new(site, source, state, [$"{site}.example.com"], "R11", Now - (60 * Day), notAfter, AutoRenew: true, FailedAttempts: failures);

    private static ListeningSocketInfo Socket(int port, ExposureFirewall firewall, ExposureScope scope = ExposureScope.Public) =>
        new(FirewallProtocol.Tcp, "0.0.0.0", port, scope, firewall);

    [Fact]
    public void The_score_counts_each_judged_item_by_weight_and_a_warning_half()
    {
        ChecklistItem Item(ChecklistStatus status, int weight) => new("x", "x", status, weight, string.Empty, ChecklistFix.None, []);

        Assert.Equal(100, ChecklistRules.Score([Item(ChecklistStatus.Pass, 3), Item(ChecklistStatus.Unknown, 5)]));
        Assert.Equal(0, ChecklistRules.Score([Item(ChecklistStatus.Fail, 3)]));
        Assert.Equal(50, ChecklistRules.Score([Item(ChecklistStatus.Pass, 1), Item(ChecklistStatus.Fail, 1)]));
        Assert.Equal(75, ChecklistRules.Score([Item(ChecklistStatus.Pass, 1), Item(ChecklistStatus.Warn, 1)]));
        Assert.Equal(0, ChecklistRules.Score([Item(ChecklistStatus.Unknown, 1)]));
    }

    [Fact]
    public void A_server_with_everything_in_order_scores_100()
    {
        var checklist = ChecklistRules.Build(new ChecklistFacts
        {
            Firewall = Firewall(active: true),
            Ssh = _closedSsh,
            Updates = new UpdatesInfo("apt", [], 0, new AutoUpdatesInfo(true, true, true, "unattended-upgrades"), RebootRequired: false),
            Exposure = new ExposureInventory([Socket(22, ExposureFirewall.Open), Socket(443, ExposureFirewall.Open)], [], true, Now),
            SshPorts = [22],
            Certificates = [Certificate("blog", Now + (60 * Day))],
            Owners = [new OwnerFact("maria", TwoFactor: true, Disabled: false, Current: true)],
            CoreVersion = "1.2.0",
            AvailableCoreVersion = "1.2.0",
            NowUnixMs = Now,
        });

        Assert.Equal(100, checklist.Score);
        Assert.All(checklist.Items, item => Assert.Equal(ChecklistStatus.Pass, item.Status));
        Assert.All(checklist.Items, item => Assert.Equal(ChecklistFix.None, item.Fix));
    }

    [Fact]
    public void A_firewall_that_is_off_offers_to_turn_it_on()
    {
        Assert.Equal(ChecklistFix.EnableFirewall, ChecklistRules.Firewall(Firewall(active: false)).Fix);
        Assert.Equal(ChecklistStatus.Fail, ChecklistRules.Firewall(Firewall(false, FirewallBackendKind.None, installed: false)).Status);
        Assert.Equal(ChecklistFix.None, ChecklistRules.Firewall(Firewall(false, FirewallBackendKind.None, installed: false)).Fix);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.Firewall(Firewall(true, error: "ufw broke")).Status);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.Firewall(null).Status);
        Assert.Contains("firewalld", ChecklistRules.Firewall(Firewall(true, FirewallBackendKind.Firewalld)).Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Ssh_items_follow_sshd()
    {
        Assert.Equal(ChecklistFix.DisableSshPasswordLogin, ChecklistRules.SshPasswords(_openSsh).Fix);
        Assert.Equal(ChecklistStatus.Pass, ChecklistRules.SshPasswords(_closedSsh).Status);
        Assert.Equal(ChecklistStatus.Fail, ChecklistRules.SshPasswords(_closedSsh with { KeyboardInteractiveLogin = true }).Status);
        Assert.Equal(ChecklistFix.RestrictRootLogin, ChecklistRules.RootLogin(_openSsh).Fix);
        Assert.Equal(ChecklistStatus.Pass, ChecklistRules.RootLogin(_closedSsh).Status);
        var broken = new SshPolicyInfo(null, null, null, null, false, "sshd -T failed");
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.SshPasswords(broken).Status);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.RootLogin(broken).Status);
    }

    [Fact]
    public void Updates_and_reboots()
    {
        var off = new UpdatesInfo("dnf", [], 0, new AutoUpdatesInfo(true, false, false, "dnf-automatic"));
        Assert.Equal(ChecklistFix.EnableAutomaticUpdates, ChecklistRules.AutomaticUpdates(off).Fix);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.AutomaticUpdates(off with { AutomaticSecurityUpdates = new(false, false, false, "none") }).Status);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.AutomaticUpdates(null).Status);
        Assert.Equal(ChecklistFix.Reboot, ChecklistRules.Reboot(true).Fix);
        Assert.Equal(ChecklistStatus.Pass, ChecklistRules.Reboot(false).Status);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.Reboot(null).Status);
    }

    [Fact]
    public void Public_ports_beyond_ssh_and_the_web_are_flagged_and_docker_bypasses_fail()
    {
        var sockets = new ExposureInventory(
            [
                Socket(22, ExposureFirewall.Open),
                Socket(2222, ExposureFirewall.Open),
                Socket(3000, ExposureFirewall.Open),
                Socket(5432, ExposureFirewall.Closed),
                Socket(6379, ExposureFirewall.Open, ExposureScope.Local),
            ],
            [],
            true,
            Now);
        var flagged = ChecklistRules.Exposure(sockets, [22, 2222]);
        var withDocker = ChecklistRules.Exposure(
            sockets with { Containers = [new ContainerPortInfo("c1", "db", "postgres:17", FirewallProtocol.Tcp, "0.0.0.0", 5432, 5432, ExposureScope.Public, ExposureFirewall.Bypassed)] },
            [22]);

        Assert.Equal(ChecklistStatus.Warn, flagged.Status);
        Assert.Equal(["3000/tcp"], flagged.Targets);
        Assert.Equal(ChecklistFix.ReviewExposure, flagged.Fix);
        Assert.Equal(ChecklistStatus.Fail, withDocker.Status);
        Assert.Contains("5432/tcp (db)", withDocker.Targets);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.Exposure(sockets with { SocketsError = "ss failed" }, [22]).Status);
    }

    [Fact]
    public void Certificates_close_to_their_end_or_failing_can_be_renewed()
    {
        var expiring = ChecklistRules.Certificates([Certificate("blog", Now + (5 * Day)), Certificate("shop", Now + (80 * Day))], Now);
        var failing = ChecklistRules.Certificates([Certificate("blog", Now + (20 * Day), failures: 3), Certificate("old", Now - Day, source: CertificateSource.Uploaded)], Now);
        var revoked = ChecklistRules.Certificates([Certificate("gone", Now - Day, state: CertificateState.Revoked)], Now);

        Assert.Equal(ChecklistStatus.Warn, expiring.Status);
        Assert.Equal(["blog"], expiring.Targets);
        Assert.Equal(ChecklistFix.RenewCertificates, expiring.Fix);
        Assert.Equal(ChecklistStatus.Fail, failing.Status);
        Assert.Equal(["blog"], failing.Targets);
        Assert.Contains("Expired: old.example.com", failing.Detail, StringComparison.Ordinal);
        Assert.Equal(ChecklistStatus.Pass, revoked.Status);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.Certificates(null, Now).Status);
    }

    [Theory]
    [InlineData("1.2.0", "1.2.0", 0)]
    [InlineData("1.2.0", "1.10.0", -1)]
    [InlineData("1.10.0", "1.2.0", 1)]
    [InlineData("1.2.0-rc.1", "1.2.0", -1)]
    [InlineData("1.2.0", "1.2.0-rc.1", 1)]
    [InlineData("1.2", "1.2.1", -1)]
    [InlineData("1.2.0+build.5", "1.2.0", 0)]
    [InlineData("dev", "1.0.0", -1)]
    public void Versions_compare_by_their_numbers(string current, string available, int expected) =>
        Assert.Equal(expected, Math.Sign(ChecklistRules.Compare(current, available)));

    [Fact]
    public void An_older_core_offers_the_update()
    {
        Assert.Equal(ChecklistFix.UpdateCore, ChecklistRules.CoreVersion("1.0.0", "1.1.0").Fix);
        Assert.Equal(ChecklistStatus.Pass, ChecklistRules.CoreVersion("1.2.0", "1.1.0").Status);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.CoreVersion("1.2.0", null).Status);
    }

    [Fact]
    public void Owners_without_two_factor_fail_and_only_the_caller_gets_the_fix()
    {
        var others = ChecklistRules.OwnersTwoFactor([new("zoe", false, false, false), new("maria", true, false, true), new("old", false, Disabled: true, false)]);
        var mine = ChecklistRules.OwnersTwoFactor([new("maria", false, false, true)]);

        Assert.Equal(ChecklistStatus.Fail, others.Status);
        Assert.Equal(["zoe"], others.Targets);
        Assert.Equal(ChecklistFix.None, others.Fix);
        Assert.Equal(ChecklistFix.EnableTwoFactor, mine.Fix);
        Assert.Equal(ChecklistStatus.Unknown, ChecklistRules.OwnersTwoFactor(null).Status);
    }
}
