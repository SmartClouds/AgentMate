<?php
/**
 * The response envelope, mirrored from bundle.ts:
 *   "AMWR1\n" | meta length (uint32, big-endian) | meta JSON {ts, status, sig} | gzip(frame)
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Protocol;

final class Envelope
{
    const MAGIC = "AMWR1\n";

    public static function encode(int $timestamp, int $status, string $signature, string $gzippedFrame): string
    {
        $meta = json_encode(array('ts' => $timestamp, 'status' => $status, 'sig' => $signature), Protocol::JSON_FLAGS);
        if (!is_string($meta)) {
            throw new \InvalidArgumentException('The response meta could not be written.');
        }
        return self::MAGIC . pack('N', strlen($meta)) . $meta . $gzippedFrame;
    }

    /**
     * Splits a reply into meta and payload. Null when it is not an envelope.
     *
     * @return array{meta: array{ts: int, status: int, sig: string}, payload: string}|null
     */
    public static function decode(string $bytes): ?array
    {
        $start = strlen(self::MAGIC);
        if (strlen($bytes) < $start + 4 || substr($bytes, 0, $start) !== self::MAGIC) {
            return null;
        }
        $unpacked = unpack('N', substr($bytes, $start, 4));
        $length = is_array($unpacked) ? $unpacked[1] : -1;
        if ($length < 0 || $length > 4096 || strlen($bytes) < $start + 4 + $length) {
            return null;
        }
        $meta = json_decode(substr($bytes, $start + 4, $length), true);
        if (!is_array($meta) || !isset($meta['ts'], $meta['status'], $meta['sig'])) {
            return null;
        }
        if (!is_int($meta['ts']) || !is_int($meta['status']) || !is_string($meta['sig'])) {
            return null;
        }
        if (preg_match('/^([A-Za-z0-9_-]{86})?$/D', $meta['sig']) !== 1) {
            return null;
        }
        return array(
            'meta' => array('ts' => $meta['ts'], 'status' => $meta['status'], 'sig' => $meta['sig']),
            'payload' => (string) substr($bytes, $start + 4 + $length),
        );
    }
}
