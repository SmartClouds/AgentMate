using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.Hardening;

/// <summary>
/// The sshd drop-in from before the rename takes the new name only when sshd reads exactly the
/// same settings under it; otherwise it keeps its old name, which the core goes on managing.
/// </summary>
public sealed class SshdDropInMoveTests : IDisposable
{
    private readonly string _folder = TestFolders.Create("sshd-move");
    private readonly FakeProcessRunner _runner = new();
    private readonly string _legacy;
    private readonly string _new;

    public SshdDropInMoveTests()
    {
        Directory.CreateDirectory(_folder);
        _legacy = Path.Combine(_folder, "00-old.conf");
        _new = Path.Combine(_folder, "00-runova.conf");
        File.WriteAllText(_legacy, "PasswordAuthentication no\n");
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private Task<NameMoveStatus> MoveAsync(bool pending = false) => new SshdDropInMove(_runner, _legacy, _new).RunAsync(pending, Cancel);

    [Fact]
    public async Task The_drop_in_takes_the_new_name_when_sshd_reads_the_same()
    {
        _runner.Respond("sshd", ["-T"], _ => FakeProcessRunner.Ok("passwordauthentication no\n"));

        Assert.Equal(new NameMoveStatus(NameMovePhase.Done), await MoveAsync());
        Assert.True(File.Exists(_new));
        Assert.False(File.Exists(_legacy));
        Assert.Contains(_runner.Calls, call => call.Program == "sshd" && call.Arguments.SequenceEqual(["-t"]));
    }

    [Fact]
    public async Task It_keeps_the_old_name_when_another_file_would_win()
    {
        var reads = 0;
        _runner.Respond("sshd", ["-T"], _ => FakeProcessRunner.Ok(++reads == 1 ? "passwordauthentication no\n" : "passwordauthentication yes\n"));

        var status = await MoveAsync();

        Assert.Equal(NameMovePhase.Kept, status.Phase);
        Assert.Contains("different settings", status.Detail, StringComparison.Ordinal);
        Assert.True(File.Exists(_legacy));
        Assert.False(File.Exists(_new));
    }

    [Fact]
    public async Task It_keeps_the_old_name_when_sshd_refuses_the_new_one()
    {
        _runner.Respond("sshd", ["-t"], _ => FakeProcessRunner.Exit(255, error: "/etc/ssh/sshd_config.d/00-runova.conf line 1: Bad configuration option"));

        var status = await MoveAsync();

        Assert.Equal(NameMovePhase.Kept, status.Phase);
        Assert.Contains("Bad configuration option", status.Detail, StringComparison.Ordinal);
        Assert.True(File.Exists(_legacy));
    }

    [Fact]
    public async Task It_waits_for_an_unconfirmed_ssh_change_and_leaves_alone_what_it_cannot_tell()
    {
        Assert.Equal(NameMovePhase.Waiting, (await MoveAsync(pending: true)).Phase);
        Assert.Empty(_runner.Calls);

        _runner.Respond("sshd", ["-T"], _ => FakeProcessRunner.Exit(1, error: "no hostkeys available"));
        var status = await MoveAsync();
        Assert.Equal(NameMovePhase.Kept, status.Phase);
        Assert.Contains("no hostkeys", status.Detail, StringComparison.Ordinal);
        Assert.True(File.Exists(_legacy));
    }

    [Fact]
    public async Task Nothing_to_do_without_the_old_file()
    {
        File.Delete(_legacy);

        Assert.Equal(NameMovePhase.NotNeeded, (await MoveAsync()).Phase);
        File.WriteAllText(_new, string.Empty);
        Assert.Equal(NameMovePhase.Done, (await MoveAsync()).Phase);
    }

    public void Dispose() => TestFolders.Delete(_folder);
}
