<?php
/**
 * The site's Ed25519 key. Every reply is signed with it, and its public half travels inside each
 * connection key, so Runova can check even the first reply it gets.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Crypto;

use Runova\Connector\Support\Json;
use Runova\Connector\Support\Options;

final class SiteKeys
{
    /** Never autoloaded: it is read only when a request needs it. */
    const OPTION = 'runova_connector_site_key';

    /** @var string */
    private $publicKey;

    /** @var string */
    private $secretKey;

    private function __construct(string $publicKey, string $secretKey)
    {
        $this->publicKey = $publicKey;
        $this->secretKey = $secretKey;
    }

    public static function fromSeed(string $seed): self
    {
        $pair = Crypto::keypairFromSeed($seed);
        return new self($pair['public'], $pair['secret']);
    }

    /**
     * Reads the key from its option, creating it the first time. The option also records the
     * site's address. A staging copy or a restored backup carries this option along; when the
     * address no longer matches, the copy gets a key of its own and $onRenewed(from, to) runs
     * (which revokes every connection), so a clone can never pass for the original.
     *
     * @param string|null $home the raw `home` option; null skips the check
     * @param callable|null $onRenewed called with the old and the new address after a renewal
     */
    public static function load(?string $home = null, ?callable $onRenewed = null): self
    {
        $raw = Options::get(self::OPTION);
        $resolved = self::resolve(is_string($raw) ? $raw : null, $home);
        if ($resolved['store'] !== null) {
            if (!is_string($raw)) {
                Options::add(self::OPTION, $resolved['store']);
                // Another request may have won the race; whatever is stored now is the key.
                $again = self::resolve(is_string(Options::get(self::OPTION)) ? Options::get(self::OPTION) : null, $home);
                if ($again['store'] !== null) {
                    throw new \RuntimeException('The site key could not be saved.');
                }
                $resolved = $again;
            } else {
                Options::update(self::OPTION, $resolved['store']);
            }
        }
        if ($resolved['renewedFrom'] !== null && $onRenewed !== null && $home !== null) {
            call_user_func($onRenewed, $resolved['renewedFrom'], $home);
        }
        return self::fromSeed($resolved['seed']);
    }

    /**
     * What load() does, without WordPress: the seed to use, the option value to write (null when
     * it is unchanged), and the old address when the key was renewed because the site moved.
     *
     * @return array{seed: string, store: string|null, renewedFrom: string|null}
     */
    public static function resolve(?string $raw, ?string $home): array
    {
        $data = $raw !== null ? json_decode($raw, true) : null;
        $seed = is_array($data) && isset($data['seed']) && is_string($data['seed']) ? Base64Url::decode($data['seed']) : null;
        if ($seed === null || strlen($seed) !== 32) {
            $fresh = Crypto::randomBytes(32);
            return array('seed' => $fresh, 'store' => self::encode($fresh, $home), 'renewedFrom' => null);
        }
        $stored = isset($data['home']) && is_string($data['home']) ? $data['home'] : null;
        if ($home === null) {
            return array('seed' => $seed, 'store' => null, 'renewedFrom' => null);
        }
        if ($stored === null) {
            // Written before addresses were recorded: remember this one, keep the key.
            return array('seed' => $seed, 'store' => self::encode($seed, $home), 'renewedFrom' => null);
        }
        if (self::sameSite($stored, $home)) {
            return array('seed' => $seed, 'store' => null, 'renewedFrom' => null);
        }
        $fresh = Crypto::randomBytes(32);
        return array('seed' => $fresh, 'store' => self::encode($fresh, $home), 'renewedFrom' => $stored);
    }

    /**
     * Host, port and path decide; the scheme does not, so moving to HTTPS is not a new site.
     */
    public static function sameSite(string $a, string $b): bool
    {
        return self::place($a) === self::place($b);
    }

    private static function place(string $url): string
    {
        $parts = parse_url(trim($url));
        if (!is_array($parts) || !isset($parts['host'])) {
            return strtolower(rtrim(trim($url), '/'));
        }
        $scheme = isset($parts['scheme']) ? strtolower($parts['scheme']) : 'http';
        $port = isset($parts['port']) ? (int) $parts['port'] : null;
        if ($port === ($scheme === 'https' ? 443 : 80)) {
            $port = null;
        }
        $path = isset($parts['path']) ? rtrim($parts['path'], '/') : '';
        return strtolower($parts['host']) . ($port !== null ? ':' . $port : '') . $path;
    }

    private static function encode(string $seed, ?string $home): string
    {
        $value = array('v' => 1, 'seed' => Base64Url::encode($seed));
        if ($home !== null) {
            $value['home'] = $home;
        }
        return Json::encode($value);
    }

    /** Raw 32 bytes. */
    public function publicKey(): string
    {
        return $this->publicKey;
    }

    public function publicKeyBase64(): string
    {
        return Base64Url::encode($this->publicKey);
    }

    /** base64url of the raw signature. */
    public function sign(string $message): string
    {
        return Base64Url::encode(Crypto::sign($message, $this->secretKey));
    }
}
