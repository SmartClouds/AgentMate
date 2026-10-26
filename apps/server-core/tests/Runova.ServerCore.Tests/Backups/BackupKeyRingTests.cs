using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Backups;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// Format 2 (E28): scheduled backups are encrypted to a key ring the core keeps, so the secret key
/// is never stored on the server. The ring's private key is wrapped with the secret and travels in
/// every backup, so the secret alone opens one on a bare server.
/// </summary>
public sealed class BackupKeyRingTests
{
    private const string Secret = "violet harbour engine kettle";
    private const string OtherSecret = "copper meadow lantern drum";
    private const int Chunk = 4096;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<byte[]> EncryptAsync(byte[] plaintext, BackupKeyRing ring)
    {
        using var output = new MemoryStream();
        await BackupCrypto.EncryptToKeyRingAsync(new MemoryStream(plaintext), output, ring, 42, Cancel, Chunk);
        return output.ToArray();
    }

    private static async Task<byte[]> DecryptAsync(byte[] file, string secret)
    {
        using var output = new MemoryStream();
        await BackupCrypto.DecryptAsync(new MemoryStream(file), output, secret, Cancel);
        return output.ToArray();
    }

    private static string HeaderOf(byte[] file) =>
        Encoding.UTF8.GetString(file, 13, BinaryPrimitives.ReadInt32BigEndian(file.AsSpan(9)));

    [Theory]
    [InlineData(0)]
    [InlineData(Chunk)]
    [InlineData((Chunk * 2) + 5)]
    public async Task A_backup_made_without_the_secret_opens_with_it(int size)
    {
        var ring = BackupKeyRing.Create(Secret, 1);
        var plaintext = RandomNumberGenerator.GetBytes(size);

        var file = await EncryptAsync(plaintext, ring);

        Assert.Equal(plaintext, await DecryptAsync(file, Secret));
        Assert.Equal(2, file[8]);
    }

    [Fact]
    public async Task A_wrong_secret_is_refused()
    {
        var file = await EncryptAsync([1, 2, 3], BackupKeyRing.Create(Secret, 1));

        var error = await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(file, OtherSecret));

        Assert.Contains("secret key is wrong", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_header_says_how_to_unwrap_the_key_and_nothing_else()
    {
        var ring = BackupKeyRing.Create(Secret, 1);

        var header = HeaderOf(await EncryptAsync(Encoding.UTF8.GetBytes("stacks and volumes"), ring));

        Assert.Contains("\"format\":2", header, StringComparison.Ordinal);
        Assert.Contains("\"iterations\":600000", header, StringComparison.Ordinal);
        Assert.Contains(ring.KeyId, header, StringComparison.Ordinal);
        Assert.DoesNotContain(Secret, header, StringComparison.Ordinal);
        Assert.DoesNotContain("stacks", header, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_changed_header_fails_even_when_the_secret_is_right()
    {
        var file = await EncryptAsync(RandomNumberGenerator.GetBytes(100), BackupKeyRing.Create(Secret, 1));
        var header = HeaderOf(file);
        var at = 13 + header.IndexOf("\"createdAtUnixMs\":42", StringComparison.Ordinal) + "\"createdAtUnixMs\":".Length;
        file[at] = (byte)'7';

        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(file, Secret));
    }

    [Fact]
    public void Changing_the_secret_keeps_the_key_pair_and_drops_the_old_secret()
    {
        var ring = BackupKeyRing.Create(Secret, 1);

        var changed = ring.WithSecret(Secret, OtherSecret);

        Assert.Equal(ring.KeyId, changed.KeyId);
        Assert.Equal(ring.PublicKey, changed.PublicKey);
        using var key = changed.Unlock(OtherSecret);
        Assert.Throws<BackupRefusedException>(() => changed.Unlock(Secret));
        Assert.Throws<BackupRefusedException>(() => ring.WithSecret(OtherSecret, Secret));
    }

    [Fact]
    public async Task Backups_made_before_a_change_still_open_with_the_secret_they_were_made_under()
    {
        var ring = BackupKeyRing.Create(Secret, 1);
        var before = await EncryptAsync([1], ring);
        var after = await EncryptAsync([2], ring.WithSecret(Secret, OtherSecret));

        Assert.Equal([1], await DecryptAsync(before, Secret));
        Assert.Equal([2], await DecryptAsync(after, OtherSecret));
        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(after, Secret));
    }

    [Fact]
    public void A_ring_whose_public_key_does_not_match_its_private_key_is_refused()
    {
        var first = BackupKeyRing.Create(Secret, 1);
        var second = BackupKeyRing.Create(Secret, 1);
        var forged = first with { PublicKey = second.PublicKey };

        Assert.Throws<BackupRefusedException>(() => forged.Unlock(Secret));
    }

    [Fact]
    public void A_weak_secret_is_refused()
    {
        Assert.Throws<BackupRefusedException>(() => BackupKeyRing.Create("short", 1));
        Assert.Throws<BackupRefusedException>(() => BackupKeyRing.Create(Secret, 1).WithSecret(Secret, "short"));
    }

    [Fact]
    public async Task A_passphrase_backup_from_format_1_still_opens()
    {
        using var output = new MemoryStream();
        await BackupCrypto.EncryptAsync(new MemoryStream([9, 9]), output, Secret, 42, Cancel, Chunk);

        Assert.Equal([9, 9], await DecryptAsync(output.ToArray(), Secret));
    }
}
