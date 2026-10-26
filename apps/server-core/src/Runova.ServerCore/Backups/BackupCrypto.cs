using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Runova.ServerCore.Compatibility;

namespace Runova.ServerCore.Backups;

/// <summary>A backup the core will not open: a wrong passphrase, a damaged file, or not a backup at all.</summary>
internal sealed class BackupRefusedException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>What a format 1 backup says about itself in the clear: how to derive its key, and nothing about what it holds.</summary>
internal sealed record BackupHeader(
    int Format,
    string Kdf,
    int Iterations,
    string Salt,
    string Cipher,
    int ChunkBytes,
    string NoncePrefix,
    long CreatedAtUnixMs);

/// <summary>
/// What a format 2 backup says in the clear: the key ring's sealed private key, the ephemeral public
/// key the content key was agreed with, and the wrapped content key.
/// </summary>
internal sealed record KeyRingHeader(
    int Format,
    string Cipher,
    int ChunkBytes,
    string NoncePrefix,
    long CreatedAtUnixMs,
    string KeyId,
    string RecipientKey,
    BackupKeySlot KeySlot,
    string EphemeralKey,
    string ContentKeyNonce,
    string WrappedContentKey);

[JsonSerializable(typeof(BackupHeader))]
[JsonSerializable(typeof(KeyRingHeader))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class BackupHeaderJson : JsonSerializerContext;

/// <summary>
/// The backup file format, with proven pieces from the BCL only. Two ways to get the content key:
/// <list type="bullet">
/// <item>Format 1 (E15, a backup made on demand): PBKDF2-HMAC-SHA256 over the passphrase with a
/// random 16-byte salt and 600,000 iterations (OWASP's figure for that hash). A file asking for
/// fewer is refused, so nobody can hand the core a weaker one.</item>
/// <item>Format 2 (E28, encrypted to a <see cref="BackupKeyRing"/>): a random content key, wrapped
/// with AES-256-GCM under a key agreed by ECDH P-256 between a fresh ephemeral key and the ring's
/// public key (through HKDF-SHA256). The ring's private key travels sealed with the secret, so the
/// secret is all a restore needs and the core never holds it.</item>
/// </list>
/// The contents: AES-256-GCM in chunks (the STREAM construction). Each chunk's nonce is a random
/// 7-byte prefix, the chunk's number and a last-chunk flag, and every chunk authenticates the header
/// too. A changed byte, a chunk moved, dropped or added, a file cut short or a changed header all
/// fail the tag. A wrong passphrase fails on the first chunk.
/// Layout: "AMBACKUP", a version byte, the header's length (4 bytes, big-endian) and the header as
/// JSON, then chunks, each its plaintext length (4 bytes), ciphertext and 16-byte tag.
/// </summary>
internal static class BackupCrypto
{
    public const int Iterations = 600_000;
    public const int MaxIterations = 10_000_000;
    public const int DefaultChunkBytes = 1024 * 1024;
    public const int MinPassphraseLength = 12;
    public const int MaxPassphraseLength = 1024;

    private const int PassphraseFormat = 1;
    private const int KeyRingFormat = 2;
    private const int SaltBytes = 16;
    private const int KeyBytes = 32;
    private const int TagBytes = 16;
    private const int NoncePrefixBytes = 7;
    private const int MaxHeaderBytes = 4096;
    private const string KdfName = "PBKDF2-HMAC-SHA256";
    private const string CipherName = "AES-256-GCM";

    private static readonly byte[] _magic = Encoding.ASCII.GetBytes(FrozenIdentifiers.BackupMagic);
    private static readonly byte[] _contentKeyInfo = Encoding.ASCII.GetBytes(FrozenIdentifiers.BackupContentKeyLabel);

    /// <summary>Why a passphrase will not do, or null.</summary>
    public static string? PassphraseProblem(string? passphrase) => passphrase switch
    {
        null or "" => "Choose a passphrase for the backup.",
        { Length: < MinPassphraseLength } => $"A backup passphrase needs at least {MinPassphraseLength} characters.",
        { Length: > MaxPassphraseLength } => $"A backup passphrase can be at most {MaxPassphraseLength} characters.",
        _ => null,
    };

    public static async Task EncryptAsync(
        Stream plaintext,
        Stream output,
        string passphrase,
        long createdAtUnixMs,
        CancellationToken cancellationToken,
        int chunkBytes = DefaultChunkBytes)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        ArgumentNullException.ThrowIfNull(output);
        if (PassphraseProblem(passphrase) is { } problem)
        {
            throw new BackupRefusedException(problem);
        }

        var header = new BackupHeader(
            PassphraseFormat,
            KdfName,
            Iterations,
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(SaltBytes)),
            CipherName,
            chunkBytes,
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(NoncePrefixBytes)),
            createdAtUnixMs);
        var preamble = Preamble(PassphraseFormat, JsonSerializer.SerializeToUtf8Bytes(header, BackupHeaderJson.Default.BackupHeader));
        await output.WriteAsync(preamble, cancellationToken);
        await EncryptChunksAsync(plaintext, output, DeriveKey(passphrase, header.Salt, header.Iterations), header.NoncePrefix, preamble, chunkBytes, cancellationToken);
    }

    /// <summary>Encrypts to a key ring: no secret needed, and only the secret opens the result.</summary>
    public static async Task EncryptToKeyRingAsync(
        Stream plaintext,
        Stream output,
        BackupKeyRing ring,
        long createdAtUnixMs,
        CancellationToken cancellationToken,
        int chunkBytes = DefaultChunkBytes)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(ring);

        var recipient = Convert.FromBase64String(ring.PublicKey);
        using var recipientKey = ECDiffieHellman.Create();
        recipientKey.ImportSubjectPublicKeyInfo(recipient, out _);
        using var ephemeral = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var ephemeralPublic = ephemeral.ExportSubjectPublicKeyInfo();
        var contentKey = RandomNumberGenerator.GetBytes(KeyBytes);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var wrapped = new byte[KeyBytes + TagBytes];
        try
        {
            var wrapKey = ContentWrapKey(ephemeral.DeriveRawSecretAgreement(recipientKey.PublicKey), ephemeralPublic, recipient);
            using (var gcm = new AesGcm(wrapKey, TagBytes))
            {
                gcm.Encrypt(nonce, contentKey, wrapped.AsSpan(0, KeyBytes), wrapped.AsSpan(KeyBytes), [.. ephemeralPublic, .. recipient]);
            }

            var header = new KeyRingHeader(
                KeyRingFormat,
                CipherName,
                chunkBytes,
                Convert.ToBase64String(RandomNumberGenerator.GetBytes(NoncePrefixBytes)),
                createdAtUnixMs,
                ring.KeyId,
                ring.PublicKey,
                ring.Slot,
                Convert.ToBase64String(ephemeralPublic),
                Convert.ToBase64String(nonce),
                Convert.ToBase64String(wrapped));
            var preamble = Preamble(KeyRingFormat, JsonSerializer.SerializeToUtf8Bytes(header, BackupHeaderJson.Default.KeyRingHeader));
            await output.WriteAsync(preamble, cancellationToken);
            await EncryptChunksAsync(plaintext, output, contentKey, header.NoncePrefix, preamble, chunkBytes, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(contentKey);
        }
    }

    /// <summary>
    /// Decrypts either format into <paramref name="output"/>, with the passphrase (format 1) or the
    /// secret key (format 2). What reaches the output before a failure is not to be trusted: write
    /// to a scratch file and use it only once this returns.
    /// </summary>
    public static async Task DecryptAsync(Stream input, Stream output, string passphrase, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        if (string.IsNullOrEmpty(passphrase) || passphrase.Length > MaxPassphraseLength)
        {
            throw new BackupRefusedException("Enter the backup's passphrase.");
        }

        var (format, headerBytes, preamble) = await ReadPreambleAsync(input, cancellationToken);
        if (format == PassphraseFormat)
        {
            var header = ParseHeader(headerBytes, BackupHeaderJson.Default.BackupHeader);
            if (header is null
                || header.Format != PassphraseFormat
                || header.Kdf != KdfName
                || header.Cipher != CipherName
                || header.Iterations is < Iterations or > MaxIterations
                || !ValidChunkBytes(header.ChunkBytes)
                || !TryBase64(header.Salt, SaltBytes, 64)
                || !TryBase64(header.NoncePrefix, NoncePrefixBytes, NoncePrefixBytes))
            {
                throw Unaccepted();
            }

            await DecryptChunksAsync(
                input,
                output,
                DeriveKey(passphrase, header.Salt, header.Iterations),
                header.NoncePrefix,
                preamble,
                header.ChunkBytes,
                "The passphrase is wrong, or the backup file is damaged.",
                cancellationToken);
            return;
        }

        var ringHeader = ParseHeader(headerBytes, BackupHeaderJson.Default.KeyRingHeader);
        if (ringHeader is null
            || ringHeader.Format != KeyRingFormat
            || ringHeader.Cipher != CipherName
            || ringHeader.KeySlot is null
            || !ValidChunkBytes(ringHeader.ChunkBytes)
            || !TryBase64(ringHeader.NoncePrefix, NoncePrefixBytes, NoncePrefixBytes)
            || !TryBase64(ringHeader.ContentKeyNonce, 12, 12)
            || !TryBase64(ringHeader.WrappedContentKey, KeyBytes + TagBytes, KeyBytes + TagBytes)
            || !TryBase64(ringHeader.EphemeralKey, 32, 512)
            || !TryBase64(ringHeader.RecipientKey, 32, 512))
        {
            throw Unaccepted();
        }

        var contentKey = UnwrapContentKey(ringHeader, passphrase);
        try
        {
            await DecryptChunksAsync(
                input,
                output,
                contentKey,
                ringHeader.NoncePrefix,
                preamble,
                ringHeader.ChunkBytes,
                "The backup file is damaged: its header does not match its contents.",
                cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(contentKey);
        }
    }

    private static byte[] UnwrapContentKey(KeyRingHeader header, string secret)
    {
        using var ring = BackupKeyRing.Unlock(header.KeySlot, header.RecipientKey, secret);
        var ephemeralPublic = Convert.FromBase64String(header.EphemeralKey);
        var recipient = Convert.FromBase64String(header.RecipientKey);
        var wrapped = Convert.FromBase64String(header.WrappedContentKey);
        var contentKey = new byte[KeyBytes];
        try
        {
            using var ephemeral = ECDiffieHellman.Create();
            ephemeral.ImportSubjectPublicKeyInfo(ephemeralPublic, out _);
            var wrapKey = ContentWrapKey(ring.DeriveRawSecretAgreement(ephemeral.PublicKey), ephemeralPublic, recipient);
            using var gcm = new AesGcm(wrapKey, TagBytes);
            gcm.Decrypt(Convert.FromBase64String(header.ContentKeyNonce), wrapped.AsSpan(0, KeyBytes), wrapped.AsSpan(KeyBytes), contentKey, [.. ephemeralPublic, .. recipient]);
            return contentKey;
        }
        catch (CryptographicException error)
        {
            throw new BackupRefusedException("The backup file is damaged: its content key does not open.", error);
        }
    }

    private static byte[] ContentWrapKey(byte[] shared, byte[] ephemeralPublic, byte[] recipient)
    {
        try
        {
            return HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, KeyBytes, [.. ephemeralPublic, .. recipient], _contentKeyInfo);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(shared);
        }
    }

    private static async Task EncryptChunksAsync(
        Stream plaintext,
        Stream output,
        byte[] key,
        string noncePrefix,
        byte[] preamble,
        int chunkBytes,
        CancellationToken cancellationToken)
    {
        var associated = SHA256.HashData(preamble);
        using var gcm = new AesGcm(key, TagBytes);
        CryptographicOperations.ZeroMemory(key);
        var prefix = Convert.FromBase64String(noncePrefix);

        var current = new byte[chunkBytes];
        var next = new byte[chunkBytes];
        var currentLength = await FillAsync(plaintext, current, cancellationToken);
        var cipher = new byte[chunkBytes];
        var tag = new byte[TagBytes];
        var lengthBytes = new byte[4];
        for (uint counter = 0; ; counter++)
        {
            // One chunk read ahead, so the last chunk is known to be the last when it is sealed.
            var nextLength = currentLength == chunkBytes ? await FillAsync(plaintext, next, cancellationToken) : 0;
            var last = nextLength == 0;
            gcm.Encrypt(Nonce(prefix, counter, last), current.AsSpan(0, currentLength), cipher.AsSpan(0, currentLength), tag, associated);
            BinaryPrimitives.WriteUInt32BigEndian(lengthBytes, (uint)currentLength);
            await output.WriteAsync(lengthBytes, cancellationToken);
            await output.WriteAsync(cipher.AsMemory(0, currentLength), cancellationToken);
            await output.WriteAsync(tag, cancellationToken);
            if (last)
            {
                break;
            }

            (current, next) = (next, current);
            currentLength = nextLength;
        }

        CryptographicOperations.ZeroMemory(current);
        CryptographicOperations.ZeroMemory(next);
    }

    private static async Task DecryptChunksAsync(
        Stream input,
        Stream output,
        byte[] key,
        string noncePrefix,
        byte[] preamble,
        int chunkBytes,
        string wrongKey,
        CancellationToken cancellationToken)
    {
        var associated = SHA256.HashData(preamble);
        using var gcm = new AesGcm(key, TagBytes);
        var prefix = Convert.FromBase64String(noncePrefix);
        var cipher = new byte[chunkBytes];
        var plain = new byte[chunkBytes];
        var tag = new byte[TagBytes];
        var lengthBytes = new byte[4];
        for (uint counter = 0; ; counter++)
        {
            if (await FillAsync(input, lengthBytes, cancellationToken) != 4)
            {
                throw Damaged();
            }

            var length = BinaryPrimitives.ReadUInt32BigEndian(lengthBytes);
            if (length > chunkBytes
                || await FillAsync(input, cipher.AsMemory(0, (int)length), cancellationToken) != length
                || await FillAsync(input, tag, cancellationToken) != TagBytes)
            {
                throw Damaged();
            }

            // A full chunk may be followed by more; a shorter one has to be the last.
            var last = length < chunkBytes || IsAtEnd(input);
            try
            {
                gcm.Decrypt(Nonce(prefix, counter, last), cipher.AsSpan(0, (int)length), tag, plain.AsSpan(0, (int)length), associated);
            }
            catch (AuthenticationTagMismatchException error)
            {
                throw counter == 0
                    ? new BackupRefusedException(wrongKey, error)
                    : new BackupRefusedException("The backup file is damaged: part of it does not match what was written.", error);
            }

            await output.WriteAsync(plain.AsMemory(0, (int)length), cancellationToken);
            if (last)
            {
                if (await FillAsync(input, lengthBytes.AsMemory(0, 1), cancellationToken) != 0)
                {
                    throw Damaged();
                }

                CryptographicOperations.ZeroMemory(plain);
                return;
            }
        }
    }

    private static async Task<(int Format, byte[] Header, byte[] Preamble)> ReadPreambleAsync(Stream input, CancellationToken cancellationToken)
    {
        var start = new byte[_magic.Length + 1 + 4];
        if (await FillAsync(input, start, cancellationToken) != start.Length || !start.AsSpan(0, _magic.Length).SequenceEqual(_magic))
        {
            throw new BackupRefusedException("This is not a Runova server backup.");
        }

        var format = start[_magic.Length];
        if (format is not (PassphraseFormat or KeyRingFormat))
        {
            throw new BackupRefusedException("This backup was made by a newer Runova. Update the server core first.");
        }

        var headerLength = BinaryPrimitives.ReadInt32BigEndian(start.AsSpan(_magic.Length + 1));
        if (headerLength is <= 0 or > MaxHeaderBytes)
        {
            throw Damaged();
        }

        var headerBytes = new byte[headerLength];
        if (await FillAsync(input, headerBytes, cancellationToken) != headerLength)
        {
            throw Damaged();
        }

        return (format, headerBytes, [.. start, .. headerBytes]);
    }

    private static T? ParseHeader<T>(byte[] headerBytes, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
    {
        try
        {
            return JsonSerializer.Deserialize(headerBytes, type);
        }
        catch (JsonException error)
        {
            throw new BackupRefusedException("The backup file is damaged.", error);
        }
    }

    private static byte[] Preamble(int format, byte[] json)
    {
        var preamble = new byte[_magic.Length + 1 + 4 + json.Length];
        _magic.CopyTo(preamble, 0);
        preamble[_magic.Length] = (byte)format;
        BinaryPrimitives.WriteInt32BigEndian(preamble.AsSpan(_magic.Length + 1), json.Length);
        json.CopyTo(preamble, _magic.Length + 5);
        return preamble;
    }

    private static byte[] DeriveKey(string passphrase, string salt, int iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(passphrase),
            Convert.FromBase64String(salt),
            iterations,
            HashAlgorithmName.SHA256,
            KeyBytes);

    private static byte[] Nonce(byte[] prefix, uint counter, bool last)
    {
        var nonce = new byte[12];
        prefix.CopyTo(nonce, 0);
        BinaryPrimitives.WriteUInt32BigEndian(nonce.AsSpan(NoncePrefixBytes), counter);
        nonce[11] = last ? (byte)1 : (byte)0;
        return nonce;
    }

    private static bool ValidChunkBytes(int chunkBytes) => chunkBytes is >= 4096 and <= 16 * 1024 * 1024;

    private static bool TryBase64(string? text, int minBytes, int maxBytes)
    {
        if (string.IsNullOrEmpty(text))
        {
            return false;
        }

        var buffer = new byte[(text.Length * 3 / 4) + 3];
        return Convert.TryFromBase64String(text, buffer, out var written) && written >= minBytes && written <= maxBytes;
    }

    private static BackupRefusedException Damaged() => new("The backup file is damaged or cut short.");

    private static BackupRefusedException Unaccepted() => new("The backup's header asks for settings the core does not accept.");

    private static bool IsAtEnd(Stream input)
    {
        if (input.CanSeek)
        {
            return input.Position >= input.Length;
        }

        throw new NotSupportedException("Backups are read from files, which can seek.");
    }

    private static Task<int> FillAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken) =>
        FillAsync(stream, buffer.AsMemory(), cancellationToken);

    /// <summary>Reads until the buffer is full or the stream ends; returns how much it read.</summary>
    private static async Task<int> FillAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[total..], cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
        }

        return total;
    }
}
