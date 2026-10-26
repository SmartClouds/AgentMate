<?php
/**
 * Ed25519, HMAC-SHA256 and randomness. Ed25519 comes from ext-sodium when PHP has it, and from
 * the sodium_compat copy WordPress ships (5.2+) when it does not.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Crypto;

final class Crypto
{
    /**
     * Tests set this to run the pure-PHP sodium_compat code even where ext-sodium is loaded.
     *
     * @var bool
     */
    public static $forceCompat = false;

    public static function ensureSodium(): void
    {
        if (self::$forceCompat) {
            if (!class_exists('ParagonIE_Sodium_Compat')) {
                throw new \RuntimeException('sodium_compat is not loaded.');
            }
            return;
        }
        if (function_exists('sodium_crypto_sign_detached')) {
            return;
        }
        if (defined('ABSPATH') && defined('WPINC')) {
            $compat = ABSPATH . WPINC . '/sodium_compat/autoload.php';
            if (is_file($compat)) {
                require_once $compat;
            }
        }
        if (!function_exists('sodium_crypto_sign_detached')) {
            throw new \RuntimeException('Ed25519 is not available on this site.');
        }
    }

    /** 'native' when ext-sodium does the work, 'compat' for WordPress's pure-PHP copy. */
    public static function sodiumMode(): string
    {
        return (!self::$forceCompat && extension_loaded('sodium')) ? 'native' : 'compat';
    }

    /**
     * @return array{public: string, secret: string} raw 32-byte public key and 64-byte secret key
     */
    public static function keypairFromSeed(string $seed): array
    {
        if (strlen($seed) !== 32) {
            throw new \InvalidArgumentException('An Ed25519 seed is 32 bytes.');
        }
        self::ensureSodium();
        if (self::$forceCompat) {
            $pair = \ParagonIE_Sodium_Compat::crypto_sign_seed_keypair($seed);
            return array(
                'public' => \ParagonIE_Sodium_Compat::crypto_sign_publickey($pair),
                'secret' => \ParagonIE_Sodium_Compat::crypto_sign_secretkey($pair),
            );
        }
        $pair = sodium_crypto_sign_seed_keypair($seed);
        return array(
            'public' => sodium_crypto_sign_publickey($pair),
            'secret' => sodium_crypto_sign_secretkey($pair),
        );
    }

    /** A raw 64-byte detached signature. */
    public static function sign(string $message, string $secretKey): string
    {
        self::ensureSodium();
        if (self::$forceCompat) {
            return \ParagonIE_Sodium_Compat::crypto_sign_detached($message, $secretKey);
        }
        return sodium_crypto_sign_detached($message, $secretKey);
    }

    public static function verify(string $signature, string $message, string $publicKey): bool
    {
        if (strlen($signature) !== 64 || strlen($publicKey) !== 32) {
            return false;
        }
        self::ensureSodium();
        try {
            if (self::$forceCompat) {
                return \ParagonIE_Sodium_Compat::crypto_sign_verify_detached($signature, $message, $publicKey);
            }
            return sodium_crypto_sign_verify_detached($signature, $message, $publicKey);
        } catch (\Throwable $error) {
            return false;
        }
    }

    /** Raw HMAC-SHA256. */
    public static function hmac(string $key, string $message): string
    {
        return hash_hmac('sha256', $message, $key, true);
    }

    public static function sha256Hex(string $bytes): string
    {
        return hash('sha256', $bytes);
    }

    public static function randomBytes(int $length): string
    {
        return random_bytes($length);
    }

    /** A random version 4 UUID, lowercase. */
    public static function uuid4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-'
            . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
    }
}
