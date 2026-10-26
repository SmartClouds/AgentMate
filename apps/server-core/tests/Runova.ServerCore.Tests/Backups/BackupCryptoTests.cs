using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Backups;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// The backup file format: what goes in comes out with the right passphrase only, and any change to
/// the file (a byte, a chunk swapped, dropped or added, a cut, a weakened header) is refused.
/// Small chunks so a few kilobytes make several of them.
/// </summary>
public sealed class BackupCryptoTests
{
    private const string Passphrase = "orange tractor bicycle lamp";
    private const int Chunk = 4096;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<byte[]> EncryptAsync(byte[] plaintext, string passphrase = Passphrase)
    {
        using var output = new MemoryStream();
        await BackupCrypto.EncryptAsync(new MemoryStream(plaintext), output, passphrase, 42, Cancel, Chunk);
        return output.ToArray();
    }

    private static async Task<byte[]> DecryptAsync(byte[] file, string passphrase = Passphrase)
    {
        using var output = new MemoryStream();
        await BackupCrypto.DecryptAsync(new MemoryStream(file), output, passphrase, Cancel);
        return output.ToArray();
    }

    private static int HeaderEnd(byte[] file) => 13 + BinaryPrimitives.ReadInt32BigEndian(file.AsSpan(9));

    /// <summary>Where each chunk starts and how long it is in the file, length prefix and tag included.</summary>
    private static List<(int Start, int Length)> Chunks(byte[] file)
    {
        var chunks = new List<(int, int)>();
        for (var at = HeaderEnd(file); at < file.Length;)
        {
            var length = 4 + (int)BinaryPrimitives.ReadUInt32BigEndian(file.AsSpan(at)) + 16;
            chunks.Add((at, length));
            at += length;
        }

        return chunks;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(10)]
    [InlineData(Chunk)]
    [InlineData((Chunk * 3) + 17)]
    public async Task What_goes_in_comes_out(int size)
    {
        var plaintext = RandomNumberGenerator.GetBytes(size);

        var file = await EncryptAsync(plaintext);

        Assert.Equal(plaintext, await DecryptAsync(file));
        Assert.True(file.AsSpan(0, 8).SequenceEqual("AMBACKUP"u8));
        Assert.Equal(Math.Max(1, (size + Chunk - 1) / Chunk), Chunks(file).Count);
    }

    [Fact]
    public async Task The_same_contents_never_encrypt_the_same_way_and_the_header_tells_nothing()
    {
        var plaintext = Encoding.UTF8.GetBytes("users, devices, stacks and certificates");

        var first = await EncryptAsync(plaintext);
        var second = await EncryptAsync(plaintext);
        var header = Encoding.UTF8.GetString(first, 13, HeaderEnd(first) - 13);

        Assert.NotEqual(first, second);
        Assert.Contains("\"iterations\":600000", header, StringComparison.Ordinal);
        Assert.Contains("PBKDF2-HMAC-SHA256", header, StringComparison.Ordinal);
        Assert.DoesNotContain("users", header, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_wrong_passphrase_is_refused()
    {
        var file = await EncryptAsync(RandomNumberGenerator.GetBytes(100));

        var refused = await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(file, "lemon tractor bicycle lamp"));

        Assert.Contains("passphrase is wrong", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_short_passphrase_is_refused_before_anything_is_written()
    {
        using var output = new MemoryStream();

        await Assert.ThrowsAsync<BackupRefusedException>(() =>
            BackupCrypto.EncryptAsync(new MemoryStream([1, 2, 3]), output, "short", 42, Cancel));

        Assert.Equal(0, output.Length);
        Assert.NotNull(BackupCrypto.PassphraseProblem("eleven char"));
        Assert.Null(BackupCrypto.PassphraseProblem("twelve chars"));
    }

    [Fact]
    public async Task A_changed_byte_anywhere_is_refused()
    {
        var file = await EncryptAsync(RandomNumberGenerator.GetBytes((Chunk * 2) + 5));

        foreach (var position in new[] { 20, HeaderEnd(file) + 10, file.Length / 2, file.Length - 1 })
        {
            var changed = (byte[])file.Clone();
            changed[position] ^= 0x01;
            await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(changed));
        }
    }

    [Fact]
    public async Task Chunks_swapped_dropped_or_added_are_refused()
    {
        var file = await EncryptAsync(RandomNumberGenerator.GetBytes((Chunk * 3) + 5));
        var chunks = Chunks(file);
        var header = file[..HeaderEnd(file)];
        byte[] Join(params (int Start, int Length)[] parts) =>
            [.. header, .. parts.SelectMany(part => file.AsSpan(part.Start, part.Length).ToArray())];

        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(Join(chunks[1], chunks[0], chunks[2], chunks[3])));
        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(Join(chunks[0], chunks[1], chunks[2])));
        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(Join(chunks[0], chunks[1], chunks[3])));
        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(Join(chunks[0], chunks[1], chunks[2], chunks[3], chunks[3])));
        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync([.. file, 0]));
        await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(file[..^3]));
    }

    [Fact]
    public async Task A_header_asking_for_fewer_iterations_is_refused()
    {
        var file = await EncryptAsync([1, 2, 3]);
        var header = Encoding.UTF8.GetString(file, 13, HeaderEnd(file) - 13).Replace("600000", "100000", StringComparison.Ordinal);
        var weakened = Encoding.UTF8.GetBytes(header);
        var lengthBytes = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(lengthBytes, weakened.Length);
        byte[] tampered = [.. file[..9], .. lengthBytes, .. weakened, .. file[HeaderEnd(file)..]];

        var refused = await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(tampered));

        Assert.Contains("does not accept", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(new byte[0])]
    [InlineData(new byte[] { 65, 77, 66 })]
    [InlineData(new byte[] { 80, 75, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0 })]
    public async Task Anything_that_is_not_a_backup_is_refused(byte[] file)
    {
        var refused = await Assert.ThrowsAsync<BackupRefusedException>(() => DecryptAsync(file));

        Assert.Contains("not a Runova server backup", refused.Message, StringComparison.Ordinal);
    }
}
