<?php
/**
 * The binary frame, mirrored from bundle.ts:
 *   "AMWB1\n" | header length (uint32, big-endian) | header JSON {r, b, l} | blobs
 * Nothing may follow the last blob. Blobs are kept as offsets into the raw bytes, so a big upload
 * is not copied until a handler asks for a blob.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Auth\ConnectionKey;
use Runova\Connector\Protocol;

final class Frame
{
    const MAGIC = "AMWB1\n";

    /** @var string */
    public $route;

    /** @var mixed The request or response body, decoded with JSON objects as PHP arrays. */
    public $body;

    /** @var string */
    private $raw;

    /** @var array<int, array{0: int, 1: int}> offset and length of each blob */
    private $blobs;

    /**
     * @param mixed $body
     * @param array<int, array{0: int, 1: int}> $blobs
     */
    private function __construct(string $route, $body, string $raw, array $blobs)
    {
        $this->route = $route;
        $this->body = $body;
        $this->raw = $raw;
        $this->blobs = $blobs;
    }

    /**
     * The uncompressed frame. Pass objects (or stdClass) where JSON must hold an object, since an
     * empty PHP array is written as [].
     *
     * @param mixed $body
     * @param string[] $blobs
     */
    public static function encode(string $route, $body, array $blobs = array()): string
    {
        if (count($blobs) > Protocol::MAX_FRAME_BLOBS) {
            throw new \InvalidArgumentException('Too many blobs for one frame.');
        }
        $lengths = array();
        foreach ($blobs as $blob) {
            $lengths[] = strlen($blob);
        }
        $header = json_encode(array('r' => $route, 'b' => $body, 'l' => $lengths), Protocol::JSON_FLAGS);
        if (!is_string($header)) {
            throw new \InvalidArgumentException('The frame header could not be written.');
        }
        if (strlen($header) > Protocol::MAX_FRAME_HEADER_BYTES) {
            throw new \InvalidArgumentException('The frame header is too large.');
        }
        return self::MAGIC . pack('N', strlen($header)) . $header . implode('', $blobs);
    }

    /**
     * Reads uncompressed frame bytes. Null for anything malformed: wrong magic, a header over the
     * limit or not a JSON object, an unknown route, no body, bad blob lengths, too many blobs, or
     * bytes left over.
     */
    public static function decode(string $bytes, int $maxHeaderBytes = Protocol::MAX_FRAME_HEADER_BYTES, int $maxBlobs = Protocol::MAX_FRAME_BLOBS): ?self
    {
        $start = strlen(self::MAGIC);
        $total = strlen($bytes);
        if ($total < $start + 4 || substr($bytes, 0, $start) !== self::MAGIC) {
            return null;
        }
        $unpacked = unpack('N', substr($bytes, $start, 4));
        $headerLength = is_array($unpacked) ? $unpacked[1] : -1;
        if ($headerLength < 0 || $headerLength > $maxHeaderBytes || $total < $start + 4 + $headerLength) {
            return null;
        }
        $json = substr($bytes, $start + 4, $headerLength);
        // TextDecoder on the TypeScript side drops a leading byte order mark.
        if (strncmp($json, "\xEF\xBB\xBF", 3) === 0) {
            $json = substr($json, 3);
        }
        $header = json_decode($json, false);
        if (json_last_error() !== JSON_ERROR_NONE || !($header instanceof \stdClass)) {
            return null;
        }
        $route = property_exists($header, 'r') ? $header->r : null;
        $lengths = property_exists($header, 'l') ? $header->l : null;
        if (!Protocol::isRoute($route) || !property_exists($header, 'b') || !is_array($lengths) || count($lengths) > $maxBlobs) {
            return null;
        }
        $at = $start + 4 + $headerLength;
        $blobs = array();
        foreach ($lengths as $length) {
            if (!ConnectionKey::isSafeInteger($length) || $length < 0) {
                return null;
            }
            $length = (int) $length;
            if ($at + $length > $total) {
                return null;
            }
            $blobs[] = array($at, $length);
            $at += $length;
        }
        if ($at !== $total) {
            return null;
        }
        $assoc = json_decode($json, true);
        return new self($route, $assoc['b'], $bytes, $blobs);
    }

    public function blobCount(): int
    {
        return count($this->blobs);
    }

    public function blobLength(int $index): int
    {
        return isset($this->blobs[$index]) ? $this->blobs[$index][1] : 0;
    }

    public function blob(int $index): string
    {
        if (!isset($this->blobs[$index])) {
            throw new \OutOfRangeException('No such blob.');
        }
        list($offset, $length) = $this->blobs[$index];
        return $length === 0 ? '' : substr($this->raw, $offset, $length);
    }
}
