using System.Security.Cryptography;
using System.Text;

namespace Runova.ServerCore.Backups;

/// <summary>A private key sealed with the secret: PBKDF2-HMAC-SHA256, then AES-256-GCM.</summary>
internal sealed record BackupKeySlot(string Kdf, int Iterations, string Salt, string Nonce, string Wrapped);

/// <summary>
/// The key scheduled backups are encrypted to (E28), so the core can make one with nobody there and
/// without ever holding the secret key. An ECDH P-256 pair: the core keeps the public half and the
/// private half sealed with the secret (<see cref="Slot"/>). Every backup carries the slot, so the
/// secret alone opens it on a bare server, and a backup keeps the secret it was made under when the
/// secret changes later.
/// </summary>
internal sealed record BackupKeyRing(string KeyId, string PublicKey, BackupKeySlot Slot, long CreatedAtUnixMs)
{
    private const string KdfName = "PBKDF2-HMAC-SHA256";
    private const int SaltBytes = 16;
    private const int NonceBytes = 12;
    private const int TagBytes = 16;

    public static BackupKeyRing Create(string secret, long createdAtUnixMs)
    {
        RefuseWeak(secret);
        using var key = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = key.ExportSubjectPublicKeyInfo();
        return new BackupKeyRing(KeyIdOf(publicKey), Convert.ToBase64String(publicKey), Seal(key, secret, publicKey), createdAtUnixMs);
    }

    /// <summary>The same key pair sealed with a new secret. Backups made before keep the old one.</summary>
    public BackupKeyRing WithSecret(string currentSecret, string newSecret)
    {
        RefuseWeak(newSecret);
        using var key = Unlock(currentSecret);
        return this with { Slot = Seal(key, newSecret, Convert.FromBase64String(PublicKey)) };
    }

    public ECDiffieHellman Unlock(string secret) => Unlock(Slot, PublicKey, secret);

    /// <summary>Opens a slot, refusing a wrong secret and a slot that does not belong to the public key.</summary>
    public static ECDiffieHellman Unlock(BackupKeySlot slot, string publicKey, string secret)
    {
        if (string.IsNullOrEmpty(secret) || secret.Length > BackupCrypto.MaxPassphraseLength)
        {
            throw new BackupRefusedException("Enter the backup secret key.");
        }

        if (slot.Kdf != KdfName
            || slot.Iterations is < BackupCrypto.Iterations or > BackupCrypto.MaxIterations
            || !TryBase64(slot.Salt, out var salt) || salt.Length != SaltBytes
            || !TryBase64(slot.Nonce, out var nonce) || nonce.Length != NonceBytes
            || !TryBase64(slot.Wrapped, out var wrapped) || wrapped.Length is <= TagBytes or > 512
            || !TryBase64(publicKey, out var publicBytes))
        {
            throw new BackupRefusedException("The backup's key asks for settings the core does not accept.");
        }

        var cipher = wrapped.AsSpan(0, wrapped.Length - TagBytes);
        var privateKey = new byte[cipher.Length];
        try
        {
            using (var gcm = new AesGcm(Derive(secret, salt, slot.Iterations), TagBytes))
            {
                gcm.Decrypt(nonce, cipher, wrapped.AsSpan(wrapped.Length - TagBytes), privateKey, publicBytes);
            }

            var key = ECDiffieHellman.Create();
            key.ImportPkcs8PrivateKey(privateKey, out _);
            if (!key.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(publicBytes))
            {
                key.Dispose();
                throw new BackupRefusedException("The backup's key does not match its public key.");
            }

            return key;
        }
        catch (AuthenticationTagMismatchException error)
        {
            throw new BackupRefusedException("The secret key is wrong, or the backup file is damaged.", error);
        }
        catch (CryptographicException error)
        {
            throw new BackupRefusedException("The backup's key is damaged.", error);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(privateKey);
        }
    }

    public static string KeyIdOf(byte[] publicKey) => Convert.ToHexStringLower(SHA256.HashData(publicKey).AsSpan(0, 8));

    private static BackupKeySlot Seal(ECDiffieHellman key, string secret, byte[] publicKey)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var nonce = RandomNumberGenerator.GetBytes(NonceBytes);
        var privateKey = key.ExportPkcs8PrivateKey();
        var wrapped = new byte[privateKey.Length + TagBytes];
        try
        {
            using var gcm = new AesGcm(Derive(secret, salt, BackupCrypto.Iterations), TagBytes);
            gcm.Encrypt(nonce, privateKey, wrapped.AsSpan(0, privateKey.Length), wrapped.AsSpan(privateKey.Length), publicKey);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(privateKey);
        }

        return new BackupKeySlot(KdfName, BackupCrypto.Iterations, Convert.ToBase64String(salt), Convert.ToBase64String(nonce), Convert.ToBase64String(wrapped));
    }

    private static byte[] Derive(string secret, byte[] salt, int iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(secret), salt, iterations, HashAlgorithmName.SHA256, 32);

    private static void RefuseWeak(string secret)
    {
        if (BackupCrypto.PassphraseProblem(secret) is { } problem)
        {
            throw new BackupRefusedException(problem.Replace("passphrase", "secret key", StringComparison.Ordinal));
        }
    }

    private static bool TryBase64(string? text, out byte[] bytes)
    {
        bytes = [];
        if (string.IsNullOrEmpty(text) || text.Length > 2048)
        {
            return false;
        }

        var buffer = new byte[(text.Length * 3 / 4) + 3];
        if (!Convert.TryFromBase64String(text, buffer, out var written))
        {
            return false;
        }

        bytes = buffer[..written];
        return true;
    }
}
