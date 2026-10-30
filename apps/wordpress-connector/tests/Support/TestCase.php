<?php
/**
 * Shared setup: the vectors, a temporary wp-content, a site with the vector keys, and a desktop
 * client that signs requests the way Runova does.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

use Runova\Connector\Auth\Canonical;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Http\Dispatcher;
use Runova\Connector\Http\Envelope;
use Runova\Connector\Http\Frame;
use Runova\Connector\Http\Gzip;
use Runova\Connector\Http\IncomingRequest;
use Runova\Connector\Http\OutgoingResponse;
use Runova\Connector\Http\StringBundle;
use Runova\Connector\Routes\Handlers;
use Runova\Connector\Storage\MemoryStorage;

abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    /** @var array<string, mixed>|null */
    private static $vectors = null;

    /** @var string[] */
    private $tempDirs = array();

    /** @var MemoryStorage */
    protected $storage;

    /** @var FakeEnvironment */
    protected $env;

    /** @var SiteKeys */
    protected $siteKeys;

    /** @var array{public: string, secret: string} */
    protected $desktop;

    /** @var array<int, \Throwable> */
    protected $logged = array();

    /**
     * @return array<string, mixed>
     */
    protected static function vectors(): array
    {
        if (self::$vectors === null) {
            $text = file_get_contents(RUNOVA_TEST_VECTORS . '/protocol-v1.json');
            self::$vectors = json_decode((string) $text, true);
        }
        return self::$vectors;
    }

    /**
     * @return array<string, mixed>
     */
    protected static function agentFiles(): array
    {
        return json_decode((string) file_get_contents(RUNOVA_TEST_VECTORS . '/agent-files.json'), true);
    }

    protected function tempDir(): string
    {
        $dir = sys_get_temp_dir() . '/runova-wpc-' . bin2hex(random_bytes(6));
        mkdir($dir, 0777, true);
        $this->tempDirs[] = $dir;
        return $dir;
    }

    protected function tearDown(): void
    {
        foreach ($this->tempDirs as $dir) {
            self::removeTree($dir);
        }
        $this->tempDirs = array();
        Crypto::$forceCompat = false;
        parent::tearDown();
    }

    private static function removeTree(string $dir): void
    {
        if (is_link($dir) || is_file($dir)) {
            @unlink($dir);
            return;
        }
        if (!is_dir($dir)) {
            return;
        }
        foreach ((array) scandir($dir) as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $path = $dir . '/' . $name;
            if (is_dir($path) && !is_link($path)) {
                @chmod($path, 0777);
                self::removeTree($path);
            } else {
                @chmod($path, 0666);
                @unlink($path);
            }
        }
        @rmdir($dir);
    }

    protected function makeSite(): void
    {
        $vectors = self::vectors();
        $this->storage = new MemoryStorage();
        $this->env = new FakeEnvironment($this->tempDir() . '/wp-content');
        $this->siteKeys = SiteKeys::fromSeed((string) hex2bin($vectors['keys']['site']['seedHex']));
        $this->desktop = Crypto::keypairFromSeed((string) hex2bin($vectors['keys']['desktop']['seedHex']));
    }

    /** @var \Runova\Connector\Files\AtomicWriter|null a writer tests swap in (Windows rename) */
    protected $writer = null;

    /** @var callable|null how the connector update moves folders; tests swap in one that fails */
    protected $rename = null;

    protected function dispatcher(): Dispatcher
    {
        $handlers = Handlers::all($this->storage, $this->env, $this->writer, $this->rename);
        $logged = &$this->logged;
        return new Dispatcher($this->storage, $this->env, $this->siteKeys, $handlers, function (\Throwable $error) use (&$logged) {
            $logged[] = $error;
        });
    }

    /**
     * Adds a connection for the desktop key and returns its id.
     *
     * @param array<string, mixed> $extra
     */
    protected function connect(string $scope = 'read', array $extra = array()): string
    {
        $id = Crypto::uuid4();
        $this->storage->insertConnection(array_merge(array(
            'id' => $id,
            'label' => 'Laptop',
            'scope' => $scope,
            'public_key' => Base64Url::encode($this->desktop['public']),
            'device_name' => 'Laptop',
            'created_at' => $this->env->now - 100,
            'expires_at' => null,
            'revoked_at' => null,
        ), $extra));
        return $id;
    }

    protected static function nonce(): string
    {
        return Base64Url::encode(random_bytes(16));
    }

    /** gzip of a request frame, as the desktop sends it. */
    protected static function bundle(string $route, $body, array $blobs = array()): string
    {
        return Gzip::encode(Frame::encode($route, $body, $blobs));
    }

    /**
     * Builds and sends a signed request. Options: connectionId, timestamp, nonce, secretKey,
     * bundle (raw gzip bytes), auth (a ready am_auth), ip, unsigned.
     *
     * @param mixed $body
     * @param array<string, mixed> $options
     * @return array{status: int, meta: array<string, mixed>, frame: Frame, body: array<string, mixed>, nonce: string, response: OutgoingResponse}
     */
    protected function call(string $route, $body = null, array $options = array()): array
    {
        $body = $body === null ? new \stdClass() : $body;
        $connectionId = array_key_exists('connectionId', $options) ? $options['connectionId'] : null;
        $timestamp = isset($options['timestamp']) ? $options['timestamp'] : $this->env->now;
        $nonce = isset($options['nonce']) ? $options['nonce'] : self::nonce();
        $bundle = isset($options['bundle']) ? $options['bundle'] : self::bundle($route, $body, isset($options['blobs']) ? $options['blobs'] : array());
        if (isset($options['auth'])) {
            $auth = $options['auth'];
        } elseif (!empty($options['unsigned'])) {
            $auth = Canonical::formatAuth($connectionId, $timestamp, $nonce, null);
        } else {
            $secret = isset($options['secretKey']) ? $options['secretKey'] : $this->desktop['secret'];
            $text = Canonical::request($route, $timestamp, $nonce, $connectionId, hash('sha256', $bundle));
            $auth = Canonical::formatAuth($connectionId, $timestamp, $nonce, Base64Url::encode(Crypto::sign($text, $secret)));
        }
        $request = new IncomingRequest($route, $auth, $bundle === false ? null : new StringBundle($bundle), isset($options['ip']) ? $options['ip'] : '203.0.113.5', !empty($options['tooLarge']));
        $response = $this->dispatcher()->handle($request);
        return $this->open($response, $route, $nonce, $connectionId);
    }

    /**
     * Reads a response the way the desktop does, checking the site signature.
     *
     * @return array{status: int, meta: array<string, mixed>, frame: Frame, body: array<string, mixed>, nonce: string, response: OutgoingResponse}
     */
    protected function open(OutgoingResponse $response, string $route, string $nonce, ?string $connectionId): array
    {
        $envelope = Envelope::decode($response->body);
        $this->assertNotNull($envelope, 'The reply is an envelope.');
        $meta = $envelope['meta'];
        $this->assertSame($response->status, $meta['status']);
        if ($meta['sig'] !== '') {
            $text = Canonical::response($route, $nonce, $connectionId, $meta['ts'], $meta['status'], hash('sha256', $envelope['payload']));
            $this->assertTrue(
                Crypto::verify((string) Base64Url::decode($meta['sig']), $text, $this->siteKeys->publicKey()),
                'The reply is signed by the site for this request.'
            );
        }
        $plain = Gzip::decode($envelope['payload'], 1 << 27);
        $this->assertNotNull($plain);
        $frame = Frame::decode($plain);
        $this->assertNotNull($frame);
        return array('status' => $meta['status'], 'meta' => $meta, 'frame' => $frame, 'body' => $frame->body, 'nonce' => $nonce, 'response' => $response);
    }

    /**
     * @param array<string, mixed> $result
     */
    protected function assertError(string $code, array $result, ?int $status = null): void
    {
        $this->assertFalse($result['body']['ok'], 'Expected an error, got ' . json_encode($result['body']));
        $this->assertSame($code, $result['body']['error']['code'], (string) json_encode($result['body']));
        if ($status !== null) {
            $this->assertSame($status, $result['status']);
        }
    }

    /**
     * @param array<string, mixed> $result
     * @return mixed the data
     */
    protected function assertOk(array $result)
    {
        $this->assertTrue($result['body']['ok'], 'Expected ok, got ' . json_encode($result['body']) . ' ' . implode("\n", array_map(function ($e) {
            return $e->getMessage() . ' ' . $e->getFile() . ':' . $e->getLine();
        }, $this->logged)));
        $this->assertSame(200, $result['status']);
        return $result['body']['data'];
    }
}
