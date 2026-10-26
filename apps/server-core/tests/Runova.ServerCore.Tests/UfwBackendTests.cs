using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// ufw on the Debian family, against files and output captured from ufw 0.36.2 on Ubuntu 24.04
/// (Fixtures/ufw): every rule shape ufw writes is read, every change becomes the exact command
/// line ufw was seen to accept, and a snapshot restores the four files ufw keeps its state in.
/// </summary>
public sealed class UfwBackendTests : IDisposable
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly TestRoot _root = new();
    private readonly FakeProcessRunner _processes = new();

    public void Dispose() => _root.Dispose();

    private UfwBackend Backend() => new(_processes, new DirectCommands(_processes), _root.Files);

    /// <summary>A server with ufw installed and the fixture's files in place.</summary>
    private void Install(string fixture, bool running)
    {
        _root.Write(UfwBackend.Program, "#!/usr/bin/python3\n");
        _root.Write(UfwBackend.UserRules, Fixtures.Read($"ufw/{fixture}/user.rules"));
        _root.Write(UfwBackend.User6Rules, Fixtures.Read($"ufw/{fixture}/user6.rules"));
        _root.Write(UfwBackend.Defaults, Fixtures.Read($"ufw/{fixture}/default-ufw"));
        _root.Write(UfwBackend.Config, Fixtures.Read($"ufw/{fixture}/ufw.conf").Replace(
            running ? "ENABLED=no" : "ENABLED=yes",
            running ? "ENABLED=yes" : "ENABLED=no",
            StringComparison.Ordinal));
        _processes.Respond("ufw", ["status"], _ => FakeProcessRunner.Ok(running ? Fixtures.Read("ufw/many-rules/status-verbose.txt") : "Status: inactive\n"));
    }

    private static string[] Arguments(FirewallStep step) => [.. step.Command!.Arguments];

    [Fact]
    public async Task A_fresh_install_is_off_with_no_rules_and_ipv6_on()
    {
        Install("fresh", running: false);

        var state = await Backend().ReadAsync(Cancel);

        Assert.Equal(FirewallBackendKind.Ufw, state.Backend);
        Assert.True(state.Installed);
        Assert.False(state.Active);
        Assert.Equal(FirewallPolicy.Deny, state.DefaultIncoming);
        Assert.Equal(FirewallPolicy.Allow, state.DefaultOutgoing);
        Assert.True(state.Ipv6);
        Assert.Empty(state.Rules);
        Assert.Empty(state.Warnings);
    }

    [Fact]
    public async Task Without_ufw_installed_there_is_no_firewall()
    {
        var state = await Backend().ReadAsync(Cancel);

        Assert.False(state.Installed);
        Assert.False(state.Active);
        Assert.Empty(_processes.Calls);
    }

    [Fact]
    public async Task Every_rule_shape_is_read_in_order_with_both_families_merged()
    {
        Install("many-rules", running: true);

        var state = await Backend().ReadAsync(Cancel);

        Assert.True(state.Active);
        Assert.Equal(
            [
                "Reject 23/tcp from anywhere",
                "Deny everything from 203.0.113.7",
                "Allow 22/tcp from anywhere",
                "Allow 80/tcp from anywhere",
                "Allow 6000-6007/tcp from anywhere",
                "Allow 5432/tcp from 10.0.0.0/8",
                "Limit 2222/tcp from anywhere",
                "Allow OpenSSH (22/tcp) from anywhere",
                "Allow 8443/tcp on eth0 from anywhere",
                "Allow 53 (TCP and UDP) from anywhere",
                "Allow everything from 192.168.1.10",
                "Deny outgoing 25 (TCP and UDP) to anywhere",
                "Allow 9000/tcp to 172.17.0.2 from 198.51.100.0/24",
                "Allow 51820/udp from anywhere",
                "Allow 5432/tcp from 2001:db8::/32",
            ],
            state.Rules.Select(FirewallEvaluation.Describe));
        var ssh = state.Rules.Single(rule => rule.Comment == "ssh access");
        Assert.Equal(FirewallFamilies.Both, ssh.Families);
        Assert.Equal("wire guard ünicode", state.Rules.Single(rule => rule.Ports == new PortRange(51820, 51820)).Comment);
        Assert.Equal(FirewallFamilies.Ipv4, state.Rules.Single(rule => rule.Source?.ToString() == "10.0.0.0/8").Families);
        Assert.Equal(FirewallFamilies.Ipv6, state.Rules.Single(rule => rule.Source?.ToString() == "2001:db8::/32").Families);
        Assert.All(state.Rules, rule => Assert.True(rule.Editable, rule.ReadOnlyReason));
    }

    [Fact]
    public async Task Rules_keep_ufws_order_within_each_family()
    {
        Install("many-rules", running: true);

        var state = await Backend().ReadAsync(Cancel);

        var v6 = state.Rules.Where(rule => rule.CoversIpv6).OrderBy(rule => rule.Ipv6Order).Select(FirewallEvaluation.Describe).ToList();
        Assert.Equal("Reject 23/tcp from anywhere", v6[0]);
        Assert.Equal("Allow 5432/tcp from 2001:db8::/32", v6[4]);
        Assert.DoesNotContain("Deny everything from 203.0.113.7", v6);
    }

    [Fact]
    public async Task Ufw_set_to_leave_ipv6_alone_is_read_and_warned_about()
    {
        Install("fresh", running: false);
        _root.Write(UfwBackend.Defaults, Fixtures.Read("ufw/fresh/default-ufw").Replace("IPV6=yes", "IPV6=no", StringComparison.Ordinal));

        var state = await Backend().ReadAsync(Cancel);

        Assert.False(state.Ipv6);
        Assert.Contains(state.Warnings, warning => warning.Contains("IPv6", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Ufw_enabled_in_its_settings_but_not_running_is_off_with_a_warning()
    {
        Install("fresh", running: false);
        _root.Write(UfwBackend.Config, "ENABLED=yes\nLOGLEVEL=low\n");

        var state = await Backend().ReadAsync(Cancel);

        Assert.False(state.Active);
        Assert.Contains(state.Warnings, warning => warning.Contains("not running", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Adding_rules_becomes_the_command_lines_ufw_accepts()
    {
        Install("fresh", running: false);
        var backend = Backend();
        var plan = FirewallChangePlanner.Plan(
            await backend.ReadAsync(Cancel),
            [
                Add(Tcp(22, comment: "ssh access")),
                Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 6000, 6007)),
                Add(Tcp(5432, "10.0.0.0/8")),
                Add(new FirewallRuleSpec(FirewallAction.Deny, FirewallProtocol.Any, Source: "203.0.113.7")),
                Add(new FirewallRuleSpec(FirewallAction.Reject, FirewallProtocol.Tcp, 23)),
                Add(new FirewallRuleSpec(FirewallAction.Limit, FirewallProtocol.Tcp, 2222)),
                Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Any, 53)),
                Add(Tcp(3333, "0.0.0.0/0")),
            ]);

        var steps = backend.Steps(plan);

        Assert.All(steps, step => Assert.Equal(UfwBackend.Program, step.Command!.Program));
        Assert.Equal(
            [
                ["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "22", "comment", "ssh access"],
                ["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "6000:6007"],
                ["allow", "in", "proto", "tcp", "from", "10.0.0.0/8", "to", "any", "port", "5432"],
                ["prepend", "deny", "in", "from", "203.0.113.7", "to", "any"],
                ["prepend", "reject", "in", "proto", "tcp", "from", "any", "to", "any", "port", "23"],
                ["limit", "in", "proto", "tcp", "from", "any", "to", "any", "port", "2222"],
                ["allow", "in", "from", "any", "to", "any", "port", "53"],
                ["allow", "in", "proto", "tcp", "from", "0.0.0.0/0", "to", "any", "port", "3333"],
            ],
            steps.Select(Arguments));
        Assert.Equal("ufw allow in proto tcp from any to any port 22 comment 'ssh access'", steps[0].Display);
    }

    [Fact]
    public async Task Every_rule_ufw_holds_is_removed_by_the_exact_rule_it_is()
    {
        Install("many-rules", running: true);
        var backend = Backend();
        var current = await backend.ReadAsync(Cancel);

        var plan = FirewallChangePlanner.Plan(current, [.. current.Rules.Select(rule => Remove(rule.Id))]);
        var steps = backend.Steps(plan);

        Assert.Equal(
            [
                ["--force", "delete", "reject", "in", "proto", "tcp", "from", "any", "to", "any", "port", "23"],
                ["--force", "delete", "deny", "in", "from", "203.0.113.7", "to", "any"],
                ["--force", "delete", "allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "22"],
                ["--force", "delete", "allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "80"],
                ["--force", "delete", "allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "6000:6007"],
                ["--force", "delete", "allow", "in", "proto", "tcp", "from", "10.0.0.0/8", "to", "any", "port", "5432"],
                ["--force", "delete", "limit", "in", "proto", "tcp", "from", "any", "to", "any", "port", "2222"],
                ["--force", "delete", "allow", "in", "from", "any", "to", "any", "app", "OpenSSH"],
                ["--force", "delete", "allow", "in", "on", "eth0", "proto", "tcp", "from", "any", "to", "any", "port", "8443"],
                ["--force", "delete", "allow", "in", "from", "any", "to", "any", "port", "53"],
                ["--force", "delete", "allow", "in", "from", "192.168.1.10", "to", "any"],
                ["--force", "delete", "deny", "out", "from", "any", "to", "any", "port", "25"],
                ["--force", "delete", "allow", "in", "proto", "tcp", "from", "198.51.100.0/24", "to", "172.17.0.2", "port", "9000"],
                ["--force", "delete", "allow", "in", "proto", "udp", "from", "any", "to", "any", "port", "51820"],
                ["--force", "delete", "allow", "in", "proto", "tcp", "from", "2001:db8::/32", "to", "any", "port", "5432"],
            ],
            steps.Select(Arguments));
    }

    [Fact]
    public async Task The_default_and_turning_ufw_on_or_off_come_last()
    {
        Install("fresh", running: false);
        var backend = Backend();
        var current = await backend.ReadAsync(Cancel);

        var on = backend.Steps(FirewallChangePlanner.Plan(current, [Enable(), Incoming(FirewallPolicy.Reject), Add(Tcp(22))]));
        var off = backend.Steps(FirewallChangePlanner.Plan(current with { Active = true }, [Disable()]));

        Assert.Equal(
            [
                ["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "22"],
                ["default", "reject", "incoming"],
                ["--force", "enable"],
            ],
            on.Select(Arguments));
        Assert.Equal([["disable"]], off.Select(Arguments));
    }

    [Fact]
    public async Task Ipv6_is_turned_on_in_ufws_settings_first_and_a_running_ufw_reloads_it()
    {
        Install("fresh", running: true);
        var defaults = Fixtures.Read("ufw/fresh/default-ufw").Replace("IPV6=yes", "IPV6=no", StringComparison.Ordinal);
        _root.Write(UfwBackend.Defaults, defaults);
        _root.Write(UfwBackend.Config, "ENABLED=yes\n");
        var backend = Backend();

        var steps = backend.Steps(FirewallChangePlanner.Plan(await backend.ReadAsync(Cancel), [Add(Tcp(80))]));

        var write = steps[0].Write!;
        Assert.Equal(UfwBackend.Defaults, write.Path);
        Assert.Contains("\nIPV6=yes\n", write.Content, StringComparison.Ordinal);
        Assert.Equal(defaults.Replace("IPV6=no", "IPV6=yes", StringComparison.Ordinal), write.Content);
        Assert.Equal(["reload"], Arguments(steps[1]));
        Assert.Equal(["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "80"], Arguments(steps[2]));
    }

    [Fact]
    public async Task Applying_runs_every_step_through_the_commands_and_stops_at_a_failure()
    {
        Install("fresh", running: false);
        _processes.Respond(
            spec => spec.Arguments.Contains("8443"),
            _ => FakeProcessRunner.Exit(1, error: "ERROR: Bad port '8443'"));
        var backend = Backend();
        var plan = FirewallChangePlanner.Plan(await backend.ReadAsync(Cancel), [Add(Tcp(80)), Add(Tcp(8443)), Add(Tcp(9000))]);
        var log = new List<string>();

        var failure = await Assert.ThrowsAsync<FirewallStepFailedException>(() =>
            backend.ApplyAsync(plan, backend.Steps(plan), log.Add, Cancel));

        Assert.Contains("ERROR: Bad port '8443'", failure.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(_processes.Calls, spec => spec.Arguments.Contains("9000"));
        Assert.Contains(log, line => line.StartsWith("ufw allow in proto tcp from any to any port 80", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_snapshot_holds_ufws_four_files_and_restoring_reloads_a_ufw_that_was_on()
    {
        Install("many-rules", running: true);
        var backend = Backend();
        var snapshot = await backend.SnapshotAsync(Cancel);
        _root.Write(UfwBackend.UserRules, "changed");
        _root.Write(UfwBackend.Config, "ENABLED=no\n");

        await backend.RestoreAsync(snapshot, _ => { }, Cancel);

        Assert.Equal(
            [UfwBackend.UserRules, UfwBackend.User6Rules, UfwBackend.Defaults, UfwBackend.Config],
            snapshot.Files.Select(file => file.Path));
        Assert.Equal(Fixtures.Read("ufw/many-rules/user.rules"), _root.Files.ReadText(UfwBackend.UserRules));
        Assert.Contains("ENABLED=yes", _root.Files.ReadText(UfwBackend.Config), StringComparison.Ordinal);
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead,
            snapshot.Files.Single(file => file.Path == UfwBackend.UserRules).Mode);
        var reload = Assert.Single(_processes.Calls, spec => spec.Arguments.Count > 0 && spec.Arguments[0] != "status");
        Assert.Equal(["reload"], reload.Arguments);
    }

    [Fact]
    public async Task Restoring_a_ufw_that_was_off_turns_it_off()
    {
        Install("fresh", running: false);
        var backend = Backend();
        var snapshot = await backend.SnapshotAsync(Cancel);

        await backend.RestoreAsync(snapshot, _ => { }, Cancel);

        Assert.Equal(["disable"], Assert.Single(_processes.Calls, spec => spec.Arguments[0] != "status").Arguments);
    }

    [Fact]
    public async Task A_failed_restore_says_what_ufw_printed()
    {
        Install("many-rules", running: true);
        _processes.Respond("ufw", ["reload"], _ => FakeProcessRunner.Exit(1, error: "ERROR: problem running ufw-init"));
        var backend = Backend();
        var snapshot = await backend.SnapshotAsync(Cancel);

        var failure = await Assert.ThrowsAsync<FirewallStepFailedException>(() => backend.RestoreAsync(snapshot, _ => { }, Cancel));

        Assert.Contains("problem running ufw-init", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Without_its_files_ufw_cannot_be_saved_so_nothing_is_changed()
    {
        Install("fresh", running: false);
        var missing = _root.Resolve(UfwBackend.User6Rules);
        File.Delete(missing);

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => Backend().SnapshotAsync(Cancel));

        Assert.Contains(UfwBackend.User6Rules, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Tuples_ufw_does_not_write_or_that_the_core_does_not_change_are_listed_read_only()
    {
        var rules = UfwRules.Parse(
            "### tuple ### allow gre any 0.0.0.0/0 any 10.0.0.1 in\n"
            + "### tuple ### route:allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 in_eth0\n"
            + "### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 - Bastion%20Host in\n"
            + "### tuple ### allow tcp\n",
            v6: null);

        Assert.Equal(3, rules.Count);
        Assert.All(rules, rule => Assert.False(rule.Editable));
        Assert.All(rules, rule => Assert.NotNull(rule.Unknown));
        Assert.Contains(rules, rule => rule.Routed);
        Assert.Equal("Bastion Host", rules.Single(rule => rule.SourceApp is not null).SourceApp);
    }

    [Fact]
    public void Rules_with_a_source_port_or_a_logging_action_are_read()
    {
        var rules = UfwRules.Parse(
            "### tuple ### allow udp any 0.0.0.0/0 53 0.0.0.0/0 in\n### tuple ### allow_log tcp 443 0.0.0.0/0 any 0.0.0.0/0 in\n",
            v6: null);

        Assert.Equal("53", rules[0].SourcePort);
        Assert.NotNull(rules[0].Unknown);
        Assert.Equal(FirewallAction.Allow, rules[1].Action);
        Assert.Equal(new PortRange(443, 443), rules[1].Ports);
    }
}
