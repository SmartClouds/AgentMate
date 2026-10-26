<?php
/**
 * Frame and bundle limits: header size, blob count, gzip bombs, and refusing to open anything
 * before the signature has checked out.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Http\ApiError;
use Runova\Connector\Http\BundleReader;
use Runova\Connector\Http\Frame;
use Runova\Connector\Http\Gzip;
use Runova\Connector\Http\StringBundle;
use Runova\Connector\Protocol;
use Runova\Connector\Tests\Support\TestCase;

final class FrameLimitsTest extends TestCase
{
    public function testHeaderLimit(): void
    {
        $frame = Frame::encode('/hello', array('pad' => str_repeat('x', 2000)));
        $this->assertNotNull(Frame::decode($frame));
        $this->assertNull(Frame::decode($frame, 1000));
        try {
            Frame::encode('/hello', array('pad' => str_repeat('x', Protocol::MAX_FRAME_HEADER_BYTES)));
            $this->fail('An oversized header must not be written.');
        } catch (\InvalidArgumentException $expected) {
            $this->assertStringContainsString('too large', $expected->getMessage());
        }
    }

    public function testBlobLimit(): void
    {
        $frame = Frame::encode('/hello', new \stdClass(), array_fill(0, 5, 'a'));
        $this->assertNotNull(Frame::decode($frame));
        $this->assertNull(Frame::decode($frame, Protocol::MAX_FRAME_HEADER_BYTES, 4));
        try {
            Frame::encode('/hello', new \stdClass(), array_fill(0, Protocol::MAX_FRAME_BLOBS + 1, ''));
            $this->fail('Too many blobs must not be written.');
        } catch (\InvalidArgumentException $expected) {
            $this->assertStringContainsString('blobs', $expected->getMessage());
        }
    }

    public function testFrameBlobsAreExact(): void
    {
        $frame = Frame::decode(Frame::encode('/files/read', array('a' => 1), array('one', '', "two\x00")));
        $this->assertSame(3, $frame->blobCount());
        $this->assertSame('one', $frame->blob(0));
        $this->assertSame('', $frame->blob(1));
        $this->assertSame("two\x00", $frame->blob(2));
        $this->assertSame(4, $frame->blobLength(2));
    }

    public function testGzipBombIsRefused(): void
    {
        $bomb = Gzip::encode(str_repeat("\0", 8 * 1048576), 9);
        $this->assertLessThan(65536, strlen($bomb));
        $this->assertNull(Gzip::decode($bomb, 1048576));
        // A forged size trailer still fails the hard limit.
        $forged = substr($bomb, 0, -4) . pack('V', 100);
        $this->assertNull(Gzip::decode($forged, 1048576));
        $this->assertSame(8 * 1048576, strlen((string) Gzip::decode($bomb, 8 * 1048576)));
    }

    public function testBundleReaderRefusesABombByItsTrailer(): void
    {
        $plain = Frame::encode('/site/info', new \stdClass(), array(str_repeat('a', 4 * 1048576)));
        $bundle = new StringBundle(Gzip::encode($plain, 9));
        try {
            BundleReader::open($bundle, '/site/info', 1048576, 1048576);
            $this->fail('A bundle that unpacks past the limit must be refused.');
        } catch (ApiError $error) {
            $this->assertSame('tooLarge', $error->errorCode);
        }
    }

    public function testBundleReaderRefusesAForgedTrailerBomb(): void
    {
        $plain = Frame::encode('/site/info', new \stdClass(), array(str_repeat('a', 4 * 1048576)));
        $gzip = Gzip::encode($plain, 9);
        $forged = substr($gzip, 0, -4) . pack('V', 10);
        try {
            BundleReader::open(new StringBundle($forged), '/site/info', 1048576, 1048576);
            $this->fail('A forged trailer must not get past the limit.');
        } catch (ApiError $error) {
            $this->assertSame('badRequest', $error->errorCode);
        }
    }

    public function testBundleReaderRefusesNonGzipAndOversizedBundles(): void
    {
        foreach (array('not gzip at all, just text', '') as $bytes) {
            try {
                BundleReader::open(new StringBundle($bytes), '/hello', 1024, 1024);
                $this->fail('Not gzip.');
            } catch (ApiError $error) {
                $this->assertSame('badRequest', $error->errorCode);
            }
        }
        try {
            BundleReader::open(new StringBundle(str_repeat('a', 2048)), '/hello', 1024, 1024);
            $this->fail('Too big.');
        } catch (ApiError $error) {
            $this->assertSame('tooLarge', $error->errorCode);
        }
    }

    public function testGzipBombThroughTheDispatcherIsRefusedAfterTheSignature(): void
    {
        $this->makeSite();
        $this->env->ini['memory_limit'] = '24M';
        $connection = $this->connect();
        $bomb = Gzip::encode(Frame::encode('/site/info', new \stdClass(), array(str_repeat('a', 6 * 1048576))), 9);
        $result = $this->call('/site/info', null, array('connectionId' => $connection, 'bundle' => $bomb));
        $this->assertError('tooLarge', $result, 413);

        // The same bomb with a bad signature never gets opened: it fails on the signature.
        $other = \Runova\Connector\Crypto\Crypto::keypairFromSeed(str_repeat("\x05", 32));
        $result = $this->call('/site/info', null, array('connectionId' => $connection, 'bundle' => $bomb, 'secretKey' => $other['secret']));
        $this->assertError('badSignature', $result);
    }

    public function testOversizedAuthenticatedBundleIsTooLarge(): void
    {
        $this->makeSite();
        $connection = $this->connect();
        $result = $this->call('/site/info', null, array('connectionId' => $connection, 'bundle' => str_repeat('x', Protocol::BATCH_MAX_BYTES + 1)));
        $this->assertError('tooLarge', $result, 413);
    }
}
