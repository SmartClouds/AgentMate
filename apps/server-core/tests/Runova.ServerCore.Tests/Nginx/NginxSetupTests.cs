using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>E10 T1 and T2: install from nginx.org or adopt, then the managed layout, never leaving nginx.conf broken.</summary>
public sealed class NginxSetupTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_installed_nginx_is_adopted_with_its_default_site_backed_up_and_the_layout_wired()
    {
        using var kit = new NginxKit();

        await kit.SetUpAsync();

        var inspection = await kit.InspectAsync();
        Assert.True(inspection.Managed);
        Assert.Equal((true, true, 1), (inspection.HttpWired, inspection.StreamWired, inspection.CurrentRelease));
        Assert.Equal("releases/1", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.Contains("return 444;", kit.Machine.Text(kit.Layout.CurrentLink + "/http.conf"), StringComparison.Ordinal);
        Assert.False(kit.Machine.Exists("/etc/nginx/conf.d/default.conf"));
        var backups = await kit.Machine.ListAsync(kit.Layout.ConfigRoot + "/backup", Cancel);
        var backup = $"{kit.Layout.ConfigRoot}/backup/{Assert.Single(backups)}";
        Assert.Contains("server_name localhost;", kit.Machine.Text(backup + "/default.conf"), StringComparison.Ordinal);
        Assert.Equal(SimulatedNginxMachine.StockNginxConf, kit.Machine.Text(backup + "/nginx.conf"));
        Assert.True(kit.Machine.Exists(kit.Layout.AcmeChallengeDirectory));
        Assert.Equal(0, kit.SigningKey.Fetches);
        Assert.DoesNotContain(kit.Machine.Commands, command => command.StartsWith("apt-get", StringComparison.Ordinal));
        Assert.Equal(1, kit.Machine.Reloads);
    }

    [Fact]
    public async Task Setting_up_twice_changes_nothing_more()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();
        var conf = kit.Machine.Text("/etc/nginx/nginx.conf");

        await kit.SetUpAsync();

        Assert.Equal(conf, kit.Machine.Text("/etc/nginx/nginx.conf"));
        Assert.Equal("releases/1", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
    }

    [Fact]
    public async Task A_missing_nginx_is_installed_from_nginx_org_with_the_checked_key()
    {
        using var kit = new NginxKit(installed: false);

        await kit.SetUpAsync();

        Assert.Equal(1, kit.SigningKey.Fetches);
        var keyring = await kit.Machine.ReadRangeAsync(NginxRepository.DebianKeyringPath, 0, 64 * 1024, Cancel);
        Assert.Equal(OpenPgpKeys.Dearmor(Fixtures.Read("nginx/nginx_signing.key")), keyring);
        Assert.Contains("https://nginx.org/packages/ubuntu noble nginx", kit.Machine.Text(NginxRepository.DebianSourcesPath), StringComparison.Ordinal);
        Assert.Contains("Pin-Priority: 900", kit.Machine.Text(NginxRepository.DebianPinPath), StringComparison.Ordinal);
        var apt = kit.Machine.Commands.Where(command => command.StartsWith("apt-get", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, apt.Count);
        Assert.EndsWith(" update", apt[0], StringComparison.Ordinal);
        Assert.EndsWith(" install nginx", apt[1], StringComparison.Ordinal);
        Assert.True((await kit.InspectAsync()).Managed);
    }

    [Fact]
    public async Task On_the_rhel_family_the_repository_file_points_at_the_major_version()
    {
        using var kit = new NginxKit(installed: false, os: new OsInfo("rocky", "9.4", "Rocky Linux 9.4", OsFamily.Rhel, Supported: true));

        await kit.SetUpAsync();

        Assert.Contains("baseurl=https://nginx.org/packages/centos/9/$basearch/", kit.Machine.Text(NginxRepository.RhelRepoPath), StringComparison.Ordinal);
        Assert.Contains("BEGIN PGP PUBLIC KEY BLOCK", kit.Machine.Text(NginxRepository.RhelKeyPath), StringComparison.Ordinal);
        Assert.Contains(kit.Machine.Commands, command => command.StartsWith("dnf -y", StringComparison.Ordinal) && command.EndsWith("install nginx", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_key_with_other_fingerprints_stops_the_install_before_anything_is_written()
    {
        var real = Fixtures.Read("nginx/nginx_signing.key");
        var firstBlock = real[..(real.IndexOf("-----END PGP PUBLIC KEY BLOCK-----", StringComparison.Ordinal) + 34)];
        using var kit = new NginxKit(installed: false, signingKey: firstBlock);

        var error = await Assert.ThrowsAsync<JobFailedException>(kit.SetUpAsync);

        Assert.Contains("fingerprints", error.Message, StringComparison.Ordinal);
        Assert.False(kit.Machine.Exists(NginxRepository.DebianSourcesPath));
        Assert.DoesNotContain(kit.Machine.Commands, command => command.StartsWith("apt-get", StringComparison.Ordinal));
    }

    [Fact]
    public async Task When_nginx_refuses_the_wiring_nginx_conf_and_the_default_site_are_put_back()
    {
        using var kit = new NginxKit();
        kit.Machine.TestFailure = _ => "nginx: [emerg] unknown directive \"stream\" in /etc/nginx/nginx.conf:30";

        await Assert.ThrowsAsync<JobFailedException>(kit.SetUpAsync);

        Assert.Equal(SimulatedNginxMachine.StockNginxConf, kit.Machine.Text("/etc/nginx/nginx.conf"));
        Assert.True(kit.Machine.Exists("/etc/nginx/conf.d/default.conf"));
        Assert.Equal(0, kit.Machine.Reloads);
    }

    [Fact]
    public async Task Without_a_stream_module_the_sites_are_still_wired()
    {
        using var kit = new NginxKit();
        kit.Machine.TestFailure = machine => machine.Text("/etc/nginx/nginx.conf")!.Contains("stream {", StringComparison.Ordinal)
            ? "nginx: [emerg] unknown directive \"stream\" in /etc/nginx/nginx.conf:30"
            : null;

        await kit.SetUpAsync();

        var inspection = await kit.InspectAsync();
        Assert.Equal((true, false), (inspection.HttpWired, inspection.StreamWired));
    }

    [Fact]
    public async Task With_selinux_on_nginx_may_reach_upstreams_and_its_folders_are_labelled()
    {
        using var kit = new NginxKit();
        kit.Machine.SeLinux = true;

        await kit.SetUpAsync();

        Assert.Contains("setsebool -P httpd_can_network_connect 1", kit.Machine.Commands);
        Assert.Contains("semanage fcontext -a -t httpd_sys_content_t /var/www/runova(/.*)?", kit.Machine.Commands);
        Assert.Contains("restorecon -R /var/www/runova /etc/nginx/runova", kit.Machine.Commands);
    }

    [Fact]
    public async Task Without_selinux_no_selinux_command_runs()
    {
        using var kit = new NginxKit();

        await kit.SetUpAsync();

        Assert.DoesNotContain(kit.Machine.Commands, command => command.StartsWith("se", StringComparison.Ordinal) || command.StartsWith("restorecon", StringComparison.Ordinal));
        Assert.Contains((await kit.Job.LinesAsync()).Select(line => line.Text), text => text == "nginx is set up for Runova.");
    }
}
