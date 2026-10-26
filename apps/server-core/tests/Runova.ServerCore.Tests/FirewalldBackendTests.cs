using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// firewalld on the RHEL family, against output captured from firewalld 1.3.4 on Rocky 9
/// (Fixtures/firewalld). The core manages the default zone through its permanent settings and
/// reloads, so a change set refuses to run while firewalld holds runtime rules it never saved.
/// </summary>
public sealed class FirewalldBackendTests : IDisposable
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly TestRoot _root = new();
    private readonly FakeProcessRunner _processes = new();
    private bool _running;
    private bool _answering;

    public void Dispose() => _root.Dispose();

    private FirewalldBackend Backend() => new(_processes, new DirectCommands(_processes), _root.Files);

    /// <summary>Every service the fixtures describe, as firewall-cmd --info-service prints each.</summary>
    private static Dictionary<string, string> Services()
    {
        var services = new Dictionary<string, string>(StringComparer.Ordinal);
        var text = Fixtures.Read("firewalld/info-service-ssh.txt") + Fixtures.Read("firewalld/info-service-others.txt")
            + Fixtures.Read("firewalld/info-service-multi.txt");
        string? current = null;
        foreach (var line in text.Split('\n'))
        {
            if (line.Length > 0 && !char.IsWhiteSpace(line[0]))
            {
                current = line.Trim();
                services[current] = line + "\n";
            }
            else if (current is not null)
            {
                services[current] += line + "\n";
            }
        }

        return services;
    }

    /// <summary>A Rocky server whose firewalld runs (or not) with the given listings for the public zone.</summary>
    private void Install(bool running, string permanent, string? runtime = null, string activeZones = "")
    {
        // The fake answers the first matching rule, so a second install only changes the state.
        _running = running;
        if (_answering)
        {
            return;
        }

        _answering = true;
        _root.Write(FirewalldBackend.Program, "#!/usr/bin/python3\n");
        _root.Write(FirewalldBackend.Config, "DefaultZone=public\nFirewallBackend=nftables\n");
        _root.Write($"{FirewalldBackend.DefaultZoneFolder}/public.xml", Fixtures.Read("firewalld/public-default.xml"));
        // The package creates /etc/firewalld/zones empty; a zone file appears there once changed.
        Directory.CreateDirectory(_root.Resolve(FirewalldBackend.ZoneFolder));
        var services = Services();
        _processes.Respond("firewall-cmd", ["--state"], _ => _running ? FakeProcessRunner.Ok("running\n") : FakeProcessRunner.Exit(252, "not running\n"));
        foreach (var tool in new[] { "firewall-cmd", "firewall-offline-cmd" })
        {
            _processes.Respond(tool, ["--get-default-zone"], _ => FakeProcessRunner.Ok("public\n"));
            _processes.Respond(tool, ["--get-active-zones"], _ => FakeProcessRunner.Ok(activeZones));
            _processes.Respond(
                spec => FakeProcessRunner.Is(spec, tool) && spec.Arguments.Count == 1 && spec.Arguments[0].StartsWith("--info-service=", StringComparison.Ordinal),
                call => services.TryGetValue(call.Spec.Arguments[0]["--info-service=".Length..], out var info)
                    ? FakeProcessRunner.Ok(info)
                    : FakeProcessRunner.Exit(101, error: "Error: INVALID_SERVICE"));
        }

        _processes.Respond("firewall-cmd", ["--permanent", "--zone=public", "--list-all"], _ => FakeProcessRunner.Ok(Fixtures.Read(permanent)));
        _processes.Respond("firewall-cmd", ["--zone=public", "--list-all"], _ => FakeProcessRunner.Ok(Fixtures.Read(runtime ?? permanent)));
        _processes.Respond("firewall-offline-cmd", ["--zone=public", "--list-all"], _ => FakeProcessRunner.Ok(Fixtures.Read(permanent)));
        _processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok(_running ? "ActiveState=active\nUnitFileState=enabled\n" : "ActiveState=inactive\nUnitFileState=disabled\n"));
    }

    private static string[] Arguments(FirewallStep step) => [.. step.Command!.Arguments];

    [Fact]
    public async Task A_fresh_rocky_server_lets_in_its_services_and_rejects_the_rest()
    {
        Install(running: true, "firewalld/list-all-fresh.txt");

        var state = await Backend().ReadAsync(Cancel);

        Assert.Equal(FirewallBackendKind.Firewalld, state.Backend);
        Assert.True(state.Installed);
        Assert.True(state.Active);
        Assert.Equal("public", state.Zone);
        Assert.Equal(FirewallPolicy.Reject, state.DefaultIncoming);
        Assert.True(state.Ipv6);
        Assert.Equal(
            ["Allow cockpit (9090/tcp) from anywhere", "Allow dhcpv6-client (546/udp) from anywhere", "Allow ssh (22/tcp) from anywhere"],
            state.Rules.Select(FirewallEvaluation.Describe));
        Assert.All(state.Rules, rule => Assert.True(rule.Editable));
        Assert.Empty(state.Warnings);
        Assert.Null(state.RefusalReason);
    }

    [Fact]
    public async Task Ports_and_every_kind_of_rich_rule_are_read()
    {
        Install(running: true, "firewalld/list-all-many-permanent.txt", "firewalld/list-all-many-runtime.txt");

        var state = await Backend().ReadAsync(Cancel);

        Assert.Equal(
            [
                "Allow cockpit (9090/tcp) from anywhere",
                "Allow dhcpv6-client (546/udp) from anywhere",
                "Allow ssh (22/tcp) from anywhere",
                "Allow 8080/tcp from anywhere",
                "Allow 6000-6007/tcp from anywhere",
                "Allow 53/udp from anywhere",
                "Deny everything from 198.51.100.8",
                "Allow 5432/tcp from 10.0.0.0/8",
                "Allow 5432/tcp from 2001:db8::/32",
                "Deny everything from 203.0.113.7",
                "Reject 23/tcp from anywhere",
                "Allow everything from 192.168.1.10",
                "Allow http (80/tcp) from 198.51.100.0/24",
                "Allow 9000/tcp from everywhere but 192.0.2.0/24",
                "Reject 22/tcp from 198.51.100.9",
                "Allow https (443/tcp) from anywhere",
            ],
            state.Rules.Select(FirewallEvaluation.Describe));
        Assert.Equal(-10, state.Rules.Single(rule => rule.Source?.ToString() == "198.51.100.8/32").Priority);
        Assert.All(state.Rules.Where(rule => rule.Shape == "rich"), rule => Assert.StartsWith("rule ", rule.Native, StringComparison.Ordinal));
        // The rate limit in the https rule belongs to its log, not to the accept.
        Assert.Null(state.Rules.Single(rule => rule.Service == "https").Unknown);
        // Rich rules list in another order at runtime; that is no difference.
        Assert.Empty(state.Warnings);
    }

    [Fact]
    public async Task Runtime_rules_that_were_never_saved_stop_every_change_with_the_reason()
    {
        Install(running: true, "firewalld/list-all-fresh.txt", "firewalld/list-all-many-runtime.txt");

        var state = await Backend().ReadAsync(Cancel);

        Assert.NotNull(state.RefusalReason);
        Assert.Contains("--runtime-to-permanent", state.RefusalReason, StringComparison.Ordinal);
        Assert.Contains(state.Warnings, warning => warning.Contains("not saved", StringComparison.Ordinal));
        // What counts is what firewalld will load again: the saved rules.
        Assert.Equal(3, state.Rules.Count);
    }

    [Fact]
    public async Task A_stopped_firewalld_is_read_with_the_offline_tool()
    {
        Install(running: false, "firewalld/list-all-fresh.txt");

        var state = await Backend().ReadAsync(Cancel);

        Assert.False(state.Active);
        Assert.Equal(3, state.Rules.Count);
        Assert.Contains(_processes.Calls, spec => FakeProcessRunner.Is(spec, "firewall-offline-cmd", "--zone=public", "--list-all"));
        Assert.DoesNotContain(_processes.Calls, spec => FakeProcessRunner.Is(spec, "firewall-cmd", "--zone=public", "--list-all"));
    }

    [Fact]
    public async Task Without_firewalld_installed_there_is_no_firewall()
    {
        var state = await Backend().ReadAsync(Cancel);

        Assert.False(state.Installed);
        Assert.Empty(_processes.Calls);
    }

    [Fact]
    public async Task Other_active_zones_are_pointed_out()
    {
        Install(running: true, "firewalld/list-all-fresh.txt", activeZones: Fixtures.Read("firewalld/active-zones-two.txt"));

        var state = await Backend().ReadAsync(Cancel);

        var warning = Assert.Single(state.Warnings);
        Assert.Contains("trusted", warning, StringComparison.Ordinal);
        Assert.Contains("10.9.0.0/16", warning, StringComparison.Ordinal);
    }

    [Fact]
    public void A_service_with_several_ports_is_listed_but_left_alone()
    {
        var samba = FirewalldListing.Service("samba", Services()["samba"]);

        Assert.Equal(2, samba.Count);
        Assert.All(samba, rule => Assert.False(rule.Editable));
        Assert.All(samba, rule => Assert.Contains("--remove-service=samba", rule.ReadOnlyReason, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Changes_become_the_permanent_commands_and_a_reload()
    {
        Install(running: true, "firewalld/list-all-many-permanent.txt", "firewalld/list-all-many-runtime.txt");
        var backend = Backend();
        var current = await backend.ReadAsync(Cancel);
        var port = current.Rules.Single(rule => rule.Native == "8080/tcp");
        var ssh = current.Rules.Single(rule => rule.Service == "ssh");
        var rich = current.Rules.Single(rule => rule.Source?.ToString() == "203.0.113.7/32");

        var steps = backend.Steps(FirewallChangePlanner.Plan(
            current,
            [
                Add(Tcp(443)),
                Add(Tcp(3306, "10.0.0.0/8")),
                Add(new FirewallRuleSpec(FirewallAction.Deny, FirewallProtocol.Tcp, 25)),
                Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Any, 5353)),
                Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 7000, 7010, "2001:db8::/32")),
                Remove(port.Id),
                Remove(ssh.Id),
                Remove(rich.Id),
                Incoming(FirewallPolicy.Deny),
            ]));

        Assert.All(steps, step => Assert.Equal(FirewalldBackend.Program, step.Command!.Program));
        Assert.Equal(
            [
                ["--permanent", "--zone=public", "--add-port=443/tcp"],
                ["--permanent", "--zone=public", "--add-rich-rule=rule family=\"ipv4\" source address=\"10.0.0.0/8\" port port=\"3306\" protocol=\"tcp\" accept"],
                ["--permanent", "--zone=public", "--add-rich-rule=rule port port=\"25\" protocol=\"tcp\" drop"],
                ["--permanent", "--zone=public", "--add-port=5353/tcp"],
                ["--permanent", "--zone=public", "--add-port=5353/udp"],
                ["--permanent", "--zone=public", "--add-rich-rule=rule family=\"ipv6\" source address=\"2001:db8::/32\" port port=\"7000-7010\" protocol=\"tcp\" accept"],
                ["--permanent", "--zone=public", "--remove-port=8080/tcp"],
                ["--permanent", "--zone=public", "--remove-service=ssh"],
                ["--permanent", "--zone=public", "--remove-rich-rule=rule family=\"ipv4\" source address=\"203.0.113.7\" drop"],
                ["--permanent", "--zone=public", "--set-target=DROP"],
                ["--reload"],
            ],
            steps.Select(Arguments));
    }

    [Fact]
    public async Task A_stopped_firewalld_is_changed_offline_and_then_started()
    {
        Install(running: false, "firewalld/list-all-fresh.txt");
        var backend = Backend();

        var steps = backend.Steps(FirewallChangePlanner.Plan(await backend.ReadAsync(Cancel), [Add(Tcp(443)), Enable()]));

        Assert.Equal(FirewalldBackend.OfflineProgram, steps[0].Command!.Program);
        Assert.Equal(["--zone=public", "--add-port=443/tcp"], Arguments(steps[0]));
        Assert.Equal(FirewalldBackend.Systemctl, steps[1].Command!.Program);
        Assert.Equal(["enable", "--now", "firewalld.service"], Arguments(steps[1]));
        Assert.Equal(2, steps.Count);
    }

    [Fact]
    public async Task Turning_firewalld_off_stops_it_without_a_reload()
    {
        Install(running: true, "firewalld/list-all-fresh.txt");
        var backend = Backend();

        var steps = backend.Steps(FirewallChangePlanner.Plan(await backend.ReadAsync(Cancel), [Disable()]));

        Assert.Equal([["disable", "--now", "firewalld.service"]], steps.Select(Arguments));
    }

    [Fact]
    public async Task A_snapshot_holds_the_zone_and_whether_firewalld_ran()
    {
        Install(running: true, "firewalld/list-all-fresh.txt");
        _root.Write($"{FirewalldBackend.ZoneFolder}/public.xml", "<zone><service name=\"ssh\"/></zone>\n");

        var snapshot = await Backend().SnapshotAsync(Cancel);

        Assert.Equal(FirewallBackendKind.Firewalld, snapshot.Backend);
        Assert.Equal("public", snapshot.Zone);
        Assert.True(snapshot.ServiceActive);
        Assert.True(snapshot.ServiceEnabled);
        Assert.Equal(
            [$"{FirewalldBackend.ZoneFolder}/public.xml", FirewalldBackend.Config],
            snapshot.Files.Select(file => file.Path));
        Assert.Equal("<zone><service name=\"ssh\"/></zone>\n", snapshot.Files[0].Content);
    }

    [Fact]
    public async Task A_zone_firewalld_keeps_only_as_shipped_is_saved_as_shipped()
    {
        Install(running: true, "firewalld/list-all-fresh.txt");

        var snapshot = await Backend().SnapshotAsync(Cancel);

        Assert.Equal(Fixtures.Read("firewalld/public-default.xml"), snapshot.Files[0].Content);
    }

    [Fact]
    public async Task Restoring_writes_the_zone_back_and_reloads_a_running_firewalld()
    {
        Install(running: true, "firewalld/list-all-fresh.txt");
        var backend = Backend();
        var snapshot = await backend.SnapshotAsync(Cancel);
        _root.Write($"{FirewalldBackend.ZoneFolder}/public.xml", "<zone/>\n");

        await backend.RestoreAsync(snapshot, _ => { }, Cancel);

        Assert.Equal(Fixtures.Read("firewalld/public-default.xml"), _root.Files.ReadText($"{FirewalldBackend.ZoneFolder}/public.xml"));
        var changes = _processes.Calls.Where(spec => spec.Program is FirewalldBackend.Program or FirewalldBackend.Systemctl).Select(spec => string.Join(' ', spec.Arguments)).ToList();
        Assert.Equal(["--reload", "enable firewalld.service"], changes);
    }

    [Fact]
    public async Task Restoring_a_firewalld_that_was_on_starts_it_and_one_that_was_off_stops_it()
    {
        Install(running: false, "firewalld/list-all-fresh.txt");
        var backend = Backend();
        var wasOn = await backend.SnapshotAsync(Cancel) with { ServiceActive = true, ServiceEnabled = true };
        var wasOff = wasOn with { ServiceActive = false, ServiceEnabled = false };

        await backend.RestoreAsync(wasOn, _ => { }, Cancel);
        var started = _processes.Calls.Where(spec => spec.Program == FirewalldBackend.Systemctl).Select(spec => string.Join(' ', spec.Arguments)).ToList();
        Install(running: true, "firewalld/list-all-fresh.txt");
        await backend.RestoreAsync(wasOff, _ => { }, Cancel);
        var stopped = _processes.Calls.Where(spec => spec.Program == FirewalldBackend.Systemctl).Select(spec => string.Join(' ', spec.Arguments)).Skip(started.Count).ToList();

        Assert.Equal(["start firewalld.service", "enable firewalld.service"], started);
        Assert.Equal(["stop firewalld.service", "disable firewalld.service"], stopped);
    }

    [Fact]
    public async Task A_zone_firewalld_does_not_have_is_not_saved_and_nothing_changes()
    {
        Install(running: true, "firewalld/list-all-fresh.txt");
        File.Delete(_root.Resolve($"{FirewalldBackend.DefaultZoneFolder}/public.xml"));

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => Backend().SnapshotAsync(Cancel));

        Assert.Contains("public", refusal.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("rule family=\"ipv4\" source address=\"10.0.0.0/8\" port port=\"5432\" protocol=\"tcp\" accept", "Allow 5432/tcp from 10.0.0.0/8", null)]
    [InlineData("rule family=\"ipv4\" source ipset=\"blocklist\" drop", "Deny everything from anywhere (IPv4 only)", "an ipset")]
    [InlineData("rule family=\"ipv4\" source address=\"10.0.0.0/8\" port port=\"22\" protocol=\"tcp\" accept limit value=\"3/m\"", "Allow 22/tcp from 10.0.0.0/8", "rate")]
    [InlineData("rule family=\"ipv4\" destination address=\"192.0.2.10\" port port=\"443\" protocol=\"tcp\" accept", "Allow 443/tcp to 192.0.2.10 from anywhere (IPv4 only)", null)]
    [InlineData("rule protocol value=\"gre\" accept", "Allow everything from anywhere", "protocol gre")]
    public void Rich_rules_say_what_the_core_cannot_be_sure_of(string text, string description, string? unknown)
    {
        var rule = FirewalldListing.RichRule(text, _ => null);

        Assert.NotNull(rule);
        Assert.Equal(description, FirewallEvaluation.Describe(rule));
        if (unknown is null)
        {
            Assert.Null(rule.Unknown);
        }
        else
        {
            Assert.Contains(unknown, rule.Unknown, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("rule family=\"ipv4\" forward-port port=\"80\" protocol=\"tcp\" to-port=\"8080\"")]
    [InlineData("rule family=\"ipv4\" source address=\"10.0.0.0/8\" log prefix=\"x\" level=\"info\"")]
    [InlineData("rule family=\"ipv4\" source address=\"10.0.0.0/8\" icmp-block name=\"echo-request\"")]
    [InlineData("not a rule")]
    public void A_rich_rule_that_accepts_and_drops_nothing_is_no_rule_for_the_core(string text) =>
        Assert.Null(FirewalldListing.RichRule(text, _ => null));
}
