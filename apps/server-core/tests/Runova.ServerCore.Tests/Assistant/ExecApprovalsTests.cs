using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Assistant;

namespace Runova.ServerCore.Tests.Assistant;

/// <summary>
/// Signed approvals (E09 T5): a nonce is good once, for two minutes, for the session and device it
/// was issued to, and only with a signature over exactly the command that runs.
/// </summary>
public sealed class ExecApprovalsTests : IDisposable
{
    private const string Command = "systemctl restart nginx";

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.UtcNow);
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly Guid _session = Guid.NewGuid();
    private readonly Guid _device = Guid.NewGuid();

    public void Dispose() => _key.Dispose();

    private byte[] PublicKey => _key.ExportSubjectPublicKeyInfo();

    private string Sign(IssuedExecNonce nonce, string command, ECDsa? key = null) =>
        Convert.ToBase64String((key ?? _key).SignData(
            Encoding.UTF8.GetBytes(ExecApprovals.Message(nonce.Id, nonce.Nonce, _device, _session, command)),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

    [Fact]
    public void A_signature_over_the_command_and_a_fresh_nonce_is_accepted_once()
    {
        var approvals = new ExecApprovals(_clock);
        var nonce = approvals.Issue(_session, _device)!;
        var signature = Sign(nonce, Command);

        Assert.True(approvals.Verify(nonce.Id, signature, _session, _device, PublicKey, Command));
        Assert.False(approvals.Verify(nonce.Id, signature, _session, _device, PublicKey, Command));
    }

    [Fact]
    public void The_message_lists_every_field_one_per_line_with_the_command_last()
    {
        var nonce = Guid.Parse("11111111-2222-3333-4444-555555555555");
        Assert.Equal(
            $"runova-core/exec/v1\n{nonce:D}\nabc\n{_device:D}\n{_session:D}\ndf -h\nuptime",
            ExecApprovals.Message(nonce, "abc", _device, _session, "df -h\nuptime"));
    }

    [Fact]
    public void A_different_command_another_key_or_garbage_is_refused_and_still_uses_the_nonce_up()
    {
        var approvals = new ExecApprovals(_clock);
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var first = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(first.Id, Sign(first, Command), _session, _device, PublicKey, Command + " && rm -rf /"));
        Assert.False(approvals.Verify(first.Id, Sign(first, Command), _session, _device, PublicKey, Command));

        var second = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(second.Id, Sign(second, Command, other), _session, _device, PublicKey, Command));

        var third = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(third.Id, "not base64!", _session, _device, PublicKey, Command));
        var fourth = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(fourth.Id, null, _session, _device, PublicKey, Command));
        var fifth = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(fifth.Id, new string('A', 600), _session, _device, PublicKey, Command));
        Assert.False(approvals.Verify(Guid.NewGuid(), Sign(fifth, Command), _session, _device, PublicKey, Command));
    }

    [Fact]
    public void A_nonce_is_bound_to_its_session_and_device_and_expires()
    {
        var approvals = new ExecApprovals(_clock);
        var nonce = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(nonce.Id, Sign(nonce, Command), Guid.NewGuid(), _device, PublicKey, Command));

        var otherDevice = approvals.Issue(_session, _device)!;
        Assert.False(approvals.Verify(otherDevice.Id, Sign(otherDevice, Command), _session, Guid.NewGuid(), PublicKey, Command));

        var late = approvals.Issue(_session, _device)!;
        _clock.Advance(ExecApprovals.Lifetime);
        Assert.False(approvals.Verify(late.Id, Sign(late, Command), _session, _device, PublicKey, Command));
    }

    [Fact]
    public void Each_session_has_a_cap_on_open_nonces_and_expired_ones_free_it()
    {
        var approvals = new ExecApprovals(_clock);
        for (var i = 0; i < 16; i++)
        {
            Assert.NotNull(approvals.Issue(_session, _device));
        }

        Assert.Null(approvals.Issue(_session, _device));
        Assert.NotNull(approvals.Issue(Guid.NewGuid(), _device));
        _clock.Advance(ExecApprovals.Lifetime + TimeSpan.FromSeconds(1));
        Assert.NotNull(approvals.Issue(_session, _device));
    }

    [Fact]
    public void Modes_are_per_session_and_start_off()
    {
        var modes = new AssistantModes();
        Assert.False(modes.AutoRuns(_session));
        modes.Set(_session, autoRun: true);
        Assert.True(modes.AutoRuns(_session));
        Assert.False(modes.AutoRuns(Guid.NewGuid()));
        modes.Set(_session, autoRun: false);
        Assert.False(modes.AutoRuns(_session));
    }
}
