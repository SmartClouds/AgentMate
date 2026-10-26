using Runova.ServerCore.Assistant;

namespace Runova.ServerCore.Tests.Assistant;

/// <summary>
/// The read-only allowlist (E09 T5): one simple command, every word one the list names. Anything a
/// shell would read as more than words, or a flag that writes, follows or kills, is refused.
/// </summary>
public sealed class CommandAllowlistTests
{
    [Theory]
    [InlineData("docker ps")]
    [InlineData("docker ps -a")]
    [InlineData("docker ps --all --no-trunc")]
    [InlineData("docker ps --filter status=restarting")]
    [InlineData("docker logs newsletter-sender-1")]
    [InlineData("docker logs --tail 100 shop-api-1")]
    [InlineData("docker logs --tail=100 --timestamps shop-api-1")]
    [InlineData("docker logs -n50 shop-api-1")]
    [InlineData("docker logs --since 10m shop-api-1")]
    [InlineData("docker inspect shop-api-1 shop-db-1")]
    [InlineData("docker stats --no-stream")]
    [InlineData("docker compose ps -p shop")]
    [InlineData("docker compose logs --tail 200 -p shop api")]
    [InlineData("docker system df")]
    [InlineData("systemctl status nginx")]
    [InlineData("systemctl status docker.service --no-pager -l")]
    [InlineData("systemctl list-units --failed --no-pager")]
    [InlineData("journalctl -u nginx -n 100 --no-pager")]
    [InlineData("journalctl -u docker.service --since -1h -p err")]
    [InlineData("journalctl --unit=ssh --lines=50")]
    [InlineData("df -h")]
    [InlineData("df -hT /var/lib/docker")]
    [InlineData("free -m")]
    [InlineData("ss -tlnp")]
    [InlineData("ss -tulpn")]
    [InlineData("uptime")]
    [InlineData("uname -a")]
    [InlineData("ip addr show")]
    [InlineData("ip -br addr")]
    [InlineData("ps aux")]
    [InlineData("ps -ef")]
    [InlineData("du -sh /var/lib/docker")]
    [InlineData("ufw status verbose")]
    [InlineData("  docker   ps  ")]
    public void Read_only_diagnostics_are_allowed(string command)
    {
        Assert.NotNull(CommandAllowlist.Parse(command));
    }

    [Theory]
    // Anything a shell reads as more than words.
    [InlineData("docker ps; rm -rf /")]
    [InlineData("docker ps && rm -rf /")]
    [InlineData("docker ps | sh")]
    [InlineData("docker ps > /etc/passwd")]
    [InlineData("df -h `rm -rf /`")]
    [InlineData("df -h $(rm -rf /)")]
    [InlineData("df $HOME")]
    [InlineData("docker logs 'shop-api-1'")]
    [InlineData("docker logs \"shop-api-1\"")]
    [InlineData("df -h *")]
    [InlineData("df -h ~")]
    [InlineData("df\t-h")]
    [InlineData("df -h\nrm -rf /")]
    [InlineData("df -h\\ /")]
    [InlineData("echo cm0gLXJmIC8= | base64 -d | sh")]
    // Programs and subcommands that are not on the list.
    [InlineData("rm -rf /")]
    [InlineData("sh -c uptime")]
    [InlineData("bash")]
    [InlineData("eval uptime")]
    [InlineData("/usr/bin/docker ps")]
    [InlineData("sudo docker ps")]
    [InlineData("docker rm -f shop-api-1")]
    [InlineData("docker restart shop-api-1")]
    [InlineData("docker exec shop-api-1 sh")]
    [InlineData("docker run debian")]
    [InlineData("docker system prune -a")]
    [InlineData("docker compose down -p shop")]
    [InlineData("docker compose config -p shop")]
    [InlineData("systemctl restart nginx")]
    [InlineData("systemctl stop docker")]
    [InlineData("systemctl show nginx")]
    [InlineData("systemctl cat nginx")]
    [InlineData("cat /etc/shadow")]
    [InlineData("hostname evil")]
    [InlineData("date -s 2020-01-01")]
    [InlineData("ip addr flush dev eth0")]
    [InlineData("ip link set eth0 down")]
    [InlineData("ufw disable")]
    [InlineData("timedatectl set-time 2020-01-01")]
    // Flags that follow, write, kill or read other files.
    [InlineData("docker logs -f shop-api-1")]
    [InlineData("docker logs --follow shop-api-1")]
    [InlineData("docker stats")]
    [InlineData("docker inspect --format=x shop-api-1")]
    [InlineData("journalctl -f")]
    [InlineData("journalctl --follow -u nginx")]
    [InlineData("journalctl --vacuum-size=1M")]
    [InlineData("journalctl --rotate")]
    [InlineData("journalctl -D /tmp")]
    [InlineData("journalctl --file=/etc/shadow")]
    [InlineData("ss -K dst 10.0.0.1")]
    [InlineData("ss -D /tmp/dump")]
    [InlineData("dmesg -C")]
    [InlineData("free -s 1")]
    [InlineData("docker logs -- shop-api-1")]
    [InlineData("docker logs --tail")]
    [InlineData("docker logs a b")]
    [InlineData("")]
    [InlineData("   ")]
    public void Anything_else_is_refused(string command)
    {
        Assert.Null(CommandAllowlist.Parse(command));
    }

    [Fact]
    public void A_null_or_overlong_command_is_refused()
    {
        Assert.Null(CommandAllowlist.Parse(null));
        Assert.Null(CommandAllowlist.Parse("df " + new string('a', CommandAllowlist.MaxLength)));
        Assert.Null(CommandAllowlist.Parse("df" + string.Concat(Enumerable.Repeat(" -h", 30))));
    }

    [Fact]
    public void The_words_come_back_without_extra_spaces_and_the_summary_names_each_entry()
    {
        Assert.Equal(["docker", "logs", "--tail", "50", "web"], CommandAllowlist.Parse(" docker  logs --tail 50   web ")!);
        Assert.Contains("docker ps", CommandAllowlist.Summary);
        Assert.Contains("journalctl", CommandAllowlist.Summary);
        Assert.Equal(CommandAllowlist.Summary.Length, CommandAllowlist.Summary.Distinct(StringComparer.Ordinal).Count());
    }
}
