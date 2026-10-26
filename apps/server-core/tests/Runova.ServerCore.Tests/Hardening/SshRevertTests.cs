using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Cli;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.DevHost.Fakes;
using Runova.ServerCore.Hardening;

namespace Runova.ServerCore.Tests.Hardening;

/// <summary>
/// The rollback of an SSH change, as its systemd timer runs it (runova-core ssh-revert) and as
/// the core runs it: the old drop-in comes back, or goes when there was none; a confirmed change
/// stays; and a revert that would leave sshd unable to load its settings removes the drop-in.
/// Also sshd's journal as `journalctl -o json` prints it.
/// </summary>
public sealed class SshRevertTests : IDisposable
{
    private readonly string _data = Path.Combine(Path.GetTempPath(), $"ssh-revert-{Guid.NewGuid():N}");
    private readonly FakeTimeProvider _time = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));

    public void Dispose() => TestFolders.Delete(_data);

    private SshChangeFiles Change(string? previous)
    {
        var files = new SshChangeFiles(_data, Guid.NewGuid());
        files.WriteSnapshot(new SshChangeSnapshot(files.Id, "SSH password login off", previous, "sshd", "maria", "ssh a", 1, 60_001));
        return files;
    }

    [Fact]
    public async Task The_timer_removes_a_drop_in_that_was_not_there_before()
    {
        var machine = new FakeSshMachine();
        machine.WriteDropIn("PasswordAuthentication no\n");
        var files = Change(previous: null);
        var output = new StringWriter();

        var exit = await SshRevertCommand.RunAsync(
            [SshRevertCommand.Name, files.Id.ToString("D"), "--data-directory", Path.GetFullPath(_data)],
            output,
            new StringWriter(),
            machine,
            _time);

        Assert.Equal(0, exit);
        Assert.Null(machine.DropIn);
        Assert.True(machine.Running.PasswordLogin);
        Assert.Contains("reload sshd", machine.Actions);
        Assert.Contains("the old settings are back", output.ToString(), StringComparison.Ordinal);
        Assert.Equal(SshHardeningState.RolledBack, files.Info()?.State);
    }

    [Fact]
    public async Task An_earlier_drop_in_comes_back_and_one_sshd_refuses_is_removed()
    {
        var machine = new FakeSshMachine();
        var kept = Change(previous: "PermitRootLogin prohibit-password\n");
        Assert.Equal(SshRevertOutcome.Restored, await SshRevert.RunAsync(kept, machine, SshRevertCause.Manual, _time, CancellationToken.None));
        Assert.Equal("PermitRootLogin prohibit-password\n", machine.DropIn);

        machine.TestComplaint = "Bad configuration option";
        var refused = Change(previous: "Nonsense here\n");
        Assert.Equal(SshRevertOutcome.Restored, await SshRevert.RunAsync(refused, machine, SshRevertCause.Timer, _time, CancellationToken.None));
        Assert.Null(machine.DropIn);
        Assert.Contains("removed instead", string.Join(" ", refused.ReadResult()!.Log), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_confirmed_change_stays_and_a_reverted_one_is_not_reverted_twice()
    {
        var machine = new FakeSshMachine();
        var confirmed = Change(previous: null);
        confirmed.Decide(SshDecision.Confirmed);
        var reverted = Change(previous: null);

        Assert.Equal(SshRevertOutcome.AlreadyConfirmed, await SshRevert.RunAsync(confirmed, machine, SshRevertCause.Timer, _time, CancellationToken.None));
        Assert.Equal(SshRevertOutcome.Restored, await SshRevert.RunAsync(reverted, machine, SshRevertCause.Timer, _time, CancellationToken.None));
        Assert.Equal(SshRevertOutcome.AlreadyReverted, await SshRevert.RunAsync(reverted, machine, SshRevertCause.Manual, _time, CancellationToken.None));
        Assert.Equal(SshHardeningState.Confirmed, confirmed.Info()?.State);
        Assert.Equal(2, SshChangeFiles.All(_data).Count);
    }

    [Theory]
    [InlineData]
    [InlineData("ssh-revert")]
    [InlineData("ssh-revert", "not-a-guid", "--data-directory", "/var/lib/runova-core")]
    [InlineData("ssh-revert", "8a5b8e7e-4f39-4c7c-9b55-5a8a1f1d2e3a", "--data-directory", "relative/path")]
    public async Task Anything_but_an_id_and_an_absolute_folder_is_refused(params string[] args)
    {
        var error = new StringWriter();

        var exit = await SshRevertCommand.RunAsync(args, new StringWriter(), error, new FakeSshMachine(), _time);

        Assert.Equal(2, exit);
        Assert.Contains("Usage", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_change_without_its_snapshot_cannot_be_reverted()
    {
        var exit = await SshRevertCommand.RunAsync(
            [SshRevertCommand.Name, Guid.NewGuid().ToString("D"), "--data-directory", Path.GetFullPath(_data)],
            new StringWriter(),
            new StringWriter(),
            new FakeSshMachine(),
            _time);

        Assert.Equal(1, exit);
    }

    [Fact]
    public void The_journal_gives_each_sign_in_with_its_time()
    {
        const string output = """
            {"MESSAGE":"Server listening on 0.0.0.0 port 22.","__REALTIME_TIMESTAMP":"1790942200000000"}
            {"MESSAGE":"Accepted password for root from 172.17.0.1 port 60146 ssh2","__REALTIME_TIMESTAMP":"1790942270494167","SYSLOG_IDENTIFIER":"sshd-session"}
            {"MESSAGE":"Accepted publickey for root from 172.17.0.1 port 60154 ssh2: ED25519 SHA256:2PYJ","__REALTIME_TIMESTAMP":"1790942274708414"}
            {"MESSAGE":[65,99,99],"__REALTIME_TIMESTAMP":"1"} Accepted
            {"MESSAGE":"Accepted publickey for root from 172.17.0.1 port 1
            """;

        var logins = JournalSshLoginLog.ParseJournal(output);

        Assert.Equal(2, logins.Count);
        Assert.Equal("password", logins[0].Method);
        Assert.Equal(1_790_942_270_494, logins[0].AtUnixMs);
        Assert.Equal(60154, logins[1].ClientPort);
    }
}
