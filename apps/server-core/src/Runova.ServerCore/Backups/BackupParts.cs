using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Runova.ServerCore.Compatibility;

namespace Runova.ServerCore.Backups;

/// <summary>One file of a backup on a destination: its place in the order, its name, size and SHA-256.</summary>
internal sealed record BackupPartInfo(int Index, string Name, long SizeBytes, string Sha256);

/// <summary>
/// The plaintext file beside a backup on a destination (E28). It holds nothing secret, only what a
/// listing and a restore need: which backup, which plan made it, when, and its parts.
/// </summary>
internal sealed record BackupManifestFile(
    int Schema,
    Guid BackupId,
    Guid? PlanId,
    string ServerName,
    long CreatedAtUnixMs,
    long SizeBytes,
    string Sha256,
    string CoreVersion,
    string KeyId,
    IReadOnlyList<BackupPartInfo> Parts)
{
    public const int SchemaVersion = 1;
    public const int MaxBytes = 64 * 1024;

    public string ToJson() => JsonSerializer.Serialize(this, BackupPartsJson.Default.BackupManifestFile);

    /// <summary>Reads a manifest someone else's storage handed back, refusing anything a restore could trip on.</summary>
    public static BackupManifestFile Parse(string json)
    {
        BackupManifestFile? manifest;
        try
        {
            manifest = json.Length > MaxBytes ? null : JsonSerializer.Deserialize(json, BackupPartsJson.Default.BackupManifestFile);
        }
        catch (JsonException error)
        {
            throw new BackupRefusedException("This is not a Runova backup manifest.", error);
        }

        if (manifest is null || manifest.Schema != SchemaVersion || manifest.Parts is null || manifest.BackupId == Guid.Empty)
        {
            throw new BackupRefusedException("This is not a Runova backup manifest.");
        }

        if (manifest.Parts.Count is 0 or > 10_000
            || manifest.SizeBytes < 0
            || !BackupNaming.IsSha256(manifest.Sha256)
            || string.IsNullOrEmpty(manifest.ServerName) || manifest.ServerName.Length > 200
            || manifest.CoreVersion is null || manifest.CoreVersion.Length > 100
            || manifest.KeyId is null || manifest.KeyId.Length > 64)
        {
            throw Damaged();
        }

        long total = 0;
        for (var i = 0; i < manifest.Parts.Count; i++)
        {
            var part = manifest.Parts[i];
            if (part is null || part.Index != i + 1 || !BackupNaming.IsSafeName(part.Name) || part.SizeBytes < 0 || !BackupNaming.IsSha256(part.Sha256))
            {
                throw Damaged();
            }

            total += part.SizeBytes;
        }

        return total == manifest.SizeBytes ? manifest : throw Damaged();
    }

    private static BackupRefusedException Damaged() => new("The backup's manifest is damaged or names files it should not.");
}

[JsonSerializable(typeof(BackupManifestFile))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class BackupPartsJson : JsonSerializerContext;

/// <summary>How backups are named on a destination, so a listing can find them and nothing else.</summary>
internal static partial class BackupNaming
{
    public const string Prefix = "runova-";
    public const string Extension = ".rnbackup";
    public const string ManifestExtension = ".manifest.json";

    /// <summary>The prefixes listings look for: backups made before the rename stay restorable.</summary>
    public static readonly string[] Prefixes = [Prefix, LegacyNames.BackupFilePrefix];

    /// <summary>The extensions part names may carry, the new one first.</summary>
    public static readonly string[] Extensions = [Extension, LegacyNames.BackupExtension];

    public static bool HasPrefix(string name) => Prefixes.Any(prefix => name.StartsWith(prefix, StringComparison.Ordinal));

    public static string BaseName(string serverName, long createdAtUnixMs, Guid backupId) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{Prefix}{FileSafe(serverName)}-{DateTimeOffset.FromUnixTimeMilliseconds(createdAtUnixMs):yyyyMMdd-HHmmss}-{backupId.ToString("N")[..8]}");

    public static string PartName(string baseName, int index, int count) =>
        count == 1 ? baseName + Extension : string.Create(CultureInfo.InvariantCulture, $"{baseName}{Extension}.part{index:D3}");

    public static string ManifestName(string baseName) => baseName + ManifestExtension;

    public static bool IsManifestName(string name) =>
        HasPrefix(name) && name.EndsWith(ManifestExtension, StringComparison.Ordinal) && IsSafeName(name);

    public static bool IsSafeName(string? name) => name is { Length: > 0 and <= 200 } && SafeName().IsMatch(name);

    public static bool IsSha256(string? text) => text is { Length: 64 } && Hex().IsMatch(text);

    public static string FileSafe(string name)
    {
        var safe = Unsafe().Replace(name, "-").Trim('-', '.');
        return safe.Length == 0 ? "server" : safe[..Math.Min(safe.Length, 40)];
    }

    [GeneratedRegex("[^A-Za-z0-9._-]+", RegexOptions.CultureInvariant)]
    private static partial Regex Unsafe();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeName();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Hex();
}

/// <summary>Cuts a backup file into parts of at most a size, and joins them back with every part checked.</summary>
internal static class BackupParts
{
    private const int BufferBytes = 1024 * 1024;

    /// <summary>The parts a file is cut into, hashed in one pass. No size means one part.</summary>
    public static async Task<IReadOnlyList<BackupPartInfo>> DescribeAsync(string path, long? maxPartBytes, string baseName, CancellationToken cancellationToken)
    {
        if (maxPartBytes is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxPartBytes));
        }

        var length = new FileInfo(path).Length;
        var size = maxPartBytes ?? Math.Max(length, 1);
        var count = (int)Math.Max(1, (length + size - 1) / size);
        var parts = new List<BackupPartInfo>(count);
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, useAsync: true);
        var buffer = new byte[BufferBytes];
        for (var index = 1; index <= count; index++)
        {
            var partBytes = Math.Min(size, length - ((index - 1) * size));
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            for (long left = partBytes; left > 0;)
            {
                var read = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, left)), cancellationToken);
                if (read == 0)
                {
                    throw new IOException("The backup file changed while it was being cut into parts.");
                }

                hash.AppendData(buffer, 0, read);
                left -= read;
            }

            parts.Add(new BackupPartInfo(index, BackupNaming.PartName(baseName, index, count), partBytes, Convert.ToHexStringLower(hash.GetHashAndReset())));
        }

        return parts;
    }

    /// <summary>A part's bytes read straight from the whole file, for uploading.</summary>
    public static Stream OpenPart(string path, BackupPartInfo part, long? maxPartBytes)
    {
        var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, useAsync: true);
        var offset = maxPartBytes is { } size ? (part.Index - 1) * size : 0;
        return new SliceStream(file, offset, part.SizeBytes);
    }

    /// <summary>Joins parts into <paramref name="output"/>, checking each one's size and SHA-256 as it goes.</summary>
    public static async Task JoinAsync(
        IReadOnlyList<BackupPartInfo> parts,
        Func<BackupPartInfo, CancellationToken, Task<Stream>> open,
        Stream output,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[BufferBytes];
        foreach (var part in parts)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long total = 0;
            await using (var input = await open(part, cancellationToken))
            {
                int read;
                while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total += read;
                    if (total > part.SizeBytes)
                    {
                        throw PartRefused(part);
                    }

                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
            }

            if (total != part.SizeBytes || Convert.ToHexStringLower(hash.GetHashAndReset()) != part.Sha256)
            {
                throw PartRefused(part);
            }
        }
    }

    private static BackupRefusedException PartRefused(BackupPartInfo part) =>
        new(string.Create(CultureInfo.InvariantCulture, $"The backup's part {part.Index} ({part.Name}) is missing, cut short or changed."));
}

/// <summary>A read-only window onto part of a stream, which it owns.</summary>
internal sealed class SliceStream : Stream
{
    private readonly Stream _inner;
    private readonly long _start;
    private readonly long _length;
    private long _position;

    public SliceStream(Stream inner, long start, long length)
    {
        _inner = inner;
        _start = start;
        _length = length;
        _inner.Seek(start, SeekOrigin.Begin);
    }

    public override bool CanRead => true;

    public override bool CanSeek => true;

    public override bool CanWrite => false;

    public override long Length => _length;

    public override long Position
    {
        get => _position;
        set => Seek(value, SeekOrigin.Begin);
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        var read = _inner.Read(buffer[..Allowed(buffer.Length)]);
        _position += read;
        return read;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var read = await _inner.ReadAsync(buffer[..Allowed(buffer.Length)], cancellationToken);
        _position += read;
        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override long Seek(long offset, SeekOrigin origin)
    {
        var target = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            _ => _length + offset,
        };
        if (target < 0 || target > _length)
        {
            throw new ArgumentOutOfRangeException(nameof(offset));
        }

        _inner.Seek(_start + target, SeekOrigin.Begin);
        _position = target;
        return target;
    }

    public override void Flush()
    {
    }

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _inner.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _inner.DisposeAsync();
        await base.DisposeAsync();
    }

    private int Allowed(int wanted) => (int)Math.Min(wanted, _length - _position);
}
