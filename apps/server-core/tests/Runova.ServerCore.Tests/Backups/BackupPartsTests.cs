using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Backups;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// A backup cut into parts for destinations that cap a file's size (Telegram), and the plaintext
/// manifest beside it. Joining checks every part's size and hash, so a missing, swapped or changed
/// part never reaches the decryption.
/// </summary>
public sealed class BackupPartsTests : IDisposable
{
    private static readonly Guid _id = Guid.Parse("6f1c2a9e-0b7d-4e55-9a31-2c4b8d7e9f10");
    private static readonly Guid _plan = Guid.Parse("11111111-2222-3333-4444-555555555555");

    private readonly string _root = Directory.CreateTempSubdirectory("am-parts-").FullName;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string Write(byte[] bytes)
    {
        var path = Path.Combine(_root, "backup.ambackup");
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static BackupManifestFile Manifest(IReadOnlyList<BackupPartInfo> parts, long size, string sha256) =>
        new(BackupManifestFile.SchemaVersion, _id, _plan, "web-1", 1_760_000_000_000, size, sha256, "1.2.3", "0123456789abcdef", [.. parts]);

    [Fact]
    public void Names_carry_the_server_the_time_and_the_id_and_nothing_unsafe()
    {
        var name = BackupNaming.BaseName("web 1/../prod", 1_760_000_000_000, _id);

        Assert.Equal("runova-web-1-..-prod-20251009-085320-6f1c2a9e", name);
        Assert.Equal(name + ".rnbackup", BackupNaming.PartName(name, 1, 1));
        Assert.Equal(name + ".rnbackup.part002", BackupNaming.PartName(name, 2, 3));
        Assert.Equal(name + ".manifest.json", BackupNaming.ManifestName(name));
        Assert.DoesNotContain('/', name);
    }

    [Theory]
    [InlineData(0, null, 1)]
    [InlineData(10, null, 1)]
    [InlineData(10, 10L, 1)]
    [InlineData(11, 10L, 2)]
    [InlineData(30, 10L, 3)]
    [InlineData(31, 10L, 4)]
    public async Task A_file_is_cut_at_the_part_size_and_every_part_is_hashed(int size, long? maxPart, int expectedParts)
    {
        var bytes = RandomNumberGenerator.GetBytes(size);
        var path = Write(bytes);

        var parts = await BackupParts.DescribeAsync(path, maxPart, "base", Cancel);

        Assert.Equal(expectedParts, parts.Count);
        Assert.Equal(size, parts.Sum(part => part.SizeBytes));
        long offset = 0;
        foreach (var part in parts)
        {
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes.AsSpan((int)offset, (int)part.SizeBytes))), part.Sha256);
            await using var stream = BackupParts.OpenPart(path, part, maxPart);
            var read = new MemoryStream();
            await stream.CopyToAsync(read, Cancel);
            Assert.Equal(bytes.AsSpan((int)offset, (int)part.SizeBytes).ToArray(), read.ToArray());
            offset += part.SizeBytes;
        }

        Assert.Equal(Enumerable.Range(1, expectedParts), parts.Select(part => part.Index));
    }

    [Fact]
    public async Task Parts_join_back_into_the_file()
    {
        var bytes = RandomNumberGenerator.GetBytes(25);
        var path = Write(bytes);
        var parts = await BackupParts.DescribeAsync(path, 10, "base", Cancel);

        var output = new MemoryStream();
        await BackupParts.JoinAsync(parts, (part, _) => Task.FromResult<Stream>(BackupParts.OpenPart(path, part, 10)), output, Cancel);

        Assert.Equal(bytes, output.ToArray());
    }

    [Fact]
    public async Task A_changed_part_is_refused()
    {
        var path = Write(RandomNumberGenerator.GetBytes(25));
        var parts = await BackupParts.DescribeAsync(path, 10, "base", Cancel);

        var error = await Assert.ThrowsAsync<BackupRefusedException>(() => BackupParts.JoinAsync(
            parts,
            (part, _) => Task.FromResult<Stream>(part.Index == 2 ? new MemoryStream(new byte[10]) : BackupParts.OpenPart(path, part, 10)),
            new MemoryStream(),
            Cancel));

        Assert.Contains("part 2", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_part_cut_short_is_refused()
    {
        var path = Write(RandomNumberGenerator.GetBytes(25));
        var parts = await BackupParts.DescribeAsync(path, 10, "base", Cancel);

        await Assert.ThrowsAsync<BackupRefusedException>(() => BackupParts.JoinAsync(
            parts,
            (part, _) => Task.FromResult<Stream>(new MemoryStream(new byte[part.SizeBytes - 1])),
            new MemoryStream(),
            Cancel));
    }

    [Fact]
    public async Task The_manifest_round_trips_and_holds_no_secret()
    {
        var path = Write(Encoding.UTF8.GetBytes("ciphertext"));
        var parts = await BackupParts.DescribeAsync(path, null, "base", Cancel);
        var manifest = Manifest(parts, 10, parts[0].Sha256);

        var json = manifest.ToJson();
        var parsed = BackupManifestFile.Parse(json);

        Assert.Equal(manifest.BackupId, parsed.BackupId);
        Assert.Equal(manifest.PlanId, parsed.PlanId);
        Assert.Equal(manifest.Parts.Count, parsed.Parts.Count);
        Assert.Equal(manifest.Parts[0], parsed.Parts[0]);
        Assert.DoesNotContain("ciphertext", json, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("../evil", 10)]
    [InlineData("sub/part", 10)]
    [InlineData("base.ambackup", 9)]
    public void A_manifest_with_unsafe_names_or_sizes_that_do_not_add_up_is_refused(string name, long partSize)
    {
        var manifest = Manifest([new BackupPartInfo(1, name, partSize, new string('a', 64))], 10, new string('a', 64));

        Assert.Throws<BackupRefusedException>(() => BackupManifestFile.Parse(manifest.ToJson()));
    }

    [Fact]
    public void A_manifest_with_a_gap_in_its_parts_is_refused()
    {
        var manifest = Manifest(
            [new BackupPartInfo(1, "a.part001", 5, new string('a', 64)), new BackupPartInfo(3, "a.part003", 5, new string('b', 64))],
            10,
            new string('c', 64));

        Assert.Throws<BackupRefusedException>(() => BackupManifestFile.Parse(manifest.ToJson()));
    }

    [Fact]
    public void Something_that_is_not_a_manifest_is_refused()
    {
        Assert.Throws<BackupRefusedException>(() => BackupManifestFile.Parse("{\"hello\":1}"));
        Assert.Throws<BackupRefusedException>(() => BackupManifestFile.Parse("not json"));
    }
}
