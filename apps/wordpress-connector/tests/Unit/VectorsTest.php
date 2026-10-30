<?php
/**
 * Every entry of packages/core/src/deploy/wordpress/vectors/protocol-v1.json, so the plugin and
 * the desktop agree byte for byte.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Auth\Canonical;
use Runova\Connector\Auth\ConnectionKey;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Files\PathPolicy;
use Runova\Connector\Http\Envelope;
use Runova\Connector\Http\Frame;
use Runova\Connector\Http\Gzip;
use Runova\Connector\Tests\Support\TestCase;

final class VectorsTest extends TestCase
{
    /**
     * @return array<string, array{0: bool}>
     */
    public function backends(): array
    {
        return array('ext-sodium' => array(false), 'sodium_compat' => array(true));
    }

    /**
     * @dataProvider backends
     */
    public function testEd25519KeysAndSignatures(bool $compat): void
    {
        Crypto::$forceCompat = $compat;
        if ($compat) {
            \ParagonIE_Sodium_Compat::$disableFallbackForUnitTests = true;
        }
        $vectors = self::vectors();
        foreach (array('site', 'desktop') as $label) {
            $pair = Crypto::keypairFromSeed((string) hex2bin($vectors['keys'][$label]['seedHex']));
            $this->assertSame($vectors['keys'][$label]['publicKey'], Base64Url::encode($pair['public']));
        }
        foreach ($vectors['ed25519'] as $case) {
            $pair = Crypto::keypairFromSeed((string) hex2bin($case['seedHex']));
            $this->assertSame($case['publicKey'], Base64Url::encode($pair['public']), $case['label']);
            $signature = Crypto::sign($case['message'], $pair['secret']);
            $this->assertSame($case['signature'], Base64Url::encode($signature), $case['label']);
            $this->assertTrue(Crypto::verify($signature, $case['message'], $pair['public']));
            $this->assertFalse(Crypto::verify($signature, $case['message'] . 'x', $pair['public']));
        }
        if ($compat) {
            \ParagonIE_Sodium_Compat::$disableFallbackForUnitTests = false;
        }
    }

    public function testCanonicalRequestTextAndSignature(): void
    {
        $vectors = self::vectors();
        foreach ($vectors['canonicalRequest'] as $case) {
            $input = $case['input'];
            $text = Canonical::request($input['route'], $input['timestamp'], $input['nonce'], $input['connectionId'], $input['bodySha256']);
            $this->assertSame($case['text'], $text);
            $signer = Crypto::keypairFromSeed((string) hex2bin($vectors['keys'][$case['signer']]['seedHex']));
            $this->assertSame($case['signature'], Base64Url::encode(Crypto::sign($text, $signer['secret'])));
            $this->assertTrue(Crypto::verify((string) Base64Url::decode($case['signature']), $text, $signer['public']));
        }
    }

    public function testCanonicalResponseSignedWithTheSiteSeed(): void
    {
        $vectors = self::vectors();
        $site = SiteKeys::fromSeed((string) hex2bin($vectors['keys']['site']['seedHex']));
        $this->assertSame($vectors['keys']['site']['publicKey'], $site->publicKeyBase64());
        foreach ($vectors['canonicalResponse'] as $case) {
            $this->assertSame('site', $case['signer']);
            $input = $case['input'];
            $text = Canonical::response($input['route'], $input['requestNonce'], $input['connectionId'], $input['timestamp'], $input['httpStatus'], $input['bodySha256']);
            $this->assertSame($case['text'], $text);
            $this->assertSame($case['signature'], $site->sign($text));
        }
    }

    public function testCanonicalRefusesBadParts(): void
    {
        $hash = str_repeat('a', 64);
        $bad = array(
            function () use ($hash) {
                Canonical::request('/hello', 1, "a\nb", null, $hash);
            },
            function () use ($hash) {
                Canonical::request('/hello', -1, 'n', null, $hash);
            },
            function () {
                Canonical::request('/hello', 1, 'n', null, str_repeat('A', 64));
            },
            function () use ($hash) {
                Canonical::response('/hello', 'n', null, 1, 600, $hash);
            },
            function () use ($hash) {
                Canonical::response('/hello', '', null, 1, 200, $hash);
            },
        );
        foreach ($bad as $index => $call) {
            try {
                $call();
                $this->fail('Case ' . $index . ' should throw.');
            } catch (\InvalidArgumentException $expected) {
                $this->assertNotSame('', $expected->getMessage());
            }
        }
    }

    public function testPairProof(): void
    {
        foreach (self::vectors()['pairProof'] as $case) {
            $input = $case['input'];
            $text = Canonical::pair($input['pairingId'], $input['desktopPublicKey'], $input['deviceName'], $input['timestamp'], $input['nonce']);
            $this->assertSame($case['text'], $text);
            $proof = Crypto::hmac((string) Base64Url::decode($case['secret']), $text);
            $this->assertSame($case['proof'], Base64Url::encode($proof));
            $this->assertTrue(Canonical::isValidDeviceName($input['deviceName']));
        }
        $this->assertFalse(Canonical::isValidDeviceName(''));
        $this->assertFalse(Canonical::isValidDeviceName("a\tb"));
        $this->assertTrue(Canonical::isValidDeviceName(str_repeat('é', 64)));
        $this->assertFalse(Canonical::isValidDeviceName(str_repeat('é', 65)));
    }

    public function testAuthFieldValidAndInvalid(): void
    {
        $vectors = self::vectors();
        foreach ($vectors['authField']['valid'] as $case) {
            $parsed = Canonical::parseAuth($case['value']);
            $this->assertSame($case['parsed'], $parsed, $case['value']);
            $this->assertSame($case['value'], Canonical::formatAuth($parsed['connectionId'], $parsed['timestamp'], $parsed['nonce'], $parsed['signature']));
        }
        foreach ($vectors['authField']['invalid'] as $value) {
            $this->assertNull(Canonical::parseAuth($value), $value);
        }
        // PHP's $ matches before a trailing newline; the parser must not.
        $this->assertNull(Canonical::parseAuth($vectors['authField']['valid'][1]['value'] . "\n"));
        $this->assertNull(Canonical::parseAuth('v1.-.1790000000.AAECAwQFBgcICQoLDA0ODw' . "\n" . '.-'));
    }

    public function testConnectionKeysParseAndFormat(): void
    {
        $keys = self::vectors()['connectionKey'];
        foreach ($keys['valid'] as $index => $case) {
            $parsed = ConnectionKey::parse($case['text'], $keys['now']);
            $this->assertTrue($parsed['ok'], 'valid key ' . $index);
            $this->assertSame($case['key'], $parsed['key']);
            $formatted = ConnectionKey::format($case['key']);
            if ($index < 2) {
                $this->assertSame($case['text'], $formatted, 'byte-exact key ' . $index);
            } else {
                $this->assertSame((string) preg_replace('/\s+/', '', $case['text']), $formatted);
            }
        }
        foreach ($keys['invalid'] as $case) {
            $parsed = ConnectionKey::parse($case['text'], $keys['now']);
            $this->assertFalse($parsed['ok'], $case['text']);
            $this->assertSame($case['error'], $parsed['error'], $case['text']);
        }
    }

    public function testStrictBase64Url(): void
    {
        $this->assertSame('', Base64Url::decode(''));
        $this->assertNull(Base64Url::decode('A'));
        $this->assertNull(Base64Url::decode('AB=='));
        $this->assertNull(Base64Url::decode('AB+/'));
        // "AB" decodes to one byte only when the low four bits of B are zero.
        $this->assertNull(Base64Url::decode('AB'));
        $this->assertSame("\x00", Base64Url::decode('AA'));
        $this->assertNull(Base64Url::decode("AA\n"));
        $this->assertSame('', Base64Url::encode(''));
        for ($length = 1; $length < 40; $length++) {
            $bytes = random_bytes($length);
            $this->assertSame($bytes, Base64Url::decode(Base64Url::encode($bytes)));
        }
    }

    public function testPathsWithExactReasons(): void
    {
        foreach (self::vectors()['paths'] as $case) {
            $reason = PathPolicy::validate($case['path']);
            if ($case['ok']) {
                $this->assertNull($reason, json_encode($case['path']));
            } else {
                $this->assertSame($case['reason'], $reason, json_encode($case['path']));
            }
        }
    }

    public function testSlugs(): void
    {
        foreach (self::vectors()['slugs'] as $case) {
            $this->assertSame($case['valid'], PathPolicy::isValidSlug($case['slug']), json_encode($case['slug']));
            $this->assertSame($case['fileItem'], PathPolicy::isFileItemSlug($case['slug']), json_encode($case['slug']));
        }
    }

    public function testFramesDecodeAndRoundTrip(): void
    {
        foreach (self::vectors()['frames'] as $case) {
            $frame = Frame::decode((string) hex2bin($case['frameHex']));
            $this->assertNotNull($frame, $case['route']);
            $this->assertSame($case['route'], $frame->route);
            $this->assertSame($case['body'], $frame->body);
            $this->assertSame(count($case['blobsHex']), $frame->blobCount());
            foreach ($case['blobsHex'] as $index => $hex) {
                $this->assertSame((string) hex2bin($hex), $frame->blob($index));
            }
            // PHP's own encoding of the same frame decodes to the same thing.
            $blobs = array_map(function ($hex) {
                return (string) hex2bin($hex);
            }, $case['blobsHex']);
            $body = $case['body'] === array() ? new \stdClass() : $case['body'];
            $again = Frame::decode(Frame::encode($case['route'], $body, $blobs));
            $this->assertNotNull($again);
            $this->assertSame($case['body'], $again->body);
            $this->assertSame(count($blobs), $again->blobCount());
        }
    }

    public function testEmptyBodyFrameIsByteExact(): void
    {
        $hello = self::vectors()['frames'][0];
        $this->assertSame($hello['frameHex'], bin2hex(Frame::encode('/hello', new \stdClass())));
    }

    public function testInvalidFramesAreRejected(): void
    {
        foreach (self::vectors()['invalidFrames'] as $case) {
            $this->assertNull(Frame::decode((string) hex2bin($case['hex'])), $case['why']);
        }
        // `b` may be null; only a missing `b` is invalid.
        $json = '{"r":"/hello","b":null,"l":[]}';
        $this->assertNotNull(Frame::decode("AMWB1\n" . pack('N', strlen($json)) . $json));
        // An integral float is a whole length, a fractional one is not.
        $json = '{"r":"/hello","b":{},"l":[2.0]}';
        $frame = Frame::decode("AMWB1\n" . pack('N', strlen($json)) . $json . 'ab');
        $this->assertNotNull($frame);
        $this->assertSame('ab', $frame->blob(0));
    }

    public function testGzipSample(): void
    {
        $gzip = self::vectors()['gzip'];
        $bytes = (string) hex2bin($gzip['gzipHex']);
        $this->assertSame($gzip['gzipSha256'], hash('sha256', $bytes));
        $this->assertSame($gzip['plainHex'], bin2hex((string) Gzip::decode($bytes, 1 << 20)));
        $ours = Gzip::encode((string) hex2bin($gzip['plainHex']));
        $this->assertSame($gzip['plainHex'], bin2hex((string) gzdecode($ours)));
    }

    public function testMultipartSampleCarriesTheBundle(): void
    {
        $sample = self::vectors()['multipart'];
        $body = (string) hex2bin($sample['bodyHex']);
        $this->assertStringContainsString("name=\"am_auth\"\r\n\r\n" . $sample['auth'] . "\r\n", $body);
        $this->assertStringContainsString((string) hex2bin($sample['gzipHex']), $body);
        $this->assertNotNull(Canonical::parseAuth($sample['auth']));
    }

    public function testResponseEnvelope(): void
    {
        $vectors = self::vectors();
        $case = $vectors['response'];
        $site = SiteKeys::fromSeed((string) hex2bin($vectors['keys']['site']['seedHex']));
        $payload = (string) hex2bin($case['payloadHex']);
        $input = $case['canonicalInput'];
        $this->assertSame($input['bodySha256'], hash('sha256', $payload));
        $signature = $site->sign(Canonical::response($input['route'], $input['requestNonce'], $input['connectionId'], $input['timestamp'], $input['httpStatus'], $input['bodySha256']));
        $this->assertSame($case['meta']['sig'], $signature);
        $envelope = Envelope::encode($case['meta']['ts'], $case['meta']['status'], $signature, $payload);
        $this->assertSame($case['envelopeHex'], bin2hex($envelope));
        $decoded = Envelope::decode($envelope);
        $this->assertSame($case['meta'], $decoded['meta']);
        $this->assertSame($case['frameHex'], bin2hex((string) Gzip::decode($decoded['payload'], 1 << 20)));
        $this->assertNull(Envelope::decode('<html>Just a moment...</html>'));
    }

    public function testVersionMatchesTheContract(): void
    {
        $ts = (string) file_get_contents(RUNOVA_TEST_PROTOCOL_TS);
        $this->assertSame(1, preg_match("/WP_CONNECTOR_VERSION = '([^']+)'/", $ts, $match));
        $main = (string) file_get_contents(dirname(__DIR__, 2) . '/runova-connector.php');
        $this->assertSame(1, preg_match('/^ \* Version:\s+(\S+)$/m', $main, $header));
        $this->assertSame(1, preg_match("/define\('RUNOVA_CONNECTOR_VERSION', '([^']+)'\)/", $main, $constant));
        $readme = (string) file_get_contents(dirname(__DIR__, 2) . '/readme.txt');
        $this->assertSame(1, preg_match('/^Stable tag: (\S+)$/m', $readme, $stable));
        $guard = (string) file_get_contents(dirname(__DIR__, 2) . '/guard/00-runova-connector-guard.php');
        $this->assertSame(1, preg_match('/^ \* Version:\s+(\S+)$/m', $guard, $guardVersion));
        $this->assertSame($match[1], $header[1]);
        $this->assertSame($match[1], $constant[1]);
        $this->assertSame($match[1], $stable[1]);
        $this->assertSame($match[1], $guardVersion[1]);
    }
}
